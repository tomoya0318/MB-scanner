import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { LayoutKind } from "../../../contracts/preprocessing-contracts";
import { LAYOUT_KIND } from "../../../contracts/preprocessing-contracts";

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

/**
 * `test_case_before(.js)` / `test_case_after(.js)` は Selakovic dataset の *workload* ファイル
 * (server の `init`/`setupTest`/`test`) であって lib ではない。`clientServerIssues` の多くは
 * `<lib>_before.js` と `test_case_before.js` を同居させており、readdir 順次第で `test_case_*` を
 * 「lib ファイル」と誤検出しうる (例: `underscore_before.js` は `t` より後ろ → `test_case_before.js`
 * が先にヒットして libSource = test_case になり、`exports is not defined` で即死していた)。
 * lib 候補からは常に除外し、検出順を安定させるため readdir をソートする。
 */
const LIB_ENTRY_EXCLUDE = /^test_case_/;

function findLibEntry(
  issueDir: string,
  suffix: string,
  expectedKind: "file" | "directory",
): string | null {
  const entries = readdirSync(issueDir).sort();
  for (const entry of entries) {
    if (!entry.endsWith(suffix)) continue;
    if (LIB_ENTRY_EXCLUDE.test(entry)) continue;
    const fullPath = join(issueDir, entry);
    const stat = statSync(fullPath);
    if (expectedKind === "directory" && !stat.isDirectory()) continue;
    if (expectedKind === "file" && !stat.isFile()) continue;
    return fullPath;
  }
  return null;
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect, afterEach } = import.meta.vitest;

  describe("detectLayout — clientServerIssues の lib ファイル選定 (in-source)", () => {
    const tmpDirs: string[] = [];
    afterEach(() => {
      for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });
    const mkIssue = (files: string[]): string => {
      const d = mkdtempSync(join(tmpdir(), "layout-test-"));
      tmpDirs.push(d);
      for (const f of files) {
        const p = join(d, f);
        mkdirSync(join(p, ".."), { recursive: true });
        writeFileSync(p, "// stub\n");
      }
      return d;
    };

    it("v_*.html + <lib>_*.js + test_case_*.js が同居しても、lib は <lib>_*.js を選ぶ (test_case_* を除外)", () => {
      // `underscore_before.js` はアルファベット順で `test_case_before.js` より後ろ → 旧実装は test_case を誤検出していた
      const d = mkIssue(["v_before.html", "v_after.html", "underscore_before.js", "underscore_after.js", "test_case_before.js", "test_case_after.js"]);
      const layout = detectLayout(d);
      expect(layout.kind).toBe(LAYOUT_KIND.CLIENT);
      expect(layout.serverFiles?.beforeFile).toMatch(/underscore_before\.js$/);
      expect(layout.serverFiles?.afterFile).toMatch(/underscore_after\.js$/);
    });

    it("test_case_*.js しか無ければ lib は検出されない (= test_case は lib ではない)", () => {
      const d = mkIssue(["v_before.html", "v_after.html", "test_case_before.js", "test_case_after.js"]);
      const layout = detectLayout(d);
      expect(layout.kind).toBe(LAYOUT_KIND.CLIENT);
      expect(layout.serverFiles).toBeUndefined();
    });

    it("server: <lib>_before/ ディレクトリが test_case_*.js より優先される", () => {
      const d = mkIssue(["test_case_before.js", "test_case_after.js", "cheerio_before/index.js", "cheerio_after/index.js"]);
      const layout = detectLayout(d);
      expect(layout.kind).toBe(LAYOUT_KIND.SERVER);
      expect(layout.serverDirs?.beforeDir).toMatch(/cheerio_before$/);
    });
  });
}
