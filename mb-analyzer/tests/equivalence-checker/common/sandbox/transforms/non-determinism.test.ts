/**
 * 対象: nonDeterministicGlobals (素 vm 用の非決定性遮断グローバル一式) / freezeContextNonDeterminism (jsdom context 用の差し替え)
 * 観点: 2 回の実行で同じ入力から同じ観測値が得られるよう、Math.random / Date / timer / performance.now を決定化・no-op 化すること
 * 判定事項:
 *   - Math.random: 決定的シードで同一値列、値域 [0, 1)、互いに異なる、2 回 createContext しても同じ列
 *   - Date.now / new Date() / performance.now はすべて 0 を返す
 *   - setTimeout / setInterval の callback は呼ばれない (timer 実行禁止)
 *   - freezeContextNonDeterminism: 素の vm context に後付けしても Date.now / Math.random が凍結される
 */
import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import {
  freezeContextNonDeterminism,
  nonDeterministicGlobals,
} from "../../../../../src/equivalence-checker/common/sandbox/transforms/non-determinism";

const FROZEN_EPOCH_MS = 0;

function vmContextWithGlobals(): vm.Context {
  return vm.createContext({ ...nonDeterministicGlobals() });
}

describe("nonDeterministicGlobals", () => {
  it("Math.random が同一シードで決定的な値列を返す", () => {
    const firstVals = vm.runInContext("[Math.random(), Math.random(), Math.random()]", vmContextWithGlobals()) as number[];
    const secondVals = vm.runInContext("[Math.random(), Math.random(), Math.random()]", vmContextWithGlobals()) as number[];
    expect(firstVals).toEqual(secondVals);
    expect(new Set(firstVals).size).toBe(3);
    for (const v of firstVals) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("Date.now / new Date() / performance.now が固定値になる", () => {
    const res = vm.runInContext("[Date.now(), new Date().getTime(), performance.now()]", vmContextWithGlobals()) as number[];
    expect(res).toEqual([FROZEN_EPOCH_MS, FROZEN_EPOCH_MS, FROZEN_EPOCH_MS]);
  });

  it("setTimeout / setInterval の本体は実行されない", () => {
    const res = vm.runInContext(
      `
      let touched = false;
      setTimeout(() => { touched = true; }, 0);
      setInterval(() => { touched = true; }, 0);
      touched
      `,
      vmContextWithGlobals(),
    ) as boolean;
    expect(res).toBe(false);
  });
});

describe("freezeContextNonDeterminism", () => {
  function frozenJsdomContext(): vm.Context {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only" });
    const context = dom.getInternalVMContext();
    freezeContextNonDeterminism(context);
    return context;
  }

  it("jsdom の internal VM context に後付けしても Date.now / Math.random が凍結される", () => {
    const a = vm.runInContext("[Date.now(), new Date().getTime(), Math.random(), Math.random()]", frozenJsdomContext()) as number[];
    const b = vm.runInContext("[Date.now(), new Date().getTime(), Math.random(), Math.random()]", frozenJsdomContext()) as number[];
    expect(a[0]).toBe(FROZEN_EPOCH_MS);
    expect(a[1]).toBe(FROZEN_EPOCH_MS);
    expect(a).toEqual(b);
  });
});
