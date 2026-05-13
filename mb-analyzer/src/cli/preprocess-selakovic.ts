import { existsSync, readFileSync } from "fs";
import { join } from "path";

import {
  EXCLUSION_REASON,
  LAYOUT_KIND,
  type PreprocessingInput,
  type PreprocessingResult,
} from "../contracts/preprocessing-contracts";
import {
  detectLayout,
  extractInlineScripts,
  loadLibPair,
  preprocess,
  resolveScriptDepSources,
  type DetectedLayout,
  type SelakovicPreprocessInput,
} from "../preprocessing/selakovic";

const EXIT_OK = 0;
const EXIT_ERROR = 2;
const EXIT_BATCH_OK = 0;
const EXIT_BATCH_IO_FAILURE = 2;

/**
 * 1 入力 → N 結果モデル:
 * - `preprocess()` は `PreprocessingResult[]` を返す (1 candidate なら 1 件、N candidate なら N 件)
 * - CLI は出力を **常に JSONL** (1 結果 = 1 行) に統一する
 * - 複数結果の id は `<original_id>#<index>` を付与して識別 (1 結果なら suffix なし)
 *
 * ファイル I/O (レイアウト判定 / inline `<script>` 抽出 / `<lib>_*.js` 読み出し / test_case 読み出し)
 * は CLI に閉じ込め、`preprocess()` は文字列内容のみを受け取る純関数に保つ (ADR-0011 Tier 2 は dataset
 * 規約を使うが I/O 層は分離する)。
 */

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function parseInput(raw: string): PreprocessingInput | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return `Failed to parse stdin as JSON: ${e instanceof Error ? e.message : "unknown"}`;
  }
  if (parsed === null || typeof parsed !== "object") {
    return "Expected a JSON object on stdin";
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.issue_dir !== "string") return "'issue_dir' field must be a string";
  const input: PreprocessingInput = { issue_dir: obj.issue_dir };
  if (obj.id !== undefined && obj.id !== null) {
    if (typeof obj.id !== "string") return "'id' field must be a string when present";
    input.id = obj.id;
  }
  return input;
}

const SCRIPT_TAG_PATTERN = /<script\b([^>]*)>[\s\S]*?<\/script>/gi;
const SRC_ATTR_PATTERN = /\bsrc\s*=\s*["']([^"']+)["']/i;

/** v_before.html が `<script src="<lib>_before.js">` でローカルの lib を参照しているか。 */
function htmlReferencesLib(html: string): boolean {
  let match: RegExpExecArray | null;
  SCRIPT_TAG_PATTERN.lastIndex = 0;
  while ((match = SCRIPT_TAG_PATTERN.exec(html)) !== null) {
    const attrs = match[1] ?? "";
    const srcMatch = SRC_ATTR_PATTERN.exec(attrs);
    const src = srcMatch?.[1];
    if (src === undefined) continue;
    if (/^https?:/i.test(src)) continue;
    if (/_before\.js$/i.test(src)) return true;
  }
  return false;
}

/**
 * 1 issue (ディレクトリ) 分の前処理を実行し、結果配列を返す — レイアウト判定 + ファイル I/O を
 * 担い、読んだ内容を純関数 `preprocess()` に渡す CLI 層のラッパ。
 *
 * レイアウト判定 + ファイル I/O の前段で除外する場合は 1 件の error result を返す。
 * `preprocess()` で複数 candidate が出た場合はそのまま配列を返す。
 *
 * ADR-0011 改修により、client 経路でも `<lib>_*.js` を dir scan で読み込んで diff 対象に
 * 含めるため、旧来の「client → server-single-file fallback」(clientServer 救済) は不要になった
 * (作用点 A の clientIssues は段2 ルーティングで自然に処理される)。
 */
function preprocessIssue(input: PreprocessingInput): PreprocessingResult[] {
  const layout = detectLayout(input.issue_dir);

  if (layout.kind === LAYOUT_KIND.UNKNOWN) {
    return [
      {
        layout: LAYOUT_KIND.UNKNOWN,
        excluded: EXCLUSION_REASON.LAYOUT_UNKNOWN,
        excluded_detail: `cannot determine layout for ${input.issue_dir} (no v_*.html or <lib>_* dirs/files)`,
      },
    ];
  }

  let preprocessInput: SelakovicPreprocessInput;
  try {
    preprocessInput = buildPreprocessInput(input.issue_dir, layout);
  } catch (e) {
    return [
      {
        layout: layout.kind,
        excluded: EXCLUSION_REASON.MISSING_FILES,
        excluded_detail: `file I/O failed: ${e instanceof Error ? e.message : "unknown"}`,
      },
    ];
  }

  return preprocess(preprocessInput);
}

function buildPreprocessInput(issueDir: string, layout: DetectedLayout): SelakovicPreprocessInput {
  const libPair = loadLibPair(layout);
  const libBeforeFiles = libPair?.beforeFiles ?? {};
  const libAfterFiles = libPair?.afterFiles ?? {};
  const libKind = libPair?.kind ?? null;

  if (layout.kind === LAYOUT_KIND.CLIENT) {
    if (layout.clientFiles === undefined) {
      throw new Error("internal: client layout but no html file paths");
    }
    const beforeHtml = readFileSync(layout.clientFiles.beforeHtml, "utf-8");
    const afterHtml = readFileSync(layout.clientFiles.afterHtml, "utf-8");
    // `<script src>` の CDN 依存 lib (jquery/handlebars/underscore) を dataset fork の node_modules/ から解決。
    // 解決できなかったものは stderr に出す (= install-vendor-deps.sh 未実行 or 宣言漏れ — 集計の手がかり)。
    const patchedLibFilenames = [...Object.keys(libBeforeFiles), ...Object.keys(libAfterFiles)];
    const deps = resolveScriptDepSources(issueDir, beforeHtml, patchedLibFilenames);
    if (deps.missing.length > 0) {
      process.stderr.write(`[preprocess-selakovic] ${issueDir}: unresolved <script src> deps: ${deps.missing.join(", ")}\n`);
    }
    return {
      kind: "client",
      before_inline: extractInlineScripts(beforeHtml),
      after_inline: extractInlineScripts(afterHtml),
      lib_before_files: libBeforeFiles,
      lib_after_files: libAfterFiles,
      lib_kind: libKind,
      lib_referenced_by_workload: htmlReferencesLib(beforeHtml),
      dep_lib_sources: deps.sources,
    };
  }

  // server: test_case_*.js (なければ null → preprocess() 側で fallback)
  const beforeTestCasePath = join(issueDir, "test_case_before.js");
  const afterTestCasePath = join(issueDir, "test_case_after.js");
  return {
    kind: "server",
    before_test_case: existsSync(beforeTestCasePath) ? readFileSync(beforeTestCasePath, "utf-8") : null,
    after_test_case: existsSync(afterTestCasePath) ? readFileSync(afterTestCasePath, "utf-8") : null,
    lib_before_files: libBeforeFiles,
    lib_after_files: libAfterFiles,
    lib_kind: libKind,
  };
}

/**
 * 結果配列に id を付与する。
 *
 * - 1 件のみ: original_id をそのまま設定 (suffix なし)
 * - 2 件以上: `<original_id>#<index>` 形式で識別
 *
 * original_id が undefined の場合は id 設定をスキップ。
 */
function attachIds(results: PreprocessingResult[], originalId: string | undefined): PreprocessingResult[] {
  if (originalId === undefined) return results;
  if (results.length <= 1) {
    return results.map((r) => ({ ...r, id: originalId }));
  }
  return results.map((r, idx) => ({ ...r, id: `${originalId}#${idx}` }));
}

function emitResults(results: PreprocessingResult[]): void {
  for (const result of results) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

export async function runPreprocessSelakovic(): Promise<number> {
  const raw = await readStdin();
  const parsed = parseInput(raw);
  if (typeof parsed === "string") {
    process.stderr.write(`${parsed}\n`);
    return EXIT_ERROR;
  }

  const results = attachIds(preprocessIssue(parsed), parsed.id);
  emitResults(results);
  return EXIT_OK;
}

interface BatchLineParseError {
  readonly id: string | undefined;
  readonly error: string;
}

function parseBatchLine(raw: string): PreprocessingInput | BatchLineParseError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      id: undefined,
      error: `Failed to parse line as JSON: ${e instanceof Error ? e.message : "unknown"}`,
    };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { id: undefined, error: "Expected a JSON object per line" };
  }
  const obj = parsed as Record<string, unknown>;
  let id: string | undefined;
  if (obj.id === undefined || obj.id === null) {
    id = undefined;
  } else if (typeof obj.id === "string") {
    id = obj.id;
  } else {
    return { id: undefined, error: "'id' field must be a string when present" };
  }
  if (typeof obj.issue_dir !== "string") return { id, error: "'issue_dir' field must be a string" };
  const input: PreprocessingInput = { issue_dir: obj.issue_dir };
  if (id !== undefined) input.id = id;
  return input;
}

export async function runPreprocessSelakovicBatch(): Promise<number> {
  let raw: string;
  try {
    raw = await readStdin();
  } catch (e) {
    process.stderr.write(`Failed to read stdin: ${e instanceof Error ? e.message : "unknown"}\n`);
    return EXIT_BATCH_IO_FAILURE;
  }

  const lines = raw.split("\n").filter((line) => line.length > 0);
  for (const line of lines) {
    const parsed = parseBatchLine(line);
    if ("error" in parsed) {
      const errorResult: PreprocessingResult = {
        layout: LAYOUT_KIND.UNKNOWN,
        excluded: EXCLUSION_REASON.LAYOUT_UNKNOWN,
        excluded_detail: parsed.error,
      };
      if (parsed.id !== undefined) errorResult.id = parsed.id;
      process.stdout.write(`${JSON.stringify(errorResult)}\n`);
      continue;
    }
    const results = attachIds(preprocessIssue(parsed), parsed.id);
    emitResults(results);
  }

  return EXIT_BATCH_OK;
}
