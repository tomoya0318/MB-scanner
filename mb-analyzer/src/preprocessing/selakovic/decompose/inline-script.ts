/**
 * Selakovic clientIssues の `v_*.html` から **inline `<script>`** の内容を抜き出す。
 *
 * 想定する HTML:
 * ```html
 * <script src="..."></script>      ← external (無視)
 * <script>
 *     ...inline JS...              ← これを抽出
 * </script>
 * ```
 *
 * Selakovic データセットの全 client issue で `v_*.html` には external script の後ろに
 * 1 つだけ inline script があり、テスト対象の JS が記述されている。複数 inline script
 * があれば全部結合する (将来の安全策、現状の dataset では不要)。
 *
 * 正規表現で実装。Selakovic の HTML は単純で、CDATA / HTML エスケープ / 入れ子は登場
 * しない。本格 HTML パーサ (cheerio など) を引き込むコストを避ける。
 */

const SCRIPT_TAG_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

export function extractInlineScripts(html: string): string {
  const inlineParts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = SCRIPT_TAG_PATTERN.exec(html)) !== null) {
    const attrs = match[1] ?? "";
    const content = match[2] ?? "";
    if (/\bsrc\s*=/i.test(attrs)) continue; // external script
    inlineParts.push(content);
  }
  return inlineParts.join("\n");
}
