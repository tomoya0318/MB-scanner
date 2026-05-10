import { readdirSync, readFileSync, statSync } from "fs";
import { basename, join, relative } from "path";

import type { DetectedLayout } from "./layout";

/**
 * issue ディレクトリの dir scan で見つかった `<lib>_before(.js|/)` / `<lib>_after(.js|/)` を
 * 読み出したペア (ADR-0011 §段1①)。
 *
 * client でも server でも同じ手で取れる (`detectLayout()` が `serverDirs` / `serverFiles` として
 * 既に検出している)。`<script src>` / `require` の参照とは独立 — client の inline `<script>` が
 * `<script src="angular_before.js">` を持たなくても `angular_before.js` は dir にある。
 *
 * `<lib>_*` が見つからない issue は `null` (= 後段は body diff だけで処理する)。
 *
 * ファイル I/O を含むので `preprocess()` には渡さず CLI から呼ぶ (`detectLayout` と同じ位置づけ —
 * selakovic で `fs` に触るのは `io/` 配下だけ)。
 */
export interface LibPair {
  readonly kind: "dir" | "file";
  /** lib dir 起点の relative path (dir 形式) または正規化ファイル名 (単一ファイル形式) → ソース */
  readonly beforeFiles: Record<string, string>;
  readonly afterFiles: Record<string, string>;
  /** 表示用ラベル (例 `chalk_before.js` / `mocha_before`)。 */
  readonly label: string;
}

export function loadLibPair(layout: DetectedLayout): LibPair | null {
  if (layout.serverDirs !== undefined) {
    return {
      kind: "dir",
      beforeFiles: loadLibFiles(layout.serverDirs.beforeDir),
      afterFiles: loadLibFiles(layout.serverDirs.afterDir),
      label: basename(layout.serverDirs.beforeDir),
    };
  }
  if (layout.serverFiles !== undefined) {
    return {
      kind: "file",
      beforeFiles: loadLibFiles(layout.serverFiles.beforeFile),
      afterFiles: loadLibFiles(layout.serverFiles.afterFile),
      label: basename(layout.serverFiles.beforeFile),
    };
  }
  return null;
}

/**
 * lib エントリ (ディレクトリ or 単一ファイル) から全 .js ファイルの内容を読み出す。
 *
 * - **ディレクトリ形式** (例: `chalk_before/index.js`, `mocha_before/lib/*.js`):
 *   配下を再帰的に walk し、relative path (lib dir 起点) → ソース文字列 のマップを返す
 * - **単一ファイル形式** (例: `underscore_before.js`):
 *   `_before` / `_after` を取り除いた **正規化ファイル名**をキーにする (例:
 *   `underscore_before.js` → `underscore.js`)。これで before/after の対応が取れる
 *
 * 同名 file が before/after 両方に存在しなければ AST diff の対象にできないので、
 * 呼び出し側 (`route/`/`build/`) で交差を取って処理する。
 */
function loadLibFiles(libPath: string): Record<string, string> {
  const stat = statSync(libPath);
  if (stat.isFile()) {
    return loadSingleFile(libPath);
  }
  if (stat.isDirectory()) {
    const files: Record<string, string> = {};
    walkJsFiles(libPath, libPath, files);
    return files;
  }
  return {};
}

function loadSingleFile(filePath: string): Record<string, string> {
  const fileName = basename(filePath); // "underscore_before.js"
  // _before.js / _after.js を取り除いて正規化キーにする
  const normalized = fileName.replace(/_(before|after)\.js$/, ".js");
  return { [normalized]: readFileSync(filePath, "utf-8") };
}

function walkJsFiles(rootDir: string, currentDir: string, out: Record<string, string>): void {
  const entries = readdirSync(currentDir);
  for (const entry of entries) {
    const fullPath = join(currentDir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      // node_modules / .git は除外
      if (entry === "node_modules" || entry === ".git") continue;
      walkJsFiles(rootDir, fullPath, out);
    } else if (stat.isFile() && entry.endsWith(".js")) {
      const rel = relative(rootDir, fullPath);
      out[rel] = readFileSync(fullPath, "utf-8");
    }
  }
}
