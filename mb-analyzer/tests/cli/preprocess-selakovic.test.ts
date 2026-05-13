/**
 * 対象: CLI エントリ - runPreprocessSelakovic (single モード: `mbs preprocess-selakovic`)
 * 観点: stdin に 1 件の JSON object を受け取り、1+ 件の結果を JSONL で stdout に出力する契約
 * 判定事項:
 *   - 抽出成功 (preprocess が複数 candidate を返す) → JSONL の各行に id suffix が付与される
 *   - layout 判定不能ディレクトリ → 1 件の error result (LAYOUT_UNKNOWN) で exit 0
 *   - id 省略 (undefined / null / 未指定) → 出力に id フィールドなし
 *   - id 指定あり + 1 結果 → original_id を suffix なしで付与
 *   - id 非 string (数値等) は exit 2 + stderr
 *   - issue_dir 欠落 / 非 string → exit 2
 *   - JSON parse 失敗 / 非 object → exit 2
 *
 * 注意: preprocess() の AST 解析の正しさは preprocessing/selakovic 配下の単体テスト責務 (
 * `selakovic-2016.test.ts` 等) なので、CLI テストでは I/O 契約 (JSONL 形式 / id /
 * exit code) に絞って検証する。
 */
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPreprocessSelakovic } from "../../src/cli/preprocess-selakovic";
import { feedStdin, installSpy, restoreSpy, type WritableSpy } from "../fixtures/cli-io";

interface SingleResult {
  id?: string;
  layout: string;
  excluded?: string;
  excluded_detail?: string;
  slow?: string;
  fast?: string;
}

function parseStdoutLines(writes: string[]): SingleResult[] {
  return writes
    .join("")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SingleResult);
}

function makeUnknownLayoutDir(): string {
  return mkdtempSync(join(tmpdir(), "mbs-preprocess-cli-test-"));
}

function makeClientIdenticalDir(): string {
  // v_before.html と v_after.html が同じ → "all top-level statements matched" で no-changed-nodes
  const dir = mkdtempSync(join(tmpdir(), "mbs-preprocess-cli-test-"));
  const html = "<html><body><script>const x = 1;</script></body></html>";
  writeFileSync(join(dir, "v_before.html"), html);
  writeFileSync(join(dir, "v_after.html"), html);
  return dir;
}

function makeClientMultiCandidateDir(): string {
  // 2 つの top-level function declaration がそれぞれ独立に変更されている → 2 candidate
  const dir = mkdtempSync(join(tmpdir(), "mbs-preprocess-cli-test-"));
  const before = `<html><body><script>
function f() { return arr[0]; }
function g() { return arr[0]; }
</script></body></html>`;
  const after = `<html><body><script>
function f() { return arr[1]; }
function g() { return arr[2]; }
</script></body></html>`;
  writeFileSync(join(dir, "v_before.html"), before);
  writeFileSync(join(dir, "v_after.html"), after);
  return dir;
}

describe("runPreprocessSelakovic", () => {
  let stdoutSpy: WritableSpy;
  let stderrSpy: WritableSpy;
  let restoreStdin: () => void = () => {};
  const tmpDirs: string[] = [];

  beforeEach(() => {
    stdoutSpy = installSpy("stdout");
    stderrSpy = installSpy("stderr");
  });

  afterEach(() => {
    restoreSpy("stdout", stdoutSpy);
    restoreSpy("stderr", stderrSpy);
    restoreStdin();
    restoreStdin = () => {};
    for (const d of tmpDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("layout 判定不能ディレクトリは 1 件の LAYOUT_UNKNOWN result を JSONL で出力し exit 0", async () => {
    const dir = makeUnknownLayoutDir();
    tmpDirs.push(dir);
    restoreStdin = feedStdin(JSON.stringify({ id: "case-01", issue_dir: dir }));

    const code = await runPreprocessSelakovic();

    expect(code).toBe(0);
    const results = parseStdoutLines(stdoutSpy.writes);
    expect(results).toHaveLength(1);
    expect(results[0]?.layout).toBe("unknown");
    expect(results[0]?.excluded).toBe("layout-unknown");
    expect(results[0]?.id).toBe("case-01");
  });

  it("id 省略 (undefined) は出力でも id フィールドなし", async () => {
    const dir = makeUnknownLayoutDir();
    tmpDirs.push(dir);
    restoreStdin = feedStdin(JSON.stringify({ issue_dir: dir }));

    const code = await runPreprocessSelakovic();

    expect(code).toBe(0);
    const results = parseStdoutLines(stdoutSpy.writes);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBeUndefined();
  });

  it("id: null は省略と同等 (Pydantic optional 互換)", async () => {
    const dir = makeUnknownLayoutDir();
    tmpDirs.push(dir);
    restoreStdin = feedStdin(JSON.stringify({ id: null, issue_dir: dir }));

    const code = await runPreprocessSelakovic();

    expect(code).toBe(0);
    const results = parseStdoutLines(stdoutSpy.writes);
    expect(results[0]?.id).toBeUndefined();
  });

  it("id 非 string (数値) は exit 2 + stderr", async () => {
    restoreStdin = feedStdin(JSON.stringify({ id: 42, issue_dir: "/tmp/x" }));

    const code = await runPreprocessSelakovic();

    expect(code).toBe(2);
    expect(stdoutSpy.writes).toHaveLength(0);
    expect(stderrSpy.writes.join("")).toContain("'id' field must be a string when present");
  });

  it("issue_dir 欠落は exit 2", async () => {
    restoreStdin = feedStdin(JSON.stringify({ id: "x" }));

    const code = await runPreprocessSelakovic();

    expect(code).toBe(2);
    expect(stderrSpy.writes.join("")).toContain("'issue_dir' field must be a string");
  });

  it("issue_dir が非 string は exit 2", async () => {
    restoreStdin = feedStdin(JSON.stringify({ issue_dir: 123 }));

    const code = await runPreprocessSelakovic();

    expect(code).toBe(2);
    expect(stderrSpy.writes.join("")).toContain("'issue_dir' field must be a string");
  });

  it("JSON parse 失敗は exit 2 + stderr", async () => {
    restoreStdin = feedStdin("not json");

    const code = await runPreprocessSelakovic();

    expect(code).toBe(2);
    expect(stdoutSpy.writes).toHaveLength(0);
    expect(stderrSpy.writes.join("")).toContain("Failed to parse stdin as JSON");
  });

  it("primitive (数値) は exit 2", async () => {
    restoreStdin = feedStdin("42");

    const code = await runPreprocessSelakovic();

    expect(code).toBe(2);
    expect(stderrSpy.writes.join("")).toContain("Expected a JSON object on stdin");
  });

  it("null は exit 2", async () => {
    restoreStdin = feedStdin("null");

    const code = await runPreprocessSelakovic();

    expect(code).toBe(2);
    expect(stderrSpy.writes.join("")).toContain("Expected a JSON object on stdin");
  });

  it("client モードで before/after が同一なら no-changed-nodes で 1 件返す (id は suffix なし)", async () => {
    const dir = makeClientIdenticalDir();
    tmpDirs.push(dir);
    restoreStdin = feedStdin(JSON.stringify({ id: "case-01", issue_dir: dir }));

    const code = await runPreprocessSelakovic();

    expect(code).toBe(0);
    const results = parseStdoutLines(stdoutSpy.writes);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("case-01");
    expect(results[0]?.excluded).toBe("no-changed-nodes");
  });

  it("複数 candidate を返す入力は id を <original_id>#<index> で suffix 付与する", async () => {
    const dir = makeClientMultiCandidateDir();
    tmpDirs.push(dir);
    restoreStdin = feedStdin(JSON.stringify({ id: "case-01", issue_dir: dir }));

    const code = await runPreprocessSelakovic();

    expect(code).toBe(0);
    const results = parseStdoutLines(stdoutSpy.writes);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.map((r) => r.id)).toEqual(
      results.map((_, idx) => `case-01#${idx}`),
    );
  });

  it("出力は常に JSONL (各 result は独立行)", async () => {
    const dir = makeUnknownLayoutDir();
    tmpDirs.push(dir);
    restoreStdin = feedStdin(JSON.stringify({ issue_dir: dir }));

    await runPreprocessSelakovic();

    const joined = stdoutSpy.writes.join("");
    const lines = joined.split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      expect(() => {
        JSON.parse(line);
      }).not.toThrow();
    }
    expect(joined.endsWith("\n")).toBe(true);
  });
});
