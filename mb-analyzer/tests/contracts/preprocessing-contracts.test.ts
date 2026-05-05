/**
 * 対象: src/contracts/preprocessing-contracts.ts (Python ↔ TypeScript の JSON 契約)
 * 観点: Python 側 Pydantic StrEnum と同じ文字列値・同じ union 幅で型が narrow されていること
 * 判定事項:
 *   - LAYOUT_KIND / EXCLUSION_REASON: Python 側 StrEnum と同一の文字列値 (runtime)
 *   - LayoutKind / ExclusionReason: union 型が Python と同じ列挙幅 (型レベル)
 *   - PreprocessingInput: issue_dir 必須、id は任意 (paired-change の serialize 規則)
 *   - PreprocessingResult: layout 必須、それ以外は任意 (excluded ありなしの両系統が成立)
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  EXCLUSION_REASON,
  LAYOUT_KIND,
  type ExclusionReason,
  type LayoutKind,
  type PreprocessingInput,
  type PreprocessingResult,
} from "../../src/contracts/preprocessing-contracts";

describe("LAYOUT_KIND", () => {
  it("Python 側 LayoutKind StrEnum と同じ文字列値を持つ", () => {
    expect(LAYOUT_KIND).toStrictEqual({
      CLIENT: "client",
      SERVER: "server",
      UNKNOWN: "unknown",
    });
  });

  it("LayoutKind 型が 3 値の union として narrow される", () => {
    expectTypeOf<LayoutKind>().toEqualTypeOf<"client" | "server" | "unknown">();
  });
});

describe("EXCLUSION_REASON", () => {
  it("Python 側 ExclusionReason StrEnum と同じ文字列値を持つ", () => {
    expect(EXCLUSION_REASON).toStrictEqual({
      PARSE_ERROR: "parse-error",
      NO_CHANGED_NODES: "no-changed-nodes",
      MODULE_WIDE_CHANGE: "module-wide-change",
      MULTI_FILE_CHANGE: "multi-file-change",
      NO_ENCLOSURE_CANDIDATE: "no-enclosure-candidate",
      LAYOUT_UNKNOWN: "layout-unknown",
      MISSING_FILES: "missing-files",
    });
  });

  it("ExclusionReason 型が 7 値の union", () => {
    expectTypeOf<ExclusionReason>().toEqualTypeOf<
      | "parse-error"
      | "no-changed-nodes"
      | "module-wide-change"
      | "multi-file-change"
      | "no-enclosure-candidate"
      | "layout-unknown"
      | "missing-files"
    >();
  });
});

describe("PreprocessingInput", () => {
  it("issue_dir 必須、id は任意 (Python 側 PreprocessingInput と整合)", () => {
    const minimal: PreprocessingInput = { issue_dir: "/tmp/issue-1" };
    const withId: PreprocessingInput = { id: "case-01", issue_dir: "/tmp/issue-1" };
    expect(minimal.id).toBeUndefined();
    expect(withId.id).toBe("case-01");
  });

  it("JSON 往復でフィールド名と値が保持される", () => {
    const input: PreprocessingInput = { id: "case-01", issue_dir: "/abs/path" };
    const parsed = JSON.parse(JSON.stringify(input)) as PreprocessingInput;
    expect(parsed).toStrictEqual(input);
    expect(Object.keys(parsed).sort()).toEqual(["id", "issue_dir"]);
  });
});

describe("PreprocessingResult", () => {
  it("excluded なし (抽出成功) は slow / fast / setup / enclosure_type を含めて表現できる", () => {
    const ok: PreprocessingResult = {
      id: "case-01",
      layout: LAYOUT_KIND.CLIENT,
      slow: "arr[0]",
      fast: "arr[1]",
      setup: "const arr = [1, 2, 3];",
      enclosure_type: "FunctionDeclaration",
      before_node_count: 12,
      after_node_count: 10,
    };
    expect(ok.excluded).toBeUndefined();
    expect(ok.enclosure_type).toBe("FunctionDeclaration");
  });

  it("excluded あり (抽出失敗) は excluded / excluded_detail のみで成立する", () => {
    const excluded: PreprocessingResult = {
      layout: LAYOUT_KIND.UNKNOWN,
      excluded: EXCLUSION_REASON.LAYOUT_UNKNOWN,
      excluded_detail: "cannot determine layout",
    };
    expect(excluded.slow).toBeUndefined();
    expect(excluded.excluded).toBe("layout-unknown");
  });

  it("layout のみ必須 (id を含まない結果も成立)", () => {
    const minimal: PreprocessingResult = { layout: LAYOUT_KIND.SERVER };
    expect(minimal.id).toBeUndefined();
  });
});
