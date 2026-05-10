/**
 * Selakovic & Pradel 2016 データセットから narrowing 抽出した transformation を
 * 実際に checkEquivalence に通し、Description.md の ground truth と突合する。
 *
 * 上流: data/selakovic-2016-issues/Description.md
 * 設計: ai-guide/datasets/selakovic-2016-issues.md
 *
 * 注意: 従来研究は意味論的等価性を検証していないため、実際には差分入力で diverge する
 * ケース (例: EJS #136b の out-of-range, Angular #4359 の負数) を含む。
 */
import { describe, expect, it } from "vitest";
import { checkEquivalence } from "../../src/equivalence-checker/selakovic/checker";

describe("Selakovic 2016 integration", () => {
  describe("Underscore #1222 — for-in+hasOwnProperty → Object.keys+for-loop", () => {
    // Description.md:59 / https://github.com/jashkenas/underscore/issues/1222
    it("plain object で equal", async () => {
      const result = await checkEquivalence({
        setup: `const obj = { a: 1, b: 2, c: 3 };`,
        slow: `(() => {
          const values = [];
          for (const key in obj) if (Object.prototype.hasOwnProperty.call(obj, key)) values.push(obj[key]);
          return values;
        })()`,
        fast: `(() => {
          const keys = Object.keys(obj);
          const values = new Array(keys.length);
          for (let i = 0, l = keys.length; i < l; i++) values[i] = obj[keys[i]];
          return values;
        })()`,
      });
      expect(result.verdict).toBe("equal");
    });
  });

  describe("EJS #136b — str.substr(i, 1) → str[i]", () => {
    // Description.md:75 — 従来研究は等価と見なしたが out-of-range で挙動が分かれる
    it("in-range index は equal", async () => {
      const result = await checkEquivalence({
        setup: `const str = "abc"; const i = 1;`,
        slow: `str.substr(i, 1)`,
        fast: `str[i]`,
      });
      expect(result.verdict).toBe("equal");
    });

    it("out-of-range index は not_equal ('' vs undefined) — 従来研究の反例", async () => {
      const result = await checkEquivalence({
        setup: `const str = "abc"; const i = 10;`,
        slow: `str.substr(i, 1)`,
        fast: `str[i]`,
      });
      expect(result.verdict).toBe("not_equal");
    });
  });

  describe("Underscore #572 — Array.concat → push.apply (flatten shallow)", () => {
    // Description.md:56 / https://github.com/jashkenas/underscore/issues/572
    it("ネスト配列 shallow flatten で equal", async () => {
      const result = await checkEquivalence({
        setup: `const arr = [[1, 2], [3], [4, 5]];`,
        slow: `(() => {
          let memo = [];
          for (const v of arr) memo = memo.concat(v);
          return memo;
        })()`,
        fast: `(() => {
          const flat = [];
          for (const v of arr) Array.prototype.push.apply(flat, v);
          return flat;
        })()`,
      });
      expect(result.verdict).toBe("equal");
    });
  });

  describe("Chalk #28 — Array.prototype.reduce → explicit for loop", () => {
    // Description.md:92 / chalk_before/index.js vs chalk_after/index.js
    it("ANSI スタイル累積で equal", async () => {
      const result = await checkEquivalence({
        setup: `
          const styles = [
            { open: "\\u001b[1m", close: "\\u001b[22m" },
            { open: "\\u001b[31m", close: "\\u001b[39m" },
          ];
          const input = "hello";
        `,
        slow: `styles.reduce((str, s) => s.open + str + s.close, input)`,
        fast: `(() => {
          let str = input;
          for (let i = 0; i < styles.length; i++) {
            str = styles[i].open + str + styles[i].close;
          }
          return str;
        })()`,
      });
      expect(result.verdict).toBe("equal");
    });
  });

  describe("Angular #4359 — x % 2 → x & 1", () => {
    // Description.md:15 / https://github.com/angular/angular.js/issues/4359
    // checker.test.ts にも単体ケースあり。ここでは境界条件を明示的に pin する。
    it("非負数では equal", async () => {
      const result = await checkEquivalence({
        setup: `const x = 7;`,
        slow: `x % 2`,
        fast: `x & 1`,
      });
      expect(result.verdict).toBe("equal");
    });

    it("負数では not_equal — 従来研究の反例", async () => {
      const result = await checkEquivalence({
        setup: `const x = -3;`,
        slow: `x % 2`,
        fast: `x & 1`,
      });
      expect(result.verdict).toBe("not_equal");
    });
  });
});
