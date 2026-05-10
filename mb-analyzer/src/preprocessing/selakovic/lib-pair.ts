import { basename } from "path";

import type { DetectedLayout } from "./layout";
import { loadLibFiles } from "./server";

/**
 * issue ディレクトリの dir scan で見つかった `<lib>_before(.js|/)` / `<lib>_after(.js|/)` を
 * 読み出したペア (ADR-0011 §段1①)。
 *
 * client でも server でも同じ手で取れる (`detectLayout()` が `serverDirs` / `serverFiles` として
 * 既に検出している)。`<script src>` / `require` の参照とは独立 — client の inline `<script>` が
 * `<script src="angular_before.js">` を持たなくても `angular_before.js` は dir にある (Phase 1.0 で確認)。
 *
 * `<lib>_*` が見つからない issue は `null` (= 後段は body diff だけで処理する)。
 *
 * ファイル I/O を含むので `extract()` には渡さず CLI から呼ぶ (`loadLibFiles` / `detectLayout` と同じ位置づけ)。
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
