import { VISITOR_KEYS } from "@babel/types";
import type { Node } from "@babel/types";

/**
 * File 全体のサブツリーを走査しすべてのノードを yield する generator。
 * property テスト用ヘルパ (本番コードでは fast-subtree-set.ts 内部の walk で済ませる)。
 *
 * 同ファイル内の isNode は ast/walk.ts の同名 helper と意図的に重複させている
 * (tests から src の内部実装に依存しない方針)。
 */
export function* walkAllNodes(root: Node): Generator<Node> {
  yield root;
  const keys = VISITOR_KEYS[root.type] ?? [];
  const record = root as unknown as Record<string, unknown>;
  for (const key of keys) {
    const child = record[key];
    if (child === null || child === undefined) continue;
    if (Array.isArray(child)) {
      for (const c of child) {
        if (isNode(c)) yield* walkAllNodes(c);
      }
    } else if (isNode(child)) {
      yield* walkAllNodes(child);
    }
  }
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  );
}
