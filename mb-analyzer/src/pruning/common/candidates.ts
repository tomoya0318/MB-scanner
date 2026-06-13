import type { File, Node } from "@babel/types";

import { nodeSize } from "../../ast/inspect";
import type { SubtreeSet } from "../../ast/subtree-hash";
import { walkNodes } from "../../ast/walk";
import { BLACKLIST_CATEGORIES, type ExcludeRule, type BlacklistCategories } from "./rules/blacklist";
import { PLACEHOLDER_NAME_PATTERN } from "./rules/replacement";
import { WHITELIST_CATEGORIES } from "./rules/whitelist";

/**
 * pruning 対象となる候補ノードを列挙する。
 *
 * 候補フィルタは 5 段 (`isCandidate`):
 *   1. placeholder 自身の除外: 前 iteration で生成した `$Pn` Identifier や
 *      `ExpressionStatement(Identifier("$Pn"))` を再候補化すると pruning ループが
 *      破綻する (placeholder を別 placeholder で置き換える) ため除外 (ADR-0009)
 *   2. 型 whitelist: pruning できる可能性のあるノード型 (WHITELIST_CATEGORIES) のみ残す
 *   3. 親子 blacklist: 親 field validator が置換後の型 (ExpressionStatement / Identifier /
 *      StringLiteral) を受理しない位置を除外。ルールは `@babel/types` の文法メタ
 *      データから `rules/blacklist.ts` で自動導出 (ADR-0005)
 *   4. SubtreeSet.has: after に同型が存在する「共通ノード」に絞る
 *      (研究計画 §第 1 段階 で「差分ノードは必須扱い」とするため)
 *   5. リテラルの差分内保護 (ADR-0028): リテラルは「親も共通ノード」の時だけ候補にする。
 *      hash 値衝突で差分内 load-bearing リテラルが共通誤判定されるのを防ぐ
 *
 * 結果は `end - start` の降順でソート。サイズが大きい候補を先に試す方が、成功
 * 時に一度に縮む量が大きく、全体の試行回数が減る経験則。
 */

export interface CandidatePath {
  readonly node: Node;
  /** 親ノード (File 直下の Program の子以外は必ず存在)。 */
  readonly parent: Node;
  /** 親から見た子の位置 key (例: `"consequent"`, `"body"`)。 */
  readonly parentKey: string;
  /** 親の該当 key が配列の場合のインデックス。単一ノードを指す key なら undefined。 */
  readonly listIndex?: number;
}

/**
 * pruning 候補を列挙する。
 *
 * @param before 対象の File AST
 * @param diff SubtreeSet (after との共通ノード判定)。undefined なら差分フィルタを
 *   適用せず全ての whitelist ノードを候補にする (テスト用)。
 */
export function enumerateCandidates(
  before: File,
  diff?: SubtreeSet,
): CandidatePath[] {
  const candidates: CandidatePath[] = [];
  const blacklist = BLACKLIST_CATEGORIES;

  walkNodes(before, ({ node, parent, parentKey, listIndex }) => {
    if (parent === null || parentKey === null) return;
    if (!isCandidate(node, parent, parentKey, blacklist, diff)) return;
    candidates.push({
      node,
      parent,
      parentKey,
      ...(listIndex !== undefined ? { listIndex } : {}),
    });
  });

  // サイズ降順ソート: 大きい候補を先に試すことで早期収束を狙う。
  // start/end が未付与のノードは末尾へ送る (通常 parse 直後は必ず付く)。
  candidates.sort((a, b) => nodeSize(b.node) - nodeSize(a.node));

  return candidates;
}

/**
 * 差分サブツリー内のリテラルを保護する型集合 (ADR-0028)。
 *
 * リテラルは subtree hash が値で衝突しやすく (`substr(0,2)` の `0` が無関係な `charAt(0)` の `0` と衝突)、
 * 差分ノード内の load-bearing なリテラルが「共通ノード」と誤判定され wildcard 化されていた。
 * 一方 `for(i<100000)` のループ回数のような incidental なリテラルは共通サブツリー内にあり wildcard が正しい。
 * → リテラルは「親も共通ノード」の時だけ候補にすることで両者を弁別する (`isCandidate` 末尾)。
 */
const LITERAL_TYPES = new Set<string>([
  "NumericLiteral",
  "StringLiteral",
  "BooleanLiteral",
  "NullLiteral",
  "BigIntLiteral",
  "RegExpLiteral",
]);

/**
 * 「1 つの定数を表す葉的ノード」か判定する (ADR-0028)。
 *
 * リテラル本体に加え、符号・ビット反転・論理否定などの単項式で中身が (再帰的に) リテラルの
 * もの (`-1` / `~0` / `!0` / `void 0` 等) も含める。Babel は `-1` を
 * `UnaryExpression(-, NumericLiteral(1))` に分解する (リテラル本体は常に非負の絶対値) ため、
 * 符号付き数値リテラルを拾うには UnaryExpression を見る必要がある。保護すべきか否かを分けるのは
 * operator の種類ではなく argument がリテラルか (= 定数を表すか) なので operator は問わない。
 *
 * 注: `const N = 2; key.substr(0, N)` のように変数束縛された定数は構文上 `Identifier` であり
 *     本判定では拾えない (値の出自解析が別途必要)。ADR-0028 の既知の限界③を参照。
 */
function isLiteralNode(node: Node): boolean {
  if (LITERAL_TYPES.has(node.type)) return true;
  if (node.type === "UnaryExpression") return isLiteralNode(node.argument);
  return false;
}

function isCandidate(
  node: Node,
  parent: Node,
  parentKey: string,
  blacklist: BlacklistCategories,
  diff: SubtreeSet | undefined,
): boolean {
  if (isPlaceholderNode(node)) return false;

  const category = WHITELIST_CATEGORIES.get(node.type);
  if (category === undefined) return false;

  const rule = blacklist[category].get(parent.type)?.get(parentKey);
  if (rule === true) return false;
  if (rule !== undefined) {
    const parentValue = (parent as unknown as Record<string, unknown>)[rule.discriminator];
    if (rule.value.includes(parentValue)) return false;
  }

  if (diff !== undefined) {
    // 段4: after に同型が無い差分ノードは必須扱いで候補から外す。
    if (!diff.has(node)) return false;
    // 段5: 差分サブツリー内のリテラル保護 (ADR-0028)。リテラル (符号付き数値等の単項式リテラルを含む) は
    // 親も共通ノードの時のみ候補にする (差分内の load-bearing リテラルが hash 衝突で wildcard 化されるのを防ぐ)。
    // ここに来た時点で node は共通ノード (段4 通過済み)。
    // TODO(ADR-0028 既知の限界④): diff は after から 1 回構築され不変なため、prune ループ中に親が
    //   wildcard 化されると ($P < 100000 等) incidental な harness 定数が過保護に skeleton 固定されうる。
    //   発生は候補の wildcard 順序に依存し dataset 次第。実害が出たら親判定を初期 before 基準にする等を検討。
    if (isLiteralNode(node) && !diff.has(parent)) return false;
  }

  return true;
}

/**
 * 前 iteration で挿入された placeholder ノード自身を判定する。
 *
 *   - `Identifier($Pn)`: identifier カテゴリの置換結果 (および statement の
 *     ExpressionStatement の inner)
 *   - `ExpressionStatement(Identifier($Pn))`: statement カテゴリの置換結果 (ADR-0009)
 *
 * ユーザー由来の `$P0` Identifier との判別は不能なので、ユーザーコードに
 * `$Pn` 形があれば候補から外れる (= pruning では触らない) 副作用がある。
 * `engine.prune()` が入力段階で warning を出してこのリスクを通知する。
 */
function isPlaceholderNode(node: Node): boolean {
  if (node.type === "Identifier") {
    return PLACEHOLDER_NAME_PATTERN.test(node.name);
  }
  if (node.type === "ExpressionStatement") {
    const expr = node.expression;
    if (expr.type === "Identifier") {
      return PLACEHOLDER_NAME_PATTERN.test(expr.name);
    }
  }
  return false;
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  // 本 if ブロック内でだけ必要なので遅延 import (production bundle には残らない)
  const { parse } = await import("./ast/parser");
  const { SubtreeSet } = await import("../../ast/subtree-hash");

  const stubNode = (type: string, extra: Record<string, unknown> = {}): Node =>
    ({ type, ...extra }) as unknown as Node;

  const emptyBlacklist: BlacklistCategories = {
    statement: new Map(),
    identifier: new Map(),
    expression: new Map(),
  };

  const candidateTypes = (nodes: Iterable<{ node: Node }>): string[] =>
    [...nodes].map((c) => c.node.type);

  describe("isCandidate (in-source) — placeholder ノード除外", () => {
    it("Identifier の name が $Pn なら除外 (前 iteration で挿入された placeholder)", () => {
      const ph = stubNode("Identifier", { name: "$P0" });
      const parent = stubNode("ExpressionStatement");
      expect(isCandidate(ph, parent, "expression", emptyBlacklist, undefined)).toBe(false);
    });

    it("ExpressionStatement(Identifier($Pn)) は除外 (statement placeholder の外側)", () => {
      const ph = stubNode("ExpressionStatement", {
        expression: { type: "Identifier", name: "$P3" },
      });
      const parent = stubNode("BlockStatement");
      expect(isCandidate(ph, parent, "body", emptyBlacklist, undefined)).toBe(false);
    });

    it("ユーザー由来 Identifier ($P プレフィックスでも数字なし) は除外しない", () => {
      const id = stubNode("Identifier", { name: "$P" });
      const parent = stubNode("ExpressionStatement");
      expect(isCandidate(id, parent, "expression", emptyBlacklist, undefined)).toBe(true);
    });

    it("ExpressionStatement の expression が Identifier 以外 (e.g. CallExpression) は通常通り候補化される", () => {
      const stmt = stubNode("ExpressionStatement", {
        expression: { type: "CallExpression" },
      });
      const parent = stubNode("BlockStatement");
      expect(isCandidate(stmt, parent, "body", emptyBlacklist, undefined)).toBe(true);
    });
  });

  describe("isCandidate (in-source)", () => {
    it("whitelist 外の型は他段の状態に関わらず false", () => {
      // Program は WHITELIST_CATEGORIES に無い → blacklist / diff の中身を読まずに弾かれる
      expect(
        isCandidate(stubNode("Program"), stubNode("File"), "program", emptyBlacklist, undefined),
      ).toBe(false);
    });

    it("blacklist rule === true は無条件除外", () => {
      const blacklist: BlacklistCategories = {
        statement: new Map([["IfStatement", new Map([["test", true as ExcludeRule]])]]),
        identifier: new Map(),
        expression: new Map(),
      };
      expect(
        isCandidate(
          stubNode("BlockStatement"),
          stubNode("IfStatement"),
          "test",
          blacklist,
          undefined,
        ),
      ).toBe(false);
    });

    it("discriminator 条件付き rule は親フィールド値で切り替わる", () => {
      const rule: ExcludeRule = { discriminator: "kind", value: ["const"] };
      const blacklist: BlacklistCategories = {
        statement: new Map(),
        identifier: new Map([["VariableDeclarator", new Map([["id", rule]])]]),
        expression: new Map(),
      };
      const child = stubNode("Identifier");
      // kind=const → 除外
      expect(
        isCandidate(
          child,
          stubNode("VariableDeclarator", { kind: "const" }),
          "id",
          blacklist,
          undefined,
        ),
      ).toBe(false);
      // kind=let → 通過 (rule があっても discriminator が一致しない)
      expect(
        isCandidate(
          child,
          stubNode("VariableDeclarator", { kind: "let" }),
          "id",
          blacklist,
          undefined,
        ),
      ).toBe(true);
    });

    it("diff の has === false は除外、undefined 時は diff 段がスキップされる", () => {
      const id = stubNode("Identifier");
      const parent = stubNode("ExpressionStatement");
      const diffReject = { has: () => false } as unknown as SubtreeSet;

      expect(isCandidate(id, parent, "expression", emptyBlacklist, diffReject)).toBe(false);
      expect(isCandidate(id, parent, "expression", emptyBlacklist, undefined)).toBe(true);
    });
  });

  describe("isCandidate (in-source) — 差分内リテラル保護 (ADR-0028)", () => {
    // diff.has(x) = 「x と同型サブツリーが after に存在 = 共通ノード」。渡したノードだけを
    // 共通とみなすスタブで、node / parent の共通性を独立に出し分ける。
    const diffWith = (...common: Node[]): SubtreeSet =>
      ({ has: (n: Node) => common.includes(n) }) as unknown as SubtreeSet;

    it("共通リテラルでも親が差分ノードなら除外する (load-bearing リテラルを skeleton に残す)", () => {
      // node は hash 衝突等で共通判定されるが、文脈 (親 = substr(0,2) 側) は差分。
      const lit = stubNode("NumericLiteral");
      const parent = stubNode("CallExpression");
      expect(isCandidate(lit, parent, "arguments", emptyBlacklist, diffWith(lit))).toBe(false);
    });

    it("共通リテラルで親も共通なら候補に残る (incidental な harness 定数 100000 は一般化維持)", () => {
      // 親 (i < 100000 の共通 harness) も共通なので段5 は発火せず wildcard 候補のまま。
      const lit = stubNode("NumericLiteral");
      const parent = stubNode("BinaryExpression");
      expect(isCandidate(lit, parent, "right", emptyBlacklist, diffWith(lit, parent))).toBe(true);
    });

    it("非リテラル (Identifier) は親が差分でも段5 を発火させず候補に残る", () => {
      const id = stubNode("Identifier", { name: "key" });
      const parent = stubNode("CallExpression");
      expect(isCandidate(id, parent, "arguments", emptyBlacklist, diffWith(id))).toBe(true);
    });

    it("負リテラル -1 (UnaryExpression(-, NumericLiteral)) も親が差分なら除外する", () => {
      // 例: slice(-1) の -1。Babel は符号を UnaryExpression に分解するので isLiteralNode で再帰判定。
      const neg = stubNode("UnaryExpression", {
        operator: "-",
        argument: stubNode("NumericLiteral"),
      });
      const parent = stubNode("CallExpression");
      expect(isCandidate(neg, parent, "arguments", emptyBlacklist, diffWith(neg))).toBe(false);
    });
  });

  describe("enumerateCandidates (in-source) — whitelist 連携", () => {
    it("WHITELIST_CATEGORIES の 3 カテゴリすべてから候補が拾われる", () => {
      const before = parse("if (c) { use(arr[0]); }");
      const ts = candidateTypes(enumerateCandidates(before));
      expect(ts).toContain("IfStatement"); // statement
      expect(ts).toContain("BlockStatement"); // statement
      expect(ts).toContain("CallExpression"); // expression
      expect(ts).toContain("MemberExpression"); // expression
      expect(ts).toContain("NumericLiteral"); // expression
      expect(ts).toContain("Identifier"); // identifier
    });

    it("WHITELIST_CATEGORIES 外の型 (VariableDeclarator / Program / File) は候補に入らない", () => {
      const before = parse("const x = 1;");
      const ts = candidateTypes(enumerateCandidates(before));
      expect(ts).not.toContain("VariableDeclarator");
      expect(ts).not.toContain("Program");
      expect(ts).not.toContain("File");
    });
  });

  describe("enumerateCandidates (in-source) — blacklist 連携", () => {
    it("blacklist で除外される位置は候補から消える (代表例: VariableDeclarator.id の Identifier)", () => {
      const before = parse("const x = arr[0];");
      const candidates = enumerateCandidates(before);
      const onIdSlot = candidates.filter(
        (c) => c.parent.type === "VariableDeclarator" && c.parentKey === "id",
      );
      expect(onIdSlot).toHaveLength(0);
    });

    it("blacklist 対象でない位置は同じ型でも通常通り候補化される (init 側)", () => {
      const before = parse("const x = arr[0];");
      const candidates = enumerateCandidates(before);
      const onInit = candidates.filter(
        (c) => c.parent.type === "VariableDeclarator" && c.parentKey === "init",
      );
      expect(onInit.length).toBeGreaterThan(0);
      expect(onInit[0]?.node.type).toBe("MemberExpression");
    });

    it("discriminator 条件付き blacklist が computed 値で切り替わる (MemberExpression.property)", () => {
      // computed=false: `obj.x` の `x` は blacklist (Identifier-only 位置)
      // computed=true:  `obj[expr]` の `expr` は blacklist 対象外
      const before = parse("obj.x + obj[k];");
      const candidates = enumerateCandidates(before);
      const onProperty = candidates.filter(
        (c) => c.parent.type === "MemberExpression" && c.parentKey === "property",
      );
      expect(onProperty).toHaveLength(1);
      const parent = onProperty[0]?.parent as { computed?: boolean } | undefined;
      expect(parent?.computed).toBe(true);
    });
  });

  describe("enumerateCandidates (in-source) — SubtreeSet 連携", () => {
    const BEFORE_CODE = "use(key, flag);";
    const AFTER_CODE = "use(key);";

    it("差分ノードは diff 渡し時に除外される", () => {
      const before = parse(BEFORE_CODE);
      const after = parse(AFTER_CODE);
      const diff = new SubtreeSet(after);

      const candidates = enumerateCandidates(before, diff);
      const flagIdent = candidates.find(
        (c) =>
          c.node.type === "Identifier" && (c.node as { name?: string }).name === "flag",
      );
      expect(flagIdent).toBeUndefined();
    });

    it("共通ノードは diff 渡し時にも候補に入る", () => {
      const before = parse(BEFORE_CODE);
      const after = parse(AFTER_CODE);
      const diff = new SubtreeSet(after);

      const candidates = enumerateCandidates(before, diff);
      const keyIdents = candidates.filter(
        (c) =>
          c.node.type === "Identifier" && (c.node as { name?: string }).name === "key",
      );
      expect(keyIdents.length).toBeGreaterThan(0);
    });

    it("diff を渡さなければ差分フィルタは無効化される", () => {
      const before = parse(BEFORE_CODE);
      const candidates = enumerateCandidates(before);
      const flagIdent = candidates.find(
        (c) =>
          c.node.type === "Identifier" && (c.node as { name?: string }).name === "flag",
      );
      expect(flagIdent).toBeDefined();
    });
  });

  describe("enumerateCandidates (in-source) — CandidatePath 構造", () => {
    it("配列子は listIndex 付き、スカラ子は listIndex なし", () => {
      const before = parse("if (c) { a(); b(); }");
      const candidates = enumerateCandidates(before);

      const blockChildren = candidates.filter(
        (c) => c.parent.type === "BlockStatement" && c.parentKey === "body",
      );
      expect(blockChildren.length).toBeGreaterThan(0);
      expect(blockChildren.every((c) => typeof c.listIndex === "number")).toBe(true);

      const ifTest = candidates.find(
        (c) => c.parent.type === "IfStatement" && c.parentKey === "test",
      );
      expect(ifTest).toBeDefined();
      expect(ifTest?.listIndex).toBeUndefined();
    });
  });

  describe("enumerateCandidates (in-source) — placeholder 除外", () => {
    it("入力に既に $Pn Identifier があれば候補から外れる", () => {
      // ユーザーが偶然 `$P0` という名前の変数を書いた想定 (判別不能は ADR-0009 で許容)
      const before = parse("$P0; foo();");
      const ts = candidateTypes(enumerateCandidates(before));
      // foo, ExpressionStatement(foo()) などは候補化されるが、$P0 の Identifier と
      // それを包む ExpressionStatement は除外される
      const placeholderIdent = enumerateCandidates(before).find(
        (c) =>
          c.node.type === "Identifier" &&
          (c.node as { name?: string }).name === "$P0",
      );
      expect(placeholderIdent).toBeUndefined();
      const placeholderStmt = enumerateCandidates(before).find(
        (c) =>
          c.node.type === "ExpressionStatement" &&
          ((c.node as { expression?: { type?: string; name?: string } }).expression?.name ===
            "$P0"),
      );
      expect(placeholderStmt).toBeUndefined();
      // 通常コード由来の候補は残る
      expect(ts).toContain("CallExpression"); // foo()
    });
  });

  describe("enumerateCandidates (in-source) — ソート", () => {
    it("サイズ降順 (start/end 幅) でソートされる", () => {
      const before = parse("if (c) { const x = arr[0]; use(x); }");
      const candidates = enumerateCandidates(before);
      expect(candidates[0]?.node.type).toBe("IfStatement");
      const sizes = candidates.map((c) => (c.node.end ?? 0) - (c.node.start ?? 0));
      for (let i = 0; i < sizes.length - 1; i++) {
        const a = sizes[i];
        const b = sizes[i + 1];
        if (a === undefined || b === undefined) throw new Error("bounds");
        expect(a).toBeGreaterThanOrEqual(b);
      }
    });
  });
}
