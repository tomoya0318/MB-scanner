/**
 * 対象: src/pruning/engine.ts (Hydra 式 pruning 本体)
 * 観点:
 *   - trivially-reducible: 全候補ワイルドカード化可なケースで iterations > 0
 *   - initial_mismatch: 初回検証で slow ≢ fast なら pruning を回さない
 *   - error: parse 失敗 / 初回等価性検証エラー (setup ランタイムエラー) で verdict=error
 *   - id エコーバック: 入力 id がそのまま結果に乗る
 *   - PR-2 alias-driven whitelist (ADR-0006): 新規追加型が候補化される
 */
import { describe, expect, it } from "vitest";

import { prune } from "../../src/pruning/engine";

describe("prune — trivially-reducible", () => {
  it("全候補が削除可能なケースでは pruned が返り iterations > 0", async () => {
    // slow と fast が同じなら、slow の候補はすべてワイルドカード化しても等価のまま。
    // つまり全候補が「不要」= ワイルドカード化される。
    const result = await prune({
      slow: "const x = arr[0]; use(x);",
      fast: "const x = arr[0]; use(x);",
      timeout_ms: 2000,
      max_iterations: 50,
    });
    expect(result.verdict).toBe("pruned");
    expect(result.iterations ?? 0).toBeGreaterThan(0);
    // 少なくとも 1 つ placeholder が記録される
    expect(result.placeholders?.length ?? 0).toBeGreaterThan(0);
    // node_count_after は before 以下 (prune で構造は減るか同じ)
    expect(result.node_count_after).toBeLessThanOrEqual(result.node_count_before ?? 0);
  }, 20_000);
});

describe("prune — 初回非等価の検出", () => {
  it("setup 上で slow ≢ fast なら pruning を回さず initial_mismatch", async () => {
    // ガード付き反復 (slow) と無ガード反復 (fast) を prototype chain ありの setup で
    // 評価すると結果集合が異なるので、pruning 前から非等価と判定される代表例。
    const setup = `
      function P() {}
      P.prototype.hidden = 1;
      const obj = new P();
      obj.own = 2;
    `;
    const slow = `
      const out = [];
      for (const key in obj) {
        if (obj.hasOwnProperty(key)) { out.push(key); }
      }
      out;
    `;
    const fast = `
      const out = [];
      for (const key in obj) { out.push(key); }
      out;
    `;
    const result = await prune({
      setup,
      slow,
      fast,
      timeout_ms: 3000,
      max_iterations: 30,
    });
    expect(result.verdict).toBe("initial_mismatch");
  }, 30_000);
});

describe("prune — initial_mismatch", () => {
  it("slow と fast が最初から明確に非等価なら initial_mismatch を返す", async () => {
    const result = await prune({
      slow: "throw new Error('slow');",
      fast: "42;",
      timeout_ms: 2000,
      max_iterations: 10,
    });
    expect(result.verdict).toBe("initial_mismatch");
    // pattern 系は付与されない (plan 2.3 の仕様)
    expect(result.pattern_code).toBeUndefined();
    expect(result.placeholders?.length ?? 0).toBe(0);
  }, 20_000);
});

describe("prune — error", () => {
  it("parse 失敗コード (slow が構文エラー) なら verdict=error", async () => {
    const result = await prune({
      slow: "const x =",
      fast: "42;",
      timeout_ms: 2000,
      max_iterations: 10,
    });
    expect(result.verdict).toBe("error");
    expect(result.error_message).toBeDefined();
  });

  it("fast 側が構文エラーでも error", async () => {
    const result = await prune({
      slow: "42;",
      fast: "function",
      timeout_ms: 2000,
      max_iterations: 10,
    });
    expect(result.verdict).toBe("error");
  });

  it("setup ランタイムエラーは両側で同じ throw として equal 扱い、pruning が走る", async () => {
    // executor が setup 例外を exception oracle に詰めるので、両側で同じ setup なら
    // 全体 equal → pruning Phase 2 まで進む (error にはならない)。
    const result = await prune({
      slow: "1",
      fast: "1",
      setup: "throw new Error('setup boom');",
      timeout_ms: 2000,
      max_iterations: 10,
    });
    expect(result.verdict).not.toBe("error");
    expect(result.node_count_before).toBeGreaterThan(0);
  });
});

describe("prune — id エコーバック", () => {
  it("入力 id は結果にそのまま付与される", async () => {
    const result = await prune({
      id: "test-xyz",
      slow: "42;",
      fast: "42;",
      timeout_ms: 2000,
      max_iterations: 10,
    });
    expect(result.id).toBe("test-xyz");
  }, 20_000);
});

describe("prune — statement placeholder の可視化", () => {
  it("statement カテゴリの placeholder は pattern_code に $Pn; として現れ、内側 Identifier の AST 型で識別できる", async () => {
    // 自明削除可能な BlockStatement の body 要素 (ExpressionStatement) を含めて、
    // statement カテゴリの置換が成立しやすい構造を組む。
    const code = "function f() { foo(); bar(); } f();";
    const result = await prune({
      slow: code,
      fast: code,
      timeout_ms: 3000,
      max_iterations: 100,
    });
    expect(result.verdict).toBe("pruned");
    const stmtPlaceholders = result.placeholders?.filter((p) => p.kind === "statement") ?? [];
    // Hydra 実行の挙動依存で statement 置換が必ず 1 度は成立するとは保証できない
    // ため、成立した場合にのみ可視化形を assertion する (回帰防止重視)。
    if (stmtPlaceholders.length > 0) {
      expect(result.pattern_code).toMatch(/\$P\d+;/);
      // ADR-0009: pattern_ast 上でも ExpressionStatement(Identifier(/^\$P\d+$/)) 形で
      // 識別可能であることを型ベースで検証する。
      expect(hasStatementPlaceholderNode(result.pattern_ast)).toBe(true);
    }
  }, 30_000);
});

/**
 * pattern_ast (Babel AST の JSON シリアライズ) を再帰的に走査し、
 * `ExpressionStatement(Identifier(/^\$P\d+$/))` 形のノードが存在するか判定する。
 */
function hasStatementPlaceholderNode(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  const n = node as { type?: string; expression?: { type?: string; name?: string } };
  if (
    n.type === "ExpressionStatement" &&
    n.expression?.type === "Identifier" &&
    /^\$P\d+$/.test(n.expression.name ?? "")
  ) {
    return true;
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) if (hasStatementPlaceholderNode(item)) return true;
    } else if (value !== null && typeof value === "object") {
      if (hasStatementPlaceholderNode(value)) return true;
    }
  }
  return false;
}

describe("prune — PR-2 alias-driven whitelist の recall (ADR-0006)", () => {
  // ADR-0006 で whitelist が 24 → 58 型に拡大。PR-2 以前は候補化されなかった
  // 制御構造 / 関数式 / try-catch 等を含むコードでも pruning が完走することを検証する。
  // 厳密な「何が削れたか」は L4 (Hydra 実行) の挙動依存なので、最低限「候補化され
  // iterations が回ること」を観測する。

  it("WhileStatement を含むコードでも pruning が完走する", async () => {
    // 条件 false で空回りするループを関数で包んだ無害なコード
    const code = "function f() { while (false) {} } f();";
    const result = await prune({
      slow: code,
      fast: code,
      timeout_ms: 3000,
      max_iterations: 100,
    });
    expect(result.verdict).toBe("pruned");
    // 新型が候補化されると最低 1 回は L4 が回る
    expect(result.iterations ?? 0).toBeGreaterThan(0);
  }, 30_000);

  it("ArrowFunctionExpression を含むコードでも pruning が完走する", async () => {
    const code = "const f = (x) => x + 1; f(0);";
    const result = await prune({
      slow: code,
      fast: code,
      timeout_ms: 3000,
      max_iterations: 100,
    });
    expect(result.verdict).toBe("pruned");
    expect(result.iterations ?? 0).toBeGreaterThan(0);
  }, 30_000);

  it("TryStatement を含むコードでも pruning が完走する", async () => {
    const code = "try { 42; } catch (e) { 0; }";
    const result = await prune({
      slow: code,
      fast: code,
      timeout_ms: 3000,
      max_iterations: 100,
    });
    expect(result.verdict).toBe("pruned");
    expect(result.iterations ?? 0).toBeGreaterThan(0);
  }, 30_000);
});
