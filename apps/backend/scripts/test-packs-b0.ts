#!/usr/bin/env tsx

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "../src/services/supabase";
import {
  compileAllPacks,
  hashPack,
  loadPack,
  readPackFile,
  resolveStablePack,
} from "../src/services/packs/registry";
import { PackFileSchema } from "../src/services/packs/types";
import { activateTenantPack } from "../src/services/packs/activate";

const URL = process.env.SUPABASE_URL!;
const ANON = process.env.SUPABASE_ANON_KEY!;
if (!URL || !ANON) {
  console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in env.");
  process.exit(1);
}

const SEED_PACK_ID = "pack_marketplace_p2p_rental@1.0";
const SEED_PACK_PATH = "apps/backend/data/packs/pack_marketplace_p2p_rental@1.0.json";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? `   (${detail})` : ""}`);
  }
}

async function signInAs(email: string, pw: string): Promise<SupabaseClient> {
  const tmp = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await tmp.auth.signInWithPassword({ email, password: pw });
  if (error || !data.session) throw new Error(`signin failed: ${error?.message}`);
  return createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
  });
}

async function main(): Promise<void> {
  console.log("\nB0 pack-registry smoke\n──────────────────────");

  const packFile = await readPackFile(SEED_PACK_PATH);
  assert("seed pack file validates", packFile.id === SEED_PACK_ID);
  assert("seed pack declares 6 entity_types", Object.keys(packFile.entity_types).length === 6);
  assert(
    "seed pack declares all 4 outcome_class surfaces",
    ["kyc", "email_triage", "support_resolution", "fraud_scoring"].every(
      (k) => packFile.outcome_classes[k] !== undefined,
    ),
  );

  const reordered = JSON.parse(
    JSON.stringify({ ...packFile, description: packFile.description, id: packFile.id }),
  );
  const h1 = hashPack(packFile);
  const h2 = hashPack(reordered);
  assert("hash stable under key reorder", h1 === h2);

  const bad = { ...packFile, id: "BADID" };
  const r = PackFileSchema.safeParse(bad);
  assert("rejects malformed pack id", !r.success);

  const r1 = await compileAllPacks();
  const r2 = await compileAllPacks();
  assert(
    "compileAllPacks: first run inserts/updates",
    r1.some((x) => x.pack_id === SEED_PACK_ID && (x.action === "inserted" || x.action === "updated")) ||
      r1.some((x) => x.pack_id === SEED_PACK_ID && x.action === "unchanged"),
  );
  assert(
    "compileAllPacks: second run is unchanged",
    r2.every((x) => x.action === "unchanged"),
  );

  const sb = serviceClient();
  await sb.from("packs").update({ status: "preview" }).eq("id", SEED_PACK_ID);
  const stableNone = await resolveStablePack("pack_marketplace_p2p_rental");
  assert("resolveStablePack returns null when no stable", stableNone === null);

  await sb.from("packs").update({ status: "stable" }).eq("id", SEED_PACK_ID);
  const stableOne = await resolveStablePack("pack_marketplace_p2p_rental");
  assert("resolveStablePack returns the stable row", stableOne?.id === SEED_PACK_ID);

  const ts = Date.now();
  const userEmail = `b0-test-${ts}@praxis.local`;
  const userPw = "b0-pack-smoke-987";
  const tenantSlug = `b0-${ts}`;

  const { data: userData, error: userErr } = await sb.auth.admin.createUser({
    email: userEmail,
    password: userPw,
    email_confirm: true,
  });
  if (userErr || !userData.user) {
    console.error(`failed to create test user: ${userErr?.message}`);
    process.exit(1);
  }
  const userId = userData.user.id;

  const userClient = await signInAs(userEmail, userPw);
  const { data: tenantId, error: actErr } = await userClient.rpc("activate_tenant", {
    p_slug: tenantSlug,
    p_display_name: `B0 Test ${ts}`,
    p_rar: 3500,
    p_memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
  });
  if (actErr) {
    console.error(`activate_tenant failed: ${actErr.message}`);
    process.exit(1);
  }

  const idemKey = randomUUID();
  const { data: sess } = await userClient.auth.getSession();
  const tok = sess?.session?.access_token!;

  const r3 = await activateTenantPack(tenantId as string, SEED_PACK_ID, {
    accessToken: tok,
    idempotencyKey: idemKey,
  });
  assert("activate_tenant_pack returns content_hash", typeof r3.activated_with_hash === "string" && r3.activated_with_hash.length === 64);

  const r4 = await activateTenantPack(tenantId as string, SEED_PACK_ID, {
    accessToken: tok,
    idempotencyKey: idemKey,
  });
  assert(
    "activate_tenant_pack idempotent on re-fire",
    r3.activated_with_hash === r4.activated_with_hash &&
      r3.tenant_pack_id === r4.tenant_pack_id,
  );

  const { data: tpRows } = await sb
    .from("tenant_packs")
    .select("id, pack_id, activated_with_hash")
    .eq("tenant_id", tenantId);
  assert("tenant_packs has exactly one row after double-activate", (tpRows ?? []).length === 1);

  const retiredId = `${SEED_PACK_ID}-retired-test`;
  await sb.from("packs").insert({
    id: retiredId,
    pack_slug: "pack_retired_test",
    semver: "1.0.0",
    status: "retired",
    display_name: "Retired test",
    description: "",
    supersedes: null,
    content: { ...packFile, id: retiredId, pack_slug: "pack_retired_test" },
    content_hash: "test-hash",
    entity_types: packFile.entity_types,
    outcome_classes: packFile.outcome_classes,
    connector_map: packFile.connector_map,
    seed_skills: [],
    seed_memory: {},
    seed_agent_drafts: [],
  });
  let retiredRejected = false;
  try {
    await activateTenantPack(tenantId as string, retiredId, {
      accessToken: tok,
      idempotencyKey: randomUUID(),
    });
  } catch (e) {
    retiredRejected = /retired/i.test((e as Error).message);
  }
  assert("retired pack activation is rejected", retiredRejected);
  await sb.from("packs").delete().eq("id", retiredId);

  const otherEmail = `b0-other-${ts}@praxis.local`;
  const { data: otherUser } = await sb.auth.admin.createUser({
    email: otherEmail,
    password: userPw,
    email_confirm: true,
  });
  const otherClient = await signInAs(otherEmail, userPw);
  const { data: otherView } = await otherClient
    .from("tenant_packs")
    .select("id")
    .eq("tenant_id", tenantId);
  assert("RLS hides other-tenant tenant_packs", (otherView ?? []).length === 0);

  await sb.from("activation_idempotency").delete().eq("tenant_id", tenantId);
  await sb.from("tenant_packs").delete().eq("tenant_id", tenantId);
  await sb.from("tenant_users").delete().eq("user_id", userId);
  await sb.from("profiles").delete().eq("user_id", userId);
  await sb.from("tenants").delete().eq("id", tenantId);
  await sb.auth.admin.deleteUser(userId);
  if (otherUser?.user) await sb.auth.admin.deleteUser(otherUser.user.id);

  console.log(`\n${pass} pass · ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nB0 smoke crashed:", err);
  process.exit(1);
});
