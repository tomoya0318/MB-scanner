// baseline (prune-results.jsonl, literal 抽象化あり) vs litfix (MB_PRUNE_PROTECT_DIFF_LITERALS=1) を比較。
// 期待: pruned 集合は不変、リテラル placeholder が減り skeleton にリテラルが残る。
// 実行: node compare_litfix.mjs

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(HERE, "../../../../mb-analyzer/package.json"));
const { parseExpression } = require("@babel/parser");

const DATA = resolve(HERE, "../../preprocess_workload_reachability/code");
const load = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const base = new Map(load(join(DATA, "prune-results.jsonl")).map((r) => [r.id, r]));
const fix = new Map(load(join(HERE, "prune-results-litfix.jsonl")).map((r) => [r.id, r]));

const LIT = new Set(["NumericLiteral", "StringLiteral", "BooleanLiteral", "NullLiteral", "BigIntLiteral", "RegExpLiteral"]);
const isLit = (s) => {
  try {
    const n = parseExpression((s ?? "").trim());
    return LIT.has(n.type) || (n.type === "UnaryExpression" && LIT.has(n.argument?.type));
  } catch { return false; }
};
const litPhCount = (r) => (r.placeholders ?? []).filter((p) => isLit(p.original_snippet)).length;

// verdict 集合の変化
const verd = (m) => {
  const c = {};
  for (const r of m.values()) c[r.verdict] = (c[r.verdict] ?? 0) + 1;
  return c;
};
console.log("## baseline vs litfix\n");
console.log("verdict (baseline):", JSON.stringify(verd(base)));
console.log("verdict (litfix)  :", JSON.stringify(verd(fix)));

let baseLit = 0, fixLit = 0, basePh = 0, fixPh = 0;
const changed = [];
for (const [id, b] of base) {
  if (b.verdict !== "pruned") continue;
  const f = fix.get(id);
  const bl = litPhCount(b), fl = f && f.verdict === "pruned" ? litPhCount(f) : null;
  baseLit += bl; basePh += (b.placeholders ?? []).length;
  if (f && f.verdict === "pruned") { fixLit += fl; fixPh += (f.placeholders ?? []).length; }
  if (fl !== null && fl !== bl) {
    changed.push({ id, blPh: (b.placeholders ?? []).length, flPh: (f.placeholders ?? []).length, bl, fl,
      bNode: b.node_count_after, fNode: f.node_count_after, bVerd: b.verdict, fVerd: f.verdict });
  }
}

console.log(`\npruned candidate の placeholder 合計: baseline ${basePh} / litfix ${fixPh}`);
console.log(`うちリテラル placeholder: baseline ${baseLit} / litfix ${fixLit} (差 ${baseLit - fixLit} 個が skeleton へ)\n`);

console.log("### リテラル placeholder が減った candidate\n");
console.log("| id | PH(base→fix) | リテラルPH(base→fix) | node(base→fix) |");
console.log("|----|---|---|---|");
for (const c of changed.sort((a, b) => (b.bl - b.fl) - (a.bl - a.fl))) {
  const s = c.id.replace("Issues/issue_", "/").replace(/^client(Server)?Issues\//, "").replace(/^serverIssues\//, "");
  console.log(`| ${s} | ${c.blPh}→${c.flPh} | ${c.bl}→${c.fl} | ${c.bNode}→${c.fNode} |`);
}

// 5457 と 4263 の検証
for (const sub of ["issue_5457", "issue_4263"]) {
  const id = [...fix.keys()].find((k) => k.includes(sub));
  if (!id) continue;
  console.log(`\n### ${sub} placeholders (litfix)`);
  for (const p of (fix.get(id).placeholders ?? [])) {
    console.log(`- ${p.id} kind=${p.kind} lit=${isLit(p.original_snippet)} snippet=${JSON.stringify(p.original_snippet)}`);
  }
  console.log("  pattern_code:", (fix.get(id).pattern_code ?? "").replace(/\n/g, " | ").slice(0, 200));
}
