/**
 * 対象: CLI エントリ - runPreprocessSelakovic (single モード: `mbs preprocess-selakovic`)
 * 観点: stdin に 1 件の JSON object を受け取り、1 件の IssueResult を JSONL で stdout に出力する契約 (ADR-0024)
 *
 * ADR-0024 で 1 入力 → 1 IssueResult モデル (内部に candidates: list) に変更。旧 1 入力 → N flat result の
 * suffix 付与 (`<original_id>#<index>`) は廃止。
 */
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPreprocessSelakovic } from "../../src/cli/preprocess-selakovic";
import { feedStdin, installSpy, restoreSpy, type WritableSpy } from "../fixtures/cli-io";

interface IssueResult {
  id?: string;
  issue_excluded?: string;
  issue_excluded_detail?: string;
  candidates: unknown[];
  candidate_count: number;
  issue_meta?: { layout?: string; aspect?: string };
}

function parseStdoutLines(writes: string[]): IssueResult[] {
  return writes
    .join("")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as IssueResult);
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
  // 2 つの top-level function declaration がそれぞれ独立に変更されている → 1 IssueResult 内に複数 candidate
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

  it("layout 判定不能ディレクトリは 1 件の LAYOUT_UNKNOWN issue_excluded を JSONL で出力し exit 0", async () => {
    const dir = makeUnknownLayoutDir();
    tmpDirs.push(dir);
    restoreStdin = feedStdin(JSON.stringify({ id: "case-01", issue_dir: dir }));

    const code = await runPreprocessSelakovic();

    expect(code).toBe(0);
    const results = parseStdoutLines(stdoutSpy.writes);
    expect(results).toHaveLength(1);
    expect(results[0]?.issue_meta?.layout).toBe("unknown");
    expect(results[0]?.issue_excluded).toBe("layout-unknown");
    expect(results[0]?.id).toBe("case-01");
    expect(results[0]?.candidate_count).toBe(0);
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

  it("client モードで before/after が同一なら no-changed-nodes で 1 IssueResult を返す", async () => {
    const dir = makeClientIdenticalDir();
    tmpDirs.push(dir);
    restoreStdin = feedStdin(JSON.stringify({ id: "case-01", issue_dir: dir }));

    const code = await runPreprocessSelakovic();

    expect(code).toBe(0);
    const results = parseStdoutLines(stdoutSpy.writes);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("case-01");
    expect(results[0]?.issue_excluded).toBe("no-changed-nodes");
  });

  it("複数 candidate を返す入力は 1 IssueResult 内に candidates: list として返す (id suffix なし)", async () => {
    const dir = makeClientMultiCandidateDir();
    tmpDirs.push(dir);
    restoreStdin = feedStdin(JSON.stringify({ id: "case-01", issue_dir: dir }));

    const code = await runPreprocessSelakovic();

    expect(code).toBe(0);
    const results = parseStdoutLines(stdoutSpy.writes);
    // 旧モデルでは N 行に分かれていたが、新モデルでは 1 行 1 IssueResult
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("case-01");
    expect(results[0]?.candidates.length).toBeGreaterThanOrEqual(2);
    expect(results[0]?.candidate_count).toBeGreaterThanOrEqual(2);
  });

  it("出力は常に JSONL (各 IssueResult は独立行)", async () => {
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
