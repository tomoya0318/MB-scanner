import type { File, Node } from "@babel/types";

import { parse } from "../../ast/parser";
import { walkNodes } from "../../ast/walk";
import { FN_TYPES, functionBindingName } from "./change-units";

/**
 * workload-reachability の判定: 「変更を含む unit を (推移的に) 実行する workload があるか」を
 * 名前ベースの参照グラフで近似する (plan §候補選別の向き = change-driven)。
 *
 * グラフのノード = lib 内の named 関数 + workload root (synthetic)。名前は **member-access の末端**
 * (`x.foo(...)` → `foo`) で表す = 同名メソッドで膨らむ over-approximation だが KEEP 寄り = 安全側
 * (誤って DROP すると変更を見逃す)。エッジ: 各ノードの body 内で参照されている識別子 / メンバ名へ
 * (call site だけでなく `.foo` の読みも含む — stmt unit の binding (`Ember.VERSION` 等) を「reachable
 * な関数が参照しているか」で判定するため)。
 *
 * データセットでは workload は issue ごとに `{ f1 }` 1 個。一般 PR では repo の test suite を
 * `workloadRoots: [{name:"test_a", body:[...]}, {name:"test_b", body:[...]}, ...]` として渡し、
 * 変更 unit ごとに `callersOf(unit) ∩ {テスト名}` を見る (= test-impact 解析。同じグラフを再利用)。
 */

const SYNTHETIC_WORKLOAD_PREFIX = "@workload:";

export interface CallGraph {
  /** name -> その body 内で参照される名前 (= 呼ぶ/読む先) の集合。forward edge: referrer -> referee。 */
  readonly refs: ReadonlyMap<string, ReadonlySet<string>>;
  /** lib 内の named 関数名 (末端セグメント、over-approx)。 */
  readonly fnNames: ReadonlySet<string>;
  /** workload root の synthetic ノード名 (`@workload:f1` 等)。 */
  readonly workloadNodes: ReadonlySet<string>;
}

function nodeType(n: Node | undefined): string | undefined {
  return (n as unknown as { type?: string } | undefined)?.type;
}

/** `"a.b.c"` → `"c"` / `"x"` → `"x"`。member-access 名を末端セグメントに正規化する。 */
export function lastSegment(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? name : name.slice(i + 1);
}

/**
 * ノード `subtree` の中で「参照されている名前」を集める。`Identifier`、`x.foo` の `foo`、
 * `new C(...)` の `C`、`foo(...)` の `foo` を拾う (= ほぼ全 Identifier + computed でない MemberExpression
 * の property)。ローカル束縛 (params / `var` / `function` 宣言) も区別せず拾う over-approx 版。
 */
function collectReferencedNames(subtree: Node): Set<string> {
  const names = new Set<string>();
  walkNodes(subtree, ({ node, parent, parentKey }) => {
    const t = nodeType(node);
    if (t === "Identifier") {
      // MemberExpression の computed でない property / ObjectProperty の key は「名前参照」ではないが、
      // .foo の foo はメソッド名として拾いたいので property は拾う (key は拾わない)。
      if (parent && nodeType(parent) === "ObjectProperty" && parentKey === "key") return;
      names.add((node as unknown as { name: string }).name);
    }
    if (t === "StringLiteral" && parent && nodeType(parent) === "MemberExpression" && parentKey === "property") {
      // x["foo"] の "foo"
      names.add((node as unknown as { value: string }).value);
    }
  });
  return names;
}

/**
 * lib の全 named 関数 + 各 workload root をスキャンして参照グラフを作る。
 *
 * @param libAst         patch 対象 lib の AST (before か after — 候補選別では before を使う)
 * @param workloadRoots  workload の根。`body` はその workload を構成する statement / ノード列
 *                       (データセットでは `[{ name: "f1", body: [...preWorkloadStatements, ...f1BodyStatements] }]`)
 */
export function buildCallGraph(
  libAst: File,
  workloadRoots: readonly { readonly name: string; readonly body: readonly Node[] }[],
): CallGraph {
  const refs = new Map<string, Set<string>>();
  const fnNames = new Set<string>();

  walkNodes(libAst, ({ node, ancestors }) => {
    if (!FN_TYPES.has(node.type)) return;
    const qualified = functionBindingName(ancestors, node);
    if (qualified === null) return; // 匿名関数は独立ノードにしない (= それを囲う named 関数の body の一部として参照が拾われる)
    const name = lastSegment(qualified);
    fnNames.add(name);
    const referenced = collectReferencedNames(node);
    referenced.delete(name); // 自己参照は無視 (recursion)
    const existing = refs.get(name);
    if (existing) for (const r of referenced) existing.add(r);
    else refs.set(name, referenced);
  });

  const workloadNodes = new Set<string>();
  for (const root of workloadRoots) {
    const synthetic = SYNTHETIC_WORKLOAD_PREFIX + root.name;
    workloadNodes.add(synthetic);
    const referenced = new Set<string>();
    for (const stmt of root.body) for (const r of collectReferencedNames(stmt)) referenced.add(r);
    refs.set(synthetic, referenced);
  }

  return { refs, fnNames, workloadNodes };
}

/** `target` (関数名 / binding 名。member-access なら末端で照合) を (推移的に) 参照するノード名の集合 (target 自身は含まない)。reverse BFS。 */
export function callersOf(graph: CallGraph, target: string): Set<string> {
  const goal = lastSegment(target);
  const result = new Set<string>();
  // forward edges を逆引きしながら BFS。frontier = 「まだ展開していない『target に (推移的に) 到達する名前』」。
  let frontier = new Set<string>([goal]);
  while (frontier.size > 0) {
    const next = new Set<string>();
    for (const [referrer, referees] of graph.refs) {
      if (result.has(referrer)) continue;
      let touches = false;
      for (const f of frontier) if (referees.has(f)) { touches = true; break; }
      if (touches) { result.add(referrer); next.add(referrer); }
    }
    frontier = next;
  }
  result.delete(goal);
  return result;
}

/** 変更 unit の名前 `target` を実行する workload があるか = backward closure に workload ノードが入るか。 */
export function isReachedByAnyWorkload(graph: CallGraph, target: string): boolean {
  const callers = callersOf(graph, target);
  for (const w of graph.workloadNodes) if (callers.has(w)) return true;
  return false;
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  // 観点: lib の named 関数 + workload root の参照グラフを作り、変更 unit (関数名 / binding 名) が
  // workload から (推移的に) 到達可能かを判定。直接呼び出し / 推移呼び出し / 未参照 / binding 参照 /
  // member-access 末端正規化 をカバー。

  const libAst = (body: string): File => parse(`(function () {\n${body}\n})();`);
  const stmts = (code: string): Node[] => (parse(code).program.body as unknown as Node[]);

  describe("lastSegment (in-source)", () => {
    it("末端セグメントを返す", () => {
      expect(lastSegment("a.b.c")).toBe("c");
      expect(lastSegment("foo")).toBe("foo");
      expect(lastSegment("jQuery.fn.index")).toBe("index");
    });
  });

  describe("buildCallGraph / isReachedByAnyWorkload (in-source)", () => {
    const lib = libAst(`
      var VERSION = '1.0';
      function helper() { return VERSION + 'x'; }
      var api = {
        foo: function () { return helper(); },
        bar: function () { return 42; },
        unused: function () { return 'never'; }
      };
    `);

    it("workload が直接呼ぶ関数 → reachable", () => {
      const g = buildCallGraph(lib, [{ name: "f1", body: stmts("api.foo();") }]);
      expect(isReachedByAnyWorkload(g, "foo")).toBe(true);
      expect(isReachedByAnyWorkload(g, "api.foo")).toBe(true); // member-access でも末端で照合
    });

    it("推移的に呼ばれる関数 → reachable", () => {
      const g = buildCallGraph(lib, [{ name: "f1", body: stmts("api.foo();") }]);
      expect(isReachedByAnyWorkload(g, "helper")).toBe(true); // foo -> helper
    });

    it("workload が参照しない関数 → not reachable (DROP 相当)", () => {
      const g = buildCallGraph(lib, [{ name: "f1", body: stmts("api.foo();") }]);
      expect(isReachedByAnyWorkload(g, "bar")).toBe(false);
      expect(isReachedByAnyWorkload(g, "unused")).toBe(false);
    });

    it("reachable な関数が参照する binding → reachable / 誰も読まない binding → not reachable (version-bump DROP)", () => {
      const g = buildCallGraph(lib, [{ name: "f1", body: stmts("api.foo();") }]);
      expect(isReachedByAnyWorkload(g, "VERSION")).toBe(true); // helper が VERSION を読む
      const g2 = buildCallGraph(lib, [{ name: "f1", body: stmts("api.bar();") }]);
      expect(isReachedByAnyWorkload(g2, "VERSION")).toBe(false); // bar も誰も VERSION を読まない
    });

    it("複数 workload root のいずれかから到達可能なら reachable", () => {
      const g = buildCallGraph(lib, [
        { name: "test_a", body: stmts("api.bar();") },
        { name: "test_b", body: stmts("api.foo();") },
      ]);
      expect(isReachedByAnyWorkload(g, "helper")).toBe(true); // test_b -> foo -> helper
      expect(isReachedByAnyWorkload(g, "unused")).toBe(false);
    });

    it("callersOf は target を (推移的に) 参照するノード名の集合 (target 自身は含まない)", () => {
      const g = buildCallGraph(lib, [{ name: "f1", body: stmts("api.foo();") }]);
      const callers = callersOf(g, "helper");
      expect(callers.has("foo")).toBe(true);
      expect(callers.has("@workload:f1")).toBe(true);
      expect(callers.has("helper")).toBe(false);
    });
  });
}
