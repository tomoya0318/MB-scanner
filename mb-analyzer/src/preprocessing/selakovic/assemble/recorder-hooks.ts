/**
 * 等価検証器が body 実行前に context に注入する記録 Proxy (`globalThis.__recorder` = makeRecorder()) を使うための
 * runnable 内 hook コード生成 (C6 = interaction-trace の取得側)。
 *
 * runnable は workload (`f1` / `test()`) が SUT を叩く*直前*に、`globalThis.__recorder` があれば境界オブジェクト
 * (server: `init`/`setupTest` 戻り値 / Angular: 注入 service / client lib-file: lib の window グローバル) を
 * `__recorder.wrap(obj, 'path', { recurse: true })` で包んでから呼ぶ。注入されなければ (= `globalThis.__recorder` 無し)
 * runnable は何もせず素通り → 従来挙動どおり。包んでも Proxy は透過なので観測値 (return / state / DOM) は不変。
 *
 * `RECORDER_GLOBAL` は `equivalence-checker/common/sandbox/capture/recording-proxy.ts` の同名定数と揃える
 * (preprocessing → equivalence-checker は ESLint 依存方向で import できないのでハードコード — 変更時は両方を直す)。
 */

const RECORDER_GLOBAL = "__recorder";
const RECORDER_GUARD = `typeof globalThis.${RECORDER_GLOBAL} === 'object' && globalThis.${RECORDER_GLOBAL}`;

/**
 * `pairs` = [変数名, trace path] の組を `if (記録 Proxy あり) { v = __recorder.wrap(v, 'path', {recurse:true}); }` で包む文を返す。
 * 変数は再代入されるので、その変数を closure に取り込んでいる workload は wrap 後の値を見る。pairs が空なら空文字。
 */
export function wrapBoundaryVarsStatement(pairs: ReadonlyArray<readonly [varName: string, path: string]>): string {
  if (pairs.length === 0) return "";
  const body = pairs
    .map(
      ([v, path]) =>
        `${v} = globalThis.${RECORDER_GLOBAL}.wrap(${v}, ${JSON.stringify(path)}, { recurse: true });`,
    )
    .join(" ");
  return `if (${RECORDER_GUARD}) { ${body} }`;
}

/** client lib-file 系で workload が直接叩きうる window グローバル候補 (保守的)。lib 名が不明なので存在するものだけ wrap する。 */
export const CLIENT_LIB_GLOBALS: readonly string[] = ["$", "jQuery", "_", "ejs", "Ember", "React", "angular", "Q"];

/**
 * `recurse: true` だと「メソッド戻り値 (= chain) を再帰 wrap → それが lib 内部に再投入されると version-sensitive な
 * 内部コードが Proxy で壊れる」ことがある。jQuery (`$`/`jQuery`) は `$(...).children().domManip(...)` の連鎖を
 * 内部で多用し、`recurse:true` の wrapped jQuery object を `domManip` が `.length`/`.name`/`getPrototypeOf` 経由で
 * 触って壊れる (jquery-200) ので、top-level の `$`/`jQuery` だけ wrap し chain は wrap しない (`recurse: false`)。
 * 他の lib は従来どおり `recurse: true`。
 */
const NON_RECURSIVE_LIB_GLOBALS: ReadonlySet<string> = new Set(["$", "jQuery"]);

/** `libSource` 実行後に置く: 存在する lib グローバルだけを `__recorder.wrap(...)` で包む文を返す。 */
export function wrapClientLibGlobalsStatement(): string {
  const body = CLIENT_LIB_GLOBALS.map((g) => {
    const recurse = NON_RECURSIVE_LIB_GLOBALS.has(g) ? "false" : "true";
    return `if (typeof ${g} !== 'undefined') ${g} = globalThis.${RECORDER_GLOBAL}.wrap(${g}, ${JSON.stringify(g)}, { recurse: ${recurse} });`;
  }).join(" ");
  return `if (${RECORDER_GUARD}) { ${body} }`;
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("recorder-hooks (in-source)", () => {
    it("wrapBoundaryVarsStatement: 各変数を __recorder.wrap で包む if 文を返す", () => {
      const s = wrapBoundaryVarsStatement([
        ["__selakovic_i", "init"],
        ["__selakovic_s", "setup"],
      ]);
      expect(s).toContain("typeof globalThis.__recorder === 'object'");
      expect(s).toContain('__selakovic_i = globalThis.__recorder.wrap(__selakovic_i, "init", { recurse: true });');
      expect(s).toContain('__selakovic_s = globalThis.__recorder.wrap(__selakovic_s, "setup", { recurse: true });');
    });

    it("wrapBoundaryVarsStatement: 空配列なら空文字", () => {
      expect(wrapBoundaryVarsStatement([])).toBe("");
    });

    it("wrapClientLibGlobalsStatement: 既知の lib グローバルを存在チェック付きで包む (jQuery は recurse: false)", () => {
      const s = wrapClientLibGlobalsStatement();
      // jQuery / $ は chain を wrap すると before 版が壊れるので recurse: false
      expect(s).toContain("if (typeof jQuery !== 'undefined') jQuery = globalThis.__recorder.wrap(jQuery, \"jQuery\", { recurse: false });");
      expect(s).toContain("if (typeof $ !== 'undefined') $ = globalThis.__recorder.wrap($, \"$\", { recurse: false });");
      // 他の lib は recurse: true のまま
      expect(s).toContain("if (typeof _ !== 'undefined') _ = globalThis.__recorder.wrap(_, \"_\", { recurse: true });");
      expect(s).toContain("if (typeof React !== 'undefined') React = globalThis.__recorder.wrap(React, \"React\", { recurse: true });");
      // 未注入時に runnable が壊れないよう、全体が 1 つの guard に包まれている
      expect(s.startsWith("if (typeof globalThis.__recorder === 'object'")).toBe(true);
    });
  });
}
