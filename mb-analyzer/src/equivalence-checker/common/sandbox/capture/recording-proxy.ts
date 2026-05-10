/**
 * 汎用記録 Proxy — C6 (interaction-trace oracle) の取得側。
 *
 * workload (`f1` / `test()`) が叩く境界オブジェクト (server: `init`/`setupTest` の戻り値、
 * client: 注入 service / workload が直接叩く framework global) を Proxy で包み、呼び出し列を
 * `TraceEntry[]` に記録する。slow/fast の trace を比較するのが C6。
 *
 * 設計 (spike §3 / ADR-0013 / ADR-0015):
 * - `get` / `set` / `apply` / `construct` トラップのみ定義。他 (`has`/`ownKeys`/`getPrototypeOf`/...) は
 *   未定義 = Reflect 素通し → `instanceof` / `hasOwnProperty` / `Object.getPrototypeOf` / `Object.keys` を壊さない。
 * - メソッド呼び出し / `apply` / `construct` の転送は **real target を `this` (or 素の `Reflect.construct`)** にして実行 →
 *   SUT 内部の連鎖 (`this.foo()` 等) は Proxy を通らず trace に乗らない (= 境界だけ観測)。
 * - traced call/construct の戻り値 (object/function なら) を再帰 wrap → chained API (cheerio `obj(...).next(...)`,
 *   jQuery `$(...).get(...)`, コンストラクタ→インスタンス) の各段が trace に乗る。同一 target の再 wrap は WeakMap でキャッシュ。
 * - args/result の serialize は cross-realm 耐性のため `Object.prototype.toString.call` のタグ判定を使う
 *   (`instanceof` は realm 違いで壊れるため)。`$$`-prefix プロパティ無視 / 循環 = `<circular>` / 関数 = `<function>` /
 *   DOM ノード短縮 / 深さ上限。これ専用なので `common/serializer.ts` とは別 (あちらは host-realm 用 + DOM/$$ なし)。
 */
import type { TraceEntry } from "./types";

/**
 * jsdom executor が `recordInteractions` で記録 Proxy を context に置くときの global 名。
 * runnable (= `preprocessing/selakovic/assemble/*` が生成) は `globalThis.__recorder` を見て、あれば
 * workload が叩く境界オブジェクトを `.wrap(...)` してから SUT を呼ぶ。preprocessing 側はこの文字列を
 * (依存方向の都合で import できないので) ハードコードする — 変更時は両方を揃えること。
 */
export const RECORDER_GLOBAL = "__recorder";

const MAX_DEPTH = 8;
const SKIP_KEY_PREFIX = "$$";

export interface WrapOptions {
  /** traced call/construct の戻り値を再帰 wrap するか (true = 無制限, 数値 = 深さ, 既定 0 = 境界 1 段だけ)。 */
  recurse?: boolean | number;
  /** データ値プロパティ read を trace に記録するか (既定 true; 関数を返す get は別途 call として記録)。 */
  recordGets?: boolean;
}

export interface Recorder {
  /** `target` を `path` 名で wrap して返す (wrappable でなければそのまま)。 */
  wrap: <T>(target: T, path: string, options?: WrapOptions) => T;
  /** 記録された呼び出し列。実行後にここから読み出す。 */
  trace: TraceEntry[];
  /** trace と wrap キャッシュをクリアする。 */
  reset: () => void;
}

function isWrappable(v: unknown): v is object {
  const t = typeof v;
  return v !== null && (t === "object" || t === "function");
}

function serializeNumber(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Number.POSITIVE_INFINITY) return "Infinity";
  if (n === Number.NEGATIVE_INFINITY) return "-Infinity";
  if (n === 0) return Object.is(n, -0) ? "-0" : "0";
  return String(n);
}

function domNodeRepr(obj: object): string | null {
  const node = obj as { nodeType?: unknown; nodeName?: unknown; id?: unknown; className?: unknown; textContent?: unknown };
  if (typeof node.nodeType !== "number" || typeof node.nodeName !== "string") return null;
  const text = typeof node.textContent === "string" ? node.textContent : "";
  switch (node.nodeType) {
    case 1: {
      const id = typeof node.id === "string" && node.id.length > 0 ? `#${node.id}` : "";
      const cls =
        typeof node.className === "string" && node.className.trim().length > 0
          ? `.${node.className.trim().split(/\s+/).join(".")}`
          : "";
      return `<dom:${node.nodeName.toLowerCase()}${id}${cls} text=${JSON.stringify(text)}>`;
    }
    case 3:
      return `<dom:#text ${JSON.stringify(text)}>`;
    case 8:
      return `<dom:#comment ${JSON.stringify(text)}>`;
    case 9:
      return "<dom:#document>";
    default:
      return `<dom:${node.nodeName}>`;
  }
}

/** cross-realm 耐性のあるタグベース canonical serializer (trace の args/result 用)。 */
function serializeForTrace(value: unknown, stack: object[] = [], depth = 0): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return value ? "true" : "false";
  if (t === "bigint") return `${(value as bigint).toString()}n`;
  if (t === "symbol") return `<symbol:${(value as symbol).description ?? ""}>`;
  if (t === "function") return "<function>";
  if (t === "number") return serializeNumber(value as number);

  const obj = value as object;
  if (stack.includes(obj)) return "<circular>";
  const dom = domNodeRepr(obj);
  if (dom !== null) return dom;
  if (depth >= MAX_DEPTH) return "<deep>";

  stack.push(obj);
  try {
    const tag = Object.prototype.toString.call(obj);
    if (Array.isArray(obj)) {
      return `[${obj.map((x) => serializeForTrace(x, stack, depth + 1)).join(",")}]`;
    }
    if (tag === "[object Date]") {
      try {
        return `<Date:${String((obj as Date).getTime())}>`;
      } catch {
        return "<Date:?>";
      }
    }
    if (tag === "[object RegExp]") return `<RegExp:${(obj as RegExp).toString()}>`;
    if (tag === "[object Error]") {
      const e = obj as { name?: unknown; message?: unknown };
      const name = typeof e.name === "string" ? e.name : "Error";
      const msg = typeof e.message === "string" ? e.message : "";
      return `<Error:${name}:${msg}>`;
    }
    if (tag === "[object Map]") {
      const entries: Array<[string, string]> = [];
      try {
        (obj as Map<unknown, unknown>).forEach((v, k) => {
          entries.push([serializeForTrace(k, stack, depth + 1), serializeForTrace(v, stack, depth + 1)]);
        });
      } catch {
        /* iteration が壊れていても部分結果で続行 */
      }
      entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return `<Map:{${entries.map(([k, v]) => `${k}=>${v}`).join(",")}}>`;
    }
    if (tag === "[object Set]") {
      const items: string[] = [];
      try {
        (obj as Set<unknown>).forEach((v) => {
          items.push(serializeForTrace(v, stack, depth + 1));
        });
      } catch {
        /* 同上 */
      }
      items.sort();
      return `<Set:{${items.join(",")}}>`;
    }
    let keys: string[];
    try {
      keys = Object.keys(obj);
    } catch {
      keys = [];
    }
    keys = keys.filter((k) => !k.startsWith(SKIP_KEY_PREFIX)).sort();
    const parts: string[] = [];
    for (const k of keys) {
      let v: unknown;
      try {
        v = (obj as Record<string, unknown>)[k];
      } catch {
        parts.push(`${JSON.stringify(k)}:"<getter-threw>"`);
        continue;
      }
      parts.push(`${JSON.stringify(k)}:${serializeForTrace(v, stack, depth + 1)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    stack.pop();
  }
}

function serializeThrown(e: unknown): string {
  if (e === undefined || e === null) return `<thrown:${String(e)}>`;
  if (typeof e !== "object") return `<thrown:${typeof e}:${stringifyPrimitive(e)}>`;
  const obj = e as { name?: unknown; message?: unknown; constructor?: { name?: unknown } };
  const name =
    typeof obj.name === "string" && obj.name.length > 0
      ? obj.name
      : typeof obj.constructor?.name === "string"
        ? obj.constructor.name
        : "Error";
  const msg = typeof obj.message === "string" ? obj.message : "<non-stringifiable thrown object>";
  return `<thrown:${name}:${msg}>`;
}

function stringifyPrimitive(value: unknown): string {
  if (typeof value === "symbol") return value.description ?? "symbol";
  if (typeof value === "bigint") return `${value.toString()}n`;
  return String(value as string | number | boolean);
}

export function makeRecorder(): Recorder {
  const trace: TraceEntry[] = [];
  let cache = new WeakMap<object, object>();

  function wrap<T>(target: T, path: string, options: WrapOptions = {}): T {
    if (!isWrappable(target)) return target;
    const existing = cache.get(target);
    if (existing !== undefined) return existing as T;

    const recordGets = options.recordGets !== false;
    const recurse =
      options.recurse === true
        ? Number.POSITIVE_INFINITY
        : typeof options.recurse === "number"
          ? options.recurse
          : 0;

    const maybeWrapResult = (v: unknown, childPath: string): unknown =>
      recurse > 0 && isWrappable(v) ? wrap(v, childPath, { recurse: recurse - 1, recordGets }) : v;

    const recordCall = (
      callPath: string,
      fn: (...a: unknown[]) => unknown,
      thisArg: unknown,
      args: unknown[],
    ): unknown => {
      const entry: TraceEntry = { path: callPath, op: "call", args: args.map((a) => serializeForTrace(a)) };
      let result: unknown;
      try {
        result = Reflect.apply(fn, thisArg, args);
      } catch (e) {
        entry.thrown = serializeThrown(e);
        trace.push(entry);
        throw e;
      }
      entry.result = serializeForTrace(result);
      trace.push(entry);
      return maybeWrapResult(result, `${callPath}()`);
    };

    const proxy = new Proxy(target, {
      get(tgt, prop): unknown {
        let v: unknown;
        try {
          v = Reflect.get(tgt, prop, tgt);
        } catch (e) {
          if (typeof prop === "string") trace.push({ path: `${path}.${prop}`, op: "get", thrown: serializeThrown(e) });
          throw e;
        }
        if (typeof v === "function") {
          const fn = v as (...a: unknown[]) => unknown;
          const methodPath = `${path}.${String(prop)}`;
          return (...callArgs: unknown[]): unknown => recordCall(methodPath, fn, tgt, callArgs);
        }
        if (recordGets && typeof prop === "string" && prop !== "constructor" && prop !== "prototype" && prop !== "then") {
          trace.push({ path: `${path}.${prop}`, op: "get", result: serializeForTrace(v) });
        }
        return v;
      },
      set(tgt, prop, value): boolean {
        return Reflect.set(tgt, prop, value, tgt);
      },
      apply(tgt, thisArg, args): unknown {
        return recordCall(`${path}()`, tgt as (...a: unknown[]) => unknown, thisArg, args);
      },
      construct(tgt, args): object {
        const entry: TraceEntry = { path: `new ${path}`, op: "construct", args: args.map((a) => serializeForTrace(a)) };
        let inst: object;
        try {
          inst = Reflect.construct(tgt as new (...a: unknown[]) => object, args);
        } catch (e) {
          entry.thrown = serializeThrown(e);
          trace.push(entry);
          throw e;
        }
        entry.result = serializeForTrace(inst);
        trace.push(entry);
        return maybeWrapResult(inst, `new ${path}`) as object;
      },
    });
    cache.set(target, proxy);
    return proxy as T;
  }

  return {
    wrap,
    trace,
    reset() {
      trace.length = 0;
      cache = new WeakMap();
    },
  };
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("makeRecorder (in-source)", () => {
    it("メソッド呼び出しを path / args / result で記録する", () => {
      const r = makeRecorder();
      const obj = r.wrap({ add: (a: number, b: number) => a + b, val: 7 }, "obj");
      expect(obj.add(2, 3)).toBe(5);
      expect(r.trace).toEqual([{ path: "obj.add", op: "call", args: ["2", "3"], result: "5" }]);
    });

    it("データ値プロパティ read を get として記録する", () => {
      const r = makeRecorder();
      const obj = r.wrap({ val: 7 }, "obj");
      expect(obj.val).toBe(7);
      expect(r.trace).toEqual([{ path: "obj.val", op: "get", result: "7" }]);
    });

    it("内部の this 連鎖は記録されない (real target を this にして転送)", () => {
      const r = makeRecorder();
      const sut = {
        outer(this: { inner: () => number }): number {
          return this.inner();
        },
        inner(): number {
          return 42;
        },
      };
      const wrapped = r.wrap(sut, "sut");
      expect(wrapped.outer()).toBe(42);
      // outer の呼び出しだけが乗る (inner は this=real なので Proxy を通らない)
      expect(r.trace.map((e) => e.path)).toEqual(["sut.outer"]);
    });

    it("recurse で chained API の各段が乗る", () => {
      const r = makeRecorder();
      const root = (n: number) => ({ next: (m: number) => ({ value: n + m }) });
      const wrapped = r.wrap(root, "root", { recurse: true });
      const out = wrapped(1).next(2);
      // out (proxy) を touch する前に trace を確認 (out.value の read も get として乗るため)。
      // path は連鎖を反映: root() を呼び → その戻り値 () → .next。
      expect(r.trace.map((e) => `${e.op}:${e.path}`)).toEqual(["call:root()", "call:root()().next"]);
      expect(out.value).toBe(3);
    });

    it("construct を記録する", () => {
      const r = makeRecorder();
      class Box {
        constructor(public v: number) {}
      }
      const W = r.wrap(Box, "Box", { recurse: true });
      const b = new W(9);
      expect(b.v).toBe(9);
      expect(r.trace[0]).toMatchObject({ op: "construct", path: "new Box", args: ["9"] });
    });

    it("throw した呼び出しは thrown を記録して再 throw する", () => {
      const r = makeRecorder();
      const obj = r.wrap(
        {
          boom(): never {
            throw new TypeError("nope");
          },
        },
        "obj",
      );
      expect(() => obj.boom()).toThrow("nope");
      expect(r.trace).toEqual([{ path: "obj.boom", op: "call", args: [], thrown: "<thrown:TypeError:nope>" }]);
    });

    it("instanceof / hasOwnProperty を壊さない (get/set/apply/construct 以外は Reflect 素通し)", () => {
      const r = makeRecorder();
      class C {}
      const inst = new C();
      const wrapped = r.wrap(inst, "inst");
      expect(wrapped instanceof C).toBe(true);
      expect(Object.getPrototypeOf(wrapped)).toBe(C.prototype);
    });

    it("$$ prefix プロパティを serialize で無視し、循環は <circular>", () => {
      const r = makeRecorder();
      const cyc: Record<string, unknown> = { a: 1, $$hashKey: "x" };
      cyc.self = cyc;
      const obj = r.wrap({ id: (x: unknown) => x }, "obj");
      obj.id(cyc);
      expect(r.trace[0]?.args?.[0]).toBe('{"a":1,"self":<circular>}');
    });

    it("同一 target の再 wrap は同じ proxy (WeakMap キャッシュ)", () => {
      const r = makeRecorder();
      const tgt = { f: () => 1 };
      expect(r.wrap(tgt, "a")).toBe(r.wrap(tgt, "b"));
    });

    it("reset で trace とキャッシュをクリアする", () => {
      const r = makeRecorder();
      const obj = r.wrap({ f: () => 1 }, "obj");
      obj.f();
      expect(r.trace).toHaveLength(1);
      r.reset();
      expect(r.trace).toHaveLength(0);
    });
  });
}
