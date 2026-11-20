#!/usr/bin/env node

import { createClient } from "@supabase/supabase-js";

const COMMIT = process.argv.includes("--commit");
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required (use --env-file=.env)");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

const { data: tenants, error: tErr } = await sb
  .from("tenants")
  .select("id, slug, product_url")
  .eq("kind", "real");
if (tErr) throw new Error(`tenant read failed: ${tErr.message}`);
const byId = new Map(tenants.map((t) => [t.id, t]));

const { data: intents, error: iErr } = await sb
  .from("tenant_app_setting")
  .select("tenant_id")
  .eq("key", "build_app_intent");
if (iErr) throw new Error(`build_app_intent read failed: ${iErr.message}`);
const buildFlow = new Set(intents.map((r) => r.tenant_id));

const { data: hosting, error: hErr } = await sb
  .from("tenant_resources")
  .select("tenant_id, external_ref, status")
  .eq("resource_kind", "hosting")
  .eq("status", "ready");
if (hErr) throw new Error(`tenant_resources read failed: ${hErr.message}`);

let wrote = 0;
let skippedNotBuildFlow = 0;
let skippedHasUrl = 0;
let skippedNoUrl = 0;
let failed = 0;

console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} — ${hosting.length} tenants with hosting=ready\n`);

for (const row of hosting) {
  const t = byId.get(row.tenant_id);
  if (!t) continue;

  if (!buildFlow.has(t.id)) {
    console.log(`  SKIP  ${t.slug.padEnd(34)} not a build-flow tenant — its product is not the app we built`);
    skippedNotBuildFlow++;
    continue;
  }

  const appUrl = row.external_ref?.url;
  if (typeof appUrl !== "string" || !appUrl.startsWith("https://")) {
    skippedNoUrl++;
    continue;
  }

  if (t.product_url && Object.keys(t.product_url).length > 0) {
    console.log(`  skip  ${t.slug.padEnd(34)} already has product_url`);
    skippedHasUrl++;
    continue;
  }

  if (!COMMIT) {
    console.log(`  WOULD ${t.slug.padEnd(34)} -> ${appUrl}`);
    wrote++;
    continue;
  }

  const { error } = await sb.rpc("set_tenant_product_url_system", {
    p_tenant_id: t.id,
    p_product_url: { marketing: appUrl },
  });
  if (error) {
    console.log(`  FAIL  ${t.slug.padEnd(34)} ${error.message}`);
    failed++;
    continue;
  }
  console.log(`  wrote ${t.slug.padEnd(34)} -> ${appUrl}`);
  wrote++;
}

console.log(
  `\n${COMMIT ? "wrote" : "would write"} ${wrote} · skipped ${skippedNotBuildFlow} (not build-flow) · ` +
    `${skippedHasUrl} (already set) · ${skippedNoUrl} (no url on a ready row) · ${failed} failed`,
);
if (!COMMIT) console.log("\nDry run. Re-run with --commit to write.");
