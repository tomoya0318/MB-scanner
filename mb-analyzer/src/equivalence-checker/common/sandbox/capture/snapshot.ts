/**
 * 両 executor (vm / jsdom) が共有する観測ヘルパ。
 * - 値 → 正規化文字列 (`snapshotValue`)
 * - 投げられた値 → `ExceptionCapture` (cross-realm Error の duck typing 込み)
 * - timeout 例外の判定
 * - setup の top-level `const`/`let` の `var` 正規化
 * - context の setup 由来 key / new-global の検出と pre/post snapshot
 */
import type { ArgumentSnapshot, ExceptionCapture } from "./types";
import { SerializationError, serializeValue } from "../../serializer";

export const UNSERIALIZABLE_MARKER = "<<unserializable>>";

export function snapshotValue(value: unknown): string {
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

export async function resolveIfPromise(value: unknown): Promise<unknown> {
  if (
    value !== null &&
    typeof value === "object" &&
    "then" in value &&
    typeof (value as { then: unknown }).then === "function"
  ) {
    return await (value as Promise<unknown>);
  }
  return value;
}

// vm realm で投げられた Error は main realm の `instanceof Error` で false になるため、
// name / message を持つ object かどうかで duck typing 判定する。
export function captureException(e: unknown): ExceptionCapture {
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

export function isTimeoutError(e: unknown): boolean {
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
export function normalizeSetup(setup: string): string {
  return setup.replace(/(^|[\s;{(])(const|let)(\s+[A-Za-z_$])/g, "$1var$3");
}

/**
 * setup 実行後の context から「setup が新規に定義した key」を拾い、object/array のものを
 * pre-snapshot する。`baselineKeys` は setup 実行前に存在した key の集合。
 */
export function snapshotSetupState(
  ctxRecord: Record<string, unknown>,
  baselineKeys: ReadonlySet<string>,
): { setupKeys: string[]; trackedKeys: string[]; preSnapshots: Map<string, string> } {
  const setupKeys = Object.keys(ctxRecord).filter((k) => !baselineKeys.has(k));
  const trackedKeys: string[] = [];
  const preSnapshots = new Map<string, string>();
  for (const key of setupKeys) {
    const val = ctxRecord[key];
    if (val !== null && typeof val === "object") {
      trackedKeys.push(key);
      preSnapshots.set(key, snapshotValue(val));
    }
  }
  return { setupKeys, trackedKeys, preSnapshots };
}

export function collectArgSnapshots(
  ctxRecord: Record<string, unknown>,
  trackedKeys: string[],
  preSnapshots: Map<string, string>,
): ArgumentSnapshot[] {
  return trackedKeys.map((key) => ({
    key,
    pre: preSnapshots.get(key) ?? UNSERIALIZABLE_MARKER,
    post: snapshotValue(ctxRecord[key]),
  }));
}

/** body 実行後に新規出現した global key (baseline でも setup 由来でもないもの)。 */
export function collectNewGlobals(
  ctxRecord: Record<string, unknown>,
  baselineKeys: ReadonlySet<string>,
  setupKeys: string[],
): string[] {
  const setupKeySet = new Set(setupKeys);
  const newGlobals: string[] = [];
  for (const key of Object.keys(ctxRecord)) {
    if (baselineKeys.has(key)) continue;
    if (setupKeySet.has(key)) continue;
    newGlobals.push(key);
  }
  return newGlobals;
}
