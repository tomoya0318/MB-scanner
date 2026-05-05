import type { File } from "@babel/types";

import { parse as basicParse, generate, tryGenerateNode } from "../../ast/parser";
import { PARSER_PLUGINS } from "../rules/whitelist";

/**
 * pruning モジュール用 parse: `src/ast/parser` の汎用 parse に
 * `pruning/rules/whitelist.ts` で一元管理されている `PARSER_PLUGINS` を渡す薄ラッパー。
 *
 * ADR-0006 (whitelist の plugin 一元管理) を維持しつつ、parse 実装は `src/ast/` に集約。
 * `pruning/ast/` 配下は pruning 固有のラッパーのみ置く方針。
 */
export function parse(code: string): File {
  return basicParse(code, PARSER_PLUGINS);
}

export { generate, tryGenerateNode };
