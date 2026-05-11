/**
 * 非決定性 API (Math.random / Date.now / new Date() / timer / performance.now) の遮断・固定化。
 * slow/fast の 2 実行で同じ入力から同じ観測値が得られるようにする。
 * 判断: ai-guide/adr/0012-equivalence-checker-execution-environment.md
 *
 * - vm 環境: 素の sandbox に置く差し替えグローバル一式を `nonDeterministicGlobals()` で作る。
 * - jsdom 環境: jsdom が自前の Date/Math を context に持つので、`freezeContextNonDeterminism()` で
 *   既存値を Proxy 差し替えする。jsdom の timer 系は同期実行では fire しないため触らない。
 */
import vm from "node:vm";

const FROZEN_EPOCH_MS = 0;
const PRNG_SEED = 0x42424242;

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

function makeFrozenMath(realMath: typeof Math): typeof Math {
  const rng = mulberry32(PRNG_SEED);
  return new Proxy(realMath, {
    get(target, prop, receiver) {
      if (prop === "random") return rng;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

function makeFrozenDate(realDate: DateConstructor): DateConstructor {
  return new Proxy(realDate, {
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

/** 素 vm の sandbox に置く非決定性遮断グローバル一式 (Math/Date 凍結 + timer no-op + performance)。 */
export function nonDeterministicGlobals(): Record<string, unknown> {
  return {
    Math: makeFrozenMath(Math),
    Date: makeFrozenDate(Date),
    setTimeout: () => 0,
    setInterval: () => 0,
    setImmediate: () => 0,
    clearTimeout: () => undefined,
    clearInterval: () => undefined,
    clearImmediate: () => undefined,
    queueMicrotask: () => undefined,
    performance: { now: () => FROZEN_EPOCH_MS },
  };
}

/**
 * jsdom の internal VM context の `Date.now` / `new Date()` / `Math.random` を凍結する。
 * (= AngularJS の `ng-<Date.now()>` キャッシュキー等の非決定 global が slow/fast で食い違って
 * 偽 not_equal にならないように)。timer 系は同期実行では fire しないので触らない。
 */
export function freezeContextNonDeterminism(context: vm.Context): void {
  const rec = context as unknown as Record<string, unknown>;
  rec.Date = makeFrozenDate(rec.Date as DateConstructor);
  rec.Math = makeFrozenMath(rec.Math as typeof Math);
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  // 観点: slow/fast の 2 実行で同じ入力から同じ観測値が得られるよう、Math.random は決定的シードで同一値列を、
  // Date.now / new Date() / performance.now は固定値を返し、timer の本体は実行されないこと。
  const vmContextWithGlobals = (): vm.Context => vm.createContext({ ...nonDeterministicGlobals() });

  describe("nonDeterministicGlobals (in-source)", () => {
    it("Math.random が同一シードで決定的な値列を返す ([0,1) の範囲・互いに異なる)", () => {
      const a = vm.runInContext("[Math.random(), Math.random(), Math.random()]", vmContextWithGlobals()) as number[];
      const b = vm.runInContext("[Math.random(), Math.random(), Math.random()]", vmContextWithGlobals()) as number[];
      expect(a).toEqual(b);
      expect(new Set(a).size).toBe(3);
      for (const v of a) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    });

    it("Date.now / new Date() / performance.now が固定値になる", () => {
      const res = vm.runInContext(
        "[Date.now(), new Date().getTime(), performance.now()]",
        vmContextWithGlobals(),
      ) as number[];
      expect(res).toEqual([FROZEN_EPOCH_MS, FROZEN_EPOCH_MS, FROZEN_EPOCH_MS]);
    });

    it("setTimeout / setInterval の本体は実行されない", () => {
      const res = vm.runInContext(
        `let touched = false; setTimeout(() => { touched = true; }, 0); setInterval(() => { touched = true; }, 0); touched`,
        vmContextWithGlobals(),
      ) as boolean;
      expect(res).toBe(false);
    });
  });

  describe("freezeContextNonDeterminism (in-source)", () => {
    it("既存 context の Date.now / new Date() / Math.random を後付けで凍結する", () => {
      const frozenContext = (): vm.Context => {
        const ctx = vm.createContext({ Date, Math });
        freezeContextNonDeterminism(ctx);
        return ctx;
      };
      const a = vm.runInContext(
        "[Date.now(), new Date().getTime(), Math.random(), Math.random()]",
        frozenContext(),
      ) as number[];
      const b = vm.runInContext(
        "[Date.now(), new Date().getTime(), Math.random(), Math.random()]",
        frozenContext(),
      ) as number[];
      expect(a[0]).toBe(FROZEN_EPOCH_MS);
      expect(a[1]).toBe(FROZEN_EPOCH_MS);
      expect(a).toEqual(b);
    });
  });
}
