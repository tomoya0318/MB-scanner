/**
 * どの実行環境でどの oracle を走らせるか + 評価順を決める (Selakovic adapter)。
 *
 * - `vm` 環境 (= pruning / 純粋計算): DOM も記録 Proxy も無いので C1/C4/C5/C3 の 4 本のみ (= Phase 2a までと同一)。
 * - `jsdom` 環境 (= Selakovic の client / server candidate): 上記 4 本 + C2 (DOM) + C6 (interaction-trace)。
 *   C2/C6 はチャネル (`capture.dom_html` / `capture.interaction_trace`) が空なら oracle 自身が `not_applicable` を返す。
 *
 * 評価順は report の読みやすさ用 (verdict 合成 = ADR-0013 は順序非依存)。jsdom は C5→C1→C6→C2→C4→C3。
 *
 * 注: 「作用点 A → C6 主軸 / B → C6 ほぼ N/A」の使い分けは *記録 Proxy で何を包むか* (`wrap-targets.ts`) の話。
 * oracle を observations に載せるか否かはここでは環境だけで決め、空チャネルは oracle 側が N/A にする
 * (verdict が変わらないので over-listing しても害がない)。
 */
import { ORACLE, type Oracle } from "../../contracts/equivalence-contracts";

const VM_ORACLES: readonly Oracle[] = [
  ORACLE.RETURN_VALUE,
  ORACLE.ARGUMENT_MUTATION,
  ORACLE.EXCEPTION,
  ORACLE.EXTERNAL_OBSERVATION,
];

const JSDOM_ORACLES: readonly Oracle[] = [
  ORACLE.EXCEPTION,
  ORACLE.RETURN_VALUE,
  ORACLE.INTERACTION_TRACE,
  ORACLE.DOM_MUTATION,
  ORACLE.ARGUMENT_MUTATION,
  ORACLE.EXTERNAL_OBSERVATION,
];

export function routeOracles(environment: "vm" | "jsdom"): readonly Oracle[] {
  return environment === "jsdom" ? JSDOM_ORACLES : VM_ORACLES;
}
