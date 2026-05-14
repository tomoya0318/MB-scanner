/**
 * placeholder substitution model の組み立て部品 (= dataset 非依存の汎用ヘルパ)。
 *
 * 責務: 5 つの汎用 string transform を提供する。dataset 構造 (Selakovic 物理レイアウト) や
 * 対象言語ドメイン要件 (jsperf / Angular / Ember 等) には立ち入らない。それらは
 * 呼び出し側 (`preprocessing/selakovic/*`) で吸収する。
 *
 *  1. `declareObservationGlobal`: setup の最先頭に `let __OBS__ = [];` を prepend する
 *     (= 観測配列を宣言・初期化し、後続の `wrapBodyObserved` / `wrapObservedWorkload` から
 *     closure 経由で参照可能にする)
 *  2. `replaceFunctionBody`: 関数本体の AST span を `{ $BODY$ }` プレースホルダで置換した文字列を返す
 *  3. `wrapBodyObserved`: 関数本体の statement 列を、戻り値を観測配列 `__OBS__` に push して返す形にラップ
 *  4. `wrapObservedWorkload`: workload (= 観測対象の呼び出し列) を、完了値として観測配列を返す形にラップ
 *  5. `substituteBody`: 2. の出力の `$BODY$` を 3. の出力で差し替える
 *
 * 呼び出し側はこれらを組み合わせて 4 値契約 `{setup, workload, slow, fast}` を構築する。
 * 中身の構成 (= `setup = (let __OBS__ 宣言) + libs + preWorkload` 等) は ADR-0023 §4 値契約の具体形
 * + code-map §setup 構築規約。
 *
 * 命名規則 (architecture/mb-analyzer.md §Magic 識別子の命名規則):
 *  - 置換マーカー `$BODY$`: テキスト置換専用、`substituteBody` で sandbox 投入前に消える
 *  - sandbox 実行時の internal 変数 `__OBS__` (戻り値観測配列) / `__OBS_R__` (1 回の呼び出し戻り値の一時保持):
 *    両端 underscore で sandbox 専用と明示。`__OBS__` は setup 最先頭の `let __OBS__ = [];` で
 *    宣言され、`wrapBodyObserved` / `wrapObservedWorkload` は単独参照 (= `globalThis.` プレフィックス不要)
 */

const PLACEHOLDER = "$BODY$";

/**
 * `setup` の最先頭に `let __OBS__ = [];` を prepend して返す。
 *
 * 観測配列を sandbox top-level の lexical binding として宣言・初期化する役割。これによって:
 *  - `wrapBodyObserved` / `wrapObservedWorkload` が出力する `__OBS__` 参照は closure 経由で全関数から見える
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
 * 関数本体の statement 列を「観測する形」(= 戻り値を観測配列 `__OBS__` に push して返す) にラップした文字列を返す。
 * `replaceFunctionBody` が用意した `$BODY$` プレースホルダに差し込まれる断片を生成する用途。
 *
 *  - 関数式 `(function () { <bodyCode> }).call(this)` で囲い、戻り値を `__OBS_R__` に一時保持。これで:
 *    - `bodyCode` 内の `return` 文がラッパの外側に脱出しない (= ラッパは元の関数の `return __OBS_R__;` で終わる)
 *    - 関数式は新しいスコープを作るので、`bodyCode` 内の `var` 宣言や `this` の扱いは元のセマンティクスを維持
 *    - 結果として元 `bodyCode` 内に同名 `__OBS_R__` の宣言が出現してもスコープが分離して衝突しない
 *  - 戻り値は `JSON.stringify` して `__OBS__` 配列の末尾に push。serialize 不能 (循環参照 / 環境固有オブジェクト等)
 *    は catch して `"<unserializable>"` を push (= 観測が落ちないことを保証)
 *  - `__OBS__` は `declareObservationGlobal` で setup 最先頭に宣言済の前提なので、本ラッパは直接 push する
 *    (= bootstrap-invocation で `wrapObservedWorkload` の reset より先に push されても、宣言時の初期値 `[]`
 *    があるので TypeError にならない。push された値は workload IIFE の reset で破棄される = 純粋な workload
 *    観測だけが残る、`wrapObservedWorkload` 参照)
 */
export function wrapBodyObserved(bodyCode: string): string {
  return [
    `let __OBS_R__ = (function () {`,
    bodyCode,
    `}).call(this);`,
    `__OBS__.push((function () { try { return JSON.stringify(__OBS_R__); } catch (e) { return "<unserializable>"; } })());`,
    `return __OBS_R__;`,
  ].join("\n");
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
  const { parse } = await import("../../ast/parser");

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

  describe("wrapBodyObserved / wrapObservedWorkload (in-source)", () => {
    it("wrapBodyObserved: 戻り値を __OBS__ に push、元の return を維持", () => {
      const wrapped = wrapBodyObserved("return x + 1;");
      expect(wrapped).toContain("let __OBS_R__ = (function () {");
      expect(wrapped).toContain("return x + 1;");
      expect(wrapped).toContain("}).call(this);");
      expect(wrapped).toContain("__OBS__.push");
      expect(wrapped).not.toContain("globalThis."); // 単独参照、globalThis. プレフィックスは付かない
      expect(wrapped).toContain("return __OBS_R__;");
    });
    it("wrapBodyObserved: 元 body 内に同名 __OBS_R__ 宣言があってもスコープ分離で衝突しない", () => {
      const wrapped = wrapBodyObserved("let __OBS_R__ = 99; return __OBS_R__;");
      expect(() => parse(`function f() { ${wrapped} }`)).not.toThrow();
    });
    it("wrapBodyObserved: 関数本体に差し込んで valid な構文を生む", () => {
      const wrapped = wrapBodyObserved("return x + 1;");
      expect(() => parse(`function f(x) { ${wrapped} }`)).not.toThrow();
    });
    it("wrapObservedWorkload: __OBS__ init → workload → 完了値で JSON.stringify を返す形", () => {
      const wrapped = wrapObservedWorkload("api.f(1); api.f(2);");
      expect(wrapped).toMatch(/^\(function \(\) \{/);
      expect(wrapped).toContain("__OBS__ = [];");
      expect(wrapped).toContain("return JSON.stringify(__OBS__);");
      expect(wrapped).not.toContain("globalThis."); // 単独参照
      expect(wrapped).toMatch(/\}\)\(\)$/);
      expect(() => parse(wrapped)).not.toThrow();
    });
    it("wrapObservedWorkload: declareObservationGlobal と組み合わせて top-level program として parse できる", () => {
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
}
