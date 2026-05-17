import { existsSync, readFileSync } from "fs";
import { join } from "path";

import {
  ASPECT,
  LAYOUT_KIND,
  SELAKOVIC_EXCLUSION_REASON,
  WRAPPER_KIND,
  type PreprocessingInput,
  type PreprocessingIssueResult,
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
 * 1 入力 → 1 IssueResult モデル (ADR-0024):
 * - `preprocess()` は `PreprocessingIssueResult` (内部に candidates: list) を返す
 * - CLI は出力を **常に JSONL** (1 issue = 1 行) で統一する
 * - id は input.id をそのまま設定 (旧 `<original_id>#<index>` の suffix 付与は廃止)
 *
 * ファイル I/O は CLI に閉じ込め、`preprocess()` は文字列内容のみを受け取る純関数に保つ。
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
 * 1 issue 分の前処理を実行し、`PreprocessingIssueResult` を返す。
 * レイアウト判定 + ファイル I/O の前段で除外する場合は issue_excluded を立てた IssueResult。
 */
function preprocessIssue(input: PreprocessingInput): PreprocessingIssueResult {
  const layout = detectLayout(input.issue_dir);

  if (layout.kind === LAYOUT_KIND.UNKNOWN) {
    return {
      candidates: [],
      candidate_count: 0,
      issue_excluded: SELAKOVIC_EXCLUSION_REASON.LAYOUT_UNKNOWN,
      issue_excluded_detail: `cannot determine layout for ${input.issue_dir} (no v_*.html or <lib>_* dirs/files)`,
      issue_meta: {
        adapter: "selakovic",
        layout: LAYOUT_KIND.UNKNOWN,
        aspect: ASPECT.FALLBACK,
        wrapper_kind: WRAPPER_KIND.TOP_LEVEL,
      },
    };
  }

  let preprocessInput: SelakovicPreprocessInput;
  try {
    preprocessInput = buildPreprocessInput(input.issue_dir, layout);
  } catch (e) {
    return {
      candidates: [],
      candidate_count: 0,
      issue_excluded: "missing-files",
      issue_excluded_detail: `file I/O failed: ${e instanceof Error ? e.message : "unknown"}`,
      issue_meta: {
        adapter: "selakovic",
        layout: layout.kind,
        aspect: ASPECT.FALLBACK,
        wrapper_kind: WRAPPER_KIND.TOP_LEVEL,
      },
    };
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

/** 結果に id を付与 (1 入力 1 結果なので suffix なし)。 */
function attachId(result: PreprocessingIssueResult, originalId: string | undefined): PreprocessingIssueResult {
  if (originalId === undefined) return result;
  return { ...result, id: originalId };
}

function emitResult(result: PreprocessingIssueResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export async function runPreprocessSelakovic(): Promise<number> {
  const raw = await readStdin();
  const parsed = parseInput(raw);
  if (typeof parsed === "string") {
    process.stderr.write(`${parsed}\n`);
    return EXIT_ERROR;
  }

  const result = attachId(preprocessIssue(parsed), parsed.id);
  emitResult(result);
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
      const errorResult: PreprocessingIssueResult = {
        candidates: [],
        candidate_count: 0,
        issue_excluded: SELAKOVIC_EXCLUSION_REASON.LAYOUT_UNKNOWN,
        issue_excluded_detail: parsed.error,
        issue_meta: {
          adapter: "selakovic",
          layout: LAYOUT_KIND.UNKNOWN,
          aspect: ASPECT.FALLBACK,
          wrapper_kind: WRAPPER_KIND.TOP_LEVEL,
        },
      };
      if (parsed.id !== undefined) errorResult.id = parsed.id;
      process.stdout.write(`${JSON.stringify(errorResult)}\n`);
      continue;
    }
    const result = attachId(preprocessIssue(parsed), parsed.id);
    emitResult(result);
  }

  return EXIT_BATCH_OK;
}
