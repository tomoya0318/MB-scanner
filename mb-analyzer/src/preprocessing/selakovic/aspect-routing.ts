import type { File, Statement } from "@babel/types";

import { ASPECT, type Aspect } from "../../contracts/preprocessing-contracts";
import { findChangedNodes } from "../common/ast-diff";

/**
 * ADR-0011 §段2: ① `<lib>_*.js` に実コード変化があるか × ② ベンチマーク関数 body に
 * 実コード変化があるか で作用点を A / B / A+B / fallback に振り分ける。
 *
 * - **A** (lib のみ変化): `harness_only` / `no-html` 系 — 真 patch は lib の中。
 * - **B** (body のみ変化): `f1_body_only` 系 — 真 patch は `f1`/`test()` body の中。
 * - **A+B** (両方変化): `both_changed` / ケース IV-B — ADR-0014 の identifier 交差判定で分割。
 * - **fallback** (どちらも変化なし): artefact 除去後に何も残らない安全弁。実物では起きない見込み。
 */
export function routeAspect(libHasRealChange: boolean, bodyHasRealChange: boolean): Aspect {
  if (libHasRealChange && bodyHasRealChange) return ASPECT.BOTH;
  if (libHasRealChange) return ASPECT.LIB;
  if (bodyHasRealChange) return ASPECT.BODY;
  return ASPECT.FALLBACK;
}

/**
 * statement 列 (before / after) の AST 差分が空でなければ「実コード変化あり」。
 * `canonicalHash` ベースなので整形差・コメント差は無視される。
 */
export function statementsChanged(before: readonly Statement[], after: readonly Statement[]): boolean {
  const changed = findChangedNodes(asFile(before), asFile(after));
  return changed.size > 0;
}

function asFile(statements: readonly Statement[]): File {
  return {
    type: "File",
    program: {
      type: "Program",
      body: [...statements],
      directives: [],
      sourceType: "script",
    },
    comments: [],
    errors: [],
  } as unknown as File;
}
