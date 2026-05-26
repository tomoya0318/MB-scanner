import type { Node, Statement } from "@babel/types";

import {
  classifyParamDiff,
  countNodes,
  functionBlockBody,
  hasBindingCollision,
  renameIdentifiersInStatements,
} from "../../../../ast/inspect";
import {
  SELAKOVIC_EXCLUSION_REASON,
  TARGET_SIDE,
  type PreprocessingCandidate,
} from "../../../../contracts/preprocessing-contracts";
import type { FnChangeUnit } from "../../../common/change-units";
import { replaceFunctionBodyWithObserver } from "../../../../codegen/placeholder";
import { statementsToCode } from "../../../common/setup-cleanup";
import { buildExcludedChangedFnCandidate } from "./changed-fn";

/**
 * server (CommonJS) layout の changed-fn candidate を組む (ADR-0025、placeholder substitution model)。
 *
 * client `buildChangedFnCandidate` と同じ「変更関数 body を `$BODY$` 穴あけ → slow/fast に裸 body」モデルを、
 * CommonJS `module.exports`/`require` 構造を保ったまま server の `test_case_*.js` 経路に乗せる。
 *
 * **module 解決 (map-require)**: lib の全 after ファイルを in-memory map に持ち、相対 require を map 上で解決する
 * 自前 require を組む。穴あけ対象ファイルだけ raw な関数リテラル (`__HOLED__`) として埋め (`$BODY$` が raw コード
 * 位置に来るので substituteBody が壊れない)、他ファイルは JSON map (`__FILES__`) + `new Function` で評価する。
 * lib 内部の bare require (`require('lodash')` 等) と未解決の相対 require (`./package` 等) は ambient な
 * jsdom executor の require (= `module_base_dir` 起点 + ADR-0016 lockfile-vendored) に委譲 / graceful `{}` 返し。
 * single-file lib (Chalk) は「ファイル 1 個・entry = 変更ファイル」の退化形として同じ経路で扱う。
 *
 * **観測 (2 チャネル)**: workload は test() 実行後に次の 2 つを観測値として返す:
 *  - `r`: 変更関数の戻り値列 (`__OBS__`、observer ハーネスが push)。Chalk 等「戻り値が serializable」な lib を弁別
 *  - `s`: init() 戻り値 (= SUT オブジェクト) の post-state を **汎用 safe-walk** (循環畳み込み + 関数の own プロパティも
 *    walk) した projection。Cheerio 等「戻り値が `this`/void で mutation する」lib を、最終状態 (class 属性等) で弁別
 *  → 戻り値系は `r`、mutation 系は `s` が positive-evidence になる (ADR-0018、TODO #1 の recorder/oracle 境界)。
 *
 * excluded marker の条件は client `buildChangedFnCandidate` と同じ (rename/削除 / non-block body / param 本質変更)。
 */
export function buildServerChangedFnCandidate(params: {
  unit: FnChangeUnit;
  /** 変更関数を含むファイルの map キー (lib dir 起点の相対パス。single-file は唯一のキー)。 */
  changedFileKey: string;
  /** 変更ファイルの after ソース全文 (`unit.afterFn` の span がここを指す)。 */
  changedFileAfterSrc: string;
  /** 変更ファイル以外の after ファイル map (キー → ソース)。 */
  otherAfterFiles: Record<string, string>;
  /** lib の entry ファイルの map キー (multi-file は通常 `index.js`、single-file は変更ファイルと同じ)。 */
  entryKey: string;
  /** after 側 `test_case_*.js` 全文 (slow/fast 共通の workload)。 */
  testCaseSource: string;
}): PreprocessingCandidate {
  const { unit, changedFileKey, changedFileAfterSrc, otherAfterFiles, entryKey, testCaseSource } = params;
  const afterFn = unit.afterFn;
  if (afterFn === null) {
    return buildExcludedChangedFnCandidate(SELAKOVIC_EXCLUSION_REASON.UNIT_RENAMED_OR_REMOVED);
  }
  const afterBody = functionBlockBody(afterFn);
  const beforeBody = functionBlockBody(unit.beforeFn);
  if (afterBody === null || beforeBody === null) {
    return buildExcludedChangedFnCandidate(SELAKOVIC_EXCLUSION_REASON.FN_NON_BLOCK_BODY);
  }
  const paramDiff = classifyParamDiff(unit.beforeFn, afterFn);
  if (paramDiff.kind === "structural-diff") {
    return buildExcludedChangedFnCandidate(SELAKOVIC_EXCLUSION_REASON.FN_PARAM_NAMES_MISMATCH);
  }
  if (
    paramDiff.kind === "rename-only" &&
    hasBindingCollision(beforeBody.body as readonly Statement[], paramDiff.nameMap)
  ) {
    return buildExcludedChangedFnCandidate(SELAKOVIC_EXCLUSION_REASON.FN_PARAM_NAMES_MISMATCH);
  }
  const beforeBodyStatements: readonly Statement[] =
    paramDiff.kind === "rename-only"
      ? renameIdentifiersInStatements(beforeBody.body as readonly Statement[], paramDiff.nameMap)
      : (beforeBody.body as readonly Statement[]);

  const holedSrc = replaceFunctionBodyWithObserver(changedFileAfterSrc, {
    start: afterBody.start,
    end: afterBody.end,
  });
  const slow = statementsToCode(beforeBodyStatements);
  const fast = statementsToCode(afterBody.body as readonly Statement[]);

  return {
    setup: buildMapRequireSetup(otherAfterFiles, changedFileKey, holedSrc, entryKey),
    slow,
    fast,
    workload: buildServerObservedWorkload(testCaseSource),
    before_node_count: countNodes(beforeBody as unknown as Node),
    after_node_count: countNodes(afterBody as unknown as Node),
    enclosure_node_type: afterFn.type,
    candidate_meta: { adapter: "selakovic", target_side: TARGET_SIDE.LIB, is_workload_reachable: true },
  };
}

/** map キー (`lib/api/attributes.js`) を `require` spec から引くための拡張子なし形 (`./lib/api/attributes`)。 */
function entrySpec(entryKey: string): string {
  return `./${entryKey.replace(/\.js$/, "")}`;
}

/**
 * map-require ランタイム + lib ロードを行う setup を組む。
 * - `__FILES__`: 非穴あけ after ファイルの JSON map (source 文字列)。`new Function` で評価
 * - `__HOLED__[changedFileKey]`: 穴あけ対象を raw な関数リテラルで埋め込む ($BODY$ が raw コード位置に来る)
 * - 相対 require を map 上で解決 (`.js` / `/index.js` 補完)。未解決は graceful `{}` (= `./package` 等)、
 *   bare は ambient `require` (ADR-0016) に委譲
 * - entry を load して `globalThis.__SUT__` に公開
 */
function buildMapRequireSetup(
  otherAfterFiles: Record<string, string>,
  changedFileKey: string,
  holedSrc: string,
  entryKey: string,
): string {
  return [
    `globalThis.__FILES__ = ${JSON.stringify(otherAfterFiles)};`,
    "globalThis.__HOLED__ = {};",
    `globalThis.__HOLED__[${JSON.stringify(changedFileKey)}] = function (module, exports, require) {`,
    holedSrc,
    "};",
    "globalThis.__CACHE__ = {};",
    "globalThis.__norm__ = function (p) {",
    "  var parts = p.split('/'); var out = [];",
    "  for (var i = 0; i < parts.length; i++) { var s = parts[i];",
    "    if (s === '' || s === '.') continue; if (s === '..') { out.pop(); continue; } out.push(s); }",
    "  return out.join('/');",
    "};",
    "globalThis.__resolve__ = function (fromKey, spec) {",
    "  var base = fromKey.indexOf('/') >= 0 ? fromKey.slice(0, fromKey.lastIndexOf('/')) : '';",
    "  var p = __norm__(base + '/' + spec);",
    "  var cands = [p, p + '.js', p + '/index.js'];",
    "  for (var i = 0; i < cands.length; i++) { var c = cands[i];",
    "    if (Object.prototype.hasOwnProperty.call(__HOLED__, c) || Object.prototype.hasOwnProperty.call(__FILES__, c)) return c; }",
    "  return null;",
    "};",
    "globalThis.__mapRequire__ = function (fromKey) {",
    "  return function (spec) {",
    "    if (typeof spec !== 'string') return require(spec);",
    "    if (spec.indexOf('./') !== 0 && spec.indexOf('../') !== 0) return require(spec);",
    "    var key = __resolve__(fromKey, spec);",
    "    if (key === null) return {};",
    "    if (Object.prototype.hasOwnProperty.call(__CACHE__, key)) return __CACHE__[key].exports;",
    "    var mod = { exports: {} }; __CACHE__[key] = mod;",
    "    var fn = Object.prototype.hasOwnProperty.call(__HOLED__, key) ? __HOLED__[key] : new Function('module', 'exports', 'require', __FILES__[key]);",
    "    fn(mod, mod.exports, __mapRequire__(key));",
    "    return mod.exports;",
    "  };",
    "};",
    `globalThis.__SUT__ = __mapRequire__('')(${JSON.stringify(entrySpec(entryKey))});`,
  ].join("\n");
}

/**
 * test_case を CommonJS wrapper で評価し、相対 `require('./<lib>')` を `__SUT__` に差し替えて
 * init()/setupTest()/test() を実行する workload。完了値は 2 チャネル観測の JSON:
 *  - `r`: 変更関数の戻り値列 (`__OBS__`)
 *  - `s`: init() 戻り値の post-state を汎用 safe-walk した projection
 */
function buildServerObservedWorkload(testCaseSource: string): string {
  return [
    "(function () {",
    "__OBS__ = [];",
    // 汎用 safe-walk: 循環畳み込み / 深さ・ノード budget / 関数も own プロパティを持てば walk (cheerio 等の
    // 関数オブジェクト state を捕捉)。lib 非依存。戻り値は JSON 化可能な構造。
    "var __seen__ = new WeakSet(); var __cnt__ = { n: 0 };",
    "var __walk__ = function (v, depth) {",
    "  if (__cnt__.n++ > 100000) return '<<budget>>';",
    "  if (v === null) return null;",
    "  var t = typeof v;",
    "  if (t === 'number' || t === 'boolean' || t === 'string') return v;",
    "  if (t === 'undefined') return undefined;",
    "  var isFnWithProps = (t === 'function' && Object.keys(v).length > 0);",
    "  if (t !== 'object' && !isFnWithProps) return undefined;",
    "  if (__seen__.has(v)) return '<<circ>>';",
    "  if (depth > 12) return '<<depth>>';",
    "  __seen__.add(v);",
    "  if (Array.isArray(v)) { var arr = []; for (var i = 0; i < v.length; i++) arr.push(__walk__(v[i], depth + 1)); return arr; }",
    "  var out = {}; var ks = Object.keys(v);",
    "  for (var j = 0; j < ks.length; j++) { var w = __walk__(v[ks[j]], depth + 1); if (w !== undefined) out[ks[j]] = w; }",
    "  return out;",
    "};",
    "var __tc_module__ = { exports: {} };",
    "var __tc_require__ = function (spec) {",
    "  if (typeof spec === 'string' && (spec.indexOf('./') === 0 || spec.indexOf('../') === 0)) return globalThis.__SUT__;",
    "  return require(spec);",
    "};",
    "(function (module, exports, require) {",
    testCaseSource,
    "})(__tc_module__, __tc_module__.exports, __tc_require__);",
    "var __tc_exp__ = __tc_module__.exports;",
    "var __tc_i__ = (typeof __tc_exp__.init === 'function') ? __tc_exp__.init() : undefined;",
    "var __tc_s__ = (typeof __tc_exp__.setupTest === 'function') ? __tc_exp__.setupTest(__tc_i__) : undefined;",
    "if (typeof __tc_exp__.test === 'function') __tc_exp__.test(__tc_i__, __tc_s__);",
    // 観測が空 (変更関数が一度も呼ばれず戻り値ゼロ、かつ post-state も空) なら undefined を返す。
    // → return_value oracle が両側 return_is_undefined で N/A → positive evidence 無し → inconclusive (ADR-0018)。
    // 「同じ空を観測した = equal」という false-equal を防ぐ。
    "var __s__ = __walk__(__tc_i__, 0);",
    "var __sEmpty__ = (__s__ === undefined || __s__ === null || (typeof __s__ === 'object' && Object.keys(__s__).length === 0));",
    "if (__OBS__.length === 0 && __sEmpty__) return undefined;",
    "return JSON.stringify({ r: __OBS__, s: __s__ });",
    "})()",
  ].join("\n");
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  const { findChangeUnits } = await import("../../../common/change-units");
  const { parse } = await import("../../../../ast/parser");
  const { substituteBody, declareObservationGlobal } = await import("../../../../codegen/placeholder");
  // 観点: single-file / multi-file CommonJS lib の変更関数を map-require + 2 チャネル観測 workload で 4 値契約に組む。
  // setup = map-require ランタイム ($BODY$ 1 個 + 観測ハーネス入り穴あきファイル + __SUT__ ロード)。
  // slow/fast = 変更前/後 body 裸断片。workload = test_case を __SUT__ に繋ぎ post-state(s) + 戻り値(r) を返す。
  // rename/削除・param 本質変更は excluded marker。

  const libBefore = `var lib = module.exports;\nlib.run = function () { return wrap(function self() { return 1; }); };`;
  const libAfter = `var lib = module.exports;\nlib.run = function () { return wrap(function self() { return 2; }); };`;
  const testCase = `exports.test = function () { return require('./lib_after.js').run(); };`;

  const fnUnitFor = (before: string, after: string, name: string): FnChangeUnit => {
    const cu = findChangeUnits(before, after);
    const u = cu.units.find((x): x is FnChangeUnit => x.kind === "fn" && x.name === name);
    if (!u) throw new Error(`no fn unit named ${name}`);
    return u;
  };

  describe("buildServerChangedFnCandidate (in-source)", () => {
    it("single-file: map-require setup ($BODY$ 1 個 + __SUT__) / 裸 body slow·fast / 2 チャネル観測 workload", () => {
      const unit = fnUnitFor(libBefore, libAfter, "self");
      const c = buildServerChangedFnCandidate({
        unit,
        changedFileKey: "lib.js",
        changedFileAfterSrc: libAfter,
        otherAfterFiles: {},
        entryKey: "lib.js",
        testCaseSource: testCase,
      });

      expect(c.candidate_excluded).toBeUndefined();
      expect(c.candidate_meta.target_side).toBe(TARGET_SIDE.LIB);
      expect(c.candidate_meta.is_workload_reachable).toBe(true);
      expect(c.enclosure_node_type).toBe("FunctionExpression");

      // setup: map-require + 穴あきファイル ($BODY$ 1 個 + 観測ハーネス) + entry ロード
      expect(c.setup).toContain('globalThis.__HOLED__["lib.js"] = function (module, exports, require) {');
      expect(c.setup).toContain('globalThis.__SUT__ = __mapRequire__(\'\')("./lib");');
      expect((c.setup!.match(/\$BODY\$/g) ?? []).length).toBe(1);
      expect(c.setup).toContain("let __OBS_R__");

      // slow/fast: 裸 body
      expect(c.slow).toContain("return 1;");
      expect(c.slow).not.toContain("__OBS_R__");
      expect(c.fast).toContain("return 2;");

      // workload: __SUT__ 差し替え + 2 チャネル (r/s) + safe-walk
      expect(c.workload).toContain("return globalThis.__SUT__;");
      expect(c.workload).toContain("exports.test = function () { return require('./lib_after.js').run(); };");
      // 2 チャネル観測 + 空観測ガード (r も s も空なら undefined → return_value N/A → inconclusive)
      expect(c.workload).toContain("if (__OBS__.length === 0 && __sEmpty__) return undefined;");
      expect(c.workload).toContain("return JSON.stringify({ r: __OBS__, s: __s__ });");

      // sandbox 投入直前形が valid JS
      expect(() => parse(declareObservationGlobal(substituteBody(c.setup!, c.slow!)))).not.toThrow();
      expect(() => parse(`var _ = ${c.workload!};`)).not.toThrow();
    });

    it("multi-file: 変更ファイルは __HOLED__、他ファイルは __FILES__ JSON map、entry を別指定", () => {
      const unit = fnUnitFor(libBefore, libAfter, "self");
      const c = buildServerChangedFnCandidate({
        unit,
        changedFileKey: "lib/impl.js",
        changedFileAfterSrc: libAfter,
        otherAfterFiles: { "index.js": "module.exports = require('./lib/impl');" },
        entryKey: "index.js",
        testCaseSource: testCase,
      });
      expect(c.candidate_excluded).toBeUndefined();
      expect(c.setup).toContain('globalThis.__HOLED__["lib/impl.js"]');
      expect(c.setup).toContain('"index.js":"module.exports = require(\'./lib/impl\');"');
      expect(c.setup).toContain('globalThis.__SUT__ = __mapRequire__(\'\')("./index");');
      expect((c.setup!.match(/\$BODY\$/g) ?? []).length).toBe(1);
    });

    it("afterFn === null (rename / 削除) → UNIT_RENAMED_OR_REMOVED marker", () => {
      const base = fnUnitFor(libBefore, libAfter, "self");
      const renamed: FnChangeUnit = { ...base, afterFn: null, afterFnAncestors: [] };
      const c = buildServerChangedFnCandidate({
        unit: renamed,
        changedFileKey: "lib.js",
        changedFileAfterSrc: libAfter,
        otherAfterFiles: {},
        entryKey: "lib.js",
        testCaseSource: testCase,
      });
      expect(c.candidate_excluded).toBe(SELAKOVIC_EXCLUSION_REASON.UNIT_RENAMED_OR_REMOVED);
      expect(c.setup).toBeUndefined();
    });

    it("param 個数差 (本質変更) → FN_PARAM_NAMES_MISMATCH marker", () => {
      const before = `var lib = module.exports;\nlib.run = function () { return wrap(function self(x) { return x + 1; }); };`;
      const after = `var lib = module.exports;\nlib.run = function () { return wrap(function self(x, y) { return x + y; }); };`;
      const unit = fnUnitFor(before, after, "self");
      const c = buildServerChangedFnCandidate({
        unit,
        changedFileKey: "lib.js",
        changedFileAfterSrc: after,
        otherAfterFiles: {},
        entryKey: "lib.js",
        testCaseSource: testCase,
      });
      expect(c.candidate_excluded).toBe(SELAKOVIC_EXCLUSION_REASON.FN_PARAM_NAMES_MISMATCH);
      expect(c.setup).toBeUndefined();
    });
  });
}
