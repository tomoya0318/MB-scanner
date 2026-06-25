/**
 * 条件抽出 spike — Pattern #1 (for..in (+任意 hasOwnProperty ガード) → Object.keys)。
 *
 * 仮説: 同じ before/after に対し setup を代表値ごとに差し替えて checkEquivalence を叩けば、
 * 等価性が壊れた軸 = 適用条件が観測できる。
 *
 * step B (検証実行) の最小実装。実装(before)の防御度 × 入力(setup の代表値)を差し替え、
 * EMIC が条件発現を観測できるか / 実コードの防御的実装で条件が消えるかを対比で示す。
 *
 * 設計: tmp/0001_condition-extraction-spike/plan.md
 * 雛形: tests/integration/selakovic-2016.test.ts:17-36 (Underscore #1222)
 */
import { describe, expect, it } from "vitest";

import { checkEquivalence } from "../../src/equivalence-checker/selakovic/checker";

// 変更後 (固定): Object.keys 経由で値を集める
const AFTER = `(() => {
  const keys = Object.keys(target);
  const values = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) values[i] = target[keys[i]];
  return values;
})()`;

// fragile arm: ガード無し bare for..in (継承 enumerable が漏れる)
const BEFORE_FRAGILE = `(() => {
  const values = [];
  for (const key in target) values.push(target[key]);
  return values;
})()`;

// robust arm: native 捕捉ガード (= 実 _.values の _.has 相当)
const BEFORE_ROBUST = `(() => {
  const has = Object.prototype.hasOwnProperty;
  const values = [];
  for (const key in target) if (has.call(target, key)) values.push(target[key]);
  return values;
})()`;

// 代表値 (setup で target を定義 = 入力の差し替え)
const REP_CLEAN = `var target = { a: 1, b: 2, c: 3 };`;
const REP_P = `var target = Object.create({ x: 9 }); target.a = 1;`; // P軸: 継承 enumerable x

const run = (setup: string, before: string) =>
  checkEquivalence({ setup, before, after: AFTER, environment: "vm" });

describe("条件抽出 spike — Pattern #1 (for..in → Object.keys)", () => {
  it("P軸 / fragile(bare for..in): not_equal = EMIC は条件発現を観測できる", async () => {
    const r = await run(REP_P, BEFORE_FRAGILE);
    console.log("[fragile+P]", r.verdict, JSON.stringify(r.observations));
    expect(r.verdict).toBe("not_equal");
  });

  it("P軸 / robust(native 捕捉ガード): equal = 防御的実装が条件を消す", async () => {
    const r = await run(REP_P, BEFORE_ROBUST);
    console.log("[robust+P]", r.verdict, JSON.stringify(r.observations));
    expect(r.verdict).toBe("equal");
  });

  it("baseline / clean: 両 arm とも equal", async () => {
    expect((await run(REP_CLEAN, BEFORE_FRAGILE)).verdict).toBe("equal");
    expect((await run(REP_CLEAN, BEFORE_ROBUST)).verdict).toBe("equal");
  });
});
