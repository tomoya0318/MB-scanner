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
import { tmpdir } from "node:os";

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

  /**
   * Phase 0〜2b の 97 件再走 (`tmp/0006_phase2b-equivalence-checker/verify-97-*.md` /
   * `tmp/0007_equivalence-verdict-conservative-reclassification/final-results.md`) で実際に偽 verdict を
   * 踏んだ / 修正で解消したケースを最小再現で pin する。real vm/jsdom を使うので integration 層に置く。
   */
  describe("tmp 由来の偽 verdict 再発防止", () => {
    it("C-1: 両側が同じ ReferenceError で落ちると inconclusive(both-sides-threw) — 偽 equal にしない", async () => {
      const result = await checkEquivalence({ setup: "", slow: `undefinedVar.foo()`, fast: `undefinedVar.foo()` });
      expect(result.verdict).toBe("inconclusive");
      expect(result.verdict_reason).toBe("both-sides-threw");
    });

    it("C-2: 片方だけ ReferenceError (f1-body 抽出 artefact) は not_equal", async () => {
      const result = await checkEquivalence({ setup: "", slow: `1`, fast: `el.x` });
      expect(result.verdict).toBe("not_equal");
    });

    it("C-3: モジュール解決失敗のメッセージに <lib>_before/after が混じっても両側同じく落ちたと判定する", async () => {
      const result = await checkEquivalence({
        environment: "jsdom",
        module_base_dir: tmpdir(),
        setup: "",
        slow: `require('./fixture_before/does-not-exist.js')`,
        fast: `require('./fixture_after/does-not-exist.js')`,
      });
      expect(result.verdict).toBe("inconclusive");
      expect(result.verdict_reason).toBe("both-sides-threw");
    });

    it("C-4: f1 body の top-level temp 変数が global に漏れても external-observation の profile で吸収して equal (jsdom)", async () => {
      const input = {
        environment: "jsdom" as const,
        setup: `const obj = { a: 1, b: 2, c: 3 };`,
        slow: `var values = []; for (var key in obj) values.push(obj[key]); values`,
        fast: `var keys = Object.keys(obj); var values = new Array(keys.length); for (var i = 0; i < keys.length; i++) values[i] = obj[keys[i]]; values`,
      };
      expect((await checkEquivalence(input)).verdict).toBe("equal");
      // vm 環境では external-observation に profile が渡らないので、漏れた temp 変数の差がそのまま not_equal になる (現仕様)
      expect((await checkEquivalence({ setup: input.setup, slow: input.slow, fast: input.fast })).verdict).toBe(
        "not_equal",
      );
    });

    it("C-7: 初期 mount HTML のまま DOM を触らない body は positive evidence が無く inconclusive(no-positive-evidence)", async () => {
      const result = await checkEquivalence({
        environment: "jsdom",
        mount_html: `<div id="demo1"></div>`,
        setup: "",
        slow: `console.log("noop");`,
        fast: `console.log("noop");`,
      });
      expect(result.verdict).toBe("inconclusive");
      expect(result.verdict_reason).toBe("no-positive-evidence");
    });

    it("C-8: mount_html の #demo* 要素に両側が DOM 書き込みすると dom_mutation=equal で全体 equal", async () => {
      const result = await checkEquivalence({
        environment: "jsdom",
        mount_html: `<div id="demo1"></div>`,
        setup: "",
        slow: `document.getElementById("demo1").innerHTML = "x";`,
        fast: `document.getElementById("demo1").textContent = "x";`,
      });
      expect(result.verdict).toBe("equal");
      expect(result.observations.find((o) => o.oracle === "dom_mutation")?.verdict).toBe("equal");
    });

    it("C-9: cross-realm Error (vm context で生成) のメッセージが exception oracle に正しく載る", async () => {
      const result = await checkEquivalence({ setup: "", slow: `throw new TypeError("boom");`, fast: `42` });
      expect(result.verdict).toBe("not_equal");
      expect(result.observations.find((o) => o.oracle === "exception")?.slow_value).toBe("TypeError: boom");
    });

    it("C-10: setup の const/let が body から見えて argument_mutation の pre/post 観測対象になる", async () => {
      const result = await checkEquivalence({ setup: `const obj = { a: 1 };`, slow: `obj.a = 2;`, fast: `obj.a = 2;` });
      expect(result.verdict).toBe("equal");
      // 観測されている (= obj が tracked) ことが要点。tracked でなければ N/A になる。
      expect(result.observations.find((o) => o.oracle === "argument_mutation")?.verdict).toBe("equal");
    });

    it("C-11: 片側が無限ループで timeout すると exception として捕捉され not_equal", async () => {
      const result = await checkEquivalence({ setup: "", slow: `while (true) {}`, fast: `1`, timeout_ms: 200 });
      expect(result.verdict).toBe("not_equal");
    });

    it("C-12: JSX を含む body は VM eval の SyntaxError として捕捉され not_equal", async () => {
      const result = await checkEquivalence({ setup: "", slow: `<div/>`, fast: `1` });
      expect(result.verdict).toBe("not_equal");
      expect(result.observations.find((o) => o.oracle === "exception")?.slow_value).toContain("SyntaxError");
    });

    it("C-13: workload が中間結果を捨てても C6 (interaction_trace) が slow/fast の差を検出する (angular-10351 の本質; checker のバグではない)", async () => {
      const result = await checkEquivalence({
        environment: "jsdom",
        setup: `var host = __recorder.wrap({ run: function (impl) { return impl(40); } }, "host");`,
        slow: `(function () { host.run(function (n) { return n + 2; }); })()`,
        fast: `(function () { host.run(function () { return undefined; }); })()`,
      });
      expect(result.verdict).toBe("not_equal");
      expect(result.observations.find((o) => o.oracle === "interaction_trace")?.verdict).toBe("not_equal");
    });
  });
});
