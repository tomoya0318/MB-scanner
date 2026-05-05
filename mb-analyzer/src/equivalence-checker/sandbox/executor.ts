import vm from "node:vm";
import { createStabilizedContext, type ConsoleCall } from "./stabilizer";
import { SerializationError, serializeValue } from "./serializer";

/**
 * 1 スクリプト分の観測結果。oracle 層はこの型のみに依存する。
 * - `return_value` / `arg_snapshots[i].pre|post` は失敗時 `UNSERIALIZABLE_MARKER`
 * - `exception` は正常終了なら null、throw された場合は ctor + message
 * - `timed_out` は vm.runInContext の timeout による打ち切り
 */
export const UNSERIALIZABLE_MARKER = "<<unserializable>>";

export interface ExceptionCapture {
  ctor: string;
  message: string;
}

/**
 * setup で定義された object/array 1 つ分のスナップショット。
 * pre/post は body 実行前後の時間軸 (slow/fast のサイド軸とは別概念)。
 * 概念モデル: ai-guide/code-map.md「観測軸: slow/fast と pre/post」
 */
export interface ArgumentSnapshot {
  key: string;
  pre: string;
  post: string;
}

export interface ExecutionCapture {
  return_value: string;
  return_is_undefined: boolean;
  arg_snapshots: ArgumentSnapshot[];
  exception: ExceptionCapture | null;
  console_log: ConsoleCall[];
  new_globals: string[];
  timed_out: boolean;
}

export interface ExecuteOptions {
  setup: string;
  body: string;
  timeout_ms: number;
}

export async function executeSandboxed(options: ExecuteOptions): Promise<ExecutionCapture> {
  const { context, consoleCalls, baselineKeys } = createStabilizedContext();

  let exception: ExceptionCapture | null = null;
  let timedOut = false;
  let returnValue = "undefined";
  let returnIsUndefined = true;

  // setup の例外も body と同じ ExecutionCapture.exception に詰める。両 sandbox で
  // 同じ setup を流すので両側で同じ例外になり、exception oracle で equal と判定される。
  let setupThrew = false;
  if (options.setup.length > 0) {
    try {
      vm.runInContext(normalizeSetup(options.setup), context, {
        timeout: options.timeout_ms,
        displayErrors: false,
      });
    } catch (e) {
      setupThrew = true;
      if (isTimeoutError(e)) {
        timedOut = true;
      }
      exception = captureException(e);
    }
  }

  const setupKeys = Object.keys(context).filter((k) => !baselineKeys.has(k));
  const trackedKeys: string[] = [];
  const preSnapshots = new Map<string, string>();
  for (const key of setupKeys) {
    const val = (context as Record<string, unknown>)[key];
    if (val !== null && typeof val === "object") {
      trackedKeys.push(key);
      preSnapshots.set(key, snapshotValue(val));
    }
  }

  if (!setupThrew) {
    try {
      const result: unknown = vm.runInContext(options.body, context, {
        timeout: options.timeout_ms,
        displayErrors: false,
      });
      const resolved = await resolveIfPromise(result);
      if (resolved !== undefined) {
        returnIsUndefined = false;
      }
      returnValue = snapshotValue(resolved);
    } catch (e) {
      if (isTimeoutError(e)) {
        timedOut = true;
      }
      exception = captureException(e);
    }
  }

  const argSnapshots: ArgumentSnapshot[] = trackedKeys.map((key) => {
    const postVal = (context as Record<string, unknown>)[key];
    return {
      key,
      pre: preSnapshots.get(key) ?? UNSERIALIZABLE_MARKER,
      post: snapshotValue(postVal),
    };
  });

  const newGlobals: string[] = [];
  for (const key of Object.keys(context)) {
    if (baselineKeys.has(key)) continue;
    if (setupKeys.includes(key)) continue;
    newGlobals.push(key);
  }

  return {
    return_value: returnValue,
    return_is_undefined: returnIsUndefined,
    arg_snapshots: argSnapshots,
    exception,
    console_log: [...consoleCalls],
    new_globals: newGlobals,
    timed_out: timedOut,
  };
}

function snapshotValue(value: unknown): string {
  try {
    return serializeValue(value);
  } catch (e) {
    if (e instanceof SerializationError) return UNSERIALIZABLE_MARKER;
    // 想定外エラーはサイレント握りつぶしを避けてクラッシュさせる防御再スロー。
    // 現 serializer は SerializationError のみ投げる設計のため型上 unreachable。
    /* c8 ignore next 2 */
    throw e;
  }
}

async function resolveIfPromise(value: unknown): Promise<unknown> {
  if (value !== null && typeof value === "object" && "then" in value && typeof (value as { then: unknown }).then === "function") {
    return await (value as Promise<unknown>);
  }
  return value;
}

// vm realm で投げられた Error は main realm の `instanceof Error` で false になるため、
// name / message を持つ object かどうかで duck typing 判定する。
function captureException(e: unknown): ExceptionCapture {
  if (e !== null && typeof e === "object") {
    const obj = e as { name?: unknown; message?: unknown };
    const ctor = typeof obj.name === "string" && obj.name.length > 0 ? obj.name : "Error";
    const message =
      typeof obj.message === "string" ? obj.message : "<non-stringifiable thrown object>";
    return { ctor, message };
  }
  return { ctor: "Unknown", message: stringifyPrimitive(e) };
}

function stringifyPrimitive(value: unknown): string {
  if (typeof value === "symbol") return value.description ?? "symbol";
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return String(value as string | number | boolean);
}

function isTimeoutError(e: unknown): boolean {
  if (e === null || typeof e !== "object") return false;
  const obj = e as { code?: unknown; message?: unknown };
  if (obj.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return true;
  if (typeof obj.message === "string") {
    return obj.message.toLowerCase().includes("script execution timed out");
  }
  return false;
}

// setup の top-level `const`/`let` は vm context の global property にならず、
// O2 / O4 の観測対象から漏れる。識別子境界で `var` に正規化して global に露出させる。
// 完全な parser は使わず、`\b(const|let)\s+<ident>` のパターンのみ置換する。
// ブロック内の `const`/`let` も `var` 化されるが、setup は基本トップレベル宣言で使う前提。
function normalizeSetup(setup: string): string {
  return setup.replace(/(^|[\s;{(])(const|let)(\s+[A-Za-z_$])/g, "$1var$3");
}
