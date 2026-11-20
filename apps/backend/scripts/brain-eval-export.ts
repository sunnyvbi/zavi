#!/usr/bin/env tsx

import { createWriteStream } from "node:fs";
import { streamExport } from "../src/services/memory/replay";

type Args = {
  tenant: string;
  since: string;
  out: string;
  toolName?: "search" | "query";
};

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tenant") args.tenant = argv[++i];
    else if (a === "--since") args.since = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--tool") args.toolName = argv[++i] as "search" | "query";
  }
  if (!args.tenant || !args.since || !args.out) {
    console.error(
      "usage: brain-eval-export.ts --tenant <uuid> --since 7d --out /path.ndjson",
    );
    process.exit(2);
  }
  return args as Args;
}

function parseSince(since: string): number {
  const m = since.match(/^(\d+)([dhm])$/);
  if (!m) throw new Error(`bad --since value: ${since} (expected like '7d', '24h', '60m')`);
  const n = parseInt(m[1], 10);
  if (m[2] === "d") return n;
  if (m[2] === "h") return n / 24;
  if (m[2] === "m") return n / 1440;
  throw new Error(`bad --since unit: ${m[2]}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sinceDays = parseSince(args.since);
  const writable =
    args.out === "-"
      ? { write: (line: string) => process.stdout.write(line) }
      : createWriteStream(args.out);
  const result = await streamExport(
    {
      tenant_id: args.tenant,
      since_days: sinceDays,
      tool_name: args.toolName,
    },
    writable,
  );
  console.error(
    `brain-eval-export: wrote ${result.rows_written} rows for tenant ${args.tenant} (since ${args.since})`,
  );
}

main().catch((err) => {
  console.error(`brain-eval-export FAILED: ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
