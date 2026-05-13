/**
 * 対象: CLI エントリ - runPruneBatch (batch モード: `mbs prune-batch`)
 * 観点: JSONL stdin を逐次処理し、id を各結果にエコーバックする契約 (1 subprocess 内では Promise.all なしの完全逐次)
 * 判定事項:
 *   - 複数行は入力順で stdout に出力される
 *   - timeout_ms は必須、欠落/型不一致は error verdict を id 付きで返し他行に波及させない
 *   - max_iterations は optional (engine が default 解決)
 *   - effective_timeout_ms でユーザ指定の timeout_ms が engine に届いたかを検証可能
 *   - setup (string) は engine に届き、非 string は error verdict
 *   - slow/fast が非 string、非 object 行、JSON parse 失敗行 → error verdict で他行は処理継続
 *   - id 欠落時は id フィールド無しで返す
 *   - 空入力は exit 0 + 空出力
 *
 * 注意: pattern_code / pattern_ast の具体値は engine 層の責務 (`src/pruning/README.md` +
 * `tests/pruning/engine.test.ts` でカバー) なので、CLI テストでは verdict / id /
 * effective_timeout_ms など contract レベルに絞って検証する。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPruneBatch } from "../../src/cli/prune";
import { feedStdin, installSpy, restoreSpy, type WritableSpy } from "../fixtures/cli-io";

interface BatchResult {
  id?: string;
  verdict: string;
  error_message?: string | null;
  effective_timeout_ms?: number;
  pattern_code?: string;
}

function parseOutput(writes: string[]): BatchResult[] {
  return writes
    .join("")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as BatchResult);
}

function getResult(results: BatchResult[], idx: number): BatchResult {
  const r = results[idx];
  if (r === undefined) throw new Error(`expected result at index ${idx}`);
  return r;
}

describe("runPruneBatch", () => {
  let spy: WritableSpy;
  let restoreStdin: () => void = () => {};

  beforeEach(() => {
    spy = installSpy("stdout");
  });

  afterEach(() => {
    restoreSpy("stdout", spy);
    restoreStdin();
  });

  it("3 トリプルを順序保持で処理し id をエコーバックする", async () => {
    const payload = [
      JSON.stringify({ id: "a", slow: "1 + 1", fast: "2", timeout_ms: 1000, max_iterations: 10 }),
      JSON.stringify({ id: "b", slow: "1", fast: "2", timeout_ms: 1000, max_iterations: 10 }),
      JSON.stringify({
        id: "c",
        slow: "[1,2,3]",
        fast: "[1,2,3]",
        timeout_ms: 1000,
        max_iterations: 10,
      }),
    ].join("\n");
    restoreStdin = feedStdin(payload);

    const code = await runPruneBatch();

    expect(code).toBe(0);
    const results = parseOutput(spy.writes);
    expect(results.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(getResult(results, 0).verdict).toBe("pruned");
    expect(getResult(results, 1).verdict).toBe("initial_mismatch");
    expect(getResult(results, 2).verdict).toBe("pruned");
  });

  it("effective_timeout_ms が入力値と一致する", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({
        id: "x",
        slow: "1",
        fast: "1",
        timeout_ms: 3000,
        max_iterations: 10,
      }) + "\n",
    );

    await runPruneBatch();

    const result = getResult(parseOutput(spy.writes), 0);
    expect(result.effective_timeout_ms).toBe(3000);
  });

  it("max_iterations 省略時もデフォルトで動作", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({ id: "no_iter", slow: "1 + 1", fast: "2", timeout_ms: 1000 }) + "\n",
    );

    const code = await runPruneBatch();

    expect(code).toBe(0);
    const result = getResult(parseOutput(spy.writes), 0);
    expect(result.id).toBe("no_iter");
    expect(result.verdict).toBe("pruned");
  });

  it("timeout_ms 欠落行は error verdict で id 付きで返す", async () => {
    restoreStdin = feedStdin(JSON.stringify({ id: "no_timeout", slow: "1", fast: "1" }) + "\n");

    const code = await runPruneBatch();

    expect(code).toBe(0);
    const result = getResult(parseOutput(spy.writes), 0);
    expect(result.id).toBe("no_timeout");
    expect(result.verdict).toBe("error");
    expect(result.error_message).toContain("timeout_ms");
  });

  it("JSON parse 失敗行は他行に波及しない", async () => {
    const payload = [
      JSON.stringify({ id: "ok1", slow: "1", fast: "1", timeout_ms: 1000, max_iterations: 10 }),
      "this is not json",
      JSON.stringify({ id: "ok2", slow: "2", fast: "2", timeout_ms: 1000, max_iterations: 10 }),
    ].join("\n");
    restoreStdin = feedStdin(payload);

    const code = await runPruneBatch();

    expect(code).toBe(0);
    const results = parseOutput(spy.writes);
    expect(results).toHaveLength(3);
    expect(getResult(results, 0).id).toBe("ok1");
    expect(getResult(results, 0).verdict).toBe("pruned");
    expect(getResult(results, 1).verdict).toBe("error");
    expect(getResult(results, 1).error_message).toContain("Failed to parse");
    expect(getResult(results, 2).id).toBe("ok2");
    expect(getResult(results, 2).verdict).toBe("pruned");
  });

  it("空入力は空出力 + exit 0", async () => {
    restoreStdin = feedStdin("");

    const code = await runPruneBatch();

    expect(code).toBe(0);
    expect(spy.writes.join("")).toBe("");
  });

  it("id 欠落時は id を持たない結果を返す", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({ slow: "1", fast: "1", timeout_ms: 1000, max_iterations: 10 }) + "\n",
    );

    await runPruneBatch();

    const result = getResult(parseOutput(spy.writes), 0);
    expect(result.id).toBeUndefined();
    expect(result.verdict).toBe("pruned");
  });

  it("setup あり (string) の行は setup が engine に届く", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({
        id: "with_setup",
        setup: "const base = 100;",
        slow: "base + 1",
        fast: "101",
        timeout_ms: 1000,
        max_iterations: 10,
      }) + "\n",
    );

    const code = await runPruneBatch();

    expect(code).toBe(0);
    const result = getResult(parseOutput(spy.writes), 0);
    expect(result.id).toBe("with_setup");
    expect(result.verdict).toBe("pruned");
  });

  it("setup が非 string の行は error verdict で id 付きで返す", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({
        id: "bad_setup",
        slow: "1",
        fast: "1",
        timeout_ms: 1000,
        max_iterations: 10,
        setup: 42,
      }) + "\n",
    );

    const code = await runPruneBatch();

    expect(code).toBe(0);
    const result = getResult(parseOutput(spy.writes), 0);
    expect(result.id).toBe("bad_setup");
    expect(result.verdict).toBe("error");
    expect(result.error_message).toContain("setup");
  });

  it("timeout_ms が非 number の行は error verdict", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({ id: "bad_to", slow: "1", fast: "1", timeout_ms: "5000" }) + "\n",
    );

    const code = await runPruneBatch();

    expect(code).toBe(0);
    const result = getResult(parseOutput(spy.writes), 0);
    expect(result.id).toBe("bad_to");
    expect(result.verdict).toBe("error");
    expect(result.error_message).toContain("timeout_ms");
  });

  it("max_iterations が非 number の行は error verdict", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({
        id: "bad_iter",
        slow: "1",
        fast: "1",
        timeout_ms: 1000,
        max_iterations: "50",
      }) + "\n",
    );

    const code = await runPruneBatch();

    expect(code).toBe(0);
    const result = getResult(parseOutput(spy.writes), 0);
    expect(result.id).toBe("bad_iter");
    expect(result.verdict).toBe("error");
    expect(result.error_message).toContain("max_iterations");
  });

  it("max_iterations=0 の行は error verdict (engine の silently pruned を防ぐ)", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({
        id: "zero_iter",
        slow: "1",
        fast: "1",
        timeout_ms: 1000,
        max_iterations: 0,
      }) + "\n",
    );

    const code = await runPruneBatch();

    expect(code).toBe(0);
    const result = getResult(parseOutput(spy.writes), 0);
    expect(result.id).toBe("zero_iter");
    expect(result.verdict).toBe("error");
    expect(result.error_message).toContain("max_iterations");
  });

  it("max_iterations が負の行は error verdict", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({
        id: "neg_iter",
        slow: "1",
        fast: "1",
        timeout_ms: 1000,
        max_iterations: -1,
      }) + "\n",
    );

    const code = await runPruneBatch();

    expect(code).toBe(0);
    const result = getResult(parseOutput(spy.writes), 0);
    expect(result.id).toBe("neg_iter");
    expect(result.verdict).toBe("error");
    expect(result.error_message).toContain("max_iterations");
  });

  it("max_iterations が小数の行は error verdict", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({
        id: "frac_iter",
        slow: "1",
        fast: "1",
        timeout_ms: 1000,
        max_iterations: 0.5,
      }) + "\n",
    );

    const code = await runPruneBatch();

    expect(code).toBe(0);
    const result = getResult(parseOutput(spy.writes), 0);
    expect(result.id).toBe("frac_iter");
    expect(result.verdict).toBe("error");
    expect(result.error_message).toContain("max_iterations");
  });

  it("timeout_ms=0 の行は error verdict", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({ id: "zero_to", slow: "1", fast: "1", timeout_ms: 0 }) + "\n",
    );

    const code = await runPruneBatch();

    expect(code).toBe(0);
    const result = getResult(parseOutput(spy.writes), 0);
    expect(result.id).toBe("zero_to");
    expect(result.verdict).toBe("error");
    expect(result.error_message).toContain("timeout_ms");
  });

  it("slow が非 string の行は error verdict", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({ id: "bad_slow", slow: 1, fast: "1", timeout_ms: 1000 }) + "\n",
    );

    const code = await runPruneBatch();

    expect(code).toBe(0);
    const result = getResult(parseOutput(spy.writes), 0);
    expect(result.verdict).toBe("error");
    expect(result.error_message).toContain("slow");
  });

  it("非 object 行は error verdict (id は undefined)", async () => {
    restoreStdin = feedStdin("123\n");

    const code = await runPruneBatch();

    expect(code).toBe(0);
    const result = getResult(parseOutput(spy.writes), 0);
    expect(result.id).toBeUndefined();
    expect(result.verdict).toBe("error");
    expect(result.error_message).toContain("JSON object");
  });
});
