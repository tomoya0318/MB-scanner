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
// closed/destroyed や同期 throw で callback が永遠に来ないケースも想定し、error/close と
// try/catch でフォールバック resolve してプロセスがハングしないようにする。
function waitForFlush(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.writableLength === 0 && !stream.writableNeedDrain) {
      resolve();
      return;
    }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    stream.once("error", finish);
    stream.once("close", finish);
    try {
      const accepted = stream.write("", () => finish());
      // write が false かつ closed 済みなら drain も来ないので即 resolve
      if (!accepted && stream.destroyed) finish();
    } catch {
      finish();
    }
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
