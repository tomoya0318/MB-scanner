import type { File, Node, Statement } from "@babel/types";

import { countNodes } from "../../../ast/inspect";
import { parse } from "../../../ast/parser";
import { canonicalHash } from "../../../ast/subtree-hash";
import {
  EXCLUSION_REASON,
  LAYOUT_KIND,
  type ExclusionReason,
  type LayoutKind,
  type PreprocessingResult,
} from "../../../contracts/preprocessing-contracts";
import { findChangedNodes } from "../../common/ast-diff";
import { findMinimalEnclosure } from "../../common/enclosure";
import { statementToCode, statementsToCode } from "../../common/setup-cleanup";

/**
 * Tier 1 の素の top-level statement AST diff だけで `(setup, slow, fast)` を切り出す
 * フォールバック経路 (ADR-0011 §段2 の「①にも②にも実質差がない / 規約外フォーマット」分岐)。
 *
 * 元は `selakovic/pipeline.ts` の `preprocess()` 本体だったロジック。ADR-0011 で Tier 2 を
 * 段1/段2 構成に改修した際、規約外 issue 用の安全弁としてここ (= `assemble/` の degenerate 版) に
 * 退避した。挙動は無変更。
 *
 * **statement 対応付け戦略**: top-level statement の canonical hash で greedy match → matched
 * (= 不変) を除外 → 残った unmatched-before / unmatched-after を順序対応で組合せて candidate にする。
 *
 * **setup 構築規約**: 各 candidate の setup = 「自分以外の全 top-level statement の before 版を
 * index 順に結合」(ADR-0010、「他の最適化対象は最適化前で固定」)。
 */

export function extractFromScripts(
  beforeScript: string,
  afterScript: string,
  layout: LayoutKind,
): PreprocessingResult[] {
  let beforeAst: File;
  let afterAst: File;
  try {
    beforeAst = parse(beforeScript);
    afterAst = parse(afterScript);
  } catch (e) {
    const message = e instanceof Error ? e.message : "parse failed";
    return [excluded(layout, EXCLUSION_REASON.PARSE_ERROR, message)];
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
      return [
        {
          layout,
          excluded: EXCLUSION_REASON.NO_CHANGED_NODES,
          excluded_detail: "all top-level statements matched (formatting/comment only changes)",
          before_node_count: beforeNodeCount,
          after_node_count: afterNodeCount,
        },
      ];
    }
    return [
      {
        layout,
        excluded: EXCLUSION_REASON.MODULE_WIDE_CHANGE,
        excluded_detail: `${unmatchedBeforeIdx.length} before / ${unmatchedAfterIdx.length} after unmatched statements without enclosure (no Function/Method, Block, nor top-level statement candidate matched)`,
        before_node_count: beforeNodeCount,
        after_node_count: afterNodeCount,
      },
    ];
  }

  return candidates.map((c) => {
    const setupStatements = beforeBody.filter((_, idx) => idx !== c.beforeIndex);
    return {
      layout,
      setup: statementsToCode(setupStatements),
      slow: statementToCode(c.beforeStmt),
      fast: statementToCode(c.afterStmt),
      enclosure_type: c.enclosureType,
      before_node_count: beforeNodeCount,
      after_node_count: afterNodeCount,
    };
  });
}

export function extractFromServerFiles(
  beforeFiles: Record<string, string>,
  afterFiles: Record<string, string>,
): PreprocessingResult[] {
  const commonKeys = Object.keys(beforeFiles).filter((k) => k in afterFiles);
  if (commonKeys.length === 0) {
    return [excluded(LAYOUT_KIND.SERVER, EXCLUSION_REASON.MISSING_FILES, "no common .js files between before/after")];
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
    return [excluded(LAYOUT_KIND.SERVER, EXCLUSION_REASON.NO_CHANGED_NODES, "all common files are byte-identical")];
  }

  const semanticChanges: Array<{ key: string; results: PreprocessingResult[] }> = [];
  for (const key of filesWithChanges) {
    const before = beforeFiles[key];
    const after = afterFiles[key];
    if (before === undefined || after === undefined) continue;
    const results = extractFromScripts(before, after, LAYOUT_KIND.SERVER);
    if (results.length === 1 && results[0]?.excluded === EXCLUSION_REASON.NO_CHANGED_NODES) continue;
    semanticChanges.push({ key, results });
  }

  if (semanticChanges.length === 0) {
    return [excluded(LAYOUT_KIND.SERVER, EXCLUSION_REASON.NO_CHANGED_NODES, "no semantic changes (formatting/comment only)")];
  }
  if (semanticChanges.length > 1) {
    return [
      excluded(
        LAYOUT_KIND.SERVER,
        EXCLUSION_REASON.MULTI_FILE_CHANGE,
        `changes span ${semanticChanges.length} files: ${semanticChanges.map((c) => c.key).join(", ")}`,
      ),
    ];
  }
  const onlyChange = semanticChanges[0];
  if (onlyChange === undefined) {
    return [excluded(LAYOUT_KIND.SERVER, EXCLUSION_REASON.MISSING_FILES, "internal: empty semanticChanges")];
  }
  return onlyChange.results;
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

function excluded(layout: LayoutKind, reason: ExclusionReason, detail: string): PreprocessingResult {
  return { layout, excluded: reason, excluded_detail: detail };
}
