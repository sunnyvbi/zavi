#!/usr/bin/env tsx

import "dotenv/config";
import fs from "node:fs";
import { asTenantId, type TenantId } from "@/services/tenant-client";
import {
  enqueueAgentRun,
  getAgentRunById,
} from "../src/services/agents/runner";
import { serviceClient } from "../src/services/supabase";

function arg(name: string, fallback?: string): string {
  const idx = process.argv.findIndex((a) => a === `--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required arg --${name}`);
  }
  return process.argv[idx + 1];
}

async function resolveTenantId(): Promise<string> {
  const direct = arg("tenant-id", "");
  if (direct) return direct;
  const slug = arg("tenant-slug", "upcar");
  const { data, error } = await serviceClient()
    .from("tenants")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new Error(`tenant lookup failed for slug=${slug}: ${error.message}`);
  if (!data) {
    throw new Error(
      `no tenant found with slug=${slug}. Onboard via /onboarding first or pass --tenant-id <UUID>.`,
    );
  }
  return data.id;
}

const POLL_INTERVAL_MS = 5 * 1000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const TERMINAL = new Set(["success", "parse_failed", "dispatch_error"]);

async function pollUntilTerminal(tid: TenantId, run_id: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < POLL_TIMEOUT_MS) {
    const run = await getAgentRunById(tid, run_id);
    if (!run) {
      throw new Error(`run ${run_id} disappeared`);
    }
    if (TERMINAL.has(run.status)) {
      console.log("");
      console.log("══════════════════════════════════════════════════════");
      console.log(`  AGENT RUN`);
      console.log("══════════════════════════════════════════════════════");
      console.log(`  Agent:        ${run.agent_slug}`);
      console.log(`  Tenant:       ${run.tenant_id}`);
      console.log(`  Status:       ${run.status}`);
      console.log(`  Parse OK:     ${run.parse_ok}`);
      console.log(`  Tokens:       ${run.cost_tokens.toLocaleString()}`);
      console.log(`  Cost:         $${run.cost_usd.toFixed(4)}`);
      if (run.started_at && run.finished_at) {
        const dur = (new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000;
        console.log(`  Duration:     ${dur.toFixed(1)}s`);
      }
      console.log("══════════════════════════════════════════════════════");
      if (run.parse_error) console.log(`  Parse error:  ${run.parse_error}`);
      if (run.error) console.log(`  Error:        ${run.error}`);
      console.log(`  Run id: ${run.id}`);
      console.log("");
      if (run.parse_ok && run.output_text) {
        console.log("──── Rendered output ────────────────────────────────");
        console.log(run.output_text);
        console.log("─────────────────────────────────────────────────────");
      }
      return;
    }
    process.stdout.write(`  → status=${run.status}…\r`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`run ${run_id} did not reach terminal status within ${POLL_TIMEOUT_MS / 1000}s`);
}

async function main() {
  const slug = arg("slug");
  const tenant_id = await resolveTenantId();
  const payloadPath = arg("payload", "");

  let payload: unknown = undefined;
  if (payloadPath) {
    if (!fs.existsSync(payloadPath)) {
      console.error(`payload file not found: ${payloadPath}`);
      process.exit(1);
    }
    payload = JSON.parse(fs.readFileSync(payloadPath, "utf-8"));
  }

  console.log(`enqueuing agent ${slug} for tenant ${tenant_id}...`);
  const { run_id } = await enqueueAgentRun({
    agent_slug: slug,
    tenant_id,
    trigger: "manual",
    payload,
  });
  if (!run_id) {
    console.log("(dedupe — no run_id returned. Cron probably already fired this tenant×agent×bucket.)");
    return;
  }
  console.log(`enqueued run_id=${run_id}; polling…`);
  await pollUntilTerminal(asTenantId(tenant_id), run_id);
}

main().catch((e) => {
  console.error("ERROR:", (e as Error).message);
  console.error((e as Error).stack);
  process.exit(1);
});
