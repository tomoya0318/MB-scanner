/**
 * 対象: CLI エントリ - runPreprocessSelakovicBatch (batch モード: `mbs preprocess-selakovic-batch`)
 * 観点: JSONL stdin を逐次処理し、各入力に対し 1 件の IssueResult を JSONL で出力する契約 (ADR-0024)
 *
 * ADR-0024 で 1 入力 → 1 IssueResult モデルに変更。入力数 == 出力数。
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPreprocessSelakovicBatch } from "../../src/cli/preprocess-selakovic";
import { feedStdin, installSpy, restoreSpy, type WritableSpy } from "../fixtures/cli-io";

interface IssueResult {
  id?: string;
  issue_excluded?: string;
  issue_excluded_detail?: string;
  candidates: unknown[];
  candidate_count: number;
  issue_meta?: { layout?: string };
}

function parseOutput(writes: string[]): IssueResult[] {
  return writes
    .join("")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as IssueResult);
}

function makeUnknownLayoutDir(): string {
  return mkdtempSync(join(tmpdir(), "mbs-preprocess-batch-test-"));
}

describe("runPreprocessSelakovicBatch", () => {
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

  it("空入力は exit 0 + 空出力", async () => {
    restoreStdin = feedStdin("");

    const code = await runPreprocessSelakovicBatch();

    expect(code).toBe(0);
    expect(stdoutSpy.writes).toHaveLength(0);
  });

  it("3 行を入力順に処理し id をエコーバックする (1 入力 1 IssueResult)", async () => {
    const dir1 = makeUnknownLayoutDir();
    const dir2 = makeUnknownLayoutDir();
    const dir3 = makeUnknownLayoutDir();
    tmpDirs.push(dir1, dir2, dir3);
    const payload = [
      JSON.stringify({ id: "a", issue_dir: dir1 }),
      JSON.stringify({ id: "b", issue_dir: dir2 }),
      JSON.stringify({ id: "c", issue_dir: dir3 }),
    ].join("\n");
    restoreStdin = feedStdin(payload);

    const code = await runPreprocessSelakovicBatch();

    expect(code).toBe(0);
    const results = parseOutput(stdoutSpy.writes);
    expect(results.map((r) => r.id)).toEqual(["a", "b", "c"]);
    for (const r of results) {
      expect(r.issue_meta?.layout).toBe("unknown");
      expect(r.issue_excluded).toBe("layout-unknown");
    }
  });

  it("id: null は undefined と同等 (出力でも id フィールドなし)", async () => {
    const dir = makeUnknownLayoutDir();
    tmpDirs.push(dir);
    restoreStdin = feedStdin(JSON.stringify({ id: null, issue_dir: dir }));

    const code = await runPreprocessSelakovicBatch();

    expect(code).toBe(0);
    const results = parseOutput(stdoutSpy.writes);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBeUndefined();
  });

  it("id 欠落の行は出力でも id フィールドなし", async () => {
    const dir = makeUnknownLayoutDir();
    tmpDirs.push(dir);
    restoreStdin = feedStdin(JSON.stringify({ issue_dir: dir }));

    const code = await runPreprocessSelakovicBatch();

    expect(code).toBe(0);
    const results = parseOutput(stdoutSpy.writes);
    expect(results[0]?.id).toBeUndefined();
  });

  it("JSON parse 失敗の行は LAYOUT_UNKNOWN error として出力し、他行は処理継続", async () => {
    const dir = makeUnknownLayoutDir();
    tmpDirs.push(dir);
    const payload = [
      "this is not json",
      JSON.stringify({ id: "ok", issue_dir: dir }),
    ].join("\n");
    restoreStdin = feedStdin(payload);

    const code = await runPreprocessSelakovicBatch();

    expect(code).toBe(0);
    const results = parseOutput(stdoutSpy.writes);
    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBeUndefined();
    expect(results[0]?.issue_excluded).toBe("layout-unknown");
    expect(results[0]?.issue_excluded_detail).toContain("Failed to parse line as JSON");
    expect(results[1]?.id).toBe("ok");
  });

  it("非 object 行は error として出力し、他行は処理継続", async () => {
    const dir = makeUnknownLayoutDir();
    tmpDirs.push(dir);
    const payload = ["42", JSON.stringify({ id: "ok", issue_dir: dir })].join("\n");
    restoreStdin = feedStdin(payload);

    const code = await runPreprocessSelakovicBatch();

    expect(code).toBe(0);
    const results = parseOutput(stdoutSpy.writes);
    expect(results).toHaveLength(2);
    expect(results[0]?.issue_excluded_detail).toContain("Expected a JSON object per line");
    expect(results[1]?.id).toBe("ok");
  });

  it("issue_dir 欠落の行は id を保持したまま error result", async () => {
    const dir = makeUnknownLayoutDir();
    tmpDirs.push(dir);
    const payload = [
      JSON.stringify({ id: "broken" }),
      JSON.stringify({ id: "ok", issue_dir: dir }),
    ].join("\n");
    restoreStdin = feedStdin(payload);

    const code = await runPreprocessSelakovicBatch();

    expect(code).toBe(0);
    const results = parseOutput(stdoutSpy.writes);
    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe("broken");
    expect(results[0]?.issue_excluded_detail).toContain("'issue_dir' field must be a string");
    expect(results[1]?.id).toBe("ok");
  });

  it("id 非 string (string でも null でも undefined でもない値) は error result", async () => {
    const dir = makeUnknownLayoutDir();
    tmpDirs.push(dir);
    const payload = [
      JSON.stringify({ id: 42, issue_dir: dir }),
      JSON.stringify({ id: "ok", issue_dir: dir }),
    ].join("\n");
    restoreStdin = feedStdin(payload);

    const code = await runPreprocessSelakovicBatch();

    expect(code).toBe(0);
    const results = parseOutput(stdoutSpy.writes);
    expect(results).toHaveLength(2);
    expect(results[0]?.issue_excluded_detail).toContain("'id' field must be a string");
    expect(results[1]?.id).toBe("ok");
  });
});
