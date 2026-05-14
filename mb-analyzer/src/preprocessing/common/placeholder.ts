/**
 * v2 = placeholder substitution 方式 (ADR-0023) の組み立て部品。
 *
 * 設計の核 (= 1 仕掛けに簡素化):
 *  - **setup** = lib (after) のうち変更関数の body `{ ... }` を `{ $BODY$ }` に置換した文字列 + preF1。
 *    bootstrap 中は `$BODY$` が構文として残ると parse error なので、executor 側で `slow` / `fast` の body
 *    文字列に **テキスト置換** してから既存 executor の (setup, body) 2 引数 API に渡す
 *    (= setup = substituteBody(originalSetup, slow/fast), body = workload)。これで既存の 2 回
 *    runInContext + snapshot 機構 (argument_mutation oracle 用) を再利用できる (= ADR-0023 §設計)。
 *  - **slow / fast body** = 変更関数の before / after 本体を「観測する形」(= `var __r = (function () { ... }).call(this);
 *    __OBS__.push(JSON.stringify(__r)); return __r;`) にラップした文字列 → `$BODY$` に差し込まれる。
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
 * 文字列断片。closure に `__OBS__`/`globalThis` が見える前提 (= workload IIFE 内 or setup 先頭で init)。
 *
 *  - IIFE `.call(this)` で囲って戻り値を `__r` に保持 → `__OBS__.push` に JSON.stringify → 元の return 動作を維持
 *  - serialize 不能 (循環参照 / DOM ノード等) は catch して `"<unserializable>"` を push
 */
export function wrapBodyObserved(bodyCode: string): string {
  return [
    `var __r = (function () {`,
    bodyCode,
    `}).call(this);`,
    `(globalThis.__OBS__ = globalThis.__OBS__ || []).push((function () { try { return JSON.stringify(__r); } catch (e) { return "<unserializable>"; } })());`,
    `return __r;`,
  ].join("\n");
}

/**
 * f1 body を `(function () { __OBS__ = []; <f1 body>; return JSON.stringify(__OBS__); })()` IIFE で包む。
 * 完了値が `__OBS__` の serialize 結果になる (= sandbox の `Script.runInContext` の戻り値として観測できる)。
 * `__OBS__ = []` の reset で bootstrap-invocation 中の観測は捨て、純粋な workload 観測だけを残す。
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
 */
export function substituteBody(setup: string, body: string): string {
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
    it("wrapBodyObserved: IIFE で囲って __r を __OBS__ に push、元の return を維持", () => {
      const wrapped = wrapBodyObserved("return x + 1;");
      expect(wrapped).toContain("var __r = (function () {");
      expect(wrapped).toContain("return x + 1;");
      expect(wrapped).toContain("}).call(this);");
      expect(wrapped).toContain("globalThis.__OBS__");
      expect(wrapped).toContain("return __r;");
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
  });
}
