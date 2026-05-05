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

// pipe (Python subprocess など) では POSIX 上 process.stdout/stderr の write が async で、
// `process.exit()` を直接呼ぶと kernel に渡されていない write が捨てられて末尾の出力が
// truncate される。空 write のコールバックは内部キューが完全に flush された時点で発火
// するので、backpressure の有無に関わらず確実に exit 直前まで待てる。
function waitForFlush(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.writableLength === 0 && !stream.writableNeedDrain) {
      resolve();
      return;
    }
    stream.write("", () => resolve());
  });
}

async function flushStdio(): Promise<void> {
  await Promise.all([waitForFlush(process.stdout), waitForFlush(process.stderr)]);
}

main()
  .then(async (code) => {
    await flushStdio();
    process.exit(code);
  })
  .catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : "unexpected non-Error thrown";
    process.stderr.write(`Fatal: ${message}\n`);
    await flushStdio();
    process.exit(2);
  });
