#!/usr/bin/env node
import { runCheckEquivalence, runCheckEquivalenceBatch } from "./check-equivalence";
import { runPreprocessSelakovic, runPreprocessSelakovicBatch } from "./preprocess-selakovic";
import { runPrune, runPruneBatch } from "./prune";

const SUBCOMMANDS = {
  "check-equivalence": runCheckEquivalence,
  "check-equivalence-batch": runCheckEquivalenceBatch,
  "preprocess-selakovic": runPreprocessSelakovic,
  "preprocess-selakovic-batch": runPreprocessSelakovicBatch,
  prune: runPrune,
  "prune-batch": runPruneBatch,
} as const;

async function main(): Promise<number> {
  const subcommand = process.argv[2];
  if (subcommand === undefined || !(subcommand in SUBCOMMANDS)) {
    const available = Object.keys(SUBCOMMANDS).join(", ");
    process.stderr.write(
      `Usage: mb-analyzer <subcommand>\nAvailable subcommands: ${available}\n` +
        (subcommand !== undefined ? `Unknown subcommand: ${subcommand}\n` : ""),
    );
    return 2;
  }
  const handler = SUBCOMMANDS[subcommand as keyof typeof SUBCOMMANDS];
  return await handler();
}

/**
 * pipe 出力 (Python subprocess 経由など) で大量 stdout (>64KB) を書くとき、
 * `process.exit()` 即座実行だと flush が間に合わず stdout が truncate される。
 * 解決策: `exitCode` だけ設定して Node のイベントループに自然終了させる。
 * stdout/stderr が drain された後で exit する。
 *
 * preprocess-selakovic で 1 issue から 100KB+ の slow/fast を返すケースに対応。
 */
async function waitForFlush(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise<void>((resolve) => {
    if (stream.writableLength === 0) {
      resolve();
      return;
    }
    stream.once("drain", () => resolve());
  });
}

main()
  .then(async (code) => {
    await waitForFlush(process.stdout);
    await waitForFlush(process.stderr);
    process.exit(code);
  })
  .catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : "unexpected non-Error thrown";
    process.stderr.write(`Fatal: ${message}\n`);
    await waitForFlush(process.stderr);
    process.exit(2);
  });
