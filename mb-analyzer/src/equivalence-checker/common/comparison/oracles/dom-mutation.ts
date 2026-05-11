import { JSDOM } from "jsdom";

import { ORACLE, ORACLE_VERDICT, type OracleObservation } from "../../../../contracts/equivalence-contracts";
import type { ExecutionCapture } from "../../sandbox/capture/types";

/**
 * C2 (DOM-mutation): jsdom 実行後の DOM-HTML (`capture.dom_html` = 正規化前) を `profile` で正規化して
 * slow/fast を文字列比較する。正規化規則 (どの属性/class/コメントが framework ノイズか) は dataset 知識
 * なので `profile` として selakovic adapter から渡す。DOM ノード判定・空白 collapse・属性 sort 自体は汎用。
 *
 * - 両側とも `dom_html` 無し (= vm 環境 or DOM 操作なし) → `not_applicable`
 * - 片方だけ DOM 取得 → `not_equal`
 * - 正規化後の HTML が一致 → `equal` / 不一致 → `not_equal` (detail に最初の差分位置)
 * - 正規化中に parse 例外 → `error`
 */
export interface DomNormalizeProfile {
  /** 比較対象の subtree の root セレクタ。省略時は `<body>`。 */
  rootSelector?: string;
  /** 全要素から除去する属性名 (framework が動的に付与する `ng-*` / `data-reactid` 等)。 */
  ignoreAttributes?: readonly string[];
  /** class 属性から除去するトークン (`ng-scope` / `ng-binding` 等)。残り 0 個になったら class 属性ごと削除。 */
  ignoreClassTokens?: readonly string[];
  /** コメントノードを除去するか (`<!-- ngRepeat: ... -->` / `<!-- react-text: N -->` 等)。 */
  ignoreCommentNodes?: boolean;
  /** テキストノードの連続空白を 1 個に潰して trim するか (空になったら削除)。 */
  collapseWhitespace?: boolean;
  /** 各要素の属性を名前順にソートするか。 */
  sortAttributes?: boolean;
}

const EMPTY_PROFILE: DomNormalizeProfile = {};

const NODE_TYPE_ELEMENT = 1;
const NODE_TYPE_TEXT = 3;
const NODE_TYPE_COMMENT = 8;

export function checkDomMutation(
  slow: ExecutionCapture,
  fast: ExecutionCapture,
  profile: DomNormalizeProfile = EMPTY_PROFILE,
): OracleObservation {
  const oracle = ORACLE.DOM_MUTATION;
  const slowHtml = slow.dom_html ?? null;
  const fastHtml = fast.dom_html ?? null;

  if (slowHtml === null && fastHtml === null) {
    return { oracle, verdict: ORACLE_VERDICT.NOT_APPLICABLE };
  }
  if (slowHtml === null || fastHtml === null) {
    return {
      oracle,
      verdict: ORACLE_VERDICT.NOT_EQUAL,
      slow_value: slowHtml,
      fast_value: fastHtml,
      detail: "DOM was captured on one side only",
    };
  }
  // 両側とも DOM を変更しなかった (= 初期 mount HTML のまま) → 「DOM 観測としては何も起きていない」
  // ので N/A を返す (両側に同じ初期 HTML を流しているので比較は常に equal になるが、それは
  // positive な等価エビデンスにならない。ADR-0018 + verdict.ts の positive-evidence ルールが
  // dom_mutation を信頼するためには「何か触ったかを判定済」が前提)。
  if (slow.dom_changed === false && fast.dom_changed === false) {
    return { oracle, verdict: ORACLE_VERDICT.NOT_APPLICABLE };
  }

  let slowNorm: string;
  let fastNorm: string;
  try {
    slowNorm = normalizeDom(slowHtml, profile);
    fastNorm = normalizeDom(fastHtml, profile);
  } catch (e) {
    return {
      oracle,
      verdict: ORACLE_VERDICT.ERROR,
      detail: `DOM normalization failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (slowNorm === fastNorm) {
    return { oracle, verdict: ORACLE_VERDICT.EQUAL, slow_value: slowNorm, fast_value: fastNorm };
  }
  return {
    oracle,
    verdict: ORACLE_VERDICT.NOT_EQUAL,
    slow_value: slowNorm,
    fast_value: fastNorm,
    detail: `normalized DOM differs (first diff at char offset ${firstDiffOffset(slowNorm, fastNorm)})`,
  };
}

function firstDiffOffset(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

function normalizeDom(html: string, profile: DomNormalizeProfile): string {
  const doc = new JSDOM(html).window.document;
  const root = profile.rootSelector !== undefined ? doc.querySelector(profile.rootSelector) : doc.body;
  if (root === null) return "";
  normalizeElement(root, profile);
  return root.outerHTML;
}

function normalizeElement(el: Element, profile: DomNormalizeProfile): void {
  if (profile.ignoreAttributes !== undefined) {
    for (const name of profile.ignoreAttributes) el.removeAttribute(name);
  }
  if (profile.ignoreClassTokens !== undefined && el.hasAttribute("class")) {
    for (const token of profile.ignoreClassTokens) el.classList.remove(token);
    if (el.classList.length === 0) el.removeAttribute("class");
  }
  if (profile.sortAttributes === true) {
    const attrs = Array.from(el.attributes).map((a) => [a.name, a.value] as const);
    attrs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [name] of attrs) el.removeAttribute(name);
    for (const [name, value] of attrs) el.setAttribute(name, value);
  }
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === NODE_TYPE_COMMENT && profile.ignoreCommentNodes === true) {
      el.removeChild(node);
    } else if (node.nodeType === NODE_TYPE_TEXT && profile.collapseWhitespace === true) {
      const collapsed = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (collapsed.length === 0) el.removeChild(node);
      else node.textContent = collapsed;
    } else if (node.nodeType === NODE_TYPE_ELEMENT) {
      normalizeElement(node as Element, profile);
    }
  }
}
