#!/usr/bin/env tsx
import "./_smoke-env";
import { enqueueAgentRun } from "../src/services/agents/runner";
import { serviceClient } from "../src/services/supabase";

const TENANT_SLUG = "upcar";
const AGENT_SLUG = "listing-quality";

async function resolveTenantId(slug: string): Promise<string> {
  const { data, error } = await serviceClient()
    .from("tenants")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new Error(`tenant lookup: ${error.message}`);
  if (!data) throw new Error(`no tenant slug=${slug}`);
  return (data as { id: string }).id;
}

async function setKillSwitch(tenant_id: string, on: boolean): Promise<void> {
  const sb = serviceClient();
  if (on) {
    const { error } = await sb
      .from("tenant_agent_kill_switch")
      .upsert({ tenant_id, agent_slug: AGENT_SLUG }, { onConflict: "tenant_id,agent_slug" });
    if (error) throw new Error(`kill switch upsert: ${error.message}`);
  } else {
    const { error } = await sb
      .from("tenant_agent_kill_switch")
      .delete()
      .eq("tenant_id", tenant_id)
      .eq("agent_slug", AGENT_SLUG);
    if (error) throw new Error(`kill switch delete: ${error.message}`);
  }
}

async function tryEnqueue(tenant_id: string): Promise<{ ok: boolean; error?: string; run_id?: string }> {
  try {
    const r = await enqueueAgentRun({
      tenant_id,
      agent_slug: AGENT_SLUG,
      trigger: "a2a",
      payload: { source: "kill-switch-probe" },
    });
    return { ok: true, run_id: r.run_id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function main() {
  const tenant_id = await resolveTenantId(TENANT_SLUG);
  console.log(`tenant=${TENANT_SLUG}(${tenant_id}) agent=${AGENT_SLUG}\n`);

  await setKillSwitch(tenant_id, false);

  console.log(`[phase1] kill switch ON`);
  await setKillSwitch(tenant_id, true);
  const r1 = await tryEnqueue(tenant_id);
  if (r1.ok) {
    console.log(`  ❌ enqueue succeeded with kill switch ON (run_id=${r1.run_id})`);
  } else {
    console.log(`  ✅ enqueue blocked: ${r1.error}`);
  }

  console.log(`\n[phase2] kill switch OFF`);
  await setKillSwitch(tenant_id, false);
  const r2 = await tryEnqueue(tenant_id);
  if (r2.ok) {
    console.log(`  ✅ enqueue succeeded (run_id=${r2.run_id})`);
    if (r2.run_id) {
      const sb = serviceClient();
      await sb
        .from("agent_runs")
        .update({ status: "failed", error: "probe-only enqueue; not executed" })
        .eq("id", r2.run_id);
      console.log(`  (marked run_id=${r2.run_id} failed to prevent stuck-scan revival)`);
    }
  } else {
    console.log(`  ❌ enqueue failed with kill switch OFF: ${r2.error}`);
  }

  const pass = !r1.ok && r2.ok;
  console.log(`\n${pass ? "✅ kill switch PASS" : "❌ kill switch FAIL"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
