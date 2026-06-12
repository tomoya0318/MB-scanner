import type { File, Node } from "@babel/types";

import { VERDICT, type Verdict } from "../../contracts/equivalence-contracts";
import {
  PRUNING_VERDICT,
  type Placeholder,
  type PruningInput,
  type PruningResult,
} from "../../contracts/pruning-contracts";

import { countNodes, snippetOfNode } from "../../ast/inspect";
import { SubtreeSet } from "../../ast/subtree-hash";
import { walkNodes } from "../../ast/walk";
import { generate, parse } from "./ast/parser";
import { enumerateCandidates, type CandidatePath } from "./candidates";
import { PLACEHOLDER_NAME_PATTERN, replacementFor } from "./rules/replacement";

/**
 * pruning が「この before 変種はまだ等価か」を判定するために呼ぶ等価検証関数。
 *
 * `pruning/common/` は dataset 非依存層なので `equivalence-checker/` を直接 import せず、
 * この関数を DI で受け取る (`pruning/selakovic/` が `checkEquivalence` を bind する)。
 * 実行環境 (`environment` / `module_base_dir` / `mount_html`) や oracle routing hint は
 * 呼び出し側 (`pruning/selakovic/`) が closure に閉じ込めるため、`common/` は知らない。
 */
export interface EquivalenceCheck {
  (args: {
    setup: string;
    before: string;
    after: string;
    timeout_ms: number;
  }): Promise<{ verdict: Verdict; error_message?: string | null }>;
}

/** `prune` が必要とする外部依存 (composition root / adapter が注入する)。 */
export interface PruneDeps {
  readonly checkEquivalence: EquivalenceCheck;
}

/**
 * Hydra 式実行ベース pruning の本体。
 *
 * 処理の骨格 (研究計画 ai-guide/current-research.md §第 1 段階):
 *
 *   1. 初回等価性検証: before ≡ after が `setup` 上で成立しなければ `initial_mismatch`
 *      (pruning 前提が崩れているので即 return)
 *   2. AST 差分フィルタ: SubtreeSet で after に同型が存在する「共通ノード」のみを
 *      候補として列挙。差分ノードは「after に対応物がない = パターンの本質」として
 *      必須扱い (試行しない)
 *   3. 候補を大きい順に DFS 走査: 1 候補ごとに親キーを mutate → 等価判定 → 等価なら
 *      reparsed AST を採用、不等価/round-trip 失敗なら finally で必ず revert (DB の
 *      savepoint パターン)。pruning は単スレッド逐次なので isolation 不要が成立
 *   4. budget (max_iterations / total_budget_ms) で打ち切り
 *
 * 単一 setup 設計の採用判断は ai-guide/adr/0004-pruning-setup-single.md 参照。
 */

/**
 * pruning にとって「これ以上の縮約をしても witness 上の挙動が変わっていない」と見なせる verdict。
 * `equal` (positive evidence あり) に加えて `inconclusive` (差は観測されなかったが positive evidence 無し)
 * も含める: `inconclusive` の保守的な区別は等価検証アーティファクト (Selakovic dataset の検証主張) のための
 * もので、パターン縮約の健全性とは別軸 — pruning は「観測可能な差が無い」を縮約可否の基準にする (ADR-0018)。
 */
function isEquivalentEnoughForPruning(verdict: Verdict): boolean {
  return verdict === VERDICT.EQUAL || verdict === VERDICT.INCONCLUSIVE;
}

/**
 * `prune` の本体。失敗時は verdict=error を返し例外は呼び出し側へ投げない。
 *
 * 等価検証の実体は `deps.checkEquivalence` で注入される (`pruning/common/` は dataset 非依存層なので
 * `equivalence-checker/` を直接知らない)。
 */
export async function prune(input: PruningInput, deps: PruneDeps): Promise<PruningResult> {
  const cfg = resolveBudget(input, deps);
  const baseResult = {
    ...(input.id !== undefined ? { id: input.id } : {}),
    effective_timeout_ms: cfg.timeout_ms,
  };

  // Phase 0: parse。parse 失敗は verdict=error。
  let beforeAst: File;
  let afterAst: File;
  let currentBeforeCode: string;
  try {
    beforeAst = parse(input.before);
    afterAst = parse(input.after);
    currentBeforeCode = input.before;
  } catch (e) {
    const message = e instanceof Error ? e.message : "parse failed";
    return {
      ...baseResult,
      verdict: PRUNING_VERDICT.ERROR,
      error_message: message,
    };
  }

  const nodeCountInitial = countNodes(beforeAst);

  // 入力に placeholder 形 (`$Pn`) の Identifier があれば warning を出す (ADR-0009)。
  // 動作は変えない: 候補列挙では placeholder と区別できず除外される副作用があるが、
  // 等価性検証は普通の Identifier として走る。ユーザー側の知っておくべきリスク。
  warnIfPlaceholderCollision(beforeAst, "before");
  warnIfPlaceholderCollision(afterAst, "after");

  // Phase 1: 初回等価性検証。before ≡ after でなければ pruning を回す意味がない。
  const initialCheck = await cfg.checkEquivalence({
    setup: cfg.setup,
    before: currentBeforeCode,
    after: cfg.afterCode,
    timeout_ms: cfg.timeout_ms,
  });
  if (initialCheck.verdict === VERDICT.ERROR) {
    return {
      ...baseResult,
      verdict: PRUNING_VERDICT.ERROR,
      error_message: initialCheck.error_message ?? "initial equivalence check error",
      node_count_initial: nodeCountInitial,
    };
  }
  if (!isEquivalentEnoughForPruning(initialCheck.verdict)) {
    return {
      ...baseResult,
      verdict: PRUNING_VERDICT.INITIAL_MISMATCH,
      node_count_initial: nodeCountInitial,
    };
  }

  // Phase 2: AST 差分フィルタ + 候補列挙 + DFS 走査
  // 1 回 prune に成功したら beforeAst が変わるので候補を再列挙する。SubtreeSet は
  // after 側の hash 集合だけを保持し after は不変なので、ループ外で 1 回だけ構築する。
  // 失敗候補のクロスパス dedup は将来の最適化として保留 (canonical hash ベースで
  // 実装する余地あり)。
  const placeholders: Placeholder[] = [];
  let iterations = 0;
  const startedAt = Date.now();
  const diff = new SubtreeSet(afterAst);

  while (iterations < cfg.max_iterations) {
    if (Date.now() - startedAt >= cfg.total_budget_ms) break;

    const candidates = enumerateCandidates(beforeAst, diff);
    if (candidates.length === 0) break;

    const prunedInThisPass = await tryPruneCandidates({
      candidates,
      beforeAst,
      currentBeforeCode,
      cfg,
      placeholders,
      startedAt,
      iterations,
    });

    iterations = prunedInThisPass.iterations;
    if (!prunedInThisPass.pruned) break; // もう縮まない or budget 切れ

    beforeAst = prunedInThisPass.nextAst;
    currentBeforeCode = prunedInThisPass.nextCode;
  }

  const patternCode = generate(beforeAst);
  const nodeCountPruned = countNodes(beforeAst);

  return {
    ...baseResult,
    verdict: PRUNING_VERDICT.PRUNED,
    pattern_ast: beforeAst,
    pattern_code: patternCode,
    placeholders,
    iterations,
    node_count_initial: nodeCountInitial,
    node_count_pruned: nodeCountPruned,
  };
}

interface ResolvedConfig {
  readonly setup: string;
  readonly afterCode: string;
  readonly timeout_ms: number;
  readonly max_iterations: number;
  readonly total_budget_ms: number;
  readonly checkEquivalence: EquivalenceCheck;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_ITERATIONS = 1_000;

/**
 * 1 回の checkEquivalence 呼び出しを最大 timeout_ms 使う前提で、
 * max_iterations 分の予算と等しいだけの wall-time を確保する。
 */
function resolveBudget(input: PruningInput, deps: PruneDeps): ResolvedConfig {
  const timeout_ms = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const max_iterations = input.max_iterations ?? DEFAULT_MAX_ITERATIONS;
  return {
    setup: input.setup ?? "",
    afterCode: input.after,
    timeout_ms,
    max_iterations,
    total_budget_ms: timeout_ms * max_iterations,
    checkEquivalence: deps.checkEquivalence,
  };
}

interface TryPruneInput {
  readonly candidates: CandidatePath[];
  readonly beforeAst: File;
  readonly currentBeforeCode: string;
  readonly cfg: ResolvedConfig;
  readonly placeholders: Placeholder[];
  readonly startedAt: number;
  readonly iterations: number;
}

interface TryPruneResult {
  readonly pruned: boolean;
  readonly nextAst: File;
  readonly nextCode: string;
  readonly iterations: number;
}

/**
 * 現在の候補リストを順に試し、最初に成功した 1 候補で AST を更新して返す。
 * 各候補は親キーを mutate → 等価判定 → finally で必ず revert (savepoint パターン)。
 * 全候補が失敗、または budget 切れの場合は `pruned=false` を返し、`iterations` は
 * 試行で消費した分まで反映済み。
 */
async function tryPruneCandidates(args: TryPruneInput): Promise<TryPruneResult> {
  const { candidates, beforeAst, currentBeforeCode, cfg, placeholders, startedAt } = args;
  let iterations = args.iterations;
  const stop = (): TryPruneResult => ({
    pruned: false,
    nextAst: beforeAst,
    nextCode: currentBeforeCode,
    iterations,
  });

  for (const candidate of candidates) {
    if (iterations >= cfg.max_iterations) return stop();
    if (Date.now() - startedAt >= cfg.total_budget_ms) return stop();

    const replacement = replacementFor(candidate.node);
    if (replacement === null) continue; // whitelist 外 (通常 enumerateCandidates で弾かれる)

    const placeholderId = `$P${placeholders.length}`;
    const saved = readAt(candidate.parent, candidate.parentKey, candidate.listIndex);
    writeAt(candidate.parent, candidate.parentKey, candidate.listIndex, replacement.buildNode(placeholderId));

    let succeeded = false;
    try {
      let code: string;
      let reparsed: File;
      try {
        code = generate(beforeAst);
        reparsed = parse(code);
      } catch {
        continue; // round-trip 失敗 (finally で revert)
      }

      iterations += 1;
      const result = await cfg.checkEquivalence({
        setup: cfg.setup,
        before: code,
        after: cfg.afterCode,
        timeout_ms: cfg.timeout_ms,
      });

      if (!isEquivalentEnoughForPruning(result.verdict)) continue; // 不等価 / error → 次候補へ

      succeeded = true;
      placeholders.push({
        id: placeholderId,
        kind: replacement.placeholderKind,
        original_snippet: snippetOfNode(candidate.node, currentBeforeCode),
      });
      return {
        pruned: true,
        nextAst: reparsed,
        nextCode: code,
        iterations,
      };
    } finally {
      if (!succeeded) writeAt(candidate.parent, candidate.parentKey, candidate.listIndex, saved);
    }
  }

  return stop();
}

/**
 * 入力 AST に placeholder と同じ命名 (`$Pn`) の Identifier が含まれていれば
 * stderr に warning を出す。pruning 動作は変えない (候補列挙では placeholder と
 * 区別できず除外される副作用のみ)。ADR-0009。
 *
 * 重複検出を避けるため、同じ name は 1 input につき 1 行だけ通知する。
 */
function warnIfPlaceholderCollision(ast: File, label: "before" | "after"): void {
  const seen = new Set<string>();
  walkNodes(ast, ({ node }) => {
    if (node.type !== "Identifier") return;
    const { name } = node;
    if (!PLACEHOLDER_NAME_PATTERN.test(name)) return;
    if (seen.has(name)) return;
    seen.add(name);
    process.stderr.write(
      `warning: input (${label}) contains identifier "${name}" which collides with internal placeholder format. pruning may produce ambiguous results.\n`,
    );
  });
}

function readAt(parent: Node, parentKey: string, listIndex: number | undefined): unknown {
  const record = parent as unknown as Record<string, unknown>;
  if (listIndex === undefined) return record[parentKey];
  const arr = record[parentKey];
  return Array.isArray(arr) ? (arr as unknown[])[listIndex] : undefined;
}

/**
 * `parent[parentKey]` (listIndex 指定時は配列要素) に値を代入する。
 * `enumerateCandidates` (`walkNodes` 経由) の不変条件を信頼し、配列でない / 範囲外の
 * 不正位置は内部 bug として例外で fail-after する。
 */
function writeAt(
  parent: Node,
  parentKey: string,
  listIndex: number | undefined,
  value: unknown,
): void {
  const record = parent as unknown as Record<string, unknown>;
  if (listIndex === undefined) {
    record[parentKey] = value;
    return;
  }
  const arr = record[parentKey];
  if (!Array.isArray(arr) || listIndex < 0 || listIndex >= arr.length) {
    throw new Error(`writeAt: invalid position ${parent.type}.${parentKey}[${listIndex}]`);
  }
  (arr as unknown[])[listIndex] = value;
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect, vi } = import.meta.vitest;

  // resolveBudget は等価検証を呼ばないので、検証側は呼ばれない前提のスタブで十分。
  const stubDeps: PruneDeps = {
    checkEquivalence: () => Promise.resolve({ verdict: VERDICT.EQUAL }),
  };

  describe("warnIfPlaceholderCollision (in-source)", () => {
    it("入力に $Pn Identifier があれば stderr に warning を 1 行出す", () => {
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        warnIfPlaceholderCollision(parse("const $P0 = 1;"), "before");
        const calls = spy.mock.calls.map((c) => String(c[0]));
        expect(calls.some((m) => m.includes("warning") && m.includes("$P0") && m.includes("before")))
          .toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("同じ name の重複出現は 1 行に dedup される", () => {
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        warnIfPlaceholderCollision(parse("$P0; $P0; $P0;"), "after");
        const matches = spy.mock.calls.filter((c) => String(c[0]).includes("$P0"));
        expect(matches.length).toBe(1);
      } finally {
        spy.mockRestore();
      }
    });

    it("複数の異なる $Pn name は別行で通知される", () => {
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        warnIfPlaceholderCollision(parse("$P0; $P1;"), "before");
        const lines = spy.mock.calls.map((c) => String(c[0]));
        expect(lines.some((m) => m.includes("$P0"))).toBe(true);
        expect(lines.some((m) => m.includes("$P1"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("placeholder 形と無関係な Identifier では warning は出ない", () => {
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        warnIfPlaceholderCollision(parse("const x = $P; foo();"), "before");
        // `$P` (数字なし) は PLACEHOLDER_NAME_PATTERN に合わない
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("resolveBudget (in-source)", () => {
    it("timeout_ms / max_iterations のデフォルトは 5_000 / 1_000、total_budget_ms はその積", () => {
      const cfg = resolveBudget({ before: "", after: "" }, stubDeps);
      expect(cfg.timeout_ms).toBe(5_000);
      expect(cfg.max_iterations).toBe(1_000);
      expect(cfg.total_budget_ms).toBe(5_000_000);
    });

    it("入力で渡された値はデフォルトを上書きする", () => {
      const cfg = resolveBudget({ before: "", after: "", timeout_ms: 100, max_iterations: 7 }, stubDeps);
      expect(cfg.timeout_ms).toBe(100);
      expect(cfg.max_iterations).toBe(7);
      expect(cfg.total_budget_ms).toBe(700);
    });

    it("setup 未指定は空文字、after はそのまま afterCode に渡る", () => {
      const cfg = resolveBudget({ before: "a", after: "b" }, stubDeps);
      expect(cfg.setup).toBe("");
      expect(cfg.afterCode).toBe("b");
    });

    it("checkEquivalence は deps からそのまま cfg に渡る", () => {
      const cfg = resolveBudget({ before: "", after: "" }, stubDeps);
      expect(cfg.checkEquivalence).toBe(stubDeps.checkEquivalence);
    });
  });

  describe("readAt / writeAt (in-source)", () => {
    it("単一子: listIndex=undefined で read/write が round-trip する", () => {
      const parent = { type: "ExpressionStatement", expression: { type: "Identifier", name: "a" } } as unknown as Node;
      const saved = readAt(parent, "expression", undefined);
      writeAt(parent, "expression", undefined, { type: "NumericLiteral", value: 0 });
      expect((parent as unknown as { expression: { type: string } }).expression.type).toBe("NumericLiteral");
      writeAt(parent, "expression", undefined, saved);
      expect((parent as unknown as { expression: { type: string } }).expression.type).toBe("Identifier");
    });

    it("配列子: listIndex 指定で特定要素だけ書き換わる", () => {
      const a = { type: "Identifier", name: "a" };
      const b = { type: "Identifier", name: "b" };
      const c = { type: "Identifier", name: "c" };
      const parent = { type: "BlockStatement", body: [a, b, c] } as unknown as Node;
      writeAt(parent, "body", 1, { type: "EmptyStatement" });
      const body = (parent as unknown as { body: Array<{ type: string }> }).body;
      expect(body[0]?.type).toBe("Identifier");
      expect(body[1]?.type).toBe("EmptyStatement");
      expect(body[2]?.type).toBe("Identifier");
    });

    it("writeAt: 配列でない位置に listIndex を渡すと例外", () => {
      const parent = { type: "ExpressionStatement", expression: { type: "Identifier" } } as unknown as Node;
      expect(() => writeAt(parent, "expression", 0, { type: "NumericLiteral", value: 0 })).toThrow(/invalid position/);
    });

    it("writeAt: 配列の範囲外 index を渡すと例外", () => {
      const parent = { type: "BlockStatement", body: [{ type: "Identifier" }] } as unknown as Node;
      expect(() => writeAt(parent, "body", 5, { type: "EmptyStatement" })).toThrow(/invalid position/);
    });
  });
}
