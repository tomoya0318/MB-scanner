import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import vm from "node:vm";

import { JSDOM } from "jsdom";

import type { ConsoleCall, ConsoleMethod } from "./stabilizer";
import { SerializationError, serializeValue } from "./serializer";
import type { ArgumentSnapshot, ExceptionCapture, ExecutionCapture } from "./executor";

/**
 * `jsdom` の window/document を持つ VM context で 1 スクリプトを実行し `ExecutionCapture` を返す
 * (ADR-0012 の「jsdom 環境」の **最小版** — Playwright fallback も観測 channel ルーティングも無し、
 * Phase 2b で `common/`+`selakovic/` に再配置 + DOM oracle 追加)。
 *
 * - `runScripts: "outside-only"` で素の jsdom + `getInternalVMContext()` を使う (= `<script>` は実行しないが
 *   外から `vm.runInContext` で同じ realm に注入できる)。AngularJS / jQuery 等の browser ライブラリが
 *   `window` / `document` を参照しても動く (Phase 1.0 スパイクで AngularJS 950KB の load+bootstrap を実証)。
 * - server `test_case_*.js` の `require('./<lib>_*.js')` 解決のため、グローバル `require` を注入する:
 *   相対パスは `moduleBaseDir` 起点で resolve して同 context で eval、bare npm dep は dataset の
 *   `node_modules` から host `createRequire` で解決を試みる (見つからなければ throw → `error` verdict)。
 * - `executor.ts` (素 vm 版) と同じ `ExecutionCapture` 形を返す (= oracle 層はこの型のみに依存)。
 *
 * 非決定 API の stabilize (Math.random / Date / timers) は Phase 2b。本最小版は jsdom の挙動そのまま。
 */

export interface JsdomExecuteOptions {
  setup: string;
  body: string;
  timeout_ms: number;
  /** 相対 `require('./x')` を解決する基準ディレクトリ (絶対パス)。省略時は relative require が throw。 */
  module_base_dir?: string;
}

const UNSERIALIZABLE_MARKER = "<<unserializable>>";

export async function executeInJsdom(options: JsdomExecuteOptions): Promise<ExecutionCapture> {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    runScripts: "outside-only",
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const context = dom.getInternalVMContext();
  const consoleCalls: ConsoleCall[] = [];
  hookConsole(dom, consoleCalls);
  stabilizeNonDeterminism(context);
  installRequire(context, options.module_base_dir, options.timeout_ms);

  const ctxRecord = context as unknown as Record<string, unknown>;
  const baselineKeys = new Set(Object.keys(ctxRecord));

  if (options.setup.length > 0) {
    vm.runInContext(normalizeSetup(options.setup), context, { timeout: options.timeout_ms, displayErrors: false });
  }

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

  let exception: ExceptionCapture | null = null;
  let timedOut = false;
  let returnValue = "undefined";
  let returnIsUndefined = true;
  try {
    const result: unknown = vm.runInContext(options.body, context, { timeout: options.timeout_ms, displayErrors: false });
    const resolved = await resolveIfPromise(result);
    if (resolved !== undefined) returnIsUndefined = false;
    returnValue = snapshotValue(resolved);
  } catch (e) {
    if (isTimeoutError(e)) timedOut = true;
    exception = captureException(e);
  }

  const argSnapshots: ArgumentSnapshot[] = trackedKeys.map((key) => ({
    key,
    pre: preSnapshots.get(key) ?? UNSERIALIZABLE_MARKER,
    post: snapshotValue(ctxRecord[key]),
  }));

  const newGlobals: string[] = [];
  for (const key of Object.keys(ctxRecord)) {
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

const FROZEN_EPOCH_MS = 0;
const PRNG_SEED = 0x42424242;

/**
 * jsdom context の `Date.now` / `Math.random` を凍結する (= AngularJS の `ng-<Date.now()>` キャッシュキー
 * 等の非決定 global が slow/fast で食い違って偽 not_equal にならないように)。timer 系は同期実行では
 * fire しないので触らない。`stabilizer.ts` (vm 版) の最小相当。完全な stabilize は Phase 2b。
 */
function stabilizeNonDeterminism(context: vm.Context): void {
  const rec = context as unknown as Record<string, unknown>;
  const RealDate = rec.Date as DateConstructor;
  const RealMath = rec.Math as typeof Math;
  let seed = PRNG_SEED >>> 0;
  const rng = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rec.Date = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      const normalized = args.length === 0 ? [FROZEN_EPOCH_MS] : args;
      return Reflect.construct(target, normalized, newTarget) as Date;
    },
    get(target, prop, receiver) {
      if (prop === "now") return () => FROZEN_EPOCH_MS;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  rec.Math = new Proxy(RealMath, {
    get(target, prop, receiver) {
      if (prop === "random") return rng;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

function hookConsole(dom: JSDOM, sink: ConsoleCall[]): void {
  const methods: ConsoleMethod[] = ["log", "error", "warn", "info", "debug"];
  const console = dom.window.console as unknown as Record<string, (...args: unknown[]) => void>;
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      sink.push({ method, args });
    };
  }
}

interface ModuleRecord {
  exports: unknown;
}

/** グローバル `require` を context に注入する (server `test_case` の相対/bare require 解決用)。 */
function installRequire(context: vm.Context, moduleBaseDir: string | undefined, timeoutMs: number): void {
  const cache = new Map<string, ModuleRecord>();
  const baseRequire = moduleBaseDir !== undefined ? createRequire(join(moduleBaseDir, "package.json")) : null;

  const makeRequire = (fromDir: string) => {
    const requireFn = (spec: string): unknown => {
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const resolved = resolveRelative(fromDir, spec);
        const cached = cache.get(resolved);
        if (cached !== undefined) return cached.exports;
        const src = readFileSync(resolved, "utf-8");
        const record: ModuleRecord = { exports: {} };
        cache.set(resolved, record);
        const wrapper: unknown = vm.runInContext(
          `(function (module, exports, require, __dirname, __filename) {\n${src}\n})`,
          context,
          { timeout: timeoutMs, displayErrors: false },
        );
        (wrapper as (m: ModuleRecord, e: unknown, r: unknown, d: string, f: string) => void)(
          record,
          record.exports,
          makeRequire(dirname(resolved)),
          dirname(resolved),
          resolved,
        );
        return record.exports;
      }
      // bare npm dep — Selakovic dataset は SUT lib の依存を bundle していない (spike-results.md §6)。
      // host の dataset node_modules から解決を試み、無ければ throw (= Phase F の error 分類で可視化)。
      if (baseRequire !== null) {
        return baseRequire(spec) as unknown;
      }
      throw new Error(`Cannot resolve bare module '${spec}' (no module_base_dir provided)`);
    };
    return requireFn;
  };

  const root = moduleBaseDir ?? process.cwd();
  (context as unknown as Record<string, unknown>).require = makeRequire(root);
}

function resolveRelative(fromDir: string, spec: string): string {
  let resolved = isAbsolute(spec) ? spec : join(fromDir, spec);
  if (!existsSync(resolved) && existsSync(`${resolved}.js`)) resolved = `${resolved}.js`;
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    const pkgPath = join(resolved, "package.json");
    const main = existsSync(pkgPath)
      ? ((JSON.parse(readFileSync(pkgPath, "utf-8")) as { main?: string }).main ?? "index.js")
      : "index.js";
    resolved = join(resolved, main);
    if (!existsSync(resolved) && existsSync(`${resolved}.js`)) resolved = `${resolved}.js`;
  }
  if (!existsSync(resolved)) throw new Error(`Cannot find module '${spec}' (resolved to ${resolved})`);
  return resolved;
}

function snapshotValue(value: unknown): string {
  try {
    return serializeValue(value);
  } catch (e) {
    if (e instanceof SerializationError) return UNSERIALIZABLE_MARKER;
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

function captureException(e: unknown): ExceptionCapture {
  if (e !== null && typeof e === "object") {
    const obj = e as { name?: unknown; message?: unknown };
    const ctor = typeof obj.name === "string" && obj.name.length > 0 ? obj.name : "Error";
    const message = typeof obj.message === "string" ? obj.message : "<non-stringifiable thrown object>";
    return { ctor, message };
  }
  if (typeof e === "symbol") return { ctor: "Unknown", message: e.description ?? "symbol" };
  if (typeof e === "bigint") return { ctor: "Unknown", message: `${e.toString()}n` };
  if (e === undefined) return { ctor: "Unknown", message: "undefined" };
  if (e === null) return { ctor: "Unknown", message: "null" };
  return { ctor: "Unknown", message: String(e as string | number | boolean) };
}

function isTimeoutError(e: unknown): boolean {
  if (e === null || typeof e !== "object") return false;
  const obj = e as { code?: unknown; message?: unknown };
  if (obj.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return true;
  if (typeof obj.message === "string") return obj.message.toLowerCase().includes("script execution timed out");
  return false;
}

// setup の top-level `const`/`let` を `var` 化して context の global property に露出させる (executor.ts と同じ)。
function normalizeSetup(setup: string): string {
  return setup.replace(/(^|[\s;{(])(const|let)(\s+[A-Za-z_$])/g, "$1var$3");
}
