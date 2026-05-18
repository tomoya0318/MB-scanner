import type { File, Node, Statement } from "@babel/types";

import { countNodes } from "../../../../ast/inspect";
import { parse } from "../../../../ast/parser";
import { canonicalHash } from "../../../../ast/subtree-hash";
import {
  EXCLUSION_REASON_BASE,
  SELAKOVIC_EXCLUSION_REASON,
  TARGET_SIDE,
  type ExclusionReasonAny,
  type PreprocessingCandidate,
} from "../../../../contracts/preprocessing-contracts";
import { findChangedNodes } from "../../../common/ast-diff";
import { findMinimalEnclosure } from "../../../common/enclosure";
import { statementToCode, statementsToCode } from "../../../common/setup-cleanup";

/**
 * 段2 が「①にも②にも実質差がない / `f1`・`test` が規約外フォーマット」と判定した issue 用の安全弁 —
 * Tier 1 の素の top-level statement AST diff だけで `(setup, slow, fast)` を切り出す (`assemble/` の
 * degenerate 版、ADR-0011 §段2)。
 *
 * **statement 対応付け戦略**: top-level statement の canonical hash で greedy match → matched
 * (= 不変) を除外 → 残った unmatched-before / unmatched-after を順序対応で組合せて candidate にする。
 *
 * **setup 構築規約**: 各 candidate の setup = 「自分以外の全 top-level statement の before 版を
 * index 順に結合」(ADR-0010、「他の最適化対象は最適化前で固定」)。
 *
 * adapter_meta:
 *  - target_side = both (fallback は lib/workload 両方の patch を含みうる top-level diff、ADR-0024 §D-2)
 *  - is_workload_reachable = false (changed-fn 抽出経路ではない)
 */

/** 抽出失敗時の戻り値: `(candidates, issueExcluded)` のペア。 */
export interface FallbackResult {
  candidates: PreprocessingCandidate[];
  /** issue 全体が処理失敗の場合は理由コード、成功 (= candidates が空でない) の場合は null。 */
  issue_excluded?: ExclusionReasonAny;
  issue_excluded_detail?: string;
  /** 成功 / 失敗いずれの場合も before/after の AST ノード数を返す (集計用)。 */
  before_node_count?: number;
  after_node_count?: number;
}

export function extractFromScripts(beforeScript: string, afterScript: string): FallbackResult {
  let beforeAst: File;
  let afterAst: File;
  try {
    beforeAst = parse(beforeScript);
    afterAst = parse(afterScript);
  } catch (e) {
    const message = e instanceof Error ? e.message : "parse failed";
    return { candidates: [], issue_excluded: EXCLUSION_REASON_BASE.PARSE_ERROR, issue_excluded_detail: message };
  }

  const beforeNodeCount = countNodes(beforeAst);
  const afterNodeCount = countNodes(afterAst);

  const beforeBody = beforeAst.program.body;
  const afterBody = afterAst.program.body;

  const beforeHashes = beforeBody.map(canonicalHash);
  const afterHashes = afterBody.map(canonicalHash);

  const beforeMatched = new Set<number>();
  const afterMatched = new Set<number>();
  for (let i = 0; i < beforeBody.length; i++) {
    for (let j = 0; j < afterBody.length; j++) {
      if (afterMatched.has(j)) continue;
      if (beforeHashes[i] === afterHashes[j]) {
        beforeMatched.add(i);
        afterMatched.add(j);
        break;
      }
    }
  }

  const unmatchedBeforeIdx = beforeBody.map((_, i) => i).filter((i) => !beforeMatched.has(i));
  const unmatchedAfterIdx = afterBody.map((_, i) => i).filter((i) => !afterMatched.has(i));

  const candidates: CandidateRecord[] = [];
  const minU = Math.min(unmatchedBeforeIdx.length, unmatchedAfterIdx.length);
  for (let k = 0; k < minU; k++) {
    const beforeIdx = unmatchedBeforeIdx[k];
    const afterIdx = unmatchedAfterIdx[k];
    if (beforeIdx === undefined || afterIdx === undefined) continue;
    const beforeStmt = beforeBody[beforeIdx];
    const afterStmt = afterBody[afterIdx];
    if (beforeStmt === undefined || afterStmt === undefined) continue;

    const stmtChanged = findChangedNodesForStatement(beforeStmt, afterStmt);
    if (stmtChanged === null || stmtChanged.size === 0) continue;

    const enclosureType = findEnclosureForStatement(beforeStmt, stmtChanged);
    if (enclosureType === null) continue;

    candidates.push({ beforeIndex: beforeIdx, afterIndex: afterIdx, beforeStmt, afterStmt, enclosureType });
  }

  if (candidates.length === 0) {
    if (unmatchedBeforeIdx.length === 0 && unmatchedAfterIdx.length === 0) {
      return {
        candidates: [],
        issue_excluded: EXCLUSION_REASON_BASE.NO_CHANGED_NODES,
        issue_excluded_detail: "all top-level statements matched (formatting/comment only changes)",
        before_node_count: beforeNodeCount,
        after_node_count: afterNodeCount,
      };
    }
    return {
      candidates: [],
      issue_excluded: SELAKOVIC_EXCLUSION_REASON.MODULE_WIDE_CHANGE,
      issue_excluded_detail: `${unmatchedBeforeIdx.length} before / ${unmatchedAfterIdx.length} after unmatched statements without enclosure (no Function/Method, Block, nor top-level statement candidate matched)`,
      before_node_count: beforeNodeCount,
      after_node_count: afterNodeCount,
    };
  }

  const out: PreprocessingCandidate[] = candidates.map((c) => {
    const setupStatements = beforeBody.filter((_, idx) => idx !== c.beforeIndex);
    return {
      setup: statementsToCode(setupStatements),
      slow: statementToCode(c.beforeStmt),
      fast: statementToCode(c.afterStmt),
      enclosure_node_type: c.enclosureType,
      before_node_count: beforeNodeCount,
      after_node_count: afterNodeCount,
      candidate_meta: { adapter: "selakovic", target_side: TARGET_SIDE.BOTH, is_workload_reachable: false },
    };
  });
  return { candidates: out, before_node_count: beforeNodeCount, after_node_count: afterNodeCount };
}

export function extractFromServerFiles(
  beforeFiles: Record<string, string>,
  afterFiles: Record<string, string>,
): FallbackResult {
  const commonKeys = Object.keys(beforeFiles).filter((k) => k in afterFiles);
  if (commonKeys.length === 0) {
    return {
      candidates: [],
      issue_excluded: EXCLUSION_REASON_BASE.MISSING_FILES,
      issue_excluded_detail: "no common .js files between before/after",
    };
  }

  const filesWithChanges: string[] = [];
  for (const key of commonKeys) {
    const before = beforeFiles[key];
    const after = afterFiles[key];
    if (before === undefined || after === undefined) continue;
    if (before === after) continue;
    filesWithChanges.push(key);
  }

  if (filesWithChanges.length === 0) {
    return {
      candidates: [],
      issue_excluded: EXCLUSION_REASON_BASE.NO_CHANGED_NODES,
      issue_excluded_detail: "all common files are byte-identical",
    };
  }

  const semanticChanges: Array<{ key: string; result: FallbackResult }> = [];
  for (const key of filesWithChanges) {
    const before = beforeFiles[key];
    const after = afterFiles[key];
    if (before === undefined || after === undefined) continue;
    const result = extractFromScripts(before, after);
    if (result.candidates.length === 0 && result.issue_excluded === EXCLUSION_REASON_BASE.NO_CHANGED_NODES) continue;
    semanticChanges.push({ key, result });
  }

  if (semanticChanges.length === 0) {
    return {
      candidates: [],
      issue_excluded: EXCLUSION_REASON_BASE.NO_CHANGED_NODES,
      issue_excluded_detail: "no semantic changes (formatting/comment only)",
    };
  }
  if (semanticChanges.length > 1) {
    return {
      candidates: [],
      issue_excluded: EXCLUSION_REASON_BASE.MULTI_FILE_CHANGE,
      issue_excluded_detail: `changes span ${semanticChanges.length} files: ${semanticChanges.map((c) => c.key).join(", ")}`,
    };
  }
  const onlyChange = semanticChanges[0];
  if (onlyChange === undefined) {
    return {
      candidates: [],
      issue_excluded: EXCLUSION_REASON_BASE.MISSING_FILES,
      issue_excluded_detail: "internal: empty semanticChanges",
    };
  }
  return onlyChange.result;
}

interface CandidateRecord {
  readonly beforeIndex: number;
  readonly afterIndex: number;
  readonly beforeStmt: Statement;
  readonly afterStmt: Statement;
  readonly enclosureType: string;
}

function findChangedNodesForStatement(beforeStmt: Statement, afterStmt: Statement): Set<Node> | null {
  return findChangedNodes(wrapAsFile(beforeStmt), wrapAsFile(afterStmt));
}

function findEnclosureForStatement(beforeStmt: Statement, changed: Set<Node>): string | null {
  const result = findMinimalEnclosure(wrapAsFile(beforeStmt), changed);
  return result?.enclosureType ?? null;
}

function wrapAsFile(stmt: Statement): File {
  return {
    type: "File",
    program: { type: "Program", body: [stmt], directives: [], sourceType: "script" },
    comments: [],
    errors: [],
  } as unknown as File;
}
