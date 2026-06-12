import generateModule from "@babel/generator";
import { parse as babelParse, type ParserPlugin } from "@babel/parser";
import type { File, Node } from "@babel/types";

/**
 * Babel parse / generate の汎用ラッパー。
 *
 * `plugins` は optional で、各機能が必要な構文 plugin を渡せる:
 * - `pruning` 側は `pruning/rules/whitelist.ts` の `PARSER_PLUGINS` を渡す (ADR-0006 一元管理)
 * - `preprocessing` 側は素 JS のみで plugins=[] (デフォルト)
 *
 * パーサ設定方針:
 * - `sourceType: "module"` (関数外 return / await / super を allowOutside フラグで許容)
 * - errorRecovery=false で SyntaxError を即 throw
 */
export function parse(code: string, plugins: readonly ParserPlugin[] = []): File {
  return babelParse(code, {
    sourceType: "module",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowSuperOutsideMethod: true,
    allowUndeclaredExports: true,
    errorRecovery: false,
    plugins: [...plugins],
  });
}

function resolveGenerator(): typeof generateModule {
  return (generateModule as unknown as { default?: typeof generateModule }).default ?? generateModule;
}

/**
 * `comments: false` を渡すと Node に attach された leading/trailing コメントを除去して出力。
 * デフォルト (`undefined`) は @babel/generator のデフォルト挙動 = コメントを残す
 * (既存呼び出しの後方互換)。
 */
export interface GenerateOptions {
  comments?: boolean;
}

export function generate(file: File, opts: GenerateOptions = {}): string {
  return resolveGenerator()(file, { comments: opts.comments }).code;
}

/**
 * 任意の Node を generate する。`generate(file)` は File 専用なので、Node 単独を
 * generate したいケース (snippetOfNode の fallback 等) で使う。失敗時は空文字。
 */
export function tryGenerateNode(node: Node, opts: GenerateOptions = {}): string {
  try {
    return resolveGenerator()(node, { comments: opts.comments }).code;
  } catch {
    return "";
  }
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("parse (in-source)", () => {
    it("式を含むスニペットを File として parse する", () => {
      const file = parse("const x = arr[0];");
      expect(file.type).toBe("File");
      expect(file.program.body).toHaveLength(1);
      expect(file.program.body[0]?.type).toBe("VariableDeclaration");
    });

    it("空文字列は空 body を持つ File を返す", () => {
      const file = parse("");
      expect(file.type).toBe("File");
      expect(file.program.body).toHaveLength(0);
    });

    it("関数外の return も許容する (pruning 対象スニペット向け)", () => {
      const file = parse("return arr[0];");
      expect(file.program.body[0]?.type).toBe("ReturnStatement");
    });

    it("関数外の await も許容する", () => {
      const file = parse("await fetch(url);");
      expect(file.program.body[0]?.type).toBe("ExpressionStatement");
    });

    it("plugins デフォルトでは TypeScript の型アノテーションは SyntaxError", () => {
      expect(() => parse("const x: number = 1;")).toThrow(SyntaxError);
    });

    it("plugins デフォルトでは JSX も SyntaxError", () => {
      expect(() => parse("const el = <div>hi</div>;")).toThrow(SyntaxError);
    });

    it("syntax error は SyntaxError として投げる", () => {
      expect(() => parse("const x =")).toThrow(SyntaxError);
    });

    it("複数文を parse して順序を保つ", () => {
      const file = parse("const a = 1; const b = 2; a + b;");
      expect(file.program.body).toHaveLength(3);
      expect(file.program.body.map((n) => n.type)).toEqual([
        "VariableDeclaration",
        "VariableDeclaration",
        "ExpressionStatement",
      ]);
    });

    it("plugins に typescript を渡すと型アノテーションを受理", () => {
      const file = parse("const x: number = 1;", ["typescript"]);
      expect(file.program.body[0]?.type).toBe("VariableDeclaration");
    });
  });

  describe("generate (in-source)", () => {
    it("parse → generate で構文構造が保たれる", () => {
      const code = generate(parse("const x = arr[0];"));
      expect(code).toContain("const x");
      expect(code).toContain("arr[0]");
    });
  });

  describe("tryGenerateNode (in-source)", () => {
    it("正常な Node は generate 可能", () => {
      const file = parse("const x = 1;");
      const decl = file.program.body[0];
      if (decl === undefined) throw new Error("empty program");
      expect(tryGenerateNode(decl)).toContain("const x = 1");
    });

    it("generate 不能なケースは空文字を返す (例外を漏らさない)", () => {
      const broken = { type: "__UnknownNonStandardType__" } as unknown as Node;
      expect(tryGenerateNode(broken)).toBe("");
    });
  });
}
