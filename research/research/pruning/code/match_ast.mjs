// Backend B (AST tree-match): pruned pattern_code を @babel/parser でパースし、
// 各パターンの before-shape を AST ノード条件で判定する。
// strict = 生 pattern_code (骨格) / loose = placeholder 展開後 (reconstructed)。
//
// 実行: NODE_PATH=<mb-analyzer/node_modules> node match_ast.mjs
// 入力: shape-targets.json (match_regex.py が生成)
// 出力: 標準出力に md 表 + ast-match.json

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
// @babel/* は mb-analyzer/node_modules にあるので、そこを anchor に require 解決する
const require = createRequire(resolve(HERE, "../../../../mb-analyzer/package.json"));
const { parse } = require("@babel/parser");
const _traverse = require("@babel/traverse");
const traverse = _traverse.default ?? _traverse;

// $P0 / $P12 はそのままでも valid 識別子だが、念のため安全な識別子へ退避してから parse
function sanitize(code) {
  return code.replace(/\$P(\d+)/g, "_PH$1_");
}

function toAst(code) {
  try {
    return parse(sanitize(code), {
      sourceType: "script",
      allowReturnOutsideFunction: true,
      errorRecovery: true,
    });
  } catch {
    return null;
  }
}

const prop = (n) => {
  const p = n?.property;
  if (!p) return null;
  return p.name ?? p.value ?? null; // 計算プロパティの 0 / "" を || で潰さないよう ?? で扱う
};

// パターン番号 → AST マッチャ (1つでも該当ノードがあれば true)
const MATCHERS = {
  1: (ast) => hasNode(ast, (n) => n.type === "ForInStatement"),
  2: (ast) => hasNode(ast, (n) =>
    n.type === "CallExpression" && prop(n.callee) === "substr" &&
    n.arguments.length >= 2 && n.arguments[1].type === "NumericLiteral" && n.arguments[1].value === 1),
  3: (ast) => hasNode(ast, (n) =>
    n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "String"),
  4: (ast) => hasNode(ast, (n) =>
    n.type === "CallExpression" && prop(n.callee) === "html" &&
    n.arguments.length === 1 && n.arguments[0].type === "StringLiteral" && n.arguments[0].value === ""),
  5: (ast) => hasNode(ast, (n) =>
    n.type === "CallExpression" && prop(n.callee) === "substr" && n.arguments.length >= 2 &&
    n.arguments[0].type === "NumericLiteral" && n.arguments[0].value === 0 &&
    n.arguments[1].type === "NumericLiteral" && n.arguments[1].value === 2),
  6: (ast) => hasNode(ast, (n) =>
    n.type === "CallExpression" && prop(n.callee) === "join" &&
    n.callee.object?.type === "CallExpression" && prop(n.callee.object.callee) === "split"),
  7: (ast) => hasNode(ast, (n) => {
    if (n.type === "StringLiteral") return /^\[object\s+\w+\]$/.test(n.value);
    if (n.type !== "CallExpression" || prop(n.callee) !== "call") return false;
    const obj = n.callee.object;
    // X.prototype.toString.call(...) (prop で toString) と bare toString.call(...) (Identifier) の両形を拾う
    return prop(obj) === "toString" || (obj?.type === "Identifier" && obj.name === "toString");
  }),
  8: (ast) => hasNode(ast, (n) =>
    n.type === "BinaryExpression" && n.operator === "%" &&
    n.right.type === "NumericLiteral" && n.right.value === 2),
  9: (ast) => hasNode(ast, (n) => n.type === "CallExpression" && prop(n.callee) === "reduce"),
  10: (ast) => hasNode(ast, (n) => {
    // .join( ... ) で、その object が slice.call(arguments) の形
    if (!(n.type === "CallExpression" && prop(n.callee) === "join")) return false;
    const inner = n.callee.object; // expected: CallExpression slice.call(arguments)
    return inner?.type === "CallExpression" && prop(inner.callee) === "call" &&
      prop(inner.callee.object) === "slice" &&
      inner.arguments.some((a) => a.type === "Identifier" && a.name === "arguments");
  }),
};

function hasNode(ast, pred) {
  let found = false;
  traverse(ast, {
    enter(path) {
      if (!found && pred(path.node)) found = true;
    },
  });
  return found;
}

function detect(codes, matcher) {
  return codes.some((c) => {
    const ast = toAst(c);
    return ast ? matcher(ast) : false;
  });
}

const targets = JSON.parse(readFileSync(join(HERE, "shape-targets.json"), "utf8"));

// pattern 単位に集約
const byPattern = new Map();
const rows = [];
for (const t of targets) {
  const m = MATCHERS[t.pattern];
  const strict = detect(t.pattern_codes, m);
  // loose = skeleton ∪ フル展開 ∪ 各 placeholder スニペット。
  // フル展開は連結崩れで parse 不能なことがある (例 EJS 136b の };else if) ので、
  // その場合も断片 (valid) で拾えるよう 3 系統を OR する。
  const loose = strict || detect(t.reconstructed, m) || detect(t.placeholder_snippets ?? [], m);
  rows.push({ pattern: t.pattern, id: t.id, strict, loose });
  if (!byPattern.has(t.pattern)) byPattern.set(t.pattern, { strict: false, loose: false, n: 0 });
  const agg = byPattern.get(t.pattern);
  agg.strict ||= strict;
  agg.loose ||= loose;
  agg.n += 1;
}

console.log("## Backend B (AST tree-match): before-shape 検出 (pruned issue のみ)\n");
console.log("| P | issue | strict(骨格) | loose(展開後) |");
console.log("|---|-------|:--:|:--:|");
for (const r of rows) {
  console.log(`| P${r.pattern} | ${r.id.split("/").pop()} | ${r.strict ? "✅" : "❌"} | ${r.loose ? "✅" : "❌"} |`);
}

console.log("\n## パターン単位 (pruned issue を OR 集約)\n");
console.log("| P | pruned issue | AST strict | AST loose |");
console.log("|---|----:|:--:|:--:|");
for (const [p, agg] of [...byPattern.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`| P${p} | ${agg.n} | ${agg.strict ? "✅" : "❌"} | ${agg.loose ? "✅" : "❌"} |`);
}

writeFileSync(join(HERE, "ast-match.json"), JSON.stringify(rows, null, 2));
