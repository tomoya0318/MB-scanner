#!/usr/bin/env node
import { runCheckEquivalence, runCheckEquivalenceBatch } from "./check-equivalence";
import { runPrune, runPruneBatch } from "./prune";

const SUBCOMMANDS = {
  "check-equivalence": runCheckEquivalence,
  "check-equivalence-batch": runCheckEquivalenceBatch,
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

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : "unexpected non-Error thrown";
    process.stderr.write(`Fatal: ${message}\n`);
    process.exit(2);
  });
