#!/usr/bin/env tsx

import { serviceClient } from "../src/services/supabase";

const DOGFOOD_TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

export type MonitorThresholds = {
  minParseRate: number;
  maxSilentNoopRate: number;
  maxToolErrorRate: number;
  rollbackFlaggedRate: number;
};

export const MONITOR_THRESHOLDS: MonitorThresholds = {
  minParseRate: 0.9,
  maxSilentNoopRate: 0.2,
  maxToolErrorRate: 0.2,
  rollbackFlaggedRate: 0.5,
};

export type MonitoredRun = {
  run_id: string;
  status: string;
  parse_ok: boolean | null;
  cost_usd: number;
  latency_ms: number | null;
  decisions: number;
  tools_completed: number;
  tools_errored: number;
};

export type RowClass = {
  run_id: string;
  parsed: boolean;
  tool_errored: boolean;
  silent_noop: boolean;
  flagged: boolean;
};

export function classifyRun(r: MonitoredRun): RowClass {
  const parsed = r.parse_ok === true;
  const tool_errored = r.tools_errored > 0;
  const firedSideEffect = r.decisions > 0 || r.tools_completed > 0;
  const silent_noop = parsed && !firedSideEffect;
  const flagged = !parsed || tool_errored || silent_noop;
  return { run_id: r.run_id, parsed, tool_errored, silent_noop, flagged };
}

export type MonitorVerdict = {
  verdict: "PASS" | "WATCH" | "ROLLBACK";
  total: number;
  parse_rate: number;
  tool_error_rate: number;
  silent_noop_rate: number;
  flagged_rate: number;
  avg_cost_usd: number;
  avg_latency_ms: number | null;
  parse_failed_ids: string[];
  tool_errored_ids: string[];
  silent_noop_ids: string[];
  reasons: string[];
};

export function computeVerdict(
  runs: MonitoredRun[],
  thresholds: MonitorThresholds = MONITOR_THRESHOLDS,
): MonitorVerdict {
  const total = runs.length;
  const classes = runs.map(classifyRun);

  const parseFailed = classes.filter((c) => !c.parsed);
  const toolErrored = classes.filter((c) => c.tool_errored);
  const silentNoop = classes.filter((c) => c.silent_noop);
  const flagged = classes.filter((c) => c.flagged);

  const rate = (n: number) => (total > 0 ? n / total : 0);
  const parse_rate = total > 0 ? (total - parseFailed.length) / total : 0;
  const tool_error_rate = rate(toolErrored.length);
  const silent_noop_rate = rate(silentNoop.length);
  const flagged_rate = rate(flagged.length);

  const avg_cost_usd =
    total > 0 ? runs.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0) / total : 0;
  const lat = runs.map((r) => r.latency_ms).filter((m): m is number => typeof m === "number");
  const avg_latency_ms =
    lat.length > 0 ? Math.round(lat.reduce((s, m) => s + m, 0) / lat.length) : null;

  const reasons: string[] = [];
  if (parse_rate < thresholds.minParseRate)
    reasons.push(
      `parse-rate ${(parse_rate * 100).toFixed(0)}% < ${(thresholds.minParseRate * 100).toFixed(0)}% (${parseFailed.length} unparsed)`,
    );
  if (tool_error_rate > thresholds.maxToolErrorRate)
    reasons.push(
      `tool-error-rate ${(tool_error_rate * 100).toFixed(0)}% > ${(thresholds.maxToolErrorRate * 100).toFixed(0)}% (${toolErrored.length} errored)`,
    );
  if (silent_noop_rate > thresholds.maxSilentNoopRate)
    reasons.push(
      `silent-no-op rate ${(silent_noop_rate * 100).toFixed(0)}% > ${(thresholds.maxSilentNoopRate * 100).toFixed(0)}% (${silentNoop.length} parsed-but-fired-nothing)`,
    );

  let verdict: MonitorVerdict["verdict"];
  if (total === 0) {
    verdict = "WATCH";
    reasons.push("no live runs yet for the flipped pair — nothing to judge.");
  } else if (flagged_rate >= thresholds.rollbackFlaggedRate) {
    verdict = "ROLLBACK";
    reasons.unshift(
      `flagged-rate ${(flagged_rate * 100).toFixed(0)}% >= ${(thresholds.rollbackFlaggedRate * 100).toFixed(0)}% — a majority of post-switch runs misbehaved.`,
    );
  } else if (reasons.length > 0) {
    verdict = "WATCH";
  } else {
    verdict = "PASS";
    reasons.push("all post-switch runs parsed, fired downstream side-effects, no tool errors.");
  }

  return {
    verdict,
    total,
    parse_rate,
    tool_error_rate,
    silent_noop_rate,
    flagged_rate,
    avg_cost_usd,
    avg_latency_ms,
    parse_failed_ids: parseFailed.map((c) => c.run_id),
    tool_errored_ids: toolErrored.map((c) => c.run_id),
    silent_noop_ids: silentNoop.map((c) => c.run_id),
    reasons,
  };
}

export function rollbackHint(tenant_id: string, agent_slug: string): string {
  return [
    "ROLLBACK HINT — undo this flip with either lever:",
    "",
    "  (1) Per-agent revert (clears just this override row → agent default):",
    `      curl -X DELETE https://api.zaviagent.com/api/admin/engine-override \\`,
    `        -H "Authorization: Bearer $STAFF_TOKEN" -H 'Content-Type: application/json' \\`,
    `        -d '{"tenant_id":"${tenant_id}","agent_slug":"${agent_slug}"}'`,
    "",
    "  (2) Fleet-wide master-kill (ignores ALL overrides in one flag flip, no row deletes):",
    `      curl -X POST https://api.zaviagent.com/api/admin/engine-override/master-kill \\`,
    `        -H "Authorization: Bearer $STAFF_TOKEN" -H 'Content-Type: application/json' \\`,
    `        -d '{"provider_overrides_disabled":true}'`,
  ].join("\n");
}

export type MonitorArgs = {
  agent: string;
  tenant: string;
  limit: number;
  provider?: string;
};

export function parseMonitorArgs(argv: string[]): MonitorArgs {
  let agent = "";
  let tenant = DOGFOOD_TENANT;
  let limit = 10;
  let provider: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent") agent = argv[++i] ?? "";
    else if (a === "--tenant") tenant = argv[++i] ?? "";
    else if (a === "--provider") provider = argv[++i] ?? "";
    else if (a === "--limit") {
      const n = Number(argv[++i]);
      limit = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 10;
    }
  }

  agent = agent.trim();
  if (!agent) throw new Error("--agent <slug> is required.");
  tenant = tenant.trim();
  if (!tenant) throw new Error("--tenant <uuid> is required (the flipped tenant).");
  return { agent, tenant, limit, provider };
}

async function readMonitoredRuns(args: MonitorArgs): Promise<MonitoredRun[]> {
  const sb = serviceClient();
  const { data: runRows, error: runErr } = await sb
    .from("agent_runs")
    .select("id, status, parse_ok, cost_usd, started_at, finished_at")
    .eq("tenant_id", args.tenant)
    .eq("agent_slug", args.agent)
    .order("enqueued_at", { ascending: false })
    .limit(args.limit);
  if (runErr) throw new Error(`post-switch-monitor run read failed: ${runErr.message}`);
  const runs = (runRows ?? []) as Array<{
    id: string;
    status: string;
    parse_ok: boolean | null;
    cost_usd: number | null;
    started_at: string | null;
    finished_at: string | null;
  }>;
  if (runs.length === 0) return [];

  const ids = runs.map((r) => r.id);

  const { data: decRows, error: decErr } = await sb
    .from("decisions")
    .select("agent_run_id")
    .eq("tenant_id", args.tenant)
    .in("agent_run_id", ids);
  if (decErr) throw new Error(`post-switch-monitor decisions read failed: ${decErr.message}`);
  const decByRun = new Map<string, number>();
  for (const d of (decRows ?? []) as Array<{ agent_run_id: string | null }>) {
    if (!d.agent_run_id) continue;
    decByRun.set(d.agent_run_id, (decByRun.get(d.agent_run_id) ?? 0) + 1);
  }

  const { data: evRows, error: evErr } = await sb
    .from("agent_run_events")
    .select("agent_run_id, stage")
    .eq("tenant_id", args.tenant)
    .in("agent_run_id", ids)
    .in("stage", ["tool_use_completed", "tool_use_errored"]);
  if (evErr) throw new Error(`post-switch-monitor events read failed: ${evErr.message}`);
  const completedByRun = new Map<string, number>();
  const erroredByRun = new Map<string, number>();
  for (const e of (evRows ?? []) as Array<{ agent_run_id: string; stage: string }>) {
    const m = e.stage === "tool_use_errored" ? erroredByRun : completedByRun;
    m.set(e.agent_run_id, (m.get(e.agent_run_id) ?? 0) + 1);
  }

  return runs.map((r) => {
    const latency_ms =
      r.started_at && r.finished_at
        ? Math.max(0, new Date(r.finished_at).getTime() - new Date(r.started_at).getTime())
        : null;
    return {
      run_id: r.id,
      status: r.status,
      parse_ok: r.parse_ok,
      cost_usd: Number(r.cost_usd) || 0,
      latency_ms,
      decisions: decByRun.get(r.id) ?? 0,
      tools_completed: completedByRun.get(r.id) ?? 0,
      tools_errored: erroredByRun.get(r.id) ?? 0,
    };
  });
}

function emoji(v: MonitorVerdict["verdict"]): string {
  return v === "PASS" ? "✅" : v === "WATCH" ? "⚠️" : "🛑";
}

async function main(): Promise<void> {
  let args: MonitorArgs;
  try {
    args = parseMonitorArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`post-switch-monitor: ${(e as Error).message}`);
    process.exit(2);
    return;
  }

  console.log(
    `post-switch-monitor: inspecting the first ${args.limit} live run(s) of "${args.agent}"` +
      (args.provider ? ` (provider ${args.provider})` : "") +
      ` for tenant ${args.tenant}...`,
  );

  const runs = await readMonitoredRuns(args);
  const v = computeVerdict(runs);

  console.log("\n──────────────────────────────────────────────────────────────");
  console.log(`POST-SWITCH ${v.verdict} ${emoji(v.verdict)} — ${args.agent} @ ${args.tenant}`);
  console.log(`  live runs inspected: ${v.total}`);
  console.log(`  parse-rate:          ${(v.parse_rate * 100).toFixed(0)}%`);
  console.log(`  tool-error-rate:     ${(v.tool_error_rate * 100).toFixed(0)}%`);
  console.log(`  silent-no-op rate:   ${(v.silent_noop_rate * 100).toFixed(0)}%  (parsed but fired nothing)`);
  console.log(`  flagged-rate:        ${(v.flagged_rate * 100).toFixed(0)}%`);
  console.log(`  avg cost:            $${v.avg_cost_usd.toFixed(4)}`);
  console.log(
    `  avg latency:         ${v.avg_latency_ms === null ? "n/a" : `${v.avg_latency_ms} ms`}`,
  );
  if (v.parse_failed_ids.length) console.log(`  parse_failed rows:   ${v.parse_failed_ids.join(", ")}`);
  if (v.tool_errored_ids.length) console.log(`  tool_errored rows:   ${v.tool_errored_ids.join(", ")}`);
  if (v.silent_noop_ids.length) console.log(`  silent_noop rows:    ${v.silent_noop_ids.join(", ")}`);
  console.log("  why:");
  for (const r of v.reasons) console.log(`    - ${r}`);
  console.log("──────────────────────────────────────────────────────────────");

  if (v.verdict !== "PASS") {
    console.log("\n" + rollbackHint(args.tenant, args.agent) + "\n");
  }

  process.exit(v.verdict === "ROLLBACK" ? 1 : 0);
}

if (process.argv[1] && /post-switch-monitor\.(ts|js)$/.test(process.argv[1])) {
  void main();
}
