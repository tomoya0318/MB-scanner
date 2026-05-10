/**
 * `ExecutionCapture` の test data builder。
 * neutral な初期値 (空 arg_snapshots / null exception / undefined return) に overrides を
 * マージして返す。oracle / checker / property テスト全般の共通起点として使う。
 *
 * 配置先: vitest 公式用語 (test.extend が生む値を "fixture" と呼ぶ) に合わせて tests/fixtures/
 * に置く。lifecycle を持つ fixture が増えたら同ディレクトリに共存させる想定。
 * 中身そのものは副作用なしの pure factory であり、`test.extend` 経由ではなく直接 import で使う。
 */
import type { ExceptionCapture, ExecutionCapture } from "../../src/equivalence-checker/common/sandbox/capture/types";

export type { ExceptionCapture, ExecutionCapture };

export function capture(overrides: Partial<ExecutionCapture> = {}): ExecutionCapture {
  return {
    return_value: "undefined",
    return_is_undefined: true,
    arg_snapshots: [],
    exception: null,
    console_log: [],
    new_globals: [],
    timed_out: false,
    ...overrides,
  };
}
