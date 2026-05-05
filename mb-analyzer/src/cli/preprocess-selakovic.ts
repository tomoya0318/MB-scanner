import { readFileSync } from "fs";

import {
  EXCLUSION_REASON,
  LAYOUT_KIND,
  type PreprocessingInput,
  type PreprocessingResult,
} from "../contracts/preprocessing-contracts";
import { extract, type SelakovicExtractInput } from "../preprocessing/selakovic";
import { extractInlineScripts } from "../preprocessing/selakovic/client";
import { detectLayout } from "../preprocessing/selakovic/layout";
import { loadLibFiles } from "../preprocessing/selakovic/server";

const EXIT_OK = 0;
const EXIT_ERROR = 2;
const EXIT_BATCH_OK = 0;
const EXIT_BATCH_IO_FAILURE = 2;

/**
 * 1 入力 → N 結果モデル:
 * - extract() は `PreprocessingResult[]` を返す (1 candidate なら 1 件、N candidate なら N 件)
 * - CLI は出力を **常に JSONL** (1 結果 = 1 行) に統一する
 * - 複数結果の id は `<original_id>#<index>` を付与して識別 (1 結果なら suffix なし)
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
  if (obj.id !== undefined) {
    if (typeof obj.id !== "string") return "'id' field must be a string when present";
    input.id = obj.id;
  }
  return input;
}

/**
 * 1 issue 分の前処理を実行し、結果配列を返す。
 *
 * レイアウト判定 + ファイル I/O の前段で除外する場合は 1 件の error result を返す。
 * extract() で複数 candidate が出た場合はそのまま配列を返す。
 *
 * **fallback 戦略 (clientServer 救済)**:
 * client モードで全結果が `no-changed-nodes` (= inline script に変更なし) になった場合、
 * `<libname>_*.js` 単一ファイルが共存していれば server-single-file モードで再試行する。
 * これにより clientServerIssues カテゴリ (実際の最適化はライブラリ側) を救済できる。
 * 物理ファイル構造ベースの探索順序ルールで、Selakovic 論文 §6 / Table 4 への依存はない。
 */
function preprocess(input: PreprocessingInput): PreprocessingResult[] {
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

  // 1 次抽出
  const primaryResults = runExtraction(layout, /*useFallback*/ false);

  // client モードで extracted が 1 件も出なかった (= 全件 excluded) かつ server-single-file
  // fallback が利用可能なら、ライブラリ側の AST diff で再試行する。
  // 論文非依存の物理構造ベース探索順序ルール: v_*.html で最適化が見つからなければ
  // <libname>_*.js を見る。これにより clientServerIssues (jsperf ハーネスは jsperf 計測
  // 用で実最適化はライブラリ側) が救済される。
  if (
    layout.kind === LAYOUT_KIND.CLIENT &&
    layout.serverFiles !== undefined &&
    primaryResults.every((r) => r.excluded !== undefined)
  ) {
    const fallbackResults = runExtraction(layout, /*useFallback*/ true);
    // fallback で extracted が 1 件でも出れば採用 (= ライブラリ側に最適化があった)
    if (fallbackResults.some((r) => r.excluded === undefined)) {
      return fallbackResults;
    }
  }

  return primaryResults;
}

function runExtraction(layout: ReturnType<typeof detectLayout>, useFallback: boolean): PreprocessingResult[] {
  let extractInput: SelakovicExtractInput;
  try {
    if (useFallback && layout.serverFiles !== undefined) {
      extractInput = {
        kind: "server",
        before_files: loadLibFiles(layout.serverFiles.beforeFile),
        after_files: loadLibFiles(layout.serverFiles.afterFile),
      };
    } else if (layout.kind === LAYOUT_KIND.CLIENT) {
      if (layout.clientFiles === undefined) {
        return [
          {
            layout: LAYOUT_KIND.CLIENT,
            excluded: EXCLUSION_REASON.MISSING_FILES,
            excluded_detail: "internal: client layout but no file paths",
          },
        ];
      }
      const beforeHtml = readFileSync(layout.clientFiles.beforeHtml, "utf-8");
      const afterHtml = readFileSync(layout.clientFiles.afterHtml, "utf-8");
      extractInput = {
        kind: "client",
        before_script: extractInlineScripts(beforeHtml),
        after_script: extractInlineScripts(afterHtml),
      };
    } else if (layout.serverDirs !== undefined) {
      extractInput = {
        kind: "server",
        before_files: loadLibFiles(layout.serverDirs.beforeDir),
        after_files: loadLibFiles(layout.serverDirs.afterDir),
      };
    } else if (layout.serverFiles !== undefined) {
      extractInput = {
        kind: "server",
        before_files: loadLibFiles(layout.serverFiles.beforeFile),
        after_files: loadLibFiles(layout.serverFiles.afterFile),
      };
    } else {
      return [
        {
          layout: LAYOUT_KIND.SERVER,
          excluded: EXCLUSION_REASON.MISSING_FILES,
          excluded_detail: "internal: server layout but no dir/file paths",
        },
      ];
    }
  } catch (e) {
    return [
      {
        layout: layout.kind,
        excluded: EXCLUSION_REASON.MISSING_FILES,
        excluded_detail: `file I/O failed: ${e instanceof Error ? e.message : "unknown"}`,
      },
    ];
  }

  return extract(extractInput);
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

  const results = attachIds(preprocess(parsed), parsed.id);
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
  const id = typeof obj.id === "string" ? obj.id : undefined;
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
    const results = attachIds(preprocess(parsed), parsed.id);
    emitResults(results);
  }

  return EXIT_BATCH_OK;
}
