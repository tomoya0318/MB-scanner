/**
 * 順 1-d (no-fn-unit rescue) の end-to-end 検証: changed-stmt strategy が組んだ candidate を
 * `checkEquivalence` に通し、stmt の変更が verdict に反映されることを確認する。
 *
 * Copilot review #1 (observer 機構欠落で常に equal) の回帰防止: full-observation 形 (reachable fn 群を
 * observer 化) によって binding 値の差が verdict=not_equal として観測されることを担保する。
 *
 * 設計: ai-guide/adr/0023-preprocess-placeholder-substitution.md (§設計のポイント stmt unit full-observation 形)
 */
import { describe, expect, it } from "vitest";

import { checkEquivalence } from "../../src/equivalence-checker/selakovic/checker";
import { preprocess } from "../../src/preprocessing/selakovic/pipeline";
import type { PreprocessingCandidate } from "../../src/contracts/preprocessing-contracts";

/** client issue の preprocess input を組む薄いヘルパ。 */
function clientInput(libBefore: string, libAfter: string, inline: string) {
  return {
    kind: "client" as const,
    before_inline: inline,
    after_inline: inline,
    lib_before_files: { "lib.js": libBefore },
    lib_after_files: { "lib.js": libAfter },
    lib_kind: "file" as const,
    lib_referenced_by_workload: true,
  };
}

/** preprocess 結果から changed-stmt 由来の candidate (is_workload_reachable=true, excluded でない) を 1 件取る。 */
function changedStmtCandidate(libBefore: string, libAfter: string, inline: string): PreprocessingCandidate {
  const result = preprocess(clientInput(libBefore, libAfter, inline));
  const c = result.candidates.find(
    (x) => x.candidate_excluded === undefined && x.candidate_meta.is_workload_reachable && x.workload != null,
  );
  if (!c) throw new Error("no changed-stmt candidate produced");
  return c;
}

describe("no-fn-unit rescue (順 1-d) — changed-stmt end-to-end verdict", () => {
  const inline = `var f1 = function () { lib.get(); };\nvar a = execute(f1, 10);`;

  it("reachable fn が読む module-level binding の差 → verdict=not_equal (Copilot #1 回帰防止)", async () => {
    const libBefore = `var KEY = 'foo';\nvar lib = {};\nlib.get = function () { return KEY; };`;
    const libAfter = `var KEY = 'bar';\nvar lib = {};\nlib.get = function () { return KEY; };`;
    const candidate = changedStmtCandidate(libBefore, libAfter, inline);

    const result = await checkEquivalence({
      setup: candidate.setup!,
      slow: candidate.slow!,
      fast: candidate.fast!,
      workload: candidate.workload!,
      timeout_ms: 5000,
    });

    expect(result.verdict).toBe("not_equal");
  });

  it("誰も読まない binding の変更 → reachable でないので changed-stmt candidate は出ず CHANGE_NOT_EXERCISED marker", () => {
    // KEY の値は同じだがコメント等の incidental 差を作る。reachable fn の戻り値は両側同じなので equal。
    const libBefore = `var KEY = 'same';\nvar lib = {};\nlib.get = function () { return KEY; };\nvar UNUSED = 1;`;
    const libAfter = `var KEY = 'same';\nvar lib = {};\nlib.get = function () { return KEY; };\nvar UNUSED = 2;`;
    // UNUSED の変更が stmt unit になるが、lib.get は KEY だけ読むので UNUSED は workload に伝播しない。
    // ただし UNUSED が reachable 判定されなければ candidate 化されず、ここは「reachable だが伝播しない」確認用。
    const result = preprocess(clientInput(libBefore, libAfter, inline));
    const stmtCandidates = result.candidates.filter(
      (x) => x.candidate_excluded === undefined && x.candidate_meta.is_workload_reachable && x.workload != null,
    );
    // UNUSED は誰も読まないので reachable でない → changed-stmt candidate は出ない (CHANGE_NOT_EXERCISED marker)
    expect(stmtCandidates.length).toBe(0);
    expect(
      result.candidates.some((x) => x.candidate_excluded === "change-not-exercised"),
    ).toBe(true);
  });
});
