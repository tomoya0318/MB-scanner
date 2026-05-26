/**
 * 対象: server-changed-fn strategy (ADR-0025、順 3-2) を実 Selakovic データで end-to-end 検証する。
 * 観点: single-file CommonJS lib (Chalk) の変更関数を組み立て → jsdom executor で実行 → 等価判定まで通るか。
 * 判定事項:
 *   - chalk-27a (self() の引数短絡、挙動保存) → equal、観測は self() 戻り値を多数捕捉 (空虚な equal でない)
 *   - 同 setup で fast を真に非等価な body に差し替え → not_equal (観測が挙動を弁別している反証)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, it, expect } from "vitest";

import { checkEquivalence } from "../../src/equivalence-checker/selakovic/checker";
import { findChangeUnits, type FnChangeUnit } from "../../src/preprocessing/common/change-units";
import { buildServerChangedFnCandidate } from "../../src/preprocessing/selakovic/assemble/strategies/server-changed-fn";

function readDirJs(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === ".git") continue;
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (e.endsWith(".js")) out[relative(root, full)] = readFileSync(full, "utf-8");
    }
  };
  walk(root);
  return out;
}

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
  return buildServerChangedFnCandidate({
    unit,
    changedFileKey: "chalk.js",
    changedFileAfterSrc: libAfter,
    otherAfterFiles: {},
    entryKey: "chalk.js",
    testCaseSource: testCaseAfter,
  });
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

const CHEERIO_DIR = join(
  __dirname,
  "../../../data/selakovic-2016-issues/serverIssues/CheerioIssues/issues/issue_386b",
);

function buildCheerio386bCandidate() {
  const afterFiles = readDirJs(join(CHEERIO_DIR, "cheerio_after"));
  const changedKey = "lib/api/attributes.js";
  const beforeSrc = readFileSync(join(CHEERIO_DIR, "cheerio_before", changedKey), "utf-8");
  const afterSrc = afterFiles[changedKey]!;
  const testCaseAfter = readFileSync(join(CHEERIO_DIR, "test_case_after.js"), "utf-8");
  const cu = findChangeUnits(beforeSrc, afterSrc);
  const unit = cu.units
    .filter((u): u is FnChangeUnit => u.kind === "fn")
    .find((u) => u.name === "exports.removeClass");
  if (unit === undefined) throw new Error("expected 'exports.removeClass' fn unit");
  const otherFiles = { ...afterFiles };
  delete otherFiles[changedKey];
  return buildServerChangedFnCandidate({
    unit,
    changedFileKey: changedKey,
    changedFileAfterSrc: afterSrc,
    otherAfterFiles: otherFiles,
    entryKey: "index.js",
    testCaseSource: testCaseAfter,
  });
}

describe("server-changed-fn × cheerio-386b (integration, multi-file + post-state)", () => {
  it("removeClass (_.difference→indexOf/splice) を multi-file 穴あけ→jsdom 実行→post-state で equal に到達する", async () => {
    const candidate = buildCheerio386bCandidate();
    expect(candidate.candidate_excluded).toBeUndefined();
    const result = await checkEquivalence({
      setup: candidate.setup!,
      slow: candidate.slow!,
      fast: candidate.fast!,
      workload: candidate.workload!,
      environment: "jsdom",
      module_base_dir: CHEERIO_DIR,
      timeout_ms: 20_000,
    });
    expect(result.verdict).toBe("equal");
    // post-state (s チャネル) が class 状態を捉えている: 観測に class 属性が出る
    const obs = result.observations?.find((o) => o.oracle === "return_value");
    expect(obs?.slow_value).toContain("class");
  });

  it("removeClass を「除去しない」に差し替えると post-state が変わり not_equal (mutation 観測の反証)", async () => {
    const candidate = buildCheerio386bCandidate();
    const result = await checkEquivalence({
      setup: candidate.setup!,
      slow: candidate.slow!,
      // 元の class を一切いじらず this を返すだけ → post-state が before と変わる
      fast: "return this;",
      workload: candidate.workload!,
      environment: "jsdom",
      module_base_dir: CHEERIO_DIR,
      timeout_ms: 20_000,
    });
    expect(result.verdict).toBe("not_equal");
  });
});

describe("空観測 → inconclusive (ADR-0018 positive-evidence 厳密化、Fix A/B)", () => {
  it("変更関数が workload で呼ばれず init 戻り値も無い (r 空 + s 空) → equal でなく inconclusive", async () => {
    // 変更関数 onlyState は test_case から呼ばれない (test は無関係な計算をするだけ)。
    // init も観測可能な状態を返さない → r=[], s=空 → 空観測 → undefined return → return_value N/A。
    const libBefore = `var lib = module.exports;\nlib.onlyState = function () { return 1; };\nlib.unused = function () { return wrap(function self() { return 1; }); };`;
    const libAfter = `var lib = module.exports;\nlib.onlyState = function () { return 1; };\nlib.unused = function () { return wrap(function self() { return 2; }); };`;
    const testCase = `exports.test = function () { return 1 + 1; };`; // lib を一切呼ばない
    const cu = findChangeUnits(libBefore, libAfter);
    const unit = cu.units.filter((u): u is FnChangeUnit => u.kind === "fn" && u.afterFn !== null)[0]!;
    const candidate = buildServerChangedFnCandidate({
      unit,
      changedFileKey: "lib.js",
      changedFileAfterSrc: libAfter,
      otherAfterFiles: {},
      entryKey: "lib.js",
      testCaseSource: testCase,
    });
    const result = await checkEquivalence({
      setup: candidate.setup!,
      slow: candidate.slow!,
      fast: candidate.fast!,
      workload: candidate.workload!,
      environment: "jsdom",
      timeout_ms: 10_000,
    });
    expect(result.verdict).toBe("inconclusive");
  });
});
