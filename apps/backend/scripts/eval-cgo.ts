#!/usr/bin/env tsx

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const envFile = resolve(__dirname, "../.env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const { REPLAY_CASES, LIVE_DEFAULT_CASES } = await import("../src/services/eval/growth-sim/replay-cases");
  if (process.argv.includes("--list")) {
    for (const c of REPLAY_CASES) console.log(`${c.id.padEnd(34)} ${c.kind.padEnd(9)} ${c.title}`);
    return;
  }
  const which = arg("cases", LIVE_DEFAULT_CASES.join(","));
  const k = Math.max(1, Number(arg("k", "1")));
  const maxUsd = Number(arg("max-usd", "25"));
  if (!Number.isInteger(k)) throw new Error("--k must be a positive integer");
  const ids = which === "all" ? REPLAY_CASES.map((c) => c.id) : which.split(",").map((s) => s.trim());
  const cases = ids.map((id) => {
    const c = REPLAY_CASES.find((x) => x.id === id);
    if (!c) throw new Error(`no replay case "${id}" (see --list)`);
    return c;
  });

  const { cgoProdConfig, cgoSystemPrompt, liveReplayCall } = await import("../src/services/eval/growth-sim/cgo-model");
  const { runReplayCases, replayReport } = await import("../src/services/eval/growth-sim/replay-run");
  const cfg = await cgoProdConfig();
  console.log(`cgo replay: ${cases.length} case(s) x ${k} on ${cfg.model}, ${cfg.tools.length} declared tools, max ${cfg.maxTurns} turns`);

  let spent = 0;
  const results = [];
  for (const c of cases) {
    if (spent >= maxUsd) {
      console.log(`stopping: $${spent.toFixed(2)} spent (>= --max-usd ${maxUsd})`);
      break;
    }
    const [r] = await runReplayCases({
      cases: [c],
      k,
      systemPrompt: cgoSystemPrompt,
      call: liveReplayCall,
      onAttempt: (id, i, a) =>
        console.log(`  ${id} #${i + 1}: ${a.error ? `ERROR ${a.error}` : a.pass ? "pass" : `FAIL ${[...a.judge, ...a.safety].join("; ")}`} ($${a.costUsd.toFixed(3)}, ${a.turns} turns, ${a.outcome.toolCalls.length} tool calls)`),
    });
    spent += r.costUsd;
    results.push(r);
  }
  const report = replayReport(results, k, cfg.model);
  console.log(`\n${report}`);
  const out = arg("out", "");
  if (out) {
    const dir = resolve(out);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.md"), report);
    for (const r of results) writeFileSync(join(dir, `${r.id}.json`), JSON.stringify(r, null, 2));
    console.log(`\nwrote ${dir}`);
  }
  const skipped = cases.length - results.length;
  if (skipped > 0) console.log(`${skipped} case(s) NOT run (spend cap): this run is incomplete`);
  if (skipped > 0 || results.some((r) => !r.pass)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
