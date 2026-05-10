import { checkEquivalence } from "../equivalence-checker";
import {
  EXECUTION_ENVIRONMENT,
  type EquivalenceCheckResult,
  type EquivalenceInput,
  type ExecutionEnvironment,
} from "../contracts/equivalence-contracts";

function parseEnvironment(value: unknown): ExecutionEnvironment | null {
  return value === EXECUTION_ENVIRONMENT.VM || value === EXECUTION_ENVIRONMENT.JSDOM ? value : null;
}

const EXIT_EQUAL = 0;
const EXIT_NOT_EQUAL = 1;
const EXIT_ERROR = 2;
const EXIT_BATCH_OK = 0;
const EXIT_BATCH_IO_FAILURE = 2;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function parseInput(raw: string): EquivalenceInput | string {
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

  const input: EquivalenceInput = { slow: obj.slow, fast: obj.fast };
  if (obj.setup !== undefined) {
    if (typeof obj.setup !== "string") return "'setup' field must be a string when present";
    input.setup = obj.setup;
  }
  if (obj.timeout_ms !== undefined) {
    if (typeof obj.timeout_ms !== "number" || !Number.isFinite(obj.timeout_ms)) {
      return "'timeout_ms' field must be a finite number when present";
    }
    input.timeout_ms = obj.timeout_ms;
  }
  if (obj.environment !== undefined && obj.environment !== null) {
    const env = parseEnvironment(obj.environment);
    if (env === null) return "'environment' field must be 'vm' or 'jsdom' when present";
    input.environment = env;
  }
  if (obj.module_base_dir !== undefined && obj.module_base_dir !== null) {
    if (typeof obj.module_base_dir !== "string") return "'module_base_dir' field must be a string when present";
    input.module_base_dir = obj.module_base_dir;
  }
  return input;
}

export async function runCheckEquivalence(): Promise<number> {
  const raw = await readStdin();
  const parsed = parseInput(raw);
  if (typeof parsed === "string") {
    process.stderr.write(`${parsed}\n`);
    return EXIT_ERROR;
  }

  const result = await checkEquivalence(parsed);
  process.stdout.write(`${JSON.stringify(result)}\n`);

  if (result.verdict === "equal") return EXIT_EQUAL;
  if (result.verdict === "not_equal") return EXIT_NOT_EQUAL;
  return EXIT_ERROR;
}

// バッチ API は単発と異なり `timeout_ms` を **必須** とする。
// Python→Node への受け渡しで過去に timeout_ms が落ちて DEFAULT=5000 に
// サイレントフォールバックした事例があったため、バッチ側では未指定を error 行化して
// 呼び出し側に気付かせる。単発 API (parseInput) は後方互換のため従来どおり。
function parseBatchLine(raw: string): EquivalenceInput | { id: string | undefined; error: string } {
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
  if (typeof obj.timeout_ms !== "number" || !Number.isFinite(obj.timeout_ms)) {
    return { id, error: "'timeout_ms' field must be a finite number" };
  }

  const input: EquivalenceInput = {
    slow: obj.slow,
    fast: obj.fast,
    timeout_ms: obj.timeout_ms,
  };
  if (id !== undefined) input.id = id;
  if (obj.setup !== undefined) {
    if (typeof obj.setup !== "string") return { id, error: "'setup' field must be a string when present" };
    input.setup = obj.setup;
  }
  if (obj.environment !== undefined && obj.environment !== null) {
    const env = parseEnvironment(obj.environment);
    if (env === null) return { id, error: "'environment' field must be 'vm' or 'jsdom' when present" };
    input.environment = env;
  }
  if (obj.module_base_dir !== undefined && obj.module_base_dir !== null) {
    if (typeof obj.module_base_dir !== "string") return { id, error: "'module_base_dir' field must be a string when present" };
    input.module_base_dir = obj.module_base_dir;
  }
  return input;
}

function errorResult(id: string | undefined, message: string): EquivalenceCheckResult {
  const result: EquivalenceCheckResult = {
    verdict: "error",
    observations: [],
    error_message: message,
  };
  if (id !== undefined) result.id = id;
  return result;
}

export async function runCheckEquivalenceBatch(): Promise<number> {
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
    let result: EquivalenceCheckResult;
    if ("error" in parsed) {
      result = errorResult(parsed.id, parsed.error);
    } else {
      const input = parsed;
      const checkResult = await checkEquivalence(input);
      result = { ...checkResult };
      if (input.id !== undefined) result.id = input.id;
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }

  return EXIT_BATCH_OK;
}
