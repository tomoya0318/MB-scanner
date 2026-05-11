/**
 * 対象: CLI エントリ - runCheckEquivalence (single モード: `mbs check-equivalence`)
 * 観点: stdin に 1 件の JSON object を受け取り、verdict を stdout に出力し、exit code に対応させる契約
 * 判定事項:
 *   - equal → stdout に result JSON、exit 0
 *   - not_equal → exit 1
 *   - inconclusive → exit 2
 *   - checker 内部で verdict=error → exit 3
 *   - setup / timeout_ms が checker まで届く (effective_timeout_ms でエコーバック検証)
 *   - JSON parse 失敗 / 非 object / null → exit 3 + stderr、stdout は空
 *   - slow/fast が非 string、setup / timeout_ms が present かつ型不一致 / 非 finite → exit 3
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCheckEquivalence } from "../../src/cli/check-equivalence";
import { feedStdin, installSpy, restoreSpy, type WritableSpy } from "../fixtures/cli-io";

interface SingleResult {
  verdict: string;
  observations: unknown[];
  verdict_reason?: string | null;
  error_message?: string | null;
  effective_timeout_ms?: number;
}

function parseStdout(writes: string[]): SingleResult {
  const joined = writes.join("").trim();
  if (joined.length === 0) throw new Error("no stdout output");
  return JSON.parse(joined) as SingleResult;
}

describe("runCheckEquivalence", () => {
  let stdoutSpy: WritableSpy;
  let stderrSpy: WritableSpy;
  let restoreStdin: () => void = () => {};

  beforeEach(() => {
    stdoutSpy = installSpy("stdout");
    stderrSpy = installSpy("stderr");
  });

  afterEach(() => {
    restoreSpy("stdout", stdoutSpy);
    restoreSpy("stderr", stderrSpy);
    restoreStdin();
    restoreStdin = () => {};
  });

  it("equal な入力は exit 0 と result を stdout に出力", async () => {
    restoreStdin = feedStdin(JSON.stringify({ slow: "1 + 1", fast: "2" }));

    const code = await runCheckEquivalence();

    expect(code).toBe(0);
    const result = parseStdout(stdoutSpy.writes);
    expect(result.verdict).toBe("equal");
    expect(stderrSpy.writes).toHaveLength(0);
  });

  it("not_equal な入力は exit 1 を返す", async () => {
    restoreStdin = feedStdin(JSON.stringify({ slow: "1", fast: "2" }));

    const code = await runCheckEquivalence();

    expect(code).toBe(1);
    expect(parseStdout(stdoutSpy.writes).verdict).toBe("not_equal");
  });

  it("checker が error を返すと exit 3", async () => {
    // setup 自体が throw → checker トップ catch で verdict=error
    restoreStdin = feedStdin(
      JSON.stringify({ setup: `throw new Error("setup boom")`, slow: "1", fast: "1" }),
    );

    const code = await runCheckEquivalence();

    expect(code).toBe(3);
    const result = parseStdout(stdoutSpy.writes);
    expect(result.verdict).toBe("error");
    expect(result.verdict_reason).toBe("executor-error");
  });

  it("両側が同じ例外で落ちるだけ (positive evidence 無し) は inconclusive / exit 2", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({ slow: `throw new Error("boom")`, fast: `throw new Error("boom")` }),
    );

    const code = await runCheckEquivalence();

    expect(code).toBe(2);
    const result = parseStdout(stdoutSpy.writes);
    expect(result.verdict).toBe("inconclusive");
    expect(result.verdict_reason).toBe("both-sides-threw");
  });

  it("setup + timeout_ms が checker に届く (effective_timeout_ms 反映)", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({ setup: "const x = 10;", slow: "x + 1", fast: "11", timeout_ms: 3000 }),
    );

    const code = await runCheckEquivalence();

    expect(code).toBe(0);
    const result = parseStdout(stdoutSpy.writes);
    expect(result.verdict).toBe("equal");
    expect(result.effective_timeout_ms).toBe(3000);
  });

  it("JSON parse 失敗は exit 2 + stderr にエラー、stdout は空", async () => {
    restoreStdin = feedStdin("this is not json");

    const code = await runCheckEquivalence();

    expect(code).toBe(3);
    expect(stdoutSpy.writes).toHaveLength(0);
    expect(stderrSpy.writes.join("")).toContain("Failed to parse stdin as JSON");
  });

  it("primitive (数値) は exit 2", async () => {
    restoreStdin = feedStdin("42");

    const code = await runCheckEquivalence();

    expect(code).toBe(3);
    expect(stderrSpy.writes.join("")).toContain("Expected a JSON object on stdin");
  });

  it("null は exit 2", async () => {
    restoreStdin = feedStdin("null");

    const code = await runCheckEquivalence();

    expect(code).toBe(3);
    expect(stderrSpy.writes.join("")).toContain("Expected a JSON object on stdin");
  });

  it("slow が string でないと exit 2", async () => {
    restoreStdin = feedStdin(JSON.stringify({ slow: 1, fast: "2" }));

    const code = await runCheckEquivalence();

    expect(code).toBe(3);
    expect(stderrSpy.writes.join("")).toContain("'slow' field must be a string");
  });

  it("fast が string でないと exit 2", async () => {
    restoreStdin = feedStdin(JSON.stringify({ slow: "1", fast: 2 }));

    const code = await runCheckEquivalence();

    expect(code).toBe(3);
    expect(stderrSpy.writes.join("")).toContain("'fast' field must be a string");
  });

  it("setup が present かつ非 string だと exit 2", async () => {
    restoreStdin = feedStdin(JSON.stringify({ slow: "1", fast: "1", setup: 42 }));

    const code = await runCheckEquivalence();

    expect(code).toBe(3);
    expect(stderrSpy.writes.join("")).toContain("'setup' field must be a string when present");
  });

  it("timeout_ms が present かつ非 number だと exit 2", async () => {
    restoreStdin = feedStdin(JSON.stringify({ slow: "1", fast: "1", timeout_ms: "5000" }));

    const code = await runCheckEquivalence();

    expect(code).toBe(3);
    expect(stderrSpy.writes.join("")).toContain(
      "'timeout_ms' field must be a finite number when present",
    );
  });

  it("timeout_ms が Infinity (非 finite) だと exit 2", async () => {
    // JSON.stringify では Infinity は null 化されるため、文字列リテラルで直接渡す。
    // JSON.parse は 1e500 を Infinity に解釈する。
    restoreStdin = feedStdin(`{"slow":"1","fast":"1","timeout_ms":1e500}`);

    const code = await runCheckEquivalence();

    expect(code).toBe(3);
    expect(stderrSpy.writes.join("")).toContain(
      "'timeout_ms' field must be a finite number when present",
    );
  });
});
