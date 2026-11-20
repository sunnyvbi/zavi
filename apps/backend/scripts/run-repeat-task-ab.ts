#!/usr/bin/env tsx
import "dotenv/config";

import { serviceClient } from "@/services/supabase";
import {
  runRepeatTaskAb,
  type RepeatTaskGoldenLite,
} from "@/services/memory/repeat-task-ab";
import {
  makeRepeatTaskAbLiveDeps,
  isRepeatAbRealTenant,
} from "@/services/memory/repeat-task-ab-live";
import {
  AB_ARMS,
  computeGoldenDelta,
  summarizeAbRun,
  type AbArm,
  type AbArmResult,
  type AbGoldenDelta,
} from "@/services/memory/repeat-task-ab-types";

function parseLimit(argv: string[]): number | null {
  const eq = argv.find((a) => a.startsWith("--limit="));
  let raw: string | undefined;
  if (eq) raw = eq.split("=")[1];
  else {
    const i = argv.indexOf("--limit");
    if (i >= 0) raw = argv[i + 1];
    else return null;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--limit must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return n;
}

function fmt(n: number | null): string {
  return n == null ? "—" : n.toFixed(6);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const tenantId = positional[0];
  let limit: number;
  try {
    limit = parseLimit(argv) ?? 50;
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }

  if (!tenantId) {
    console.error(
      "usage: run-repeat-task-ab.ts <tenant_id> [--limit=N | --limit N] [--i-know]",
    );
    process.exit(2);
  }
  if (isRepeatAbRealTenant(tenantId) && !flags.has("--i-know")) {
    console.error(
      `REFUSED: ${tenantId} is a known real customer tenant. This runs REAL (side-effect-disabled)\n` +
        `agent dispatches and can reserve credits. Prefer a throwaway test tenant. To override,\n` +
        `re-run with --i-know (only after confirming the draft_mode post-processor guard is deployed).`,
    );
    process.exit(3);
  }

  const sb = serviceClient();
  const { data: goldens, error } = await sb
    .from("repeat_task_golden")
    .select("id, tenant_id, agent_slug, query")
    .eq("tenant_id", tenantId)
    .eq("active", true)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.error(`failed to load goldens: ${error.message}`);
    process.exit(1);
  }
  if (!goldens || goldens.length === 0) {
    console.log(`No active goldens for tenant ${tenantId}. Seed some first.`);
    return;
  }

  console.log(
    `Running repeat-task A/B for ${goldens.length} golden(s) on tenant ${tenantId}...\n`,
  );
  const deps = makeRepeatTaskAbLiveDeps({ allowRealTenant: flags.has("--i-know") });
  const deltas: AbGoldenDelta[] = [];

  for (const g of goldens) {
    const golden: RepeatTaskGoldenLite = {
      id: g.id as string,
      tenant_id: g.tenant_id as string,
      agent_slug: g.agent_slug as string,
      query: g.query as string,
    };
    const { eval_run_id, outcomes } = await runRepeatTaskAb(golden, deps);

    const rows: AbArmResult[] = AB_ARMS.map((arm: AbArm) => {
      const o = outcomes.find((x) => x.arm === arm);
      if (o && o.ok) return o.row;
      const terminal =
        o && !o.ok
          ? o.kind === "dispatch_error"
            ? "dispatch_error"
            : "metric_write_error"
          : "missing";
      return {
        tenant_id: golden.tenant_id,
        agent_slug: golden.agent_slug,
        golden_id: golden.id,
        eval_run_id,
        arm,
        correctness_score: null,
        model_cost_usd: null,
        retrieval_cost_usd: null,
        judge_cost_usd: null,
        walltime_ms: null,
        terminal_status: terminal,
      };
    });

    const delta = computeGoldenDelta(rows);
    deltas.push(delta);
    const on = rows.find((r) => r.arm === "brain_on");
    const off = rows.find((r) => r.arm === "brain_off");
    console.log(
      `• ${golden.agent_slug} [${golden.id.slice(0, 8)}] on=${on?.terminal_status} off=${off?.terminal_status} ` +
        `cost_on=${fmt(on?.model_cost_usd ?? null)} cost_off=${fmt(off?.model_cost_usd ?? null)} ` +
        `customer_cost_delta=${fmt(delta.customer_cost_delta)} both_finished=${delta.both_arms_finished}`,
    );
  }

  const summary = summarizeAbRun("batch", deltas);
  console.log("\n── Summary ──────────────────────────────────────────────");
  console.log(`goldens run:              ${goldens.length}`);
  console.log(`goldens scored (both ✓):  ${summary.goldens_compared}`);
  console.log(
    `mean correctness delta:   ${summary.mean_correctness_delta == null ? "null (judge lands in P4.3)" : summary.mean_correctness_delta.toFixed(4)}`,
  );
  console.log(`mean customer cost delta: ${fmt(summary.mean_customer_cost_delta)}`);
  console.log(`brain helped / hurt:      ${summary.brain_helped_count} / ${summary.brain_hurt_count}`);
  console.log(
    "\nNote: correctness is null until P4.3's blinded cross-family judge scores the outputs.",
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
