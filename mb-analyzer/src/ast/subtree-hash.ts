import { VISITOR_KEYS } from "@babel/types";
import type { File, Node } from "@babel/types";

import { walkNodes } from "./walk";

/**
 * AST ノードのサブツリー同型判定用ハッシュと所属判定器。
 *
 * 機能間で重複していた subtree-hash ユーティリティをここに集約する (旧
 * `pruning/ast/subtrees.ts` の `SubtreeSet` / `preprocessing/common/subtree-hash.ts`)。
 *
 * 「同型」はハッシュによる厳密一致で、タイプ・子・識別子名・リテラル値・演算子が
 * すべて揃って初めて同型と扱う。例えば `arr[0]` と `arr[1]` は別物。loc / start /
 * end / コメントなどの表示系メタデータは無視する。
 *
 * 採用判断 (top-down subtree hash 自作 / bottom-up は非採用):
 *   - ai-guide/adr/0002-babel-topdown-subtree-hash.md
 *   - ai-guide/adr/0003-bottom-up-mapping-deferred.md
 */
export class SubtreeSet {
  private readonly hashes: Set<string>;

  constructor(root: File | Node) {
    this.hashes = new Set<string>();
    walkNodes(root, ({ node }) => this.hashes.add(canonicalHash(node)));
  }

  /** node と同型のサブツリーが root のどこかに含まれるか。 */
  has(node: Node): boolean {
    return this.hashes.has(canonicalHash(node));
  }
}

// Babel AST ノードには loc / start / end / comments / extra などソース位置・表示系の
// プロパティが含まれる。同じコードを再 parse しても微妙にぶれる値が多いので、ハッシュ
// からはまとめて除外する。
const METADATA_KEYS: ReadonlySet<string> = new Set([
  "type",
  "loc",
  "start",
  "end",
  "range",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "extra",
  "trailingComma",
  "comments",
  "errors",
]);

type VisitorChild = Node | null | undefined | Array<Node | null | undefined>;

function hashChild(child: VisitorChild): string {
  if (child === null || child === undefined) return "_";
  if (Array.isArray(child)) {
    return `[${child.map(hashChild).join(",")}]`;
  }
  return canonicalHash(child);
}

/**
 * ノードの正規化ハッシュ。
 *
 * タイプ・子ノード・識別子名・リテラル値・演算子・`computed` などの構造フラグが
 * 全部一致すれば等しいハッシュを持つ。ソース位置・コメント・`extra` (原表記情報)
 * は計算に含めない — METADATA_KEYS 参照。
 */
export function canonicalHash(node: Node): string {
  const visitorKeys = VISITOR_KEYS[node.type] ?? [];
  const visitorKeySet = new Set<string>(visitorKeys);

  const record = node as unknown as Record<string, unknown>;
  const valueEntries: string[] = [];
  for (const key of Object.keys(record).sort()) {
    if (METADATA_KEYS.has(key)) continue;
    if (visitorKeySet.has(key)) continue;
    const value = record[key];
    if (value === undefined) continue;
    valueEntries.push(`${key}=${JSON.stringify(value)}`);
  }

  const childEntries: string[] = [];
  for (const key of visitorKeys) {
    childEntries.push(`${key}=${hashChild(record[key] as VisitorChild)}`);
  }

  return `${node.type}{${valueEntries.join(",")}}(${childEntries.join(",")})`;
}
