// Spike: 「pruning がリテラルを抽象化しない」ルールの影響を、既存 50 pruned 結果から静的に測定する。
// 本体 (isCandidate) は変更せず、placeholder の original_snippet を分類して
// 「リテラルだった placeholder = 新ルールで skeleton に戻る数」を数える。
//
// 注意: pruning が iterate&keep (貪欲) なら厳密な再走で多少ずれるが、リテラルは葉なので
// 他候補への影響は小さく、本静的見積りは良い近似 (要・本走確認は本体修正後)。
//
// 実行: node spike_literal_impact.mjs

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(HERE, "../../../../mb-analyzer/package.json"));
const { parseExpression } = require("@babel/parser");

const DATA = resolve(HERE, "../../preprocess_workload_reachability/code");
const pres = readFileSync(join(DATA, "prune-results.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => r.verdict === "pruned");

const LITERAL_TYPES = new Set([
  "NumericLiteral", "StringLiteral", "BooleanLiteral", "NullLiteral",
  "BigIntLiteral", "RegExpLiteral",
]);

// snippet を式としてパースし種別を返す。失敗 (statement 等) は "non-expr"。
function classify(kind, snippet) {
  if (kind === "statement") return "statement";
  if (kind === "identifier") return "identifier";
  const s = (snippet ?? "").trim();
  try {
    const node = parseExpression(s);
    if (LITERAL_TYPES.has(node.type)) return "literal";
    if (node.type === "UnaryExpression" && node.argument && LITERAL_TYPES.has(node.argument.type)) {
      return "literal"; // -1 などの符号付き
    }
    if (node.type === "Identifier") return "identifier";
    if (node.type === "MemberExpression") return "member";
    if (node.type === "CallExpression") return "call";
    return node.type;
  } catch {
    return "unparsed";
  }
}

const kindCounts = new Map();
let totalPh = 0;
let litPh = 0;
const perCand = [];
for (const r of pres) {
  const phs = r.placeholders ?? [];
  let lits = 0;
  const litSnippets = [];
  for (const ph of phs) {
    const c = classify(ph.kind, ph.original_snippet);
    kindCounts.set(c, (kindCounts.get(c) ?? 0) + 1);
    totalPh += 1;
    if (c === "literal") {
      litPh += 1;
      lits += 1;
      litSnippets.push(ph.original_snippet);
    }
  }
  perCand.push({
    id: r.id,
    nPh: phs.length,
    nLit: lits,
    nodeAfter: r.node_count_after,
    litSnippets,
  });
}

console.log("## Spike: リテラルを抽象化しない場合の影響 (50 pruned)\n");
console.log(`総 placeholder 数: ${totalPh}`);
console.log(`うちリテラル: ${litPh} (${((litPh / totalPh) * 100).toFixed(0)}%) → 新ルールで skeleton に戻る\n`);

console.log("### placeholder スニペットの種別分布\n");
console.log("| 種別 | 数 |");
console.log("|------|---:|");
for (const [k, v] of [...kindCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`| ${k} | ${v} |`);
}

console.log("\n### リテラル placeholder を持つ candidate (= 形が変わる)\n");
console.log("| id | 全PH | リテラルPH | node数 | node数(推定後) | リテラル例 |");
console.log("|----|---:|---:|---:|---:|------|");
const affected = perCand.filter((c) => c.nLit > 0).sort((a, b) => b.nLit - a.nLit);
for (const c of affected) {
  const short = c.id.replace("Issues/issue_", "/").replace(/^client(Server)?Issues\//, "").replace(/^serverIssues\//, "");
  const exΥ = c.litSnippets.slice(0, 4).map((s) => JSON.stringify(s)).join(", ");
  // node 数はリテラル placeholder が skeleton リテラルに置換されるだけなので ~不変 (±0)
  console.log(`| ${short} | ${c.nPh} | ${c.nLit} | ${c.nodeAfter} | ${c.nodeAfter} | ${exΥ} |`);
}
console.log(`\n影響を受ける candidate: ${affected.length} / ${pres.length}`);

// 5457 詳細
const c5457 = pres.find((r) => r.id.includes("issue_5457"));
if (c5457) {
  console.log("\n### 5457 の placeholder 詳細 (狙い: 0/2 はリテラル→skeleton, key は identifier→wildcard 維持)\n");
  for (const ph of c5457.placeholders ?? []) {
    console.log(`- ${ph.id} kind=${ph.kind} class=${classify(ph.kind, ph.original_snippet)} snippet=${JSON.stringify(ph.original_snippet)}`);
  }
}
