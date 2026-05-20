/**
 * 対象: server-changed-fn strategy (ADR-0025、順 3-2) を実 Selakovic データで end-to-end 検証する。
 * 観点: single-file CommonJS lib (Chalk) の変更関数を組み立て → jsdom executor で実行 → 等価判定まで通るか。
 * 判定事項:
 *   - chalk-27a (self() の引数短絡、挙動保存) → equal、観測は self() 戻り値を多数捕捉 (空虚な equal でない)
 *   - 同 setup で fast を真に非等価な body に差し替え → not_equal (観測が挙動を弁別している反証)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { checkEquivalence } from "../../src/equivalence-checker/selakovic/checker";
import { findChangeUnits, type FnChangeUnit } from "../../src/preprocessing/common/change-units";
import { buildServerChangedFnCandidate } from "../../src/preprocessing/selakovic/assemble/strategies/server-changed-fn";

const ISSUE_DIR = join(
  __dirname,
  "../../../data/selakovic-2016-issues/serverIssues/ChalkIssues/issues/issue_27a",
);

function buildChalk27aCandidate() {
  const libBefore = readFileSync(join(ISSUE_DIR, "chalk_before.js"), "utf-8");
  const libAfter = readFileSync(join(ISSUE_DIR, "chalk_after.js"), "utf-8");
  const testCaseAfter = readFileSync(join(ISSUE_DIR, "test_case_after.js"), "utf-8");
  const cu = findChangeUnits(libBefore, libAfter);
  const unit = cu.units
    .filter((u): u is FnChangeUnit => u.kind === "fn")
    .find((u) => u.name === "self");
  if (unit === undefined) throw new Error("expected named-FE 'self' fn unit");
  return buildServerChangedFnCandidate(unit, libAfter, testCaseAfter);
}

describe("server-changed-fn × chalk-27a (integration)", () => {
  it("self() の引数短絡 diff を組み立て→jsdom 実行→equal、観測は self() 戻り値を多数捕捉する", async () => {
    const candidate = buildChalk27aCandidate();
    expect(candidate.candidate_excluded).toBeUndefined();
    expect(candidate.candidate_meta.is_workload_reachable).toBe(true);

    const result = await checkEquivalence({
      setup: candidate.setup!,
      slow: candidate.slow!,
      fast: candidate.fast!,
      workload: candidate.workload!,
      environment: "jsdom",
      module_base_dir: ISSUE_DIR,
      timeout_ms: 15_000,
    });

    expect(result.verdict).toBe("equal");
    const returnObs = result.observations?.find((o) => o.oracle === "return_value");
    expect(returnObs?.slow_value).toBeTruthy();
    expect(returnObs!.slow_value!.length).toBeGreaterThan(500);
    expect(returnObs!.slow_value).toContain("foo");
  });

  it("fast を真に非等価な body に差し替えると not_equal (観測が機能している反証)", async () => {
    const candidate = buildChalk27aCandidate();
    const result = await checkEquivalence({
      setup: candidate.setup!,
      slow: candidate.slow!,
      fast: "return '';",
      workload: candidate.workload!,
      environment: "jsdom",
      module_base_dir: ISSUE_DIR,
      timeout_ms: 15_000,
    });
    expect(result.verdict).toBe("not_equal");
  });
});
