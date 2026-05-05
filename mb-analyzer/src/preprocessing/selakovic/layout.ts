import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

import type { LayoutKind } from "../../contracts/preprocessing-contracts";
import { LAYOUT_KIND } from "../../contracts/preprocessing-contracts";

/**
 * Selakovic データセットの 1 issue ディレクトリのレイアウトを判定する。
 *
 * 判定は **物理ファイル構造のみ** に基づく (ファイル名規則は使うが、内容の構造規則
 * `f1` / `init`/`setupTest`/`test` には依存しない):
 *
 * - `v_before.html` と `v_after.html` がある → `client` (HTML inline script を抽出対象)
 * - `<lib>_before/` ディレクトリがある → `server` (ディレクトリ内全 .js が対象)
 * - `<lib>_before.js` 単一ファイルがある → `server` (clientServerIssues 系の単一ファイル lib)
 * - どちらでもない → `unknown`
 *
 * **fallback 用の追加情報**: `v_*.html` と `<lib>_*.js` 単一ファイルが共存する場合
 * (= clientIssues / clientServerIssues の物理構造的混在) には、両方のパスを記録する。
 * 呼び出し側は client モードで `no-changed-nodes` が返れば server-single-file に
 * フォールバックできる。
 *
 * 注意: layout 規則は Selakovic データセットの物理レイアウトに依存する。論文 §6 の
 * 10 パターン分類や precondition 体系には依存しない。
 */

export interface DetectedLayout {
  readonly kind: LayoutKind;
  readonly clientFiles?: { beforeHtml: string; afterHtml: string };
  readonly serverDirs?: { beforeDir: string; afterDir: string };
  /**
   * server 系の単一ファイル形式 (例: clientServerIssues の `underscore_before.js`)。
   * `<lib>_before/` ディレクトリがない場合に検出される。
   */
  readonly serverFiles?: { beforeFile: string; afterFile: string };
}

export function detectLayout(issueDir: string): DetectedLayout {
  if (!existsSync(issueDir) || !statSync(issueDir).isDirectory()) {
    return { kind: LAYOUT_KIND.UNKNOWN };
  }

  const beforeHtml = join(issueDir, "v_before.html");
  const afterHtml = join(issueDir, "v_after.html");
  const hasHtml = existsSync(beforeHtml) && existsSync(afterHtml);

  // server-multi-file: <lib>_before/ ディレクトリ
  const beforeDir = findLibEntry(issueDir, "_before", "directory");
  const afterDir = findLibEntry(issueDir, "_after", "directory");
  if (beforeDir !== null && afterDir !== null) {
    // ディレクトリ形式が見つかれば優先 (Mocha / Chalk など serverIssues の典型)
    return {
      kind: LAYOUT_KIND.SERVER,
      serverDirs: { beforeDir, afterDir },
    };
  }

  // server-single-file: <lib>_before.js / <lib>_after.js
  const beforeFile = findLibEntry(issueDir, "_before.js", "file");
  const afterFile = findLibEntry(issueDir, "_after.js", "file");
  const hasServerSingleFile = beforeFile !== null && afterFile !== null;

  if (hasHtml) {
    // client モードを基本とし、server-single-file が共存すれば fallback 候補として記録。
    // 抽出器は client → fallback の順で試す (clientServerIssues の救済)。
    const layout: DetectedLayout = {
      kind: LAYOUT_KIND.CLIENT,
      clientFiles: { beforeHtml, afterHtml },
    };
    if (hasServerSingleFile && beforeFile !== null && afterFile !== null) {
      return { ...layout, serverFiles: { beforeFile, afterFile } };
    }
    return layout;
  }

  if (hasServerSingleFile && beforeFile !== null && afterFile !== null) {
    return {
      kind: LAYOUT_KIND.SERVER,
      serverFiles: { beforeFile, afterFile },
    };
  }

  return { kind: LAYOUT_KIND.UNKNOWN };
}

function findLibEntry(
  issueDir: string,
  suffix: string,
  expectedKind: "file" | "directory",
): string | null {
  const entries = readdirSync(issueDir);
  for (const entry of entries) {
    if (!entry.endsWith(suffix)) continue;
    const fullPath = join(issueDir, entry);
    const stat = statSync(fullPath);
    if (expectedKind === "directory" && !stat.isDirectory()) continue;
    if (expectedKind === "file" && !stat.isFile()) continue;
    return fullPath;
  }
  return null;
}
