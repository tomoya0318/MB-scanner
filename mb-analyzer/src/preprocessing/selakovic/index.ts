import type { File, Node, Statement } from "@babel/types";

import { countNodes } from "../../ast/inspect";
import { parse } from "../../ast/parser";
import { canonicalHash } from "../../ast/subtree-hash";
import {
  EXCLUSION_REASON,
  LAYOUT_KIND,
  type ExclusionReason,
  type LayoutKind,
  type PreprocessingResult,
} from "../../contracts/preprocessing-contracts";
import { findChangedNodes } from "../common/ast-diff";
import { findMinimalEnclosure } from "../common/enclosure";
import { statementToCode, statementsToCode } from "../common/setup-cleanup";

/**
 * Selakovic 1 issue 分の (setup, slow, fast) 抽出。論文 Table 4 / precondition には
 * 一切依存せず、AST diff の minimal differential extraction だけで切り出す。
 *
 * **1 入力 → N 結果** モデル:
 * - 同一 PR に独立した最適化が複数同居するケース (例: socket.io 573 では encodePacket と
 *   decodePacket が同時最適化) を独立した抽出単位として出力する
 * - 1 candidate → 1 結果、N candidate → N 結果、抽出失敗 → 1 結果 (excluded)
 *
 * **statement 対応付け戦略**:
 * - top-level statement の canonical hash を計算し、ハッシュ一致するものを
 *   matched (= 不変) としてマーク
 * - 残った unmatched-before と unmatched-after を順序対応で組合せて candidate にする
 * - これにより before/after で statement 数が違うケース (デバッグ行追加・削除等) でも
 *   不変 statement を正しく除外して真の変更点を特定できる
 *
 * **setup 構築規約**:
 * - 各 candidate の setup = 「自分以外の全 top-level statement (matched + 他 unmatched)
 *   の before 版を index 順に結合」
 * - 「他の最適化対象は最適化前の状態を環境として固定」というメンタルモデル
 * - 両側 (slow/fast) の setup が同じなので、関数間依存があっても等価判定に影響しない
 */

export type SelakovicExtractInput =
  | { kind: "client"; before_script: string; after_script: string }
  | { kind: "server"; before_files: Record<string, string>; after_files: Record<string, string> };

export function extract(input: SelakovicExtractInput): PreprocessingResult[] {
  if (input.kind === "client") {
    return extractFromScripts(input.before_script, input.after_script, LAYOUT_KIND.CLIENT);
  }
  return extractFromServerFiles(input.before_files, input.after_files);
}

function extractFromServerFiles(
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

  // 「意味論的変更があるファイル」だけを集める。1 入力 → N 結果モデルでは、
  // 単一ファイル内の複数 candidate も複数ファイルからの candidate もフラットに出力できるが、
  // 複数ファイル変更は対応付け曖昧度が増すため保守的に除外する。
  const semanticChanges: Array<{ key: string; results: PreprocessingResult[] }> = [];
  for (const key of filesWithChanges) {
    const before = beforeFiles[key];
    const after = afterFiles[key];
    if (before === undefined || after === undefined) continue;
    const results = extractFromScripts(before, after, LAYOUT_KIND.SERVER);
    // 整形差分のみのファイルはスキップ
    if (results.length === 1 && results[0]?.excluded === EXCLUSION_REASON.NO_CHANGED_NODES) continue;
    semanticChanges.push({ key, results });
  }

  if (semanticChanges.length === 0) {
    return [excluded(LAYOUT_KIND.SERVER, EXCLUSION_REASON.NO_CHANGED_NODES, "no semantic changes (formatting/comment only)")];
  }
  if (semanticChanges.length > 1) {
    return [excluded(
      LAYOUT_KIND.SERVER,
      EXCLUSION_REASON.MULTI_FILE_CHANGE,
      `changes span ${semanticChanges.length} files: ${semanticChanges.map((c) => c.key).join(", ")}`,
    )];
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

function extractFromScripts(
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

  // top-level statement の canonical hash を計算して greedy match
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

  // 順序対応で組合せて candidate にする (短い方まで)。
  // 余った片側は「削除」(unmatched-before のみ) または「追加」(unmatched-after のみ) として無視。
  // これは jsperf レポートの追加/削除や、PR 内で純粋に追加された helper 関数を捨てる効果がある。
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

    candidates.push({
      beforeIndex: beforeIdx,
      afterIndex: afterIdx,
      beforeStmt,
      afterStmt,
      enclosureType,
    });
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
        excluded_detail: `${unmatchedBeforeIdx.length} before / ${unmatchedAfterIdx.length} after unmatched statements without Function/Method/Block enclosure`,
        before_node_count: beforeNodeCount,
        after_node_count: afterNodeCount,
      },
    ];
  }

  // 各 candidate を独立した結果として出力
  return candidates.map((c) => {
    // setup: 自分以外の全 top-level statement の before 版を index 順に結合
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

/**
 * 1 つの top-level statement ペアで AST diff を取り、changed_nodes の集合を返す。
 *
 * `findChangedNodes` は File を受け取る前提なので、stub の File AST に詰めて呼ぶ。
 * 整形差分のみの場合 (changed.size === 0) はそのまま空 Set を返す。
 */
function findChangedNodesForStatement(beforeStmt: Statement, afterStmt: Statement): Set<Node> | null {
  const beforeFile = wrapAsFile(beforeStmt);
  const afterFile = wrapAsFile(afterStmt);
  return findChangedNodes(beforeFile, afterFile);
}

/**
 * statement 単独で minimal enclosure を求め、enclosure_type 名を返す。
 * Module 到達 (enclosure null) なら null を返す。
 */
function findEnclosureForStatement(beforeStmt: Statement, changed: Set<Node>): string | null {
  const beforeFile = wrapAsFile(beforeStmt);
  const result = findMinimalEnclosure(beforeFile, changed);
  return result?.enclosureType ?? null;
}

function wrapAsFile(stmt: Statement): File {
  return {
    type: "File",
    program: {
      type: "Program",
      body: [stmt],
      directives: [],
      sourceType: "script",
    },
    comments: [],
    errors: [],
  } as unknown as File;
}

function excluded(layout: LayoutKind, reason: ExclusionReason, detail: string): PreprocessingResult {
  return {
    layout,
    excluded: reason,
    excluded_detail: detail,
  };
}
