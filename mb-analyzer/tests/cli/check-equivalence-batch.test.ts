/**
 * 対象: CLI エントリ - runCheckEquivalenceBatch (batch モード: `mbs check-equivalence-batch`)
 * 観点: JSONL stdin を 1 件 1 subprocess 起動せず逐次処理し、id を各結果にエコーバックする契約
 * 判定事項:
 *   - 複数行は入力順で stdout に出力される
 *   - timeout_ms は必須、欠落/型不一致は error verdict を id 付きで返し他行に波及させない
 *   - effective_timeout_ms でユーザ指定の timeout_ms が checker に届いたかを検証可能
 *   - setup (string) は checker に届き、非 string は error verdict
 *   - before/after が非 string、非 object 行、JSON parse 失敗行 → error verdict で他行は処理継続
 *   - id 欠落時は id フィールド無しで返す
 *   - 空入力は exit 0 + 空出力
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCheckEquivalenceBatch } from "../../src/cli/check-equivalence";
import { feedStdin, installSpy, restoreSpy, type WritableSpy } from "../fixtures/cli-io";

interface BatchResult {
  id?: string;
  verdict: string;
  observations: unknown[];
  error_message?: string | null;
  effective_timeout_ms?: number;
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

describe("runCheckEquivalenceBatch", () => {
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
      JSON.stringify({ id: "a", before: "1 + 1", after: "2", timeout_ms: 5000 }),
      JSON.stringify({ id: "b", before: "1", after: "2", timeout_ms: 5000 }),
      JSON.stringify({ id: "c", before: "[1,2,3]", after: "[1,2,3]", timeout_ms: 5000 }),
    ].join("\n");
    restoreStdin = feedStdin(payload);

    const code = await runCheckEquivalenceBatch();

    expect(code).toBe(0);
    const results = parseOutput(spy.writes);
    expect(results.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(getResult(results, 0).verdict).toBe("equal");
    expect(getResult(results, 1).verdict).toBe("not_equal");
    expect(getResult(results, 2).verdict).toBe("equal");
  });

  it("effective_timeout_ms が入力値と一致する", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({ id: "x", before: "1", after: "1", timeout_ms: 3000 }) + "\n",
    );

    await runCheckEquivalenceBatch();

    const result = getResult(parseOutput(spy.writes), 0);
    expect(result.effective_timeout_ms).toBe(3000);
  });

  it("timeout_ms=1 で無限ループも checker に値が届く", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({ id: "loop", before: "while(true){}", after: "while(true){}", timeout_ms: 1 }) + "\n",
    );

    await runCheckEquivalenceBatch();

    const result = getResult(parseOutput(spy.writes), 0);
    expect(result.id).toBe("loop");
    expect(result.effective_timeout_ms).toBe(1);
    // 両側 timeout → exception oracle で ctor 一致 → inconclusive (positive evidence 無し) になるが、
    // どちらにせよ timeout_ms=1 が checker まで届いていることがエコーバックで確認できれば十分
  });

  it("timeout_ms 欠落行は error verdict で id 付きで返す", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({ id: "no_timeout", before: "1", after: "1" }) + "\n",
    );

    const code = await runCheckEquivalenceBatch();

    expect(code).toBe(0);
    const result = getResult(parseOutput(spy.writes), 0);
    expect(result.id).toBe("no_timeout");
    expect(result.verdict).toBe("error");
    expect(result.error_message).toContain("timeout_ms");
  });

  it("JSON parse 失敗行は他行に波及しない", async () => {
    const payload = [
      JSON.stringify({ id: "ok1", before: "1", after: "1", timeout_ms: 5000 }),
      "this is not json",
      JSON.stringify({ id: "ok2", before: "2", after: "2", timeout_ms: 5000 }),
    ].join("\n");
    restoreStdin = feedStdin(payload);

    const code = await runCheckEquivalenceBatch();

    expect(code).toBe(0);
    const results = parseOutput(spy.writes);
    expect(results).toHaveLength(3);
    expect(getResult(results, 0).id).toBe("ok1");
    expect(getResult(results, 0).verdict).toBe("equal");
    expect(getResult(results, 1).verdict).toBe("error");
    expect(getResult(results, 1).error_message).toContain("Failed to parse");
    expect(getResult(results, 2).id).toBe("ok2");
    expect(getResult(results, 2).verdict).toBe("equal");
  });

  it("空入力は空出力 + exit 0", async () => {
    restoreStdin = feedStdin("");

    const code = await runCheckEquivalenceBatch();

    expect(code).toBe(0);
    expect(spy.writes.join("")).toBe("");
  });

  it("id 欠落時は id を持たない結果を返す", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({ before: "1", after: "1", timeout_ms: 5000 }) + "\n",
    );

    await runCheckEquivalenceBatch();

    const result = getResult(parseOutput(spy.writes), 0);
    expect(result.id).toBeUndefined();
    expect(result.verdict).toBe("equal");
  });

  it("setup あり (string) の行は setup が checker に届く", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({
        id: "with_setup",
        setup: "const base = 100;",
        before: "base + 1",
        after: "101",
        timeout_ms: 5000,
      }) + "\n",
    );

    const code = await runCheckEquivalenceBatch();

    expect(code).toBe(0);
    const result = getResult(parseOutput(spy.writes), 0);
    expect(result.id).toBe("with_setup");
    expect(result.verdict).toBe("equal");
  });

  it("setup が非 string の行は error verdict で id 付きで返す", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({ id: "bad_setup", before: "1", after: "1", timeout_ms: 5000, setup: 42 }) +
        "\n",
    );

    const code = await runCheckEquivalenceBatch();

    expect(code).toBe(0);
    const result = getResult(parseOutput(spy.writes), 0);
    expect(result.id).toBe("bad_setup");
    expect(result.verdict).toBe("error");
    expect(result.error_message).toContain("setup");
  });

  it("timeout_ms が非 number の行は error verdict", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({ id: "bad_to", before: "1", after: "1", timeout_ms: "5000" }) + "\n",
    );

    const code = await runCheckEquivalenceBatch();

    expect(code).toBe(0);
    const result = getResult(parseOutput(spy.writes), 0);
    expect(result.id).toBe("bad_to");
    expect(result.verdict).toBe("error");
    expect(result.error_message).toContain("timeout_ms");
  });

  it("before が非 string の行は error verdict", async () => {
    restoreStdin = feedStdin(
      JSON.stringify({ id: "bad_before", before: 1, after: "1", timeout_ms: 5000 }) + "\n",
    );

    const code = await runCheckEquivalenceBatch();

    expect(code).toBe(0);
    const result = getResult(parseOutput(spy.writes), 0);
    expect(result.verdict).toBe("error");
    expect(result.error_message).toContain("before");
  });

  it("非 object 行は error verdict (id は undefined)", async () => {
    restoreStdin = feedStdin("123\n");

    const code = await runCheckEquivalenceBatch();

    expect(code).toBe(0);
    const result = getResult(parseOutput(spy.writes), 0);
    expect(result.id).toBeUndefined();
    expect(result.verdict).toBe("error");
    expect(result.error_message).toContain("JSON object");
  });
});
