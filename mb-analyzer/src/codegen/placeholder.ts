/**
 * placeholder substitution model の組み立て部品 (= dataset 非依存の汎用ヘルパ)。
 *
 * 責務: 5 つの汎用 string transform を提供する。dataset 構造 (Selakovic 物理レイアウト) や
 * 対象言語ドメイン要件 (jsperf / Angular / Ember 等) には立ち入らない。それらは
 * 呼び出し側 (`preprocessing/selakovic/*`) で吸収する。
 *
 *  1. `declareObservationGlobal`: setup の最先頭に `let __OBS__ = [];` を prepend する
 *     (= 観測配列を宣言・初期化し、後続の `replaceFunctionBodyWithObserver` / `wrapObservedWorkload` から
 *     closure 経由で参照可能にする)
 *  2. `replaceFunctionBody`: 関数本体の AST span を `{ $BODY$ }` プレースホルダで置換した文字列を返す
 *  3. `replaceFunctionBodyWithObserver`: 関数本体の AST span を「観測ハーネス入り `{ $BODY$ }`」で
 *     置換した文字列を返す (= setup 側に観測 IIFE を inline 化、pruning が見る slow/fast から
 *     観測足場を除く目的、ADR-0023 D-δ)
 *  4. `wrapObservedWorkload`: workload (= 観測対象の呼び出し列) を、完了値として観測配列を返す形にラップ
 *  5. `substituteBody`: 2. / 3. の出力の `$BODY$` を裸 body 断片で差し替える
 *
 * 呼び出し側はこれらを組み合わせて 4 値契約 `{setup, workload, slow, fast}` を構築する。
 * 中身の構成 (= `setup = (let __OBS__ 宣言) + libs + preWorkload` 等) は ADR-0023 §4 値契約の具体形
 * + code-map §setup 構築規約。
 *
 * 命名規則 (architecture/mb-analyzer.md §Magic 識別子の命名規則):
 *  - 置換マーカー `$BODY$`: テキスト置換専用、`substituteBody` で sandbox 投入前に消える
 *  - sandbox 実行時の internal 変数 `__OBS__` (戻り値観測配列) / `__OBS_R__` (1 回の呼び出し戻り値の一時保持):
 *    両端 underscore で sandbox 専用と明示。`__OBS__` は setup 最先頭の `let __OBS__ = [];` で
 *    宣言され、`replaceFunctionBodyWithObserver` / `wrapObservedWorkload` は単独参照
 *    (= `globalThis.` プレフィックス不要)
 */

const PLACEHOLDER = "$BODY$";

/**
 * 観測ハーネス string (= setup 側の関数本体に inline 化される観測 IIFE)。内部に `$BODY$` を 1 個含み、
 * `replaceFunctionBodyWithObserver` が `replaceFunctionBody` の出力する `{ $BODY$ }` の内側に差し込む。
 *
 *  - 関数式 `(function () { $BODY$ }).call(this)` で囲い、戻り値を `__OBS_R__` に一時保持。これで:
 *    - `$BODY$` に差し込まれる裸 body の `return` 文がラッパの外側 (= 元の関数) に脱出しない
 *    - 関数式は新しいスコープを作るので、裸 body 内の `var` 宣言や `this` の扱いは元のセマンティクスを維持
 *    - 結果として元 body 内に同名 `__OBS_R__` の宣言が出現してもスコープが分離して衝突しない
 *  - 戻り値は `JSON.stringify` して `__OBS__` 配列の末尾に push。serialize 不能 (循環参照 / 環境固有オブジェクト等)
 *    は catch して `"<unserializable>"` を push (= 観測が落ちないことを保証)
 *  - 末尾の `return __OBS_R__;` は元の関数の正規 return として `__OBS_R__` を再 return
 *    (= 関数の戻り値セマンティクスを維持)
 *  - `__OBS__` は `declareObservationGlobal` で setup 最先頭に宣言済の前提
 */
const OBSERVER_HARNESS = [
  `let __OBS_R__ = (function () { ${PLACEHOLDER} }).call(this);`,
  `__OBS__.push((function () { try { return JSON.stringify(__OBS_R__); } catch (e) { return "<unserializable>"; } })());`,
  `return __OBS_R__;`,
].join("\n");

/**
 * `setup` の最先頭に `let __OBS__ = [];` を prepend して返す。
 *
 * 観測配列を sandbox top-level の lexical binding として宣言・初期化する役割。これによって:
 *  - `replaceFunctionBodyWithObserver` / `wrapObservedWorkload` が出力する `__OBS__` 参照は closure 経由で全関数から見える
 *  - 初期値 `[]` があるので、bootstrap-invocation で `__OBS__.push(...)` が走っても TypeError にならない
 *  - top-level `let` の特性で `globalThis.__OBS__` 経由のアクセスは不可 (= scope を跨いだ誤参照を仕様レベルで防止)
 *
 * 注意: 本関数の出力は **setup の最先頭** に置かれる前提。dep prelude (jquery 等を `<script src>` から
 * 取り込んだソース) を別途 setup に連結する場合も、`let __OBS__` 宣言が dep prelude より前に来るよう
 * 呼び出し側で順序保証する。
 */
export function declareObservationGlobal(setup: string): string {
  return `let __OBS__ = [];\n;\n${setup}`;
}

/**
 * `source` のうち、指定された関数本体の AST span (`fnBodySpan.start..fnBodySpan.end`、`{` から `}` までを含む)
 * を `{ $BODY$ }` で置換した文字列を返す。
 *
 * `$BODY$` プレースホルダのままでは構文として valid でないので、呼び出し側は `substituteBody` で差し込んで
 * から `source` を実行コンテキストに投入する。
 */
export function replaceFunctionBody(
  source: string,
  fnBodySpan: { start: number; end: number },
): string {
  return source.slice(0, fnBodySpan.start) + `{ ${PLACEHOLDER} }` + source.slice(fnBodySpan.end);
}

/**
 * `source` のうち、指定された関数本体の AST span を「観測ハーネス入り `{ $BODY$ }`」で置換した文字列を返す
 * (ADR-0023 D-δ §observation 仕様)。
 *
 *  - 観測ハーネス (`OBSERVER_HARNESS`) は `let __OBS_R__ = (function () { $BODY$ }).call(this); __OBS__.push(...); return __OBS_R__;` の形
 *    で、観測 IIFE を **setup 側の関数本体に inline 化** する。これにより slow/fast には観測足場が乗らず、
 *    裸 body (= statementsToCode の出力) のまま `substituteBody` で `$BODY$` に差し込まれる。
 *  - 結果として pruning が見る slow/fast から観測 IIFE が消え、抽出 pattern が「変更関数の等価性の核」だけになる。
 *
 * 実装: `replaceFunctionBody` と同じ span slicing で観測ハーネスを直接埋め込む
 * (= `source.slice(0, start) + "{ <observer> }" + source.slice(end)`)。span 外には触らないので:
 *  - 通常ケース (source に `$BODY$` リテラル無し): 戻り値は `$BODY$` を **厳密に 1 個** 含む (= 観測 IIFE 内側のみ)。
 *    `substituteBody` の 1 個契約と整合
 *  - 異常ケース (source のコメント / 文字列リテラルに `$BODY$` が紛れている): 戻り値の `$BODY$` 個数は 2 個以上に
 *    なり、`substituteBody` が `count !== 1` で **fail-loud に throw**。silent な誤 substitution は起きない
 *
 * 旧実装 (`replaceFunctionBody` 出力に対する `.replace(PLACEHOLDER, ...)` の first match) では、source 側に
 * 既存の `$BODY$` があると観測ハーネスが誤った位置に挿入されつつ `substituteBody` の count check を通過する
 * silent bug の余地があった。span slicing への変更でこのリスクを除去 (Copilot review 指摘、2026-05-18)。
 *
 * 戻り値のままでは構文として valid でないので、呼び出し側は `substituteBody` で裸 body を差し込んでから
 * `declareObservationGlobal` で `__OBS__` 宣言を prepend し、実行コンテキストに投入する。
 */
export function replaceFunctionBodyWithObserver(
  source: string,
  fnBodySpan: { start: number; end: number },
): string {
  return source.slice(0, fnBodySpan.start) + `{ ${OBSERVER_HARNESS} }` + source.slice(fnBodySpan.end);
}

/**
 * `bodyWithBraces` (= `{ ... }` を含む関数本体の原文) を、元の中身を保持したまま観測ラッパで包んだ
 * 文字列を返す (changed-stmt 経路用、no-fn-unit rescue)。
 *
 * `replaceFunctionBodyWithObserver` との違い:
 *  - あちら: 関数本体を「観測ハーネス入り `{ $BODY$ }`」で置換 = **元 body を捨てて** `$BODY$` を残し、
 *    `substituteBody` で slow/fast の body 断片を差し込む (= changed-fn: 変更関数の本体が比較対象)
 *  - こちら: 元 body を **保持したまま** 観測 IIFE の内側に inline する (= `$BODY$` を残さない)。
 *    changed-stmt は変更箇所が関数の外 (stmt) にあり、reachable な named fn は「観測のためだけに計装する
 *    (本体は変えない)」ので、`$BODY$` 穴は changed stmt 側に 1 個だけ残し、fn 群は本体保持で観測化する。
 *
 * `OBSERVER_HARNESS` を `substituteBody` で再利用するので観測ハーネスの形は changed-fn と完全一致。
 */
export function wrapBodyWithObserver(bodyWithBraces: string): string {
  const inner = bodyWithBraces.trim().replace(/^\{/, "").replace(/\}$/, "");
  return `{ ${substituteBody(OBSERVER_HARNESS, inner)} }`;
}

/** `source` の指定 span を `replacement` で置換する 1 件の編集。`start`/`end` は AST span (UTF-16 offset)。 */
export interface SpanEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

/**
 * `source` に複数の span 編集をまとめて適用する。span は **互いに重ならない** 前提
 * (overlap があれば呼び出し側で除外する)。position 降順で適用するので、各 replacement の長さが元 span と
 * 違っても残りの編集位置 (= より前方の span) は元 offset のまま有効。
 */
export function applySpanEdits(source: string, edits: readonly SpanEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let result = source;
  for (const e of sorted) {
    result = result.slice(0, e.start) + e.replacement + result.slice(e.end);
  }
  return result;
}

/**
 * workload (= 観測対象の関数を呼び出す statement 列) を、完了値として観測配列 `__OBS__` の serialize 結果を返す
 * 関数式呼び出しでラップする。
 *
 *  - 関数式 `(function () { ...; return ...; })()` の完了値が sandbox 実行の戻り値として観測できる
 *  - 先頭で `__OBS__ = []` を **無条件** で実行: setup 段階や workload 開始までに push された値はここで破棄される。
 *    これにより `workloadBodyCode` 内の呼び出しによる観測値だけが完了値に乗る
 *    (`__OBS__` は `declareObservationGlobal` で既に宣言済の前提なので、ここは既存変数への代入 = `var` 不要)
 *  - 末尾で `JSON.stringify(__OBS__)` を返す
 *
 * 「setup 段階の観測値も活かす」設計に切り替えたい場合は、ここの reset を条件化する (ADR-0023 §設計のポイント参照)。
 */
export function wrapObservedWorkload(workloadBodyCode: string): string {
  return [
    "(function () {",
    "  __OBS__ = [];",
    workloadBodyCode,
    "  return JSON.stringify(__OBS__);",
    "})()",
  ].join("\n");
}

/**
 * `setup` 内の `$BODY$` プレースホルダを `body` 文字列で差し替える。
 *
 * `String.prototype.replace` の特殊置換シーケンス (`$&` / `$1` 等) を回避するため関数置換 (`() => body`) を使う。
 *
 * **前提: setup に `$BODY$` は厳密に 1 個**。0 個 / 2 個以上は呼び出し側の組み立てミスとして throw し、
 * silent な部分置換 / 未置換を防ぐ。複数 placeholder を扱う拡張が必要なら本関数を
 * `substituteBodies(setup, bodies: string[])` 等に拡張して個数固定の検査を維持する。
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
  const { parse } = await import("../ast/parser");

  describe("declareObservationGlobal (in-source)", () => {
    it("setup の最先頭に let __OBS__ = []; を prepend する", () => {
      const out = declareObservationGlobal("var x = 1;");
      expect(out).toMatch(/^let __OBS__ = \[\];/);
      expect(out).toContain("var x = 1;");
    });
    it("空 setup でも宣言行は付く", () => {
      expect(declareObservationGlobal("")).toMatch(/^let __OBS__ = \[\];/);
    });
    it("生成結果が valid な JS として parse できる", () => {
      const out = declareObservationGlobal("var x = 1;\nfunction f() { return x; }");
      expect(() => parse(out)).not.toThrow();
    });
  });

  describe("replaceFunctionBody (in-source)", () => {
    it("指定された関数本体の AST span を { $BODY$ } で置換する", () => {
      const src = "var g = function (x) { return x + 1; };";
      const ast = parse(src);
      const stmts = (ast as unknown as { program: { body: Array<{ declarations?: Array<{ init?: { body?: { type?: string; start: number; end: number } } }> }> } }).program.body;
      const init = stmts[0]?.declarations?.[0]?.init;
      if (!init?.body || init.body.type !== "BlockStatement") throw new Error("body not found");
      const placeholdered = replaceFunctionBody(src, { start: init.body.start, end: init.body.end });
      expect(placeholdered).toContain("{ $BODY$ }");
      expect(placeholdered).not.toContain("return x + 1");
    });
  });

  describe("replaceFunctionBodyWithObserver (in-source)", () => {
    const fnBodySpanOf = (src: string): { start: number; end: number } => {
      const ast = parse(src);
      const stmts = (ast as unknown as { program: { body: Array<{ declarations?: Array<{ init?: { body?: { type?: string; start: number; end: number } } }> }> } }).program.body;
      const init = stmts[0]?.declarations?.[0]?.init;
      if (!init?.body || init.body.type !== "BlockStatement") throw new Error("body not found");
      return { start: init.body.start, end: init.body.end };
    };

    it("観測ハーネスを関数本体内に inline 化、$BODY$ は厳密 1 個残る (substituteBody の 1 個契約と整合)", () => {
      const src = "var g = function (x) { return x + 1; };";
      const out = replaceFunctionBodyWithObserver(src, fnBodySpanOf(src));
      // 観測ハーネス 3 行が含まれる
      expect(out).toContain("let __OBS_R__ = (function () {");
      expect(out).toContain("}).call(this);");
      expect(out).toContain("__OBS__.push");
      expect(out).toContain("return __OBS_R__;");
      // 単独参照 (globalThis. プレフィックス無し)
      expect(out).not.toContain("globalThis.__OBS");
      // $BODY$ は厳密 1 個 (= 観測 IIFE 内側のみ、外側は埋まる)
      expect(out.split("$BODY$").length - 1).toBe(1);
      // 元の body (return x + 1) は span 内に閉じていたので消える
      expect(out).not.toContain("return x + 1");
      // 関数の宣言行 (= span 外) は残る
      expect(out).toContain("var g = function (x)");
    });

    it("$BODY$ を substituteBody で裸 body に差し替え + declareObservationGlobal で prepend すると valid JS", () => {
      const src = "var g = function (x) { return x + 1; };";
      const holed = replaceFunctionBodyWithObserver(src, fnBodySpanOf(src));
      // 裸 body を差し込んで `let __OBS__ = [];` を prepend すると top-level program として parse できる
      const substituted = substituteBody(holed, "return x * 2;");
      expect(substituted).not.toContain("$BODY$");
      expect(substituted).toContain("return x * 2;");
      expect(() => parse(declareObservationGlobal(substituted))).not.toThrow();
    });

    it("差し込まれた body 内の return は観測 IIFE で吸収される (= 外側関数には __OBS_R__ の return が走る)", () => {
      const src = "var g = function (x) { return x + 1; };";
      const holed = replaceFunctionBodyWithObserver(src, fnBodySpanOf(src));
      const substituted = substituteBody(holed, "return 99;");
      // 元の body の `return 99;` が IIFE 内側に位置 (= IIFE の完了値として __OBS_R__ に保持される)
      // IIFE の外側 (= 元の関数本体) では `return __OBS_R__;` が末尾の return として走る
      // → string レベルでは `return 99;` も `return __OBS_R__;` も両方含まれる
      expect(substituted).toContain("return 99;");
      expect(substituted).toContain("return __OBS_R__;");
      // 構文として valid
      expect(() => parse(declareObservationGlobal(substituted))).not.toThrow();
    });

    it("source 側のコメント/文字列に $BODY$ が紛れていても fail-loud (substituteBody が throw) で silent bug を防ぐ", () => {
      // source 内に `$BODY$` リテラルがコメントで混入しているケース。span 外なので置換されない。
      const src = `/* $BODY$ marker comment */ var g = function (x) { return x + 1; };`;
      const out = replaceFunctionBodyWithObserver(src, fnBodySpanOf(src));
      // $BODY$ は 2 個 (= コメント内 + 観測 IIFE 内側)
      expect(out.split("$BODY$").length - 1).toBe(2);
      // コメントは残る (= span 外には触らない)
      expect(out).toContain("/* $BODY$ marker comment */");
      // substituteBody は count !== 1 で fail-loud に throw (= silent な誤 substitution を防ぐ)
      expect(() => substituteBody(out, "return 0;")).toThrow(/exactly 1 \$BODY\$/);
    });
  });

  describe("wrapObservedWorkload (in-source)", () => {
    it("__OBS__ init → workload → 完了値で JSON.stringify を返す形", () => {
      const wrapped = wrapObservedWorkload("api.f(1); api.f(2);");
      expect(wrapped).toMatch(/^\(function \(\) \{/);
      expect(wrapped).toContain("__OBS__ = [];");
      expect(wrapped).toContain("return JSON.stringify(__OBS__);");
      expect(wrapped).not.toContain("globalThis."); // 単独参照
      expect(wrapped).toMatch(/\}\)\(\)$/);
      expect(() => parse(wrapped)).not.toThrow();
    });
    it("declareObservationGlobal と組み合わせて top-level program として parse できる", () => {
      const setup = declareObservationGlobal("");
      const workload = wrapObservedWorkload("");
      expect(() => parse(`${setup}\n;\n${workload}`)).not.toThrow();
    });
  });

  describe("substituteBody (in-source)", () => {
    it("$BODY$ プレースホルダを body 文字列で差し替える", () => {
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
    it("setup に $BODY$ が 2 個以上なら throw (個数固定の構造強制)", () => {
      expect(() => substituteBody("var f = $BODY$; var g = $BODY$;", "x")).toThrow(/exactly 1 \$BODY\$/);
    });
  });

  describe("wrapBodyWithObserver (in-source)", () => {
    it("元 body を保持したまま観測ラッパで包む ($BODY$ は残らない)", () => {
      const out = wrapBodyWithObserver("{ return x + 1; }");
      // 元 body が内側に inline されている
      expect(out).toContain("return x + 1;");
      // 観測ハーネス
      expect(out).toContain("let __OBS_R__ = (function () {");
      expect(out).toContain("__OBS__.push");
      expect(out).toContain("return __OBS_R__;");
      // $BODY$ プレースホルダは残らない (substituteBody で埋め済み)
      expect(out).not.toContain("$BODY$");
      // 関数本体として valid (function () <out> の形で parse できる)
      expect(() => parse(`var f = function () ${out};`)).not.toThrow();
    });

    it("差し込んだ body 内の return は観測 IIFE に吸収される (= 観測ラッパの return __OBS_R__ も併存)", () => {
      const out = wrapBodyWithObserver("{ return 42; }");
      expect(out).toContain("return 42;");
      expect(out).toContain("return __OBS_R__;");
      const declared = declareObservationGlobal(`var f = function () ${out};\nf();`);
      expect(() => parse(declared)).not.toThrow();
    });
  });

  describe("applySpanEdits (in-source)", () => {
    it("複数 span を position 降順で適用、各 replacement 長が違っても前方 offset は保持される", () => {
      const src = "AAAA BBBB CCCC";
      // A (0..4) → "x"、C (10..14) → "yyyyyy" (長さ違い)。B は不変。
      const out = applySpanEdits(src, [
        { start: 0, end: 4, replacement: "x" },
        { start: 10, end: 14, replacement: "yyyyyy" },
      ]);
      expect(out).toBe("x BBBB yyyyyy");
    });

    it("編集ゼロなら原文のまま", () => {
      expect(applySpanEdits("abc", [])).toBe("abc");
    });
  });
}
