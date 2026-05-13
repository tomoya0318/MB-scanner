import { prune } from "../pruning";
import type {
  ExecutionEnvironmentHint,
  PruningInput,
  PruningResult,
} from "../contracts/pruning-contracts";

const EXIT_PRUNED = 0;
const EXIT_INITIAL_MISMATCH = 1;
const EXIT_ERROR = 2;
const EXIT_BATCH_OK = 0;
const EXIT_BATCH_IO_FAILURE = 2;

// Python 側 contract (`mb_scanner.domain.entities.pruning`) と整合させる値域。
// ここで弾かないと engine は 0/負/小数の max_iterations でループをスキップして
// silently `verdict="pruned"` を返してしまう。
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 60_000;
const MIN_MAX_ITERATIONS = 1;
const MAX_MAX_ITERATIONS = 100_000;

function validateTimeoutMs(value: unknown): number | string {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return "'timeout_ms' field must be an integer";
  }
  if (value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    return `'timeout_ms' field must be in [${MIN_TIMEOUT_MS}, ${MAX_TIMEOUT_MS}]`;
  }
  return value;
}

function validateMaxIterations(value: unknown): number | string {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return "'max_iterations' field must be an integer";
  }
  if (value < MIN_MAX_ITERATIONS || value > MAX_MAX_ITERATIONS) {
    return `'max_iterations' field must be in [${MIN_MAX_ITERATIONS}, ${MAX_MAX_ITERATIONS}]`;
  }
  return value;
}

const ENVIRONMENT_VALUES = ["vm", "jsdom"] as const;
const EQUIV_CONTEXT_STRING_KEYS = [
  "module_base_dir",
  "mount_html",
  "aspect",
  "candidate_kind",
  "enclosure_type",
] as const;

/**
 * `PruningInput` 由来の等価検証コンテキスト (`environment` / `module_base_dir` / `mount_html` /
 * `aspect` / `candidate_kind` / `enclosure_type`) を `obj` から `input` へ転記する。
 * pruning 本体は解釈しない pass-through (selakovic/pruner が checkEquivalence にそのまま渡す) なので
 * 最小限の型チェックのみ — `environment` は `"vm" | "jsdom"`、残りは string。
 * 問題があればエラーメッセージ文字列を返す (`null` なら OK)。
 *
 * `null` は「未指定」として扱う (= 無視): Python 側 Gateway は `model_dump_json(exclude_none=False)` で
 * 送るため、未設定の optional フィールドが `"mount_html": null` のように届く。これを「present だが不正」と
 * 誤判定しないようにする。
 */
function applyEquivalenceContext(obj: Record<string, unknown>, input: PruningInput): string | null {
  if (obj.environment !== undefined && obj.environment !== null) {
    if (
      typeof obj.environment !== "string" ||
      !(ENVIRONMENT_VALUES as readonly string[]).includes(obj.environment)
    ) {
      return `'environment' field must be one of ${ENVIRONMENT_VALUES.join(" | ")} when present`;
    }
    input.environment = obj.environment as ExecutionEnvironmentHint;
  }
  for (const key of EQUIV_CONTEXT_STRING_KEYS) {
    const value = obj[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") return `'${key}' field must be a string when present`;
    input[key] = value;
  }
  return null;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function parseInput(raw: string): PruningInput | string {
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
  if (typeof obj.slow !== "string") return "'slow' field must be a string";
  if (typeof obj.fast !== "string") return "'fast' field must be a string";

  const input: PruningInput = { slow: obj.slow, fast: obj.fast };
  if (obj.setup !== undefined) {
    if (typeof obj.setup !== "string") return "'setup' field must be a string when present";
    input.setup = obj.setup;
  }
  if (obj.timeout_ms !== undefined) {
    const validated = validateTimeoutMs(obj.timeout_ms);
    if (typeof validated === "string") return validated;
    input.timeout_ms = validated;
  }
  if (obj.max_iterations !== undefined) {
    const validated = validateMaxIterations(obj.max_iterations);
    if (typeof validated === "string") return validated;
    input.max_iterations = validated;
  }
  const ctxError = applyEquivalenceContext(obj, input);
  if (ctxError !== null) return ctxError;
  return input;
}

export async function runPrune(): Promise<number> {
  const raw = await readStdin();
  const parsed = parseInput(raw);
  if (typeof parsed === "string") {
    process.stderr.write(`${parsed}\n`);
    return EXIT_ERROR;
  }

  const result = await prune(parsed);
  process.stdout.write(`${JSON.stringify(result)}\n`);

  if (result.verdict === "pruned") return EXIT_PRUNED;
  if (result.verdict === "initial_mismatch") return EXIT_INITIAL_MISMATCH;
  return EXIT_ERROR;
}

// バッチ API は単発と異なり `timeout_ms` を **必須** とする。
// Python→Node への受け渡しで timeout_ms が落ちて DEFAULT にサイレントフォールバック
// する事故を防ぐため (equivalence 側と同じ判断、本 PR でも踏襲)。
// `max_iterations` は optional のまま (engine が default を解決)。
function parseBatchLine(raw: string): PruningInput | { id: string | undefined; error: string } {
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

  if (typeof obj.slow !== "string") return { id, error: "'slow' field must be a string" };
  if (typeof obj.fast !== "string") return { id, error: "'fast' field must be a string" };
  if (obj.timeout_ms === undefined) {
    return { id, error: "'timeout_ms' field is required in batch mode" };
  }
  const validatedTimeout = validateTimeoutMs(obj.timeout_ms);
  if (typeof validatedTimeout === "string") return { id, error: validatedTimeout };

  const input: PruningInput = {
    slow: obj.slow,
    fast: obj.fast,
    timeout_ms: validatedTimeout,
  };
  if (id !== undefined) input.id = id;
  if (obj.setup !== undefined) {
    if (typeof obj.setup !== "string") return { id, error: "'setup' field must be a string when present" };
    input.setup = obj.setup;
  }
  if (obj.max_iterations !== undefined) {
    const validated = validateMaxIterations(obj.max_iterations);
    if (typeof validated === "string") return { id, error: validated };
    input.max_iterations = validated;
  }
  const ctxError = applyEquivalenceContext(obj, input);
  if (ctxError !== null) return { id, error: ctxError };
  return input;
}

function errorResult(id: string | undefined, message: string): PruningResult {
  const result: PruningResult = {
    verdict: "error",
    error_message: message,
  };
  if (id !== undefined) result.id = id;
  return result;
}

export async function runPruneBatch(): Promise<number> {
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
    let result: PruningResult;
    if ("error" in parsed) {
      result = errorResult(parsed.id, parsed.error);
    } else {
      const input = parsed;
      const pruneResult = await prune(input);
      result = { ...pruneResult };
      if (input.id !== undefined) result.id = input.id;
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }

  return EXIT_BATCH_OK;
}
