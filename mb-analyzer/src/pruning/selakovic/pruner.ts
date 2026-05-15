import { checkEquivalence } from "../../equivalence-checker";
import type { EquivalenceInput } from "../../contracts/equivalence-contracts";
import type { PruningInput, PruningResult } from "../../contracts/pruning-contracts";

import { prune as prunePure } from "../common/engine";

/**
 * `PruningInput` 由来の等価検証コンテキストを `EquivalenceInput` に乗せ替えて返す。
 *
 * `pruning/common/engine.prune` は `(setup, slow, fast, timeout_ms)` の最小契約で `checkEquivalence` を
 * 呼ぶので、その 4 つは `common/` 側が毎 iteration ごとに渡す。`environment` / `module_base_dir` /
 * `mount_html` は候補ごとに不変なので、ここで closure に閉じ込めて毎回マージする。
 * `common/` はこれらの存在を知らない (= pruning アルゴリズムは dataset 非依存)。
 */
function buildEquivContext(input: PruningInput): Partial<EquivalenceInput> {
  const ctx: Partial<EquivalenceInput> = {};
  if (input.environment !== undefined) ctx.environment = input.environment;
  if (input.module_base_dir !== undefined) ctx.module_base_dir = input.module_base_dir;
  if (input.mount_html !== undefined) ctx.mount_html = input.mount_html;
  return ctx;
}

/**
 * Selakovic dataset 向け pruning エントリ。
 *
 * pruning アルゴリズム本体 (`pruning/common/engine`) に「等価検証の実体」を注入するだけの薄い adapter。
 * 等価検証の実行環境・モジュール解決・oracle routing 等の dataset 固有の事情は本層が `checkEquivalence`
 * への呼び出しに閉じ込め、`common/` は一切知らない (= `equivalence-checker/` を import するのは本層だけ。
 * ESLint `import/no-restricted-paths` で `pruning/common → equivalence-checker` を機械禁止している)。
 */
export function prune(input: PruningInput): Promise<PruningResult> {
  const equivContext = buildEquivContext(input);
  return prunePure(input, {
    checkEquivalence: (args) => checkEquivalence({ ...args, ...equivContext }),
  });
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("buildEquivContext (in-source)", () => {
    it("等価検証コンテキストの 3 フィールドだけを抽出する (slow/fast/setup/timeout_ms/max_iterations は含めない)", () => {
      const ctx = buildEquivContext({
        id: "x",
        slow: "a",
        fast: "b",
        setup: "s",
        timeout_ms: 1000,
        max_iterations: 5,
        environment: "jsdom",
        module_base_dir: "/abs/issue",
        mount_html: "<div></div>",
      });
      expect(ctx).toStrictEqual({
        environment: "jsdom",
        module_base_dir: "/abs/issue",
        mount_html: "<div></div>",
      });
    });

    it("undefined のフィールドはキーごと落とす (= checkEquivalence のデフォルトに委ねる)", () => {
      expect(buildEquivContext({ slow: "a", fast: "b" })).toStrictEqual({});
      expect(buildEquivContext({ slow: "a", fast: "b", environment: "vm" })).toStrictEqual({
        environment: "vm",
      });
    });
  });
}
