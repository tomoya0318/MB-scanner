import type {
  ArrowFunctionExpression,
  BlockStatement,
  CallExpression,
  File,
  FunctionDeclaration,
  FunctionExpression,
  Node,
  Statement,
} from "@babel/types";

import { parse } from "../../../ast/parser";
import { walkNodes } from "../../../ast/walk";

/**
 * Selakovic clientIssues の inline `<script>` から「ベンチマーク関数 `f1`」を特定し、
 * その body と「f1 定義より前の非ハーネス statement」「計測ハーネス statement」に役割分解する
 * (ADR-0011 §段1②)。
 *
 * `f1` の AST 親パスは実質 2 種:
 * - **top-level 直書き**: `var f1 = function(){...}` / `function f1(){...}` が Program 直下
 * - **Angular controller wrapper**: `app.controller("Ctrl", function($scope){ ...; var f1 = ...; ... })`
 *   (`.controller` / `.directive` / `.service` / `.factory` のいずれか)
 *
 * 計測ハーネス = `var a = execute(f1, n)` / `jStat(a).mean()` / `console.log(mean)` /
 * `$.ajax({mark, mean})` 等。f1 body 内のループ反復回数 (`for (i<50000)`) は書き換えない (ADR-0017)。
 *
 * 規約外フォーマット (f1 が見つからない / arrow 式 body 等) は `null` を返し、呼び出し側が
 * Tier 1 の素の top-level diff にフォールバックする。
 */

export type WrapperKind = "top-level" | "angular-controller-wrapper";

const HARNESS_FN_NAMES: ReadonlySet<string> = new Set(["execute", "jStat", "mean"]);

export interface AngularWrapperInfo {
  readonly moduleName: string;
  readonly ctrlMethod: string;
  readonly ctrlName: string;
  readonly ctrlParams: readonly string[];
}

export interface F1Decomposition {
  readonly wrapperKind: WrapperKind;
  /** f1 の body (BlockStatement) — slow/fast の母集団。 */
  readonly f1Body: BlockStatement;
  /** Program 直下 (top-level) or controller body 内で f1 定義より前の非ハーネス statement (= setup の一部)。 */
  readonly preWorkloadStatements: readonly Statement[];
  /** 計測ハーネス statement (= 破棄対象)。 */
  readonly harnessStatements: readonly Statement[];
  /** angular-controller-wrapper のとき: bootstrap 再構成に必要な情報。 */
  readonly angular?: AngularWrapperInfo;
}

type F1Fn = FunctionDeclaration | FunctionExpression | ArrowFunctionExpression;

interface F1Hit {
  readonly fn: F1Fn;
  readonly ancestors: readonly Node[];
}

export function extractF1(inlineSource: string): F1Decomposition | null {
  let file: File;
  try {
    file = parse(inlineSource);
  } catch {
    return null;
  }

  const hit = findF1(file);
  if (hit === null) return null;
  if (hit.fn.body.type !== "BlockStatement") return null; // arrow 式 body 等は未対応 → フォールバック
  const f1Body = hit.fn.body;

  const ctrlCallIdx = hit.ancestors.findIndex(isAngularComponentCall);
  if (ctrlCallIdx === -1) {
    return decomposeTopLevel(file, hit.fn, f1Body);
  }
  return decomposeAngularWrapper(file, hit, ctrlCallIdx, f1Body);
}

function findF1(file: File): F1Hit | null {
  let hit: F1Hit | null = null;
  walkNodes(file, ({ node, ancestors }) => {
    if (hit !== null) return;
    if (
      node.type === "FunctionDeclaration" &&
      node.id !== null &&
      node.id !== undefined &&
      node.id.name === "f1"
    ) {
      hit = { fn: node, ancestors };
      return;
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.id.name === "f1" &&
      node.init !== null &&
      node.init !== undefined &&
      (node.init.type === "FunctionExpression" || node.init.type === "ArrowFunctionExpression")
    ) {
      hit = { fn: node.init, ancestors };
    }
  });
  return hit;
}

function decomposeTopLevel(file: File, f1Fn: F1Fn, f1Body: BlockStatement): F1Decomposition {
  const body = file.program.body;
  const f1Idx = body.findIndex((stmt) => isF1DefStatement(stmt, f1Fn));
  const preWorkload: Statement[] = [];
  const harness: Statement[] = [];
  body.forEach((stmt, idx) => {
    if (idx === f1Idx) return;
    if (isHarnessStatement(stmt)) harness.push(stmt);
    else if (f1Idx === -1 || idx < f1Idx) preWorkload.push(stmt);
    // f1 定義より後ろの非ハーネス statement は捨てる (= レポート系の残骸)
  });
  return { wrapperKind: "top-level", f1Body, preWorkloadStatements: preWorkload, harnessStatements: harness };
}

function decomposeAngularWrapper(
  file: File,
  hit: F1Hit,
  ctrlCallIdx: number,
  f1Body: BlockStatement,
): F1Decomposition | null {
  const ctrlCall = hit.ancestors[ctrlCallIdx];
  if (ctrlCall === undefined || ctrlCall.type !== "CallExpression") return null;
  const ctrlMethod = angularComponentMethod(ctrlCall);
  if (ctrlMethod === null) return null;
  const ctrlName = firstStringArg(ctrlCall);
  if (ctrlName === null) return null;

  const ctrlFn = hit.ancestors
    .slice(ctrlCallIdx + 1)
    .find(
      (a): a is FunctionExpression | ArrowFunctionExpression =>
        a.type === "FunctionExpression" || a.type === "ArrowFunctionExpression",
    );
  if (ctrlFn === undefined || ctrlFn.body.type !== "BlockStatement") return null;
  const ctrlParams = ctrlFn.params.map((p) => (p.type === "Identifier" ? p.name : "$x"));

  const moduleName = findAngularModuleName(file);
  if (moduleName === null) return null;

  const ctrlBody = ctrlFn.body.body;
  const f1Idx = ctrlBody.findIndex((stmt) => isF1DefStatement(stmt, hit.fn));
  const preWorkload: Statement[] = [];
  const harness: Statement[] = [];
  ctrlBody.forEach((stmt, idx) => {
    if (idx === f1Idx) return;
    if (isHarnessStatement(stmt)) harness.push(stmt);
    else if (f1Idx === -1 || idx < f1Idx) preWorkload.push(stmt);
  });

  return {
    wrapperKind: "angular-controller-wrapper",
    f1Body,
    preWorkloadStatements: preWorkload,
    harnessStatements: harness,
    angular: { moduleName, ctrlMethod, ctrlName, ctrlParams },
  };
}

function isF1DefStatement(stmt: Statement, f1Fn: F1Fn): boolean {
  if (stmt === (f1Fn as Node)) return true; // FunctionDeclaration 形式
  if (stmt.type === "VariableDeclaration") {
    return stmt.declarations.some((d) => d.init === (f1Fn as Node));
  }
  return false;
}

const ANGULAR_COMPONENT_METHODS: ReadonlySet<string> = new Set([
  "controller",
  "directive",
  "service",
  "factory",
]);

function angularComponentMethod(node: Node): string | null {
  if (node.type !== "CallExpression") return null;
  const callee = node.callee;
  if (callee.type !== "MemberExpression") return null;
  if (callee.property.type !== "Identifier") return null;
  const name = callee.property.name;
  return ANGULAR_COMPONENT_METHODS.has(name) ? name : null;
}

function isAngularComponentCall(node: Node): boolean {
  return angularComponentMethod(node) !== null;
}

function firstStringArg(call: CallExpression): string | null {
  const a0 = call.arguments[0];
  if (a0 !== undefined && a0.type === "StringLiteral") return a0.value;
  return null;
}

function findAngularModuleName(file: File): string | null {
  let name: string | null = null;
  walkNodes(file, ({ node }) => {
    if (name !== null) return;
    if (node.type !== "CallExpression") return;
    const callee = node.callee;
    if (callee.type !== "MemberExpression") return;
    if (callee.object.type !== "Identifier" || callee.object.name !== "angular") return;
    if (callee.property.type !== "Identifier" || callee.property.name !== "module") return;
    const a0 = node.arguments[0];
    if (a0 !== undefined && a0.type === "StringLiteral") name = a0.value;
  });
  return name;
}

function isHarnessStatement(stmt: Statement): boolean {
  let harness = false;
  walkNodes(stmt, ({ node }) => {
    if (harness) return;
    if (node.type !== "CallExpression") return;
    const callee = node.callee;
    if (callee.type === "Identifier" && HARNESS_FN_NAMES.has(callee.name)) {
      harness = true;
      return;
    }
    if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
      // $.ajax({...})
      if (
        callee.object.type === "Identifier" &&
        callee.object.name === "$" &&
        callee.property.name === "ajax"
      ) {
        harness = true;
        return;
      }
      // console.log(mean) — mean は計測平均値
      if (
        callee.object.type === "Identifier" &&
        callee.object.name === "console" &&
        callee.property.name === "log"
      ) {
        const a0 = node.arguments[0];
        if (a0 !== undefined && a0.type === "Identifier" && a0.name === "mean") harness = true;
      }
    }
  });
  return harness;
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("extractF1 (in-source)", () => {
    it("top-level f1 を役割分解する (計測ハーネスを harness に分離)", () => {
      const src = `
        var obj = {};
        for (var i = 0; i < 100; i++) obj[i] = i;
        var keys = Object.keys(obj);
        var f1 = function () { for (var i = 0; i < keys.length; i++) keys[i] % 2 === 0; };
        var a = execute(f1, 10);
        var mean = jStat(a).mean();
        console.log(mean);
        $.ajax({ url: 'x', data: JSON.stringify({ mark: 0, mean: mean }) });
      `;
      const d = extractF1(src);
      expect(d).not.toBeNull();
      expect(d?.wrapperKind).toBe("top-level");
      expect(d?.angular).toBeUndefined();
      // preWorkload = var obj / for / var keys の 3 つ (harness は除外)
      expect(d?.preWorkloadStatements).toHaveLength(3);
      // harness = execute / mean / console.log / $.ajax の 4 つ
      expect(d?.harnessStatements).toHaveLength(4);
    });

    it("Angular controller-wrapper の f1 を役割分解する", () => {
      const src = `
        var app = angular.module("myApp", []);
        app.controller("Ctrl", function ($scope, $http) {
          var keys = [1, 2, 3];
          var f1 = function () { keys.length; };
          var a = execute(f1, 10);
        });
      `;
      const d = extractF1(src);
      expect(d?.wrapperKind).toBe("angular-controller-wrapper");
      expect(d?.angular?.moduleName).toBe("myApp");
      expect(d?.angular?.ctrlName).toBe("Ctrl");
      expect(d?.angular?.ctrlParams).toEqual(["$scope", "$http"]);
      expect(d?.preWorkloadStatements).toHaveLength(1); // var keys
      expect(d?.harnessStatements).toHaveLength(1); // execute(f1, 10)
    });

    it("f1 が無いと null (= フォールバック対象)", () => {
      expect(extractF1("function g() { return 1; }")).toBeNull();
    });

    it("parse できないソースは null", () => {
      expect(extractF1("var f1 = function () {")).toBeNull();
    });
  });
}
