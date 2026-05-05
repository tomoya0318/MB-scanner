import vm from "node:vm";

const FROZEN_EPOCH_MS = 0;
const PRNG_SEED = 0x42424242;

export type ConsoleMethod = "log" | "error" | "warn" | "info" | "debug";

export interface ConsoleCall {
  method: ConsoleMethod;
  args: unknown[];
}

export interface StabilizedContext {
  context: vm.Context;
  consoleCalls: ConsoleCall[];
  baselineKeys: ReadonlySet<string>;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createFrozenMath(rng: () => number): typeof Math {
  return new Proxy(Math, {
    get(target, prop, receiver) {
      if (prop === "random") return rng;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

function createFrozenDate(): DateConstructor {
  return new Proxy(Date, {
    construct(target, args, newTarget) {
      const normalized = args.length === 0 ? [FROZEN_EPOCH_MS] : args;
      return Reflect.construct(target, normalized, newTarget) as Date;
    },
    get(target, prop, receiver) {
      if (prop === "now") return () => FROZEN_EPOCH_MS;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

function createConsoleHook(sink: ConsoleCall[]): Record<ConsoleMethod, (...args: unknown[]) => void> {
  const methods: ConsoleMethod[] = ["log", "error", "warn", "info", "debug"];
  const hook = {} as Record<ConsoleMethod, (...args: unknown[]) => void>;
  for (const method of methods) {
    hook[method] = (...args: unknown[]) => {
      sink.push({ method, args });
    };
  }
  return hook;
}

// global proxy で fall-through すべき ECMAScript 標準 builtins。
// Math / Date は frozen 化するため baseline 側で上書きする。
const BUILTIN_GLOBALS: ReadonlySet<string> = new Set([
  "Object", "Function", "Array", "Number", "Boolean", "String", "Symbol", "BigInt",
  "RegExp", "JSON",
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
  "EvalError", "URIError", "AggregateError",
  "Promise", "Map", "Set", "WeakMap", "WeakSet", "Proxy", "Reflect",
  "FinalizationRegistry", "WeakRef",
  "ArrayBuffer", "SharedArrayBuffer", "DataView",
  "Int8Array", "Uint8Array", "Uint8ClampedArray",
  "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
  "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
  "parseInt", "parseFloat", "isNaN", "isFinite",
  "encodeURI", "decodeURI", "encodeURIComponent", "decodeURIComponent",
  "NaN", "Infinity", "undefined", "globalThis", "Atomics",
  "escape", "unescape",
]);

// 別 realm から builtin の実体を取得して固定化する。各 stabilized context で
// 同じ pool を共有しても、builtin は frozen に近い値なので汚染は発生しない。
// realm が分離されているため `[1,2] instanceof Array` は false になる cross-realm
// の精度欠落があるが、両 sandbox で同じ realm を使うので等価判定は機能する。
let cachedBuiltinPool: Readonly<Record<string, unknown>> | null = null;
function loadBuiltinPool(): Readonly<Record<string, unknown>> {
  if (cachedBuiltinPool !== null) return cachedBuiltinPool;
  const realm = vm.createContext({});
  const pool: Record<string, unknown> = {};
  for (const name of BUILTIN_GLOBALS) {
    try {
      pool[name] = vm.runInContext(name, realm) as unknown;
    } catch {
      // 実行環境にない builtin は skip
    }
  }
  cachedBuiltinPool = pool;
  return pool;
}

const STUB_BRAND: unique symbol = Symbol.for("equivalence-checker.undefined-stub");

// 未定義 global identifier を吸収する universal stub。プロパティ参照・関数呼び出し・
// `new` のいずれも自身と同形の stub を返す。setup での framework / harness
// (angular, require, execute, ...) アクセスで ReferenceError を吐かせず、両 sandbox
// 同等に "何も起きない" 観測値に収束させて等価判定を成立させる狙い。
// 戻り値型を object にしておくと Proxy.construct trap (object 必須) と Proxy.apply trap
// (任意) の両方の戻り値として型整合する。
type UndefinedStub = object;

function makeUndefinedStub(name: string): UndefinedStub {
  // 自身を function にしておくことで `new stub()` も `stub()` も両対応できる。
  const target = function undefinedStub() {
    /* no-op */
  };
  Object.defineProperty(target, STUB_BRAND, { value: true });

  return new Proxy(target, {
    get(t, prop) {
      // await stub が無限 microtask に陥らないよう then は thenable から外す
      if (prop === "then") return undefined;
      // for...of / for await...of の暴走防止
      if (prop === Symbol.iterator || prop === Symbol.asyncIterator) return undefined;
      // 型変換時の hint に基づく primitive 化 (`+stub` / `String(stub)` / `${stub}`)
      if (prop === Symbol.toPrimitive) {
        return (hint: string): number | string => (hint === "number" ? 0 : `[stub:${name}]`);
      }
      if (prop === Symbol.toStringTag) return `Stub(${name})`;
      // function 自身が持つ length / name / prototype 等は普通に返す
      if (prop in t) return (t as unknown as Record<PropertyKey, unknown>)[prop];
      if (prop === "toString") return () => `[stub:${name}]`;
      if (prop === "valueOf") return () => 0;
      // 識別子の継承で `name.prop` 形式の名前を保持しておくとデバッグしやすい
      return makeUndefinedStub(`${name}.${String(prop)}`);
    },
    apply() {
      return makeUndefinedStub(`${name}()`);
    },
    construct() {
      return makeUndefinedStub(`new ${name}`);
    },
    has() {
      return true;
    },
  });
}

// global object 用の proxy。builtin (Object/Array/...) は別 realm 経由で本物に解決し、
// それ以外で sandbox にも無いキーは stub に化けさせる。`vm.createContext(proxy)` の
// 戻り値が proxy 自身になるので、Object.keys(context) は target の own keys を返す
// (executor の new_globals 検出が引き続き機能する)。
function installStubFallback(
  sandbox: Record<string, unknown>,
  builtins: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return new Proxy(sandbox, {
    has(target, prop) {
      if (typeof prop === "symbol") return Reflect.has(target, prop);
      // すべての string 名前解決を proxy 経由に流すことで未定義 identifier も
      // ReferenceError ではなく get trap → stub に変換する
      return prop in target || Object.hasOwn(builtins, prop) || true;
    },
    get(target, prop, receiver) {
      // symbol アクセス (Symbol.iterator など) は target/builtin に固有の意味があるので
      // stub に化けさせず素通しする。
      if (typeof prop === "symbol") {
        return (Reflect.get(target, prop, receiver) ?? undefined) as unknown;
      }
      if (prop in target) return target[prop];
      if (Object.hasOwn(builtins, prop)) return builtins[prop];
      return makeUndefinedStub(prop);
    },
  });
}

export function createStabilizedContext(): StabilizedContext {
  const consoleCalls: ConsoleCall[] = [];
  const rng = mulberry32(PRNG_SEED);
  const builtins = loadBuiltinPool();

  // process / require / eval / Function は意図的に baseline から外し、stub fallback で
  // 吸収させる。stub は外部 IO / host realm を一切持たないため、`require("fs")` も
  // `eval("malicious")` も no-op に潰れて安全 (= 旧来の `undefined` より失敗が softer)。
  const sandbox: Record<string, unknown> = {
    console: createConsoleHook(consoleCalls),
    Math: createFrozenMath(rng),
    Date: createFrozenDate(),
    setTimeout: () => 0,
    setInterval: () => 0,
    setImmediate: () => 0,
    clearTimeout: () => undefined,
    clearInterval: () => undefined,
    clearImmediate: () => undefined,
    queueMicrotask: () => undefined,
    performance: { now: () => FROZEN_EPOCH_MS },
  };

  const baselineKeys = new Set(Object.keys(sandbox));
  const proxiedSandbox = installStubFallback(sandbox, builtins);
  const context = vm.createContext(proxiedSandbox);

  return { context, consoleCalls, baselineKeys };
}
