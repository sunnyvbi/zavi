#!/usr/bin/env tsx

import { readFileSync } from "node:fs";
import { runReplay } from "../src/services/memory/replay";

type Args = {
  tenant: string;
  against: string;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tenant") args.tenant = argv[++i];
    else if (a === "--against") args.against = argv[++i];
    else if (a === "--json") args.json = true;
  }
  if (!args.tenant || !args.against) {
    console.error(
      "usage: brain-eval-replay.ts --tenant <uuid> --against /path.ndjson [--json]",
    );
    process.exit(2);
  }
  return args as Args;
}

function readBaseline(path: string): string {
  if (path === "-") {
    return readFileSync(0, "utf8");
  }
  return readFileSync(path, "utf8");
}

function renderHuman(
  report: Awaited<ReturnType<typeof runReplay>>,
): string {
  const lines: string[] = [];
  lines.push(`brain-eval-replay  tenant=${report.tenant_id}`);
  if (report.captured_at_range)
    lines.push(`  captured: ${report.captured_at_range[0]}  ..  ${report.captured_at_range[1]}`);
  lines.push(
    `  replayed=${report.queries_replayed}  errored=${report.queries_errored}  rejected_cross_tenant=${report.queries_rejected_cross_tenant}`,
  );
  lines.push(`  metric: ${report.metric_name}`);
  lines.push(`  mean_jaccard:        ${report.mean_jaccard.toFixed(3)}`);
  lines.push(`  top1_stability:      ${(report.top1_stability * 100).toFixed(1)}%`);
  lines.push(
    `  latency_delta_ms:    mean=${report.latency_delta_ms_mean}  p50=${report.latency_delta_ms_p50}  p95=${report.latency_delta_ms_p95}`,
  );
  if (report.regressions.length > 0) {
    lines.push("");
    lines.push(`  Top ${Math.min(5, report.regressions.length)} regression(s):`);
    for (const r of report.regressions.slice(0, 5)) {
      const q = r.query.length > 60 ? r.query.slice(0, 57) + "..." : r.query;
      lines.push(
        `    jaccard=${r.jaccard.toFixed(2)}  captured=${r.captured_top}  current=${r.current_top}  "${q}"`,
      );
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ndjson = readBaseline(args.against);
  const report = await runReplay({
    tenant_id: args.tenant,
    baselineNdjson: ndjson,
  });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderHuman(report));
  }
  if (report.queries_replayed === 0) {
    console.error(
      "brain-eval-replay: WARNING no queries replayed — baseline empty or tenant mismatch",
    );
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(`brain-eval-replay FAILED: ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
