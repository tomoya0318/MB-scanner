import { readdirSync, readFileSync, statSync } from "fs";
import { basename, join, relative } from "path";

/**
 * Selakovic server / clientServer issue の lib エントリ (ディレクトリ or 単一ファイル) から
 * 全 .js ファイルの内容を読み出す。
 *
 * - **ディレクトリ形式** (例: `chalk_before/index.js`, `mocha_before/lib/*.js`):
 *   配下を再帰的に walk し、relative path (lib dir 起点) → ソース文字列 のマップを返す
 * - **単一ファイル形式** (例: `underscore_before.js`):
 *   `_before` / `_after` を取り除いた **正規化ファイル名**をキーにする (例:
 *   `underscore_before.js` → `underscore.js`)。これで before/after の対応が取れる
 *
 * 同名 file が before/after 両方に存在しなければ AST diff の対象にできないので、
 * 呼び出し側 (`selakovic/index.ts`) で交差を取って処理する。
 */
export function loadLibFiles(libPath: string): Record<string, string> {
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
