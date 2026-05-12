import { existsSync, readFileSync } from "fs";
import { basename, dirname, join } from "path";

/**
 * client issue (`v_*.html`) の `<script src>` を分類し、CDN 依存ライブラリ (jquery / handlebars / underscore)
 * のソースを dataset fork の `node_modules/` から解決して返す (ADR-0016 の client 拡張 / 0022 Phase 3)。
 *
 * jsdom は `<script src>` を auto-load しないので、解決した dep の `.js` テキストを候補の `setup` に
 * 連結する方針 (plan §C1)。版番号は URL から読まず「issue から最寄りの `node_modules/<pkg>/...`」を採る
 * — これで Ember 4158 の jquery 1.7 override (issue 単位 `package.json`) が自然に効く。
 *
 * 分類:
 *  - **harness**: 計測ハーネス (`execute.js` / `jstat*` / `jsexecutor*` / `JSXTransformer.js`) → 不要 (preprocess が剥がす)
 *  - **patched-lib**: SUT (`<lib>_before.js` / `<lib>_after.js` = `lib_before_files` のキー、または `_before.js`/`_after.js` 接尾) → 不要 (preprocess が `lib_*_files` で扱う)
 *  - **cdn-dep**: jquery / handlebars / underscore の http(s) (or `//host/...`) URL → vendor 対象
 *  - **local-other**: 上記以外のローカル参照 → 解決できない (note して skip)
 */

export type ScriptSrcKind = "harness" | "patched-lib" | "cdn-dep" | "local-other";
export type DepPkg = "jquery" | "handlebars" | "underscore";

export interface ScriptSrcEntry {
  /** `src` 属性の生の値 (URL / 相対パス)。 */
  readonly src: string;
  readonly kind: ScriptSrcKind;
  /** `kind === "cdn-dep"` のとき: 解決対象の npm パッケージ名。 */
  readonly pkg?: DepPkg;
}

const SCRIPT_TAG_PATTERN = /<script\b([^>]*)>[\s\S]*?<\/script>/gi;
const SRC_ATTR_PATTERN = /\bsrc\s*=\s*["']([^"']+)["']/i;

const HARNESS_BASENAME = /^(execute|jsexecutor|jstat(\.min)?|JSXTransformer)\.js$/i;
const PATCHED_LIB_SUFFIX = /_before\.js$|_after\.js$/i;

/** basename → CDN dep の npm パッケージ名 (一致しなければ null)。 */
function depPkgFromBasename(base: string): DepPkg | null {
  if (/^jquery([.-]min)?\.js$/i.test(base)) return "jquery";
  if (/^handlebars(\.runtime)?([.-]min)?\.js$/i.test(base)) return "handlebars";
  if (/^underscore([.-]min)?\.js$/i.test(base)) return "underscore";
  return null;
}

function isAbsoluteUrl(src: string): boolean {
  return /^https?:\/\//i.test(src) || src.startsWith("//");
}

/**
 * HTML の `<script src>` を出現順に列挙して分類する (純関数)。`patchedLibFilenames` = `lib_before_files` /
 * `lib_after_files` のキー (例 `["jquery_before.js"]` / `["jquery_after.js"]`)。
 */
export function classifyScriptSrcs(html: string, patchedLibFilenames: readonly string[]): ScriptSrcEntry[] {
  const patched = new Set(patchedLibFilenames.map((f) => basename(f)));
  const entries: ScriptSrcEntry[] = [];
  let match: RegExpExecArray | null;
  SCRIPT_TAG_PATTERN.lastIndex = 0;
  while ((match = SCRIPT_TAG_PATTERN.exec(html)) !== null) {
    const attrs = match[1] ?? "";
    const src = SRC_ATTR_PATTERN.exec(attrs)?.[1];
    if (src === undefined) continue; // inline <script> (src なし) は対象外
    const base = basename(src.split("?")[0]!.split("#")[0]!);
    if (HARNESS_BASENAME.test(base)) {
      entries.push({ src, kind: "harness" });
      continue;
    }
    if (patched.has(base) || PATCHED_LIB_SUFFIX.test(base)) {
      entries.push({ src, kind: "patched-lib" });
      continue;
    }
    const pkg = depPkgFromBasename(base);
    if (pkg !== null && isAbsoluteUrl(src)) {
      entries.push({ src, kind: "cdn-dep", pkg });
      continue;
    }
    entries.push({ src, kind: "local-other" });
  }
  return entries;
}

/** パッケージ名 → `node_modules/<pkg>/` 内で `.js` 本体がありうる相対パス候補 (上から優先)。 */
const PKG_FILE_CANDIDATES: Record<DepPkg, readonly string[]> = {
  jquery: ["dist/jquery.min.js", "dist/jquery.js", "jquery.js", "jquery-min.js"],
  handlebars: ["dist/handlebars.min.js", "dist/handlebars.js", "lib/handlebars.js", "handlebars.js"],
  underscore: ["underscore-min.js", "underscore.js"],
};

/** `issueDir` から祖先方向に最大 `maxLevels` 階層さかのぼり、`<dir>/node_modules/<pkg>/<候補>` が最初に見つかったファイルのパスを返す。 */
function resolvePkgFile(issueDir: string, pkg: DepPkg, maxLevels = 8): string | null {
  let dir = issueDir;
  for (let i = 0; i <= maxLevels; i++) {
    for (const rel of PKG_FILE_CANDIDATES[pkg]) {
      const p = join(dir, "node_modules", pkg, rel);
      if (existsSync(p)) return p;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // ルートに到達
    dir = parent;
  }
  return null;
}

export interface ResolvedScriptDeps {
  /** `<script>` 出現順に並んだ dep ライブラリのソース文字列 (候補の `setup` に連結する)。 */
  readonly sources: readonly string[];
  /** 解決できなかった cdn-dep / local-other の `src` (診断用 — issue 単位の集計で見る)。 */
  readonly missing: readonly string[];
}

/**
 * `issueDir` の HTML から `<script src>` を分類し、cdn-dep を `node_modules/` から解決してソースを集める。
 * `<lib>_*.js` / harness は無視。解決できなかった cdn-dep は `missing` に積む (= `node_modules/` 未生成 or
 * 宣言漏れ — `install-vendor-deps.sh` の対象に追加が要る)。
 */
export function resolveScriptDepSources(
  issueDir: string,
  html: string,
  patchedLibFilenames: readonly string[],
): ResolvedScriptDeps {
  const sources: string[] = [];
  const missing: string[] = [];
  for (const entry of classifyScriptSrcs(html, patchedLibFilenames)) {
    if (entry.kind === "harness" || entry.kind === "patched-lib") continue;
    if (entry.kind === "local-other") {
      missing.push(entry.src);
      continue;
    }
    // cdn-dep
    const file = resolvePkgFile(issueDir, entry.pkg!);
    if (file === null) {
      missing.push(entry.src);
      continue;
    }
    sources.push(readFileSync(file, "utf-8"));
  }
  return { sources, missing };
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("fs");
  const { tmpdir } = await import("os");
  // 観点: <script src> を harness / patched-lib / cdn-dep (jquery/handlebars/underscore) / local-other に分類し、
  // cdn-dep を issue から最寄りの node_modules/<pkg>/... から解決する (issue 単位 override が category より優先)。

  describe("classifyScriptSrcs (in-source)", () => {
    it("execute.js / jstat / JSXTransformer は harness", () => {
      const html = `<script src="../../js/execute.js"></script><script src="//cdn.jsdelivr.net/jstat/1.2.1/jstat.min.js"></script><script src="JSXTransformer.js"></script>`;
      expect(classifyScriptSrcs(html, []).map((e) => e.kind)).toEqual(["harness", "harness", "harness"]);
    });
    it("<lib>_before.js / lib_before_files のキー は patched-lib", () => {
      const html = `<script src="jquery_before.js"></script><script src="ember_before.js"></script>`;
      expect(classifyScriptSrcs(html, ["jquery_before.js"]).map((e) => e.kind)).toEqual(["patched-lib", "patched-lib"]);
    });
    it("jquery / handlebars / underscore の CDN URL は cdn-dep (pkg 付き)", () => {
      const html = `
        <script src="https://ajax.googleapis.com/ajax/libs/jquery/2.1.3/jquery.min.js"></script>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/handlebars.js/1.1.0/handlebars.js"></script>
        <script src="//cdnjs.cloudflare.com/ajax/libs/underscore.js/1.8.3/underscore.js"></script>`;
      const c = classifyScriptSrcs(html, []);
      expect(c.map((e) => ({ kind: e.kind, pkg: e.pkg }))).toEqual([
        { kind: "cdn-dep", pkg: "jquery" },
        { kind: "cdn-dep", pkg: "handlebars" },
        { kind: "cdn-dep", pkg: "underscore" },
      ]);
    });
    it("出現順を保つ / inline <script> (src なし) は無視", () => {
      const html = `<script>var x=1;</script><script src="../../js/execute.js"></script><script src="https://ajax.googleapis.com/ajax/libs/jquery/1.7/jquery.min.js"></script>`;
      expect(classifyScriptSrcs(html, []).map((e) => e.kind)).toEqual(["harness", "cdn-dep"]);
    });
    it("それ以外のローカル src は local-other", () => {
      expect(classifyScriptSrcs(`<script src="./foo/bar.js"></script>`, []).map((e) => e.kind)).toEqual(["local-other"]);
    });
  });

  describe("resolveScriptDepSources (in-source, 一時 node_modules)", () => {
    it("issue 単位 node_modules が category 単位より優先される", () => {
      const root = mkdtempSync(join(tmpdir(), "selakovic-deps-"));
      // <root>/EmberIssues/node_modules/jquery/dist/jquery.min.js  (category)
      mkdirSync(join(root, "EmberIssues", "node_modules", "jquery", "dist"), { recursive: true });
      writeFileSync(join(root, "EmberIssues", "node_modules", "jquery", "dist", "jquery.min.js"), "/* jquery 2.1.3 (category) */");
      // <root>/EmberIssues/issues/issue_4158/node_modules/jquery/dist/jquery.js  (issue override)
      mkdirSync(join(root, "EmberIssues", "issues", "issue_4158", "node_modules", "jquery", "dist"), { recursive: true });
      writeFileSync(join(root, "EmberIssues", "issues", "issue_4158", "node_modules", "jquery", "dist", "jquery.js"), "/* jquery 1.7 (issue override) */");
      // <root>/EmberIssues/node_modules/handlebars/dist/handlebars.js
      mkdirSync(join(root, "EmberIssues", "node_modules", "handlebars", "dist"), { recursive: true });
      writeFileSync(join(root, "EmberIssues", "node_modules", "handlebars", "dist", "handlebars.js"), "/* handlebars 1.1.0 */");

      const issueDir = join(root, "EmberIssues", "issues", "issue_4158");
      const html = `
        <script src="https://ajax.googleapis.com/ajax/libs/jquery/2.1.3/jquery.min.js"></script>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/handlebars.js/1.1.0/handlebars.js"></script>
        <script src="ember_before.js"></script>
        <script src="../../js/execute.js"></script>`;
      const r = resolveScriptDepSources(issueDir, html, ["ember_before.js"]);
      expect(r.missing).toEqual([]);
      expect(r.sources).toHaveLength(2);
      expect(r.sources[0]).toContain("issue override"); // jquery: issue 単位が勝つ
      expect(r.sources[1]).toContain("handlebars 1.1.0"); // handlebars: category 単位
    });
    it("node_modules に無い cdn-dep は missing に積む", () => {
      const root = mkdtempSync(join(tmpdir(), "selakovic-deps-"));
      mkdirSync(join(root, "issue_x"), { recursive: true });
      const r = resolveScriptDepSources(join(root, "issue_x"), `<script src="https://ajax.googleapis.com/ajax/libs/jquery/2.1.3/jquery.min.js"></script>`, []);
      expect(r.sources).toEqual([]);
      expect(r.missing).toEqual(["https://ajax.googleapis.com/ajax/libs/jquery/2.1.3/jquery.min.js"]);
    });
  });
}
