/**
 * 対象: src/contracts/pruning-contracts.ts (Python ↔ TypeScript の JSON 契約)
 * 観点: Python 側 Pydantic enum / StrEnum と同じ文字列値・同じ union 幅で型が narrow されていること
 * 判定事項:
 *   - PRUNING_VERDICT / PLACEHOLDER_KIND: Python 側 StrEnum と同一の文字列値 (runtime)
 *   - PruningVerdict / PlaceholderKind: union 型が Python と同じ列挙幅 (型レベル)
 *   - Placeholder: JSON 往復でフィールド名 (id / kind / original_snippet) と値を保持
 *   - PruningInput: slow/fast 必須、id/setup/timeout_ms/max_iterations + 等価検証コンテキスト (environment 等) 任意
 *   - ExecutionEnvironmentHint: equivalence/preprocessing 契約と同じ "vm" | "jsdom"
 *   - PruningResult: pruned は pattern_code/placeholders/iterations で表現、initial_mismatch と error は pattern なしで成立
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  PLACEHOLDER_KIND,
  PRUNING_VERDICT,
  type ExecutionEnvironmentHint,
  type Placeholder,
  type PlaceholderKind,
  type PruningInput,
  type PruningResult,
  type PruningVerdict,
} from "../../src/contracts/pruning-contracts";

describe("PRUNING_VERDICT", () => {
  it("Python 側 PruningVerdict StrEnum と同じ文字列値を持つ", () => {
    expect(PRUNING_VERDICT).toStrictEqual({
      PRUNED: "pruned",
      INITIAL_MISMATCH: "initial_mismatch",
      ERROR: "error",
    });
  });

  it("PruningVerdict 型が 3 値の union として narrow される", () => {
    expectTypeOf<PruningVerdict>().toEqualTypeOf<"pruned" | "initial_mismatch" | "error">();
  });
});

describe("PLACEHOLDER_KIND", () => {
  it("Python 側 PlaceholderKind StrEnum と同じ文字列値を持つ", () => {
    expect(PLACEHOLDER_KIND).toStrictEqual({
      EXPRESSION: "expression",
      STATEMENT: "statement",
      IDENTIFIER: "identifier",
    });
  });

  it("PlaceholderKind 型が 3 値の union", () => {
    expectTypeOf<PlaceholderKind>().toEqualTypeOf<"expression" | "statement" | "identifier">();
  });
});

describe("Placeholder", () => {
  it("JSON 往復でフィールド名と値が保持される", () => {
    const ph: Placeholder = {
      id: "$VAR_1",
      kind: PLACEHOLDER_KIND.EXPRESSION,
      original_snippet: "arr[0]",
    };
    const parsed = JSON.parse(JSON.stringify(ph)) as Placeholder;
    expect(parsed).toStrictEqual(ph);
    expect(Object.keys(parsed)).toEqual(["id", "kind", "original_snippet"]);
  });
});

describe("PruningInput", () => {
  it("slow / fast 必須、setup / id / timeout_ms / max_iterations は任意 (EquivalenceInput precedent に揃える)", () => {
    const minimal: PruningInput = { slow: "x", fast: "x" };
    const full: PruningInput = {
      id: "case-01",
      slow: "arr[0]",
      fast: "arr[1]",
      setup: "const arr = [1, 2, 3];",
      timeout_ms: 5000,
      max_iterations: 100,
    };
    expect(minimal.setup).toBeUndefined();
    expect(full.setup).toBe("const arr = [1, 2, 3];");
    expect(full.max_iterations).toBe(100);
  });

  it("等価検証コンテキスト (environment / module_base_dir / mount_html) は任意で JSON 往復しても保持される", () => {
    const input: PruningInput = {
      slow: "x",
      fast: "x",
      timeout_ms: 5000,
      environment: "jsdom",
      module_base_dir: "/abs/data/selakovic-2016-issues/serverIssues/ChalkIssues/issues/issue_28",
      mount_html: "<div id=\"demo\"></div>",
    };
    const parsed = JSON.parse(JSON.stringify(input)) as PruningInput;
    expect(parsed).toStrictEqual(input);
    // 省略時は undefined (= 等価検証側のデフォルトに委ねる)
    const minimal: PruningInput = { slow: "x", fast: "x" };
    expect(minimal.environment).toBeUndefined();
    expect(minimal.module_base_dir).toBeUndefined();
  });
});

describe("ExecutionEnvironmentHint", () => {
  it("equivalence/preprocessing 契約と同じ \"vm\" | \"jsdom\" の union", () => {
    expectTypeOf<ExecutionEnvironmentHint>().toEqualTypeOf<"vm" | "jsdom">();
  });
});

describe("PruningResult", () => {
  it("pruned verdict は pattern_code / placeholders / iterations を含めて表現できる", () => {
    const result: PruningResult = {
      id: "case-01",
      verdict: PRUNING_VERDICT.PRUNED,
      pattern_code: "$VAR_1",
      placeholders: [
        { id: "$VAR_1", kind: PLACEHOLDER_KIND.EXPRESSION, original_snippet: "arr[0]" },
      ],
      iterations: 3,
      node_count_before: 10,
      node_count_after: 3,
      effective_timeout_ms: 5000,
      error_message: null,
    };
    expect(result.placeholders).toHaveLength(1);
  });

  it("initial_mismatch / error verdict は pattern 系フィールドなしでも成立する", () => {
    const mismatch: PruningResult = { verdict: PRUNING_VERDICT.INITIAL_MISMATCH };
    const error: PruningResult = {
      verdict: PRUNING_VERDICT.ERROR,
      error_message: "parse failed",
    };
    expect(mismatch.verdict).toBe("initial_mismatch");
    expect(error.error_message).toBe("parse failed");
  });
});
