/**
 * 対象: src/contracts/preprocessing-contracts.ts (Python ↔ TypeScript の JSON 契約、ADR-0024)
 * 観点: Python 側 Pydantic StrEnum と同じ文字列値・同じ union 幅で型が narrow されていること
 * 判定事項:
 *   - LAYOUT_KIND / EXCLUSION_REASON_BASE / SELAKOVIC_EXCLUSION_REASON / TARGET_SIDE / WRAPPER_KIND:
 *     Python 側 StrEnum と同一の文字列値 (runtime)
 *   - 各 type union が Python と同じ列挙幅 (型レベル)
 *   - PreprocessingInput: issue_dir 必須、id は任意
 *   - PreprocessingIssueResult / PreprocessingCandidate: 新階層構造の整合
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ASPECT,
  EXCLUSION_REASON_BASE,
  LAYOUT_KIND,
  SELAKOVIC_EXCLUSION_REASON,
  TARGET_SIDE,
  WRAPPER_KIND,
  type Aspect,
  type ExclusionReasonAny,
  type ExclusionReasonBase,
  type PreprocessingCandidate,
  type PreprocessingInput,
  type PreprocessingIssueResult,
  type SelakovicCandidateMeta,
  type SelakovicExclusionReason,
  type SelakovicIssueMeta,
  type TargetSide,
  type WrapperKind,
} from "../../src/contracts/preprocessing-contracts";

describe("LAYOUT_KIND", () => {
  it("Python 側 LayoutKind StrEnum と同じ文字列値を持つ", () => {
    expect(LAYOUT_KIND).toStrictEqual({
      CLIENT: "client",
      SERVER: "server",
      UNKNOWN: "unknown",
    });
  });
});

describe("EXCLUSION_REASON_BASE", () => {
  it("Python 側 ExclusionReasonBase StrEnum と同じ文字列値を持つ", () => {
    expect(EXCLUSION_REASON_BASE).toStrictEqual({
      PARSE_ERROR: "parse-error",
      NO_CHANGED_NODES: "no-changed-nodes",
      MULTI_FILE_CHANGE: "multi-file-change",
      MISSING_FILES: "missing-files",
    });
  });

  it("ExclusionReasonBase 型が 4 値の union", () => {
    expectTypeOf<ExclusionReasonBase>().toEqualTypeOf<
      "parse-error" | "no-changed-nodes" | "multi-file-change" | "missing-files"
    >();
  });
});

describe("SELAKOVIC_EXCLUSION_REASON", () => {
  it("Python 側 SelakovicExclusionReason StrEnum と同じ文字列値を持つ (ADR-0023 D-γ §DROP 可視化で 4 → 12 値に拡張)", () => {
    expect(SELAKOVIC_EXCLUSION_REASON).toStrictEqual({
      MODULE_WIDE_CHANGE: "module-wide-change",
      NO_ENCLOSURE_CANDIDATE: "no-enclosure-candidate",
      LAYOUT_UNKNOWN: "layout-unknown",
      CHANGE_NOT_EXERCISED: "change-not-exercised",
      NO_LIB_SOURCE: "no-lib-source",
      ANGULAR_WRAPPER_SKIP: "angular-wrapper-skip",
      CHANGE_UNITS_PARSE_FAIL: "change-units-parse-fail",
      EMPTY_DIFF: "empty-diff",
      NO_FN_UNIT: "no-fn-unit",
      UNIT_RENAMED_OR_REMOVED: "unit-renamed-or-removed",
      FN_NON_BLOCK_BODY: "fn-non-block-body",
      FN_PARAM_NAMES_MISMATCH: "fn-param-names-mismatch",
    });
  });

  it("SelakovicExclusionReason 型が 12 値の union", () => {
    expectTypeOf<SelakovicExclusionReason>().toEqualTypeOf<
      | "module-wide-change"
      | "no-enclosure-candidate"
      | "layout-unknown"
      | "change-not-exercised"
      | "no-lib-source"
      | "angular-wrapper-skip"
      | "change-units-parse-fail"
      | "empty-diff"
      | "no-fn-unit"
      | "unit-renamed-or-removed"
      | "fn-non-block-body"
      | "fn-param-names-mismatch"
    >();
  });

  it("ExclusionReasonAny は base 4 値 + Selakovic 4 値 (合計 8 値)", () => {
    expectTypeOf<ExclusionReasonAny>().toEqualTypeOf<ExclusionReasonBase | SelakovicExclusionReason>();
  });
});

describe("ASPECT", () => {
  it("Python 側 Aspect StrEnum と同じ文字列値を持つ", () => {
    expect(ASPECT).toStrictEqual({
      LIB: "lib",
      WORKLOAD: "workload",
      BOTH: "lib+workload",
      FALLBACK: "fallback",
    });
  });

  it("Aspect 型が 4 値の union", () => {
    expectTypeOf<Aspect>().toEqualTypeOf<"lib" | "workload" | "lib+workload" | "fallback">();
  });
});

describe("TARGET_SIDE", () => {
  it("Python 側 TargetSide StrEnum と同じ文字列値を持つ", () => {
    expect(TARGET_SIDE).toStrictEqual({
      LIB: "lib",
      WORKLOAD: "workload",
      BOTH: "both",
    });
  });

  it("TargetSide 型が 3 値の union", () => {
    expectTypeOf<TargetSide>().toEqualTypeOf<"lib" | "workload" | "both">();
  });
});

describe("WRAPPER_KIND", () => {
  it("Python 側 WrapperKind StrEnum と同じ文字列値を持つ", () => {
    expect(WRAPPER_KIND).toStrictEqual({
      TOP_LEVEL: "top_level",
      ANGULAR_CONTROLLER_WRAPPER: "angular_controller_wrapper",
    });
  });

  it("WrapperKind 型が 2 値の union", () => {
    expectTypeOf<WrapperKind>().toEqualTypeOf<"top_level" | "angular_controller_wrapper">();
  });
});

describe("PreprocessingInput", () => {
  it("issue_dir 必須、id は任意", () => {
    const minimal: PreprocessingInput = { issue_dir: "/tmp/issue-1" };
    const withId: PreprocessingInput = { id: "case-01", issue_dir: "/tmp/issue-1" };
    expect(minimal.id).toBeUndefined();
    expect(withId.id).toBe("case-01");
  });
});

describe("SelakovicIssueMeta", () => {
  it("layout / aspect / wrapper_kind を含む", () => {
    const m: SelakovicIssueMeta = {
      adapter: "selakovic",
      layout: LAYOUT_KIND.CLIENT,
      aspect: ASPECT.LIB,
      wrapper_kind: WRAPPER_KIND.TOP_LEVEL,
    };
    expect(m.adapter).toBe("selakovic");
    expect(m.aspect).toBe("lib");
  });
});

describe("SelakovicCandidateMeta", () => {
  it("target_side / is_workload_reachable を含む", () => {
    const m: SelakovicCandidateMeta = {
      adapter: "selakovic",
      target_side: TARGET_SIDE.LIB,
      is_workload_reachable: true,
    };
    expect(m.target_side).toBe("lib");
    expect(m.is_workload_reachable).toBe(true);
  });
});

describe("PreprocessingCandidate", () => {
  it("setup / slow / fast / candidate_meta を含む candidate を表現できる", () => {
    const c: PreprocessingCandidate = {
      setup: "const arr = [1, 2, 3];",
      slow: "arr[0]",
      fast: "arr[1]",
      enclosure_node_type: "FunctionExpression",
      before_node_count: 12,
      after_node_count: 10,
      candidate_meta: {
        adapter: "selakovic",
        target_side: TARGET_SIDE.WORKLOAD,
        is_workload_reachable: false,
      },
    };
    expect(c.setup).toBe("const arr = [1, 2, 3];");
    expect(c.candidate_meta.target_side).toBe("workload");
  });

  it("candidate_excluded のみで成立する (setup / slow / fast 省略可)", () => {
    const c: PreprocessingCandidate = {
      candidate_excluded: SELAKOVIC_EXCLUSION_REASON.CHANGE_NOT_EXERCISED,
      candidate_meta: {
        adapter: "selakovic",
        target_side: TARGET_SIDE.LIB,
        is_workload_reachable: false,
      },
    };
    expect(c.candidate_excluded).toBe("change-not-exercised");
    expect(c.slow).toBeUndefined();
  });

  it("workload (ADR-0023 D-β placeholder substitution + 4 値契約) は任意で changed-fn 経路でのみ定義", () => {
    const changedFn: PreprocessingCandidate = {
      setup: "var lib = { f: function () { $BODY$ } };",
      slow: "__OBS__.push(1); return 1;",
      fast: "__OBS__.push(2); return 2;",
      workload: "(function(){ __OBS__ = []; lib.f(); return JSON.stringify(__OBS__); })()",
      candidate_meta: {
        adapter: "selakovic",
        target_side: TARGET_SIDE.LIB,
        is_workload_reachable: true,
      },
    };
    expect(changedFn.workload).toContain("__OBS__");
    expect(changedFn.setup).toContain("$BODY$");
    // 旧経路の candidate は workload 未定義
    const embedded: PreprocessingCandidate = {
      setup: "var x=1;",
      slow: "x",
      fast: "x",
      candidate_meta: {
        adapter: "selakovic",
        target_side: TARGET_SIDE.WORKLOAD,
        is_workload_reachable: false,
      },
    };
    expect(embedded.workload).toBeUndefined();
  });
});

describe("PreprocessingIssueResult", () => {
  it("candidates 配列と issue_meta を含む 1 issue を表現できる", () => {
    const r: PreprocessingIssueResult = {
      id: "case-01",
      candidates: [
        {
          setup: "var x=1;",
          slow: "x",
          fast: "x",
          candidate_meta: {
            adapter: "selakovic",
            target_side: TARGET_SIDE.WORKLOAD,
            is_workload_reachable: false,
          },
        },
      ],
      candidate_count: 1,
      issue_meta: {
        adapter: "selakovic",
        layout: LAYOUT_KIND.CLIENT,
        aspect: ASPECT.WORKLOAD,
        wrapper_kind: WRAPPER_KIND.TOP_LEVEL,
      },
    };
    expect(r.candidate_count).toBe(1);
    expect(r.candidates[0]?.candidate_meta.target_side).toBe("workload");
  });

  it("issue_excluded で issue 全体の処理失敗を表現できる (issue_meta は省略可)", () => {
    const r: PreprocessingIssueResult = {
      id: "case-01",
      issue_excluded: SELAKOVIC_EXCLUSION_REASON.LAYOUT_UNKNOWN,
      issue_excluded_detail: "no v_*.html",
      candidates: [],
      candidate_count: 0,
    };
    expect(r.issue_excluded).toBe("layout-unknown");
    expect(r.candidates).toEqual([]);
    expect(r.issue_meta).toBeUndefined();
  });

  it("JSON 往復でフィールドが保持される", () => {
    const r: PreprocessingIssueResult = {
      id: "case-01",
      candidates: [],
      candidate_count: 0,
      issue_meta: {
        adapter: "selakovic",
        layout: LAYOUT_KIND.SERVER,
        aspect: ASPECT.LIB,
        wrapper_kind: WRAPPER_KIND.TOP_LEVEL,
      },
    };
    const parsed = JSON.parse(JSON.stringify(r)) as PreprocessingIssueResult;
    expect(parsed.id).toBe("case-01");
    expect(parsed.issue_meta?.layout).toBe("server");
  });
});
