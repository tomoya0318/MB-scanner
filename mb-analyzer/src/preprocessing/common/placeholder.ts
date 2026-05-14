/**
 * v2 = placeholder substitution 方式 (ADR-0023) の組み立て部品。
 *
 * 設計の核 (= 1 仕掛けに簡素化):
 *  - **setup** = lib (after) のうち変更関数の body `{ ... }` を `{ $BODY$ }` に置換した文字列 + preF1。
 *    bootstrap 中は `$BODY$` が構文として残ると parse error なので、executor 側で `slow` / `fast` の body
 *    文字列に **テキスト置換** してから既存 executor の (setup, body) 2 引数 API に渡す
 *    (= setup = substituteBody(originalSetup, slow/fast), body = workload)。これで既存の 2 回
 *    runInContext + snapshot 機構 (argument_mutation oracle 用) を再利用できる (= ADR-0023 §設計)。
 *  - **slow / fast body** = 変更関数の before / after 本体を「観測する形」(= `var __OBS_R__ = (function () { ... }).call(this);
 *    __OBS__.push(JSON.stringify(__OBS_R__)); return __OBS_R__;`) にラップした文字列 → `$BODY$` に差し込まれる。
 *  - **workload** = `(function () { __OBS__ = []; <f1 body>; return JSON.stringify(__OBS__); })()` の IIFE。
 *    完了値が `__OBS__` の serialize 結果になるので、`return_value` oracle が「変更関数を何回どんな値で呼んだか」を
 *    観測できる。bootstrap 中の呼び出しは workload IIFE 先頭で `__OBS__ = []` reset で捨てる (= 純粋な workload 観測)。
 *
 * v1 (`__HOLE__` 方式) との差 (= 3 仕掛け → 1 仕掛け):
 *  - lambda-lift 不要: `makeString` 等の lib 内部依存は lib IIFE の closure で自然に見える
 *  - `if (__HOLE__)` ガード不要: body は元の場所に書かれてるので bootstrap-invocation の経路を分けない
 *  - 観測 hook (access name 解決) 不要: body 内部で `__OBS__.push` を直接呼ぶので IIFE/AMD 内ローカル名でも観測できる
 *
 * 「観測 hook を外から立てる」案も検討したが (ADR-0023 §設計の最初のスケッチ)、`_s.startsWith` のような
 * lib IIFE 内ローカル名は bootstrap 後の global からは `_.str.startsWith` 等の別エイリアスでしかアクセスできず、
 * `<name> = function () {...}` 形の上書きが ReferenceError or 別オブジェクトへの代入になる。body 内側に観測を
 * 注入する方が汎用 (AMD/IIFE 内ローカルにも強い)。
 */

const PLACEHOLDER = "$BODY$";

/**
 * `libAfterSrc` の `afterFnBody.start..afterFnBody.end` (= `{ ... }`) を `{ $BODY$ }` に置換した文字列を返す。
 * placeholder のままだと parse error なので、executor に渡す前に `setup.replace(PLACEHOLDER, body)` で
 * body を差し込んでおく前提 (= `substituteBody`)。差し込んだ後の文字列を既存 executor の `setup` 引数に
 * 渡し、`body` 引数には `workload` を渡す。
 */
export function buildPlaceholderLib(
  libAfterSrc: string,
  afterFnBody: { start: number; end: number },
): string {
  return libAfterSrc.slice(0, afterFnBody.start) + `{ ${PLACEHOLDER} }` + libAfterSrc.slice(afterFnBody.end);
}

/**
 * 変更関数の body 文字列 (= statement 列のソース) を「観測する形」にラップして返す。`$BODY$` に差し込まれる
 * 文字列断片。`__OBS__` は `globalThis` 上の配列で、setup (= bootstrap-invocation 経由) と workload (= `wrapObservedWorkload`)
 * の双方から push されうる。
 *
 *  - IIFE `.call(this)` で囲って戻り値を `__OBS_R__` (= sandbox 専用 internal 変数、両端 underscore で命名規則統一)
 *    に保持 → `__OBS__.push` に JSON.stringify → 元の return 動作を維持
 *  - `var __OBS_R__` は本ラッパが差し込まれた関数 body 直下に置かれ、元 body 内の同名 `var` 宣言は IIFE 内側に閉じる
 *    (= JS の var hoisting で別スコープになる) ので衝突しない
 *  - serialize 不能 (循環参照 / DOM ノード等) は catch して `"<unserializable>"` を push
 *  - `__OBS__` の初期化は `|| []` で defensive (= bootstrap-invocation で workload IIFE より先に呼ばれた場合に
 *    `__OBS__` 未定義の状態を経由する。push された値は `wrapObservedWorkload` の reset で破棄される = 純粋な
 *    workload 観測だけが残る、§wrapObservedWorkload docstring 参照)
 */
export function wrapBodyObserved(bodyCode: string): string {
  return [
    `var __OBS_R__ = (function () {`,
    bodyCode,
    `}).call(this);`,
    `(globalThis.__OBS__ = globalThis.__OBS__ || []).push((function () { try { return JSON.stringify(__OBS_R__); } catch (e) { return "<unserializable>"; } })());`,
    `return __OBS_R__;`,
  ].join("\n");
}

/**
 * f1 body を `(function () { __OBS__ = []; <f1 body>; return JSON.stringify(__OBS__); })()` IIFE で包む。
 * 完了値が `__OBS__` の serialize 結果になる (= sandbox の `Script.runInContext` の戻り値として観測できる)。
 *
 * `__OBS__ = []` の **無条件 reset** で bootstrap-invocation 中の観測は **捨てる**、純粋な workload 観測だけを残す
 * 設計 (= `wrapBodyObserved` の defensive `|| []` 初期化との非対称はこの意図 = bootstrap で push されても workload
 * 開始時点でリセット)。将来「bootstrap 観測も活かす」案 (ADR-0023 §レビュー観点 1) に切り替える場合は、ここの reset を
 * 条件化する。
 */
export function wrapObservedWorkload(workloadBodyCode: string): string {
  return [
    "(function () {",
    "  globalThis.__OBS__ = [];",
    workloadBodyCode,
    "  return JSON.stringify(globalThis.__OBS__);",
    "})()",
  ].join("\n");
}

/**
 * `setup` (= `buildPlaceholderLib` の出力 + preF1) の `$BODY$` プレースホルダを body 文字列で差し替える。
 * `String.prototype.replace` は `$&` 等の特殊置換シーケンスを解釈するので、body 内の `$` が壊れないよう
 * 関数置換 (`() => body`) で 1 回だけ置換する。
 *
 * **前提: setup に `$BODY$` は厳密に 1 個だけある** (= `buildPlaceholderLib` は変更関数 body 1 つに対して 1 個埋め込む)。
 * 0 個 / 2 個以上は呼び出し側の組み立てミスなので throw して silent 不整合を防ぐ。将来複数 placeholder を扱う拡張が
 * 必要なら本関数を `substituteBodies(setup, bodies: string[])` に拡張する (= 個数固定の検査を維持しつつ複数化)。
 */
export function substituteBody(setup: string, body: string): string {
  const count = setup.split(PLACEHOLDER).length - 1;
  if (count !== 1) {
    throw new Error(`substituteBody: setup must contain exactly 1 ${PLACEHOLDER}, found ${count}`);
  }
  return setup.replace(PLACEHOLDER, () => body);
}

export const BODY_PLACEHOLDER = PLACEHOLDER;

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  const { parse } = await import("../../ast/parser");
  // 観点: placeholder lib の組み立て / body 観測ラップ / observed workload ラッパ / body 差し込み。
  // 設計の核 = executor の setup 引数 = substituteBody(originalSetup, wrapBodyObserved(originalBody))、
  // body 引数 = workload。既存 executor の 2 引数 API + snapshot 機構をそのまま使う。

  describe("buildPlaceholderLib (in-source)", () => {
    it("関数本体 { ... } を { $BODY$ } に置換", () => {
      const src = "var g = function (x) { return x + 1; };";
      const ast = parse(src);
      const stmts = (ast as unknown as { program: { body: Array<{ declarations?: Array<{ init?: { body?: { type?: string; start: number; end: number } } }> }> } }).program.body;
      const init = stmts[0]?.declarations?.[0]?.init;
      if (!init?.body || init.body.type !== "BlockStatement") throw new Error("body not found");
      const placeholdered = buildPlaceholderLib(src, { start: init.body.start, end: init.body.end });
      expect(placeholdered).toContain("{ $BODY$ }");
      expect(placeholdered).not.toContain("return x + 1");
    });
  });

  describe("wrapBodyObserved / wrapObservedWorkload (in-source)", () => {
    it("wrapBodyObserved: IIFE で囲って __OBS_R__ を __OBS__ に push、元の return を維持", () => {
      const wrapped = wrapBodyObserved("return x + 1;");
      expect(wrapped).toContain("var __OBS_R__ = (function () {");
      expect(wrapped).toContain("return x + 1;");
      expect(wrapped).toContain("}).call(this);");
      expect(wrapped).toContain("globalThis.__OBS__");
      expect(wrapped).toContain("return __OBS_R__;");
    });
    it("wrapBodyObserved: 元 body 内に同名 var __OBS_R__ があっても IIFE 内側スコープに閉じて衝突しない", () => {
      const wrapped = wrapBodyObserved("var __OBS_R__ = 99; return __OBS_R__;");
      // 元 body の var __OBS_R__ は IIFE 内側、外側の var __OBS_R__ は IIFE の戻り値を受ける別スコープ
      expect(() => parse(`function f() { ${wrapped} }`)).not.toThrow();
    });
    it("wrapBodyObserved: 関数本体に差し込んで parse できる構文を作る", () => {
      const wrapped = wrapBodyObserved("return x + 1;");
      expect(() => parse(`function f(x) { ${wrapped} }`)).not.toThrow();
    });
    it("wrapObservedWorkload: __OBS__ init → workload → return JSON.stringify を IIFE 化", () => {
      const wrapped = wrapObservedWorkload("api.f(1); api.f(2);");
      expect(wrapped).toMatch(/^\(function \(\) \{/);
      expect(wrapped).toContain("globalThis.__OBS__ = [];");
      expect(wrapped).toContain("return JSON.stringify(globalThis.__OBS__);");
      expect(wrapped).toMatch(/\}\)\(\)$/);
      expect(() => parse(wrapped)).not.toThrow();
    });
  });

  describe("substituteBody (in-source)", () => {
    it("$BODY$ プレースホルダを body 文字列で差し替え", () => {
      const setup = "var f = function (x) { $BODY$ };";
      expect(substituteBody(setup, "return x + 1;")).toBe("var f = function (x) { return x + 1; };");
    });
    it("body 内の $ や $& は壊れない (関数置換)", () => {
      const setup = "var s = $BODY$;";
      expect(substituteBody(setup, '"a$&b$1c"')).toBe('var s = "a$&b$1c";');
    });
    it("setup に $BODY$ が 0 個なら throw (silent 不整合の防止)", () => {
      expect(() => substituteBody("var f = 1;", "x")).toThrow(/exactly 1 \$BODY\$/);
    });
    it("setup に $BODY$ が 2 個以上なら throw (将来複数 placeholder 拡張時の構造強制)", () => {
      expect(() => substituteBody("var f = $BODY$; var g = $BODY$;", "x")).toThrow(/exactly 1 \$BODY\$/);
    });
  });
}
