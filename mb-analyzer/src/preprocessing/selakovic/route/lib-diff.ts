/**
 * `<lib>_before` / `<lib>_after` の差分が「実コード変化」かを判定する (ADR-0011 §段2 の入力)。
 *
 * 行ベースの multiset 差分で「license header / version 文字列 / 整形差を除いて実コード行が残るか」を見る
 * (= 作用点ルーティングに十分な近似。変更関数の AST レベル特定 + call site 到達可能性による narrowing は
 * 未実装)。lib ファイルは AngularJS (665KB) のように巨大なので、まず byte 一致で高速 short-circuit し、
 * 差がある共通ファイルだけ行差分する。multiset 差分は行の並べ替え (= 意味論変化なし) を相殺する一方、
 * 実コード行の変化は (両方の旧/新行が他所に重複しない限り) 検出する。
 */

const LICENSE_NOISE =
  /@license|@preserve|sha\.[0-9a-f]{6,}|-local\+sha|errors\.angularjs\.org|\bv?\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/;
const PUNCT_ONLY = /^[\s{}()[\];,]*$/;

export interface LibChangeSummary {
  /** license/version/整形 noise を除いて実コード行の変化があったか。 */
  readonly hasRealChange: boolean;
  /** 変化があった共通ファイルの relative key (複数あれば全部、ソート済)。 */
  readonly changedFiles: readonly string[];
  /**
   * 変化があった行の近傍 (= 直前の `function NAME` / `NAME = function` 等) から拾った関数名の集合。
   * ADR-0014 の co-evolution 交差判定 (`I ∩ F`) の `F` の近似 (行近傍ベース、AST レベルではない)。
   */
  readonly changedFunctionNames: ReadonlySet<string>;
}

export function diffLibPair(
  beforeFiles: Record<string, string>,
  afterFiles: Record<string, string>,
): LibChangeSummary {
  const commonKeys = Object.keys(beforeFiles)
    .filter((k) => k in afterFiles)
    .sort();
  const changedFiles: string[] = [];
  const changedFunctionNames = new Set<string>();
  for (const key of commonKeys) {
    const before = beforeFiles[key];
    const after = afterFiles[key];
    if (before === undefined || after === undefined) continue;
    if (before === after) continue;
    const result = analyzeFileChange(before, after);
    if (result.hasRealChange) {
      changedFiles.push(key);
      for (const name of result.functionNames) changedFunctionNames.add(name);
    }
  }
  return { hasRealChange: changedFiles.length > 0, changedFiles, changedFunctionNames };
}

const FN_DECL_PATTERNS = [
  /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/,
  /([A-Za-z_$][\w$]*)\s*[:=]\s*function\b/,
  /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*function\b/,
];

function analyzeFileChange(before: string, after: string): { hasRealChange: boolean; functionNames: Set<string> } {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const onlyBefore = new Set(multisetDiff(beforeLines, afterLines));
  const onlyAfter = new Set(multisetDiff(afterLines, beforeLines));
  const realBefore = [...onlyBefore].some(isRealCodeLine);
  const realAfter = [...onlyAfter].some(isRealCodeLine);
  const functionNames = new Set<string>();
  collectNearbyFunctionNames(beforeLines, onlyBefore, functionNames);
  collectNearbyFunctionNames(afterLines, onlyAfter, functionNames);
  return { hasRealChange: realBefore || realAfter, functionNames };
}

/** ファイルを線形に走査し、`changedLineSet` に含まれる行の直近上方の関数定義名を集める。 */
function collectNearbyFunctionNames(lines: readonly string[], changedLineSet: ReadonlySet<string>, out: Set<string>): void {
  let lastFnName: string | null = null;
  for (const line of lines) {
    for (const pattern of FN_DECL_PATTERNS) {
      const m = pattern.exec(line);
      if (m?.[1] !== undefined) {
        lastFnName = m[1];
        break;
      }
    }
    if (changedLineSet.has(line) && isRealCodeLine(line) && lastFnName !== null) {
      out.add(lastFnName);
    }
  }
}

function isRealCodeLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "") return false;
  if (PUNCT_ONLY.test(trimmed)) return false;
  if (LICENSE_NOISE.test(trimmed)) return false;
  return true;
}

/** `a` のうち `b` に (多重度を考慮して) 含まれない要素を返す。 */
function multisetDiff(a: readonly string[], b: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const line of b) counts.set(line, (counts.get(line) ?? 0) + 1);
  const out: string[] = [];
  for (const line of a) {
    const c = counts.get(line) ?? 0;
    if (c > 0) counts.set(line, c - 1);
    else out.push(line);
  }
  return out;
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("diffLibPair (in-source)", () => {
    it("byte 一致は変化なし", () => {
      const same = { "a.js": "function f() { return 1; }" };
      expect(diffLibPair(same, { "a.js": "function f() { return 1; }" }).hasRealChange).toBe(false);
    });

    it("実コード行の変化を検出し、近傍の関数名を拾う", () => {
      const r = diffLibPair(
        { "a.js": "function ngRepeatAction() {\n  return index % 2 == 0;\n}" },
        { "a.js": "function ngRepeatAction() {\n  return index & 1 == 0;\n}" },
      );
      expect(r.hasRealChange).toBe(true);
      expect(r.changedFiles).toEqual(["a.js"]);
      expect(r.changedFunctionNames.has("ngRepeatAction")).toBe(true);
    });

    it("license header / version 文字列だけの差は変化なし扱い", () => {
      const r = diffLibPair(
        { "a.js": "/* @license AngularJS v1.3.18 */\nfunction f() { return 1; }" },
        { "a.js": "/* @license AngularJS v1.3.20 */\nfunction f() { return 1; }" },
      );
      expect(r.hasRealChange).toBe(false);
    });
  });
}
