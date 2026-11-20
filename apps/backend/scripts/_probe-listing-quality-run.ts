#!/usr/bin/env tsx
import "./_smoke-env";
import { serviceClient } from "../src/services/supabase";

const ALLOWED_META_KEYS = new Set(["tool_name", "ms", "code", "iter"]);

async function main() {
  const run_id = process.argv[2];
  if (!run_id) throw new Error("usage: _probe-listing-quality-run.ts <run_id>");

  const sb = serviceClient();

  const { data: decs, error: de } = await sb
    .from("decisions")
    .select("id, decision_class, status, body")
    .eq("agent_run_id", run_id);
  if (de) throw new Error(`decisions select: ${de.message}`);
  console.log(`decisions for run ${run_id}: ${decs?.length ?? 0}`);
  for (const d of decs ?? []) {
    console.log(`  id=${d.id} class=${d.decision_class} status=${d.status}`);
    const body = (d.body ?? {}) as Record<string, unknown>;
    const keys = Object.keys(body);
    console.log(`  body keys: [${keys.join(", ")}]`);
    const t1 = (body.tier1 as unknown[] | undefined) ?? [];
    const t2 = (body.tier2 as unknown[] | undefined) ?? [];
    const t3 = (body.tier3 as unknown[] | undefined) ?? [];
    const t4 = (body.tier4 as unknown[] | undefined) ?? [];
    const rm = (body.rendered_markdown as string | undefined) ?? "";
    console.log(
      `  tier1=${t1.length} tier2=${t2.length} tier3=${t3.length} tier4=${t4.length} rendered_markdown=${rm.length}c`,
    );
  }

  const { data: evs, error: ee } = await sb
    .from("agent_run_events")
    .select("id, stage, meta")
    .eq("agent_run_id", run_id)
    .order("created_at");
  if (ee) throw new Error(`events select: ${ee.message}`);
  console.log(`\nagent_run_events: ${evs?.length ?? 0}`);
  let offenders = 0;
  for (const e of evs ?? []) {
    const meta = ((e as { meta?: unknown }).meta ?? {}) as Record<string, unknown>;
    const keys = Object.keys(meta);
    const bad = keys.filter((k) => !ALLOWED_META_KEYS.has(k));
    const flag = bad.length ? ` ⚠ OFFENDING: ${bad.join(",")}` : "";
    if (bad.length) offenders++;
    console.log(`  ${(e as { stage?: string }).stage}: [${keys.join(", ")}]${flag}`);
  }
  console.log(`\nmeta whitelist: ${offenders === 0 ? "✅ clean" : `❌ ${offenders} offenders`}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
