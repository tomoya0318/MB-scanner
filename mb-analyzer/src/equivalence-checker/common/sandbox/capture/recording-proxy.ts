/**
 * 汎用記録 Proxy — C6 (interaction-trace oracle) の取得側。
 *
 * workload (`f1` / `test()`) が叩く境界オブジェクト (server: `init`/`setupTest` の戻り値、
 * client: 注入 service / workload が直接叩く framework global) を Proxy で包み、呼び出し列を
 * `TraceEntry[]` に記録する。before/after の trace を比較するのが C6。
 *
 * 判断: ai-guide/adr/0015-equivalence-checker-layering-and-dom-oracle.md
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

const MAX_DEPTH = 6;
/**
 * serialize / get-trace で無視するプロパティキーの prefix。`$$` は AngularJS の `$$hashKey` 等、
 * `_` は多くの JS ライブラリ (Backbone / moment / underscore / request 等) が「private/内部」フィールドに
 * 使う慣習。C6 は「workload↔SUT の観測可能な interaction」を見るのが目的なので、SUT 内部のレイアウト差
 * (= patch のリファクタリングで変わるが振る舞いには影響しない) を比較対象から外す。
 */
const SKIP_KEY_PREFIXES: readonly string[] = ["$$", "_"];
/**
 * prefix 規則に当てはまらないが「逐次採番カウンタ / 内部 bookkeeping」として無視するキー (exact match)。
 * `cid` = Backbone の Model/Collection の連番 ID (`"c1"`/`"c5001"` — 何個 Model を作ったかに依存して
 * before/after で値がずれる)。prefix では拾えないのでここに足す (= C6 が観測すべき「振る舞い」ではない)。
 */
const SKIP_KEY_EXACT: ReadonlySet<string> = new Set(["cid"]);
function isSkippedKey(k: string): boolean {
  return SKIP_KEY_EXACT.has(k) || SKIP_KEY_PREFIXES.some((p) => k.startsWith(p));
}
/**
 * 「SUT との interaction」ではなく値変換 / イテレーション / Promise プロトコルの機構であって、
 * 呼び出しても trace に記録しないメソッド (= raw 関数を real target に bind して返す → 内部アクセスも漏れない)。
 * 例: `"" + wrappedObj` が `valueOf`/`toString` を呼ぶ、`for..of` が `Symbol.iterator` を呼ぶ — これらを
 * trace に乗せると「同じ振る舞いだが内部実装が違う patch」(moment の `isAfter` が `other._a` vs `other.valueOf()` 等) で
 * 偽 not_equal が出る。
 */
const NON_INTERACTION_METHODS: ReadonlySet<string | symbol> = new Set<string | symbol>([
  "valueOf",
  "toString",
  "toLocaleString",
  "toJSON",
  "then",
  Symbol.toPrimitive,
  Symbol.iterator,
  Symbol.asyncIterator,
]);
/** 1 つの値の serialize で辿る配列要素 / オブジェクトキーの最大数 (それ以上は `…(+N more)` に畳む)。 */
const MAX_BREADTH = 24;
/** 1 つの値の serialize 結果の最大文字数 (これを超えたら `<truncated>`)。深さ×幅だけでは爆発しうるため総量でも縛る。 */
const VALUE_BUDGET_CHARS = 16_384;
/** DOM ノード短縮表現に含める textContent の最大文字数。 */
const DOM_TEXT_MAX = 200;
/**
 * trace に積む最大エントリ数 (それ以上は捨てる + 末尾に 1 件だけ `<trace-truncated>` を残す)。
 * react-895 系 (workload が 1000 ノード規模の component tree を構築し、`recurse:true` で wrap した
 * lib グローバルの呼び出し列が膨れる) で V8 の文字列上限を超えてプロセスごと落ちるのを防ぐ。
 * before/after 両方が同じ閾値で打ち切られるので、prefix が一致すれば C6 は `equal`、差があれば `not_equal` のまま。
 */
const MAX_TRACE_ENTRIES = 2_000;

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

function clampText(s: string): string {
  return s.length > DOM_TEXT_MAX ? `${s.slice(0, DOM_TEXT_MAX)}…` : s;
}

function domNodeRepr(obj: object): string | null {
  const node = obj as { nodeType?: unknown; nodeName?: unknown; id?: unknown; className?: unknown; textContent?: unknown };
  if (typeof node.nodeType !== "number" || typeof node.nodeName !== "string") return null;
  const text = typeof node.textContent === "string" ? clampText(node.textContent) : "";
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

interface SerBudget {
  /** 残り予算 (文字数)。0 以下で打ち切り。 */
  n: number;
}

/** `items` を `MAX_BREADTH` 件まで serialize し、それ以上は `…(+N more)` に畳む。 */
function serializeItems(items: readonly unknown[], stack: object[], depth: number, budget: SerBudget): string[] {
  const out: string[] = [];
  const shown = Math.min(items.length, MAX_BREADTH);
  for (let i = 0; i < shown; i++) {
    if (budget.n <= 0) {
      out.push("<truncated>");
      return out;
    }
    out.push(serializeForTrace(items[i], stack, depth + 1, budget));
  }
  if (items.length > shown) out.push(`…(+${items.length - shown} more)`);
  return out;
}

/** cross-realm 耐性のあるタグベース canonical serializer (trace の args/result 用)。深さ・幅・総量に上限を持つ。 */
function serializeForTrace(value: unknown, stack: object[] = [], depth = 0, budget: SerBudget = { n: VALUE_BUDGET_CHARS }): string {
  if (budget.n <= 0) return "<truncated>";
  const out = serializeForTraceInner(value, stack, depth, budget);
  budget.n -= out.length;
  return out;
}

function serializeForTraceInner(value: unknown, stack: object[], depth: number, budget: SerBudget): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") {
    const s = value as string;
    return JSON.stringify(s.length > VALUE_BUDGET_CHARS ? `${s.slice(0, VALUE_BUDGET_CHARS)}…` : s);
  }
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
      return `[${serializeItems(obj, stack, depth, budget).join(",")}]`;
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
        let i = 0;
        (obj as Map<unknown, unknown>).forEach((v, k) => {
          if (i++ >= MAX_BREADTH || budget.n <= 0) return;
          entries.push([serializeForTrace(k, stack, depth + 1, budget), serializeForTrace(v, stack, depth + 1, budget)]);
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
        let i = 0;
        (obj as Set<unknown>).forEach((v) => {
          if (i++ >= MAX_BREADTH || budget.n <= 0) return;
          items.push(serializeForTrace(v, stack, depth + 1, budget));
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
    keys = keys.filter((k) => !isSkippedKey(k)).sort();
    const shown = Math.min(keys.length, MAX_BREADTH);
    const parts: string[] = [];
    for (let i = 0; i < shown; i++) {
      if (budget.n <= 0) {
        parts.push("<truncated>");
        break;
      }
      const k = keys[i];
      if (k === undefined) break;
      let v: unknown;
      try {
        v = (obj as Record<string, unknown>)[k];
      } catch {
        parts.push(`${JSON.stringify(k)}:"<getter-threw>"`);
        continue;
      }
      parts.push(`${JSON.stringify(k)}:${serializeForTrace(v, stack, depth + 1, budget)}`);
    }
    if (keys.length > shown) parts.push(`…(+${keys.length - shown} more)`);
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
  let truncated = false;

  /** `MAX_TRACE_ENTRIES` を超えたら捨て、末尾に 1 件だけ番兵を残す。戻り値 = まだ受け付けるか。 */
  const pushTrace = (entry: TraceEntry): void => {
    if (trace.length >= MAX_TRACE_ENTRIES) {
      if (!truncated) {
        trace.push({ path: "<trace-truncated>", op: "call", result: `<exceeded ${MAX_TRACE_ENTRIES} entries>` });
        truncated = true;
      }
      return;
    }
    trace.push(entry);
  };
  const traceFull = (): boolean => trace.length >= MAX_TRACE_ENTRIES;

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
      // trace が満杯なら entry を組まずに素通しで forward (巨大 args の serialize も避ける)。
      if (traceFull()) {
        pushTrace({ path: callPath, op: "call" });
        const r = Reflect.apply(fn, thisArg, args);
        return maybeWrapResult(r, `${callPath}()`);
      }
      const entry: TraceEntry = { path: callPath, op: "call", args: args.map((a) => serializeForTrace(a)) };
      let result: unknown;
      try {
        result = Reflect.apply(fn, thisArg, args);
      } catch (e) {
        entry.thrown = serializeThrown(e);
        pushTrace(entry);
        throw e;
      }
      entry.result = serializeForTrace(result);
      pushTrace(entry);
      return maybeWrapResult(result, `${callPath}()`);
    };

    const proxy = new Proxy(target, {
      get(tgt, prop): unknown {
        let v: unknown;
        try {
          v = Reflect.get(tgt, prop, tgt);
        } catch (e) {
          if (typeof prop === "string") pushTrace({ path: `${path}.${prop}`, op: "get", thrown: serializeThrown(e) });
          throw e;
        }
        if (typeof v === "function") {
          const fn = v as (...a: unknown[]) => unknown;
          // 値変換 / イテレーション / Promise プロトコルの機構は trace に乗せず real target に bind して返す
          // (= 呼んでも記録しないし内部アクセスも漏れない)。
          if (NON_INTERACTION_METHODS.has(prop)) return fn.bind(tgt);
          const methodPath = `${path}.${String(prop)}`;
          return (...callArgs: unknown[]): unknown => recordCall(methodPath, fn, tgt, callArgs);
        }
        if (
          recordGets &&
          !traceFull() &&
          typeof prop === "string" &&
          prop !== "constructor" &&
          prop !== "prototype" &&
          !NON_INTERACTION_METHODS.has(prop) &&
          !isSkippedKey(prop)
        ) {
          pushTrace({ path: `${path}.${prop}`, op: "get", result: serializeForTrace(v) });
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
        if (traceFull()) {
          pushTrace({ path: `new ${path}`, op: "construct" });
          const r = Reflect.construct(tgt as new (...a: unknown[]) => object, args);
          return maybeWrapResult(r, `new ${path}`) as object;
        }
        const entry: TraceEntry = { path: `new ${path}`, op: "construct", args: args.map((a) => serializeForTrace(a)) };
        let inst: object;
        try {
          inst = Reflect.construct(tgt as new (...a: unknown[]) => object, args);
        } catch (e) {
          entry.thrown = serializeThrown(e);
          pushTrace(entry);
          throw e;
        }
        entry.result = serializeForTrace(inst);
        pushTrace(entry);
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
      truncated = false;
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

    it("$$ / _ prefix と cid プロパティを serialize で無視し、循環は <circular>", () => {
      const r = makeRecorder();
      const cyc: Record<string, unknown> = { a: 1, $$hashKey: "x", _internal: 7, _f: undefined, cid: "c1" };
      cyc.self = cyc;
      const obj = r.wrap({ id: (x: unknown) => x }, "obj");
      obj.id(cyc);
      // $$hashKey ($$ prefix) / _internal / _f (_ prefix) / cid (exact) はいずれも serialize から除外される
      expect(r.trace[0]?.args?.[0]).toBe('{"a":1,"self":<circular>}');
    });

    it("_ prefix / cid のデータプロパティ get は trace に記録されない (bookkeeping)", () => {
      const r = makeRecorder();
      const obj = r.wrap({ _internal: 7, cid: "c1", value: 42 }, "obj");
      expect(obj._internal).toBe(7);
      expect(obj.cid).toBe("c1");
      expect(obj.value).toBe(42); // 普通のプロパティは従来どおり get として乗る
      expect(r.trace).toEqual([{ path: "obj.value", op: "get", result: "42" }]);
    });

    it("valueOf / toString は呼んでも trace に乗らず、内部アクセスも漏れない", () => {
      const r = makeRecorder();
      const obj = r.wrap(
        {
          _internal: 99,
          valueOf(this: { _internal: number }): number {
            return this._internal; // this を real target に bind するので proxy 経由でない
          },
          touch(): number {
            return 1;
          },
        },
        "obj",
      );
      expect(+obj).toBe(99); // valueOf 呼び出し
      expect(obj.toString()).toBe("[object Object]"); // toString 呼び出し (Object.prototype.toString)
      // valueOf / toString の呼び出しも内部の this._internal read も trace に乗らない
      expect(r.trace).toEqual([]);
      // 通常メソッドは従来どおり乗る
      obj.touch();
      expect(r.trace).toEqual([{ path: "obj.touch", op: "call", args: [], result: "1" }]);
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

    it("MAX_TRACE_ENTRIES を超えると末尾に 1 件だけ <trace-truncated> 番兵を残し以降は捨てる", () => {
      const r = makeRecorder();
      const obj = r.wrap({ f: (x: number) => x }, "obj");
      for (let i = 0; i < MAX_TRACE_ENTRIES + 100; i++) obj.f(i);
      expect(r.trace).toHaveLength(MAX_TRACE_ENTRIES + 1);
      expect(r.trace.at(-1)).toEqual({
        path: "<trace-truncated>",
        op: "call",
        result: `<exceeded ${MAX_TRACE_ENTRIES} entries>`,
      });
    });

    it("配列・オブジェクトの要素数が MAX_BREADTH を超えると …(+N more) に畳む", () => {
      const r = makeRecorder();
      const obj = r.wrap({ id: (x: unknown) => x }, "obj");
      obj.id(Array.from({ length: MAX_BREADTH + 5 }, (_, i) => i));
      obj.id(Object.fromEntries(Array.from({ length: MAX_BREADTH + 3 }, (_, i) => [`k${i}`, i])));
      expect(r.trace[0]?.args?.[0]).toContain("…(+5 more)");
      expect(r.trace[1]?.args?.[0]).toContain("…(+3 more)");
    });
  });
}
