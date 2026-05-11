import type { ParserPlugin } from "@babel/parser";
import * as t from "@babel/types";

/**
 * pruning 対象となる Babel ノード型の分類テーブル (whitelist)。
 *
 * `@babel/types` の `Statement` / `Expression` alias から alias-driven に自動導出する
 * (ADR-0006)。データセット・dataset 言語に依存せず文法だけで決まる。
 *
 * 除外集合は本 ADR §機械的除外集合 で定義された 3 群:
 *   - 構造的 no-op: `PARSER_PLUGINS` で有効化していない plugin の型 (TS / JSX / Flow)
 *   - 元から極小: `EmptyStatement` (元コードの `;` を候補化しても意味がない)
 *   - 時点規範的除外: TC39 stage < 4 の experimental 構文
 *
 * カテゴリの意味 (詳細は ADR-0009 / `replacement.ts:REPLACEMENTS`):
 *   - statement: `ExpressionStatement(Identifier("$Pn"))` に置換、`$Pn;` として可視化
 *   - expression: `"$Pn"` 文字列リテラル (式) に置換してワイルドカード化する
 *   - identifier: `$Pn` 識別子に置換してリネーム扱いにする
 */

export type NodeCategory = "statement" | "expression" | "identifier";

/**
 * pruning モジュールの parser plugin 設定。
 *
 * 対象言語は ECMAScript core (素 JS)。TS / JSX / Flow への拡張は ADR-0006 §対象言語拡張で
 * 扱える dataset 例 を参照し、本配列と下記の除外集合を paired で更新する (paired-change 原則)。
 * `parser.ts` はこの定数を使って `@babel/parser` を構成する。
 */
export const PARSER_PLUGINS: ReadonlyArray<ParserPlugin> = [];

const ENABLED_PLUGIN_NAMES = new Set<string>(
  PARSER_PLUGINS.map((p) => (typeof p === "string" ? p : p[0])),
);

/**
 * Flow 由来の構文型のうち prefix (`Declare`) で判定できないもの。
 */
const FLOW_EXPLICIT_TYPES = new Set([
  "TypeAlias",
  "OpaqueType",
  "InterfaceDeclaration",
  "EnumDeclaration",
  "TypeCastExpression",
]);

/**
 * 構造的 no-op: parser config で plugin OFF の構文型 → AST に出現不能 → whitelist 含有は
 * vacuous なので除外。`ENABLED_PLUGIN_NAMES` を変更すると除外範囲が自動で連動する
 * (paired-change の実装表現)。
 */
function isPluginExcluded(type: string): boolean {
  if (!ENABLED_PLUGIN_NAMES.has("typescript") && type.startsWith("TS")) return true;
  if (!ENABLED_PLUGIN_NAMES.has("jsx") && type.startsWith("JSX")) return true;
  if (!ENABLED_PLUGIN_NAMES.has("flow")) {
    if (type.startsWith("Declare")) return true;
    if (FLOW_EXPLICIT_TYPES.has(type)) return true;
  }
  return false;
}

/**
 * 元から極小: `EmptyStatement` は構文上の空文 `;`。元コード由来の `;` を
 * 別 placeholder で置き換えても表現力は変わらず、候補列挙の無駄試行になるため除外。
 * placeholder 自身の再候補化防止は `candidates.ts:isPlaceholderNode` (ADR-0009) が担う。
 */
const ALREADY_MINIMAL_TYPES = new Set(["EmptyStatement"]);

/**
 * 時点規範的除外: TC39 stage < 4 (= "Finished" 未到達) の experimental 構文。
 *
 * ADR-0006 Date (2026-04-27) 時点での TC39 提案 stage に基づく。Babel version は
 * `pnpm-lock.yaml` で pin されているため、AST 型集合は完全再現可能。stage 4 への昇格時には
 * 本リストから外す (ADR-0006 トリガー節)。各構文の stage は TC39 提案リポジトリで検証可能:
 * https://github.com/tc39/proposals
 */
const EXPERIMENTAL_TYPES = new Set([
  "BindExpression", // stage 0
  "DoExpression", // stage 1
  "RecordExpression", // stage 2 → withdrawn (2023)
  "TupleExpression", // stage 2 → withdrawn (2023)
  "ModuleExpression", // stage 1
  "PipelineBareFunction", // stage 2 (Hack proposal)
  "PipelinePrimaryTopicReference", // stage 2
  "PipelineTopicExpression", // stage 2
  "TopicReference", // stage 2
  "DecimalLiteral", // stage 1
]);

function isExcluded(type: string): boolean {
  return (
    isPluginExcluded(type) ||
    ALREADY_MINIMAL_TYPES.has(type) ||
    EXPERIMENTAL_TYPES.has(type)
  );
}

/**
 * `@babel/types` の alias テーブルからカテゴリ別 whitelist を構築する。
 *
 * カテゴリ振り分け規則 (ADR-0006):
 *   - `Identifier` 単独 → identifier (Expression alias にも属するが binding 位置除外を
 *     grammar-blacklist で扱うため独立。ADR-0005:71-77)
 *   - `FLIPPED_ALIAS_KEYS.Statement` ∖ excluded → statement
 *   - `FLIPPED_ALIAS_KEYS.Expression` ∖ {Identifier} ∖ excluded → expression
 */
function buildWhitelistCategories(): ReadonlyMap<string, NodeCategory> {
  const m = new Map<string, NodeCategory>();
  const flipped = (t as unknown as { FLIPPED_ALIAS_KEYS?: Record<string, string[]> })
    .FLIPPED_ALIAS_KEYS;
  if (flipped === undefined) {
    throw new Error(
      "@babel/types.FLIPPED_ALIAS_KEYS が未初期化です。Babel のメジャーバージョン更新で API が変わった可能性があります (ADR-0006 トリガー)",
    );
  }

  m.set("Identifier", "identifier");

  for (const type of flipped.Statement ?? []) {
    if (!isExcluded(type)) m.set(type, "statement");
  }
  for (const type of flipped.Expression ?? []) {
    if (type === "Identifier") continue;
    if (!isExcluded(type)) m.set(type, "expression");
  }

  return m;
}

export const WHITELIST_CATEGORIES: ReadonlyMap<string, NodeCategory> = buildWhitelistCategories();

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  const EXPERIMENTAL_TYPE_NAMES = [
    "BindExpression",
    "DoExpression",
    "RecordExpression",
    "TupleExpression",
    "ModuleExpression",
    "PipelineBareFunction",
    "PipelinePrimaryTopicReference",
    "PipelineTopicExpression",
    "TopicReference",
    "DecimalLiteral",
  ];

  describe("PARSER_PLUGINS (in-source)", () => {
    it("対象言語は素 JS (plugin 配列は空)", () => {
      expect(PARSER_PLUGINS).toEqual([]);
    });
  });

  describe("WHITELIST_CATEGORIES (in-source) — 想定カバレッジ", () => {
    it("statement カテゴリは 24 型", () => {
      const stmt = [...WHITELIST_CATEGORIES.entries()].filter(([, v]) => v === "statement");
      expect(stmt.length).toBe(24);
    });

    it("identifier カテゴリは 1 型 (Identifier のみ)", () => {
      const id = [...WHITELIST_CATEGORIES.entries()].filter(([, v]) => v === "identifier");
      expect(id.map(([k]) => k)).toEqual(["Identifier"]);
    });

    it("expression カテゴリは 33 型", () => {
      const expr = [...WHITELIST_CATEGORIES.entries()].filter(([, v]) => v === "expression");
      expect(expr.length).toBe(33);
    });

    it("合計 58 型 (Babel 全 alias 99 のうち約 59%)", () => {
      expect(WHITELIST_CATEGORIES.size).toBe(58);
    });
  });

  describe("WHITELIST_CATEGORIES (in-source) — 構造的 no-op (parser plugin OFF 由来の除外)", () => {
    const flipped = (t as unknown as { FLIPPED_ALIAS_KEYS?: Record<string, string[]> })
      .FLIPPED_ALIAS_KEYS!;

    it("TS prefix 型は除外される", () => {
      const tsTypes = [...(flipped.Statement ?? []), ...(flipped.Expression ?? [])].filter((s) =>
        s.startsWith("TS"),
      );
      expect(tsTypes.length).toBeGreaterThan(0); // 前提検証
      for (const ts of tsTypes) {
        expect(WHITELIST_CATEGORIES.has(ts)).toBe(false);
      }
    });

    it("JSX prefix 型は除外される", () => {
      const jsxTypes = [...(flipped.Statement ?? []), ...(flipped.Expression ?? [])].filter((s) =>
        s.startsWith("JSX"),
      );
      for (const jsx of jsxTypes) {
        expect(WHITELIST_CATEGORIES.has(jsx)).toBe(false);
      }
    });

    it("Flow Declare prefix 型は除外される", () => {
      const flowTypes = (flipped.Statement ?? []).filter((s) => s.startsWith("Declare"));
      expect(flowTypes.length).toBeGreaterThan(0);
      for (const flow of flowTypes) {
        expect(WHITELIST_CATEGORIES.has(flow)).toBe(false);
      }
    });

    it("Flow 明示型 (TypeAlias / OpaqueType / InterfaceDeclaration / EnumDeclaration / TypeCastExpression) は除外される", () => {
      for (const flow of [
        "TypeAlias",
        "OpaqueType",
        "InterfaceDeclaration",
        "EnumDeclaration",
        "TypeCastExpression",
      ]) {
        expect(WHITELIST_CATEGORIES.has(flow)).toBe(false);
      }
    });
  });

  describe("WHITELIST_CATEGORIES (in-source) — 元から極小", () => {
    it("EmptyStatement は除外される", () => {
      expect(WHITELIST_CATEGORIES.has("EmptyStatement")).toBe(false);
    });
  });

  describe("WHITELIST_CATEGORIES (in-source) — 時点規範的除外 (TC39 stage < 4)", () => {
    it.each(EXPERIMENTAL_TYPE_NAMES)("experimental 型 %s は除外される", (type) => {
      expect(WHITELIST_CATEGORIES.has(type)).toBe(false);
    });
  });
}

