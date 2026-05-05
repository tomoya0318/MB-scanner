import generateModule from "@babel/generator";
import { parse as babelParse, type ParserPlugin } from "@babel/parser";
import type { File, Node } from "@babel/types";

/**
 * Babel parse / generate の汎用ラッパー。
 *
 * 機能間で重複していた AST ユーティリティをここに集約する (旧 `pruning/ast/parser.ts` /
 * `preprocessing/common/parser.ts`)。
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

export function generate(file: File): string {
  return resolveGenerator()(file).code;
}

/**
 * 任意の Node を generate する。`generate(file)` は File 専用なので、Node 単独を
 * generate したいケース (snippetOfNode の fallback 等) で使う。失敗時は空文字。
 */
export function tryGenerateNode(node: Node): string {
  try {
    return resolveGenerator()(node).code;
  } catch {
    return "";
  }
}
