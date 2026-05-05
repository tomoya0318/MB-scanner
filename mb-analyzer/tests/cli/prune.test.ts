/**
 * 対象: CLI エントリ - runPrune (single モード: `mbs prune`)
 * 観点: stdin に 1 件の JSON object を受け取り、verdict を stdout に出力し、exit code に対応させる契約
 * 判定事項:
 *   - pruned → stdout に result JSON、exit 0
 *   - initial_mismatch (slow ≢ fast) → exit 1
 *   - parse 失敗等で verdict=error → exit 2
 *   - timeout_ms / max_iterations が engine まで届く (effective_timeout_ms でエコーバック検証)
 *   - JSON parse 失敗 / 非 object / null → exit 2 + stderr、stdout は空
 *   - slow/fast が非 string、setup / timeout_ms / max_iterations が present かつ型不一致 → exit 2
 *
 * 注意: pattern_code / pattern_ast の具体値は engine 層の責務 (`src/pruning/README.md` +
 * `tests/pruning/engine.test.ts` でカバー) なので、CLI テストでは verdict と
 * effective_timeout_ms / id エコーバックなど contract レベルに絞って検証する。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPrune } from "../../src/cli/prune";
import { feedStdin, installSpy, restoreSpy, type WritableSpy } from "../fixtures/cli-io";

interface SingleResult {
  verdict: string;
  error_message?: string | null;
  effective_timeout_ms?: number;
  pattern_code?: string;
}

function parseStdout(writes: string[]): SingleResult {
  const joined = writes.join("").trim();
  if (joined.length === 0) throw new Error("no stdout output");
  return JSON.parse(joined) as SingleResult;
}

describe("runPrune", () => {
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

  it("pruned な入力は exit 0 と result を stdout に出力", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({ slow: "1 + 1", fast: "2", timeout_ms: 1000, max_iterations: 10 }),
    );

    const code = await runPrune();

    expect(code).toBe(0);
    const result = parseStdout(stdoutSpy.writes);
    expect(result.verdict).toBe("pruned");
    expect(stderrSpy.writes).toHaveLength(0);
  });

  it("slow ≢ fast の入力は initial_mismatch で exit 1", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({ slow: "1", fast: "2", timeout_ms: 1000, max_iterations: 10 }),
    );

    const code = await runPrune();

    expect(code).toBe(1);
    expect(parseStdout(stdoutSpy.writes).verdict).toBe("initial_mismatch");
  });

  it("両側で setup throw は exception oracle equal 扱いで pruning が走る", async () => {
    // 両側で同じ setup → exception oracle で equal → pruning Phase 2 まで進む。
    // verdict は pruned / initial_match のいずれか (error にはならない)。
    restoreStdin = feedStdin(
      JSON.stringify({
        setup: `throw new Error("setup boom")`,
        slow: "1",
        fast: "1",
        timeout_ms: 1000,
        max_iterations: 10,
      }),
    );

    const code = await runPrune();

    const result = parseStdout(stdoutSpy.writes);
    expect(result.verdict).not.toBe("error");
    expect(code).not.toBe(2);
  });

  it("timeout_ms が engine に届く (effective_timeout_ms 反映)", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({ slow: "1 + 1", fast: "2", timeout_ms: 3000, max_iterations: 10 }),
    );

    const code = await runPrune();

    expect(code).toBe(0);
    const result = parseStdout(stdoutSpy.writes);
    expect(result.effective_timeout_ms).toBe(3000);
  });

  it("max_iterations 省略時もデフォルトで動作 (engine 解決)", async () => {
    restoreStdin = feedStdin(JSON.stringify({ slow: "1 + 1", fast: "2", timeout_ms: 1000 }));

    const code = await runPrune();

    expect(code).toBe(0);
    expect(parseStdout(stdoutSpy.writes).verdict).toBe("pruned");
  });

  it("JSON parse 失敗は exit 2 + stderr にエラー、stdout は空", async () => {
    restoreStdin = feedStdin("this is not json");

    const code = await runPrune();

    expect(code).toBe(2);
    expect(stdoutSpy.writes).toHaveLength(0);
    expect(stderrSpy.writes.join("")).toContain("Failed to parse stdin as JSON");
  });

  it("primitive (数値) は exit 2", async () => {
    restoreStdin = feedStdin("42");

    const code = await runPrune();

    expect(code).toBe(2);
    expect(stderrSpy.writes.join("")).toContain("Expected a JSON object on stdin");
  });

  it("null は exit 2", async () => {
    restoreStdin = feedStdin("null");

    const code = await runPrune();

    expect(code).toBe(2);
    expect(stderrSpy.writes.join("")).toContain("Expected a JSON object on stdin");
  });

  it("slow が string でないと exit 2", async () => {
    restoreStdin = feedStdin(JSON.stringify({ slow: 1, fast: "2" }));

    const code = await runPrune();

    expect(code).toBe(2);
    expect(stderrSpy.writes.join("")).toContain("'slow' field must be a string");
  });

  it("fast が string でないと exit 2", async () => {
    restoreStdin = feedStdin(JSON.stringify({ slow: "1", fast: 2 }));

    const code = await runPrune();

    expect(code).toBe(2);
    expect(stderrSpy.writes.join("")).toContain("'fast' field must be a string");
  });

  it("setup が present かつ非 string だと exit 2", async () => {
    restoreStdin = feedStdin(JSON.stringify({ slow: "1", fast: "1", setup: 42 }));

    const code = await runPrune();

    expect(code).toBe(2);
    expect(stderrSpy.writes.join("")).toContain("'setup' field must be a string when present");
  });

  it("timeout_ms が present かつ非 number だと exit 2", async () => {
    restoreStdin = feedStdin(JSON.stringify({ slow: "1", fast: "1", timeout_ms: "5000" }));

    const code = await runPrune();

    expect(code).toBe(2);
    expect(stderrSpy.writes.join("")).toContain("'timeout_ms' field must be an integer");
  });

  it("max_iterations が present かつ非 number だと exit 2", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({ slow: "1", fast: "1", timeout_ms: 1000, max_iterations: "50" }),
    );

    const code = await runPrune();

    expect(code).toBe(2);
    expect(stderrSpy.writes.join("")).toContain("'max_iterations' field must be an integer");
  });

  it("max_iterations が Infinity (非整数) だと exit 2", async () => {
    restoreStdin = feedStdin(`{"slow":"1","fast":"1","timeout_ms":1000,"max_iterations":1e500}`);

    const code = await runPrune();

    expect(code).toBe(2);
    expect(stderrSpy.writes.join("")).toContain("'max_iterations' field must be an integer");
  });

  it("max_iterations=0 は exit 2 (engine がループをスキップして silently pruned を返す事故を防ぐ)", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({ slow: "1", fast: "1", timeout_ms: 1000, max_iterations: 0 }),
    );

    const code = await runPrune();

    expect(code).toBe(2);
    expect(stderrSpy.writes.join("")).toContain("'max_iterations' field must be in [1, 100000]");
  });

  it("max_iterations が負だと exit 2", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({ slow: "1", fast: "1", timeout_ms: 1000, max_iterations: -1 }),
    );

    const code = await runPrune();

    expect(code).toBe(2);
    expect(stderrSpy.writes.join("")).toContain("'max_iterations' field must be in [1, 100000]");
  });

  it("max_iterations が小数だと exit 2", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({ slow: "1", fast: "1", timeout_ms: 1000, max_iterations: 0.5 }),
    );

    const code = await runPrune();

    expect(code).toBe(2);
    expect(stderrSpy.writes.join("")).toContain("'max_iterations' field must be an integer");
  });

  it("timeout_ms=0 は exit 2", async () => {
    restoreStdin = feedStdin(JSON.stringify({ slow: "1", fast: "1", timeout_ms: 0 }));

    const code = await runPrune();

    expect(code).toBe(2);
    expect(stderrSpy.writes.join("")).toContain("'timeout_ms' field must be in [1, 60000]");
  });

  it("timeout_ms が上限超過 (60000 超) だと exit 2", async () => {
    restoreStdin = feedStdin(JSON.stringify({ slow: "1", fast: "1", timeout_ms: 60001 }));

    const code = await runPrune();

    expect(code).toBe(2);
    expect(stderrSpy.writes.join("")).toContain("'timeout_ms' field must be in [1, 60000]");
  });
});
