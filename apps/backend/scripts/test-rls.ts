#!/usr/bin/env tsx

import "dotenv/config";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "../src/services/supabase";

const URL = process.env.SUPABASE_URL!;
const ANON = process.env.SUPABASE_ANON_KEY!;

if (!URL || !ANON) {
  console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in env. Did you run `npm run db:start` and populate apps/backend/.env?");
  process.exit(1);
}

const TENANT_A_SLUG = `rls-test-a-${Date.now()}`;
const TENANT_B_SLUG = `rls-test-b-${Date.now()}`;
const USER_A_EMAIL = `rls-test-a-${Date.now()}@praxis.local`;
const USER_B_EMAIL = `rls-test-b-${Date.now()}@praxis.local`;
const PW = "rls-smoke-pass-987";

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

async function signInAs(email: string): Promise<SupabaseClient> {
  const tmp = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await tmp.auth.signInWithPassword({ email, password: PW });
  if (error || !data.session) throw new Error(`signin failed for ${email}: ${error?.message}`);
  return createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
  });
}

async function main(): Promise<void> {
  console.log(`[rls smoke] URL=${URL}`);
  const svc = serviceClient();

  console.log("[setup] creating dev users + tenants");
  const userA = await svc.auth.admin.createUser({ email: USER_A_EMAIL, password: PW, email_confirm: true });
  const userB = await svc.auth.admin.createUser({ email: USER_B_EMAIL, password: PW, email_confirm: true });
  if (userA.error) throw new Error(`createUser A: ${userA.error.message}`);
  if (userB.error) throw new Error(`createUser B: ${userB.error.message}`);
  const userAId = userA.data.user!.id;
  const userBId = userB.data.user!.id;

  const clientA = await signInAs(USER_A_EMAIL);
  const clientB = await signInAs(USER_B_EMAIL);

  const memA = { company: "tenant A company", ops: "A ops", policies: "A pol", disputes: "A disp", support: "A sup" };
  const memB = { company: "tenant B company", ops: "B ops", policies: "B pol", disputes: "B disp", support: "B sup" };
  const { data: aTid, error: aErr } = await clientA.rpc("activate_tenant", {
    p_slug: TENANT_A_SLUG, p_display_name: "Tenant A", p_rar: 1000, p_memory: memA,
  });
  const { data: bTid, error: bErr } = await clientB.rpc("activate_tenant", {
    p_slug: TENANT_B_SLUG, p_display_name: "Tenant B", p_rar: 2000, p_memory: memB,
  });
  assert("activate_tenant succeeds for user A", !aErr && !!aTid, aErr?.message);
  assert("activate_tenant succeeds for user B", !bErr && !!bTid, bErr?.message);
  const tenantAId = aTid as unknown as string;
  const tenantBId = bTid as unknown as string;

  const { data: aMem, error: aMemErr } = await clientA
    .from("memory_note")
    .select("tenant_id, slug, note_type")
    .not("slug", "is", null);
  const { data: bMem, error: bMemErr } = await clientB
    .from("memory_note")
    .select("tenant_id, slug, note_type")
    .not("slug", "is", null);
  assert("user A memory_note anchor SELECT returns rows", !aMemErr && (aMem?.length ?? 0) === 5, `${aMemErr?.message ?? `count=${aMem?.length}`}`);
  assert("user B memory_note anchor SELECT returns rows", !bMemErr && (bMem?.length ?? 0) === 5, `${bMemErr?.message ?? `count=${bMem?.length}`}`);
  assert("user A sees ONLY tenant A's anchor rows", (aMem ?? []).every((r) => r.tenant_id === tenantAId));
  assert("user B sees ONLY tenant B's anchor rows", (bMem ?? []).every((r) => r.tenant_id === tenantBId));
  assert("user A anchors all have note_type='anchor'", (aMem ?? []).every((r) => r.note_type === "anchor"));

  const { data: aTen } = await clientA.from("tenants").select("id,slug");
  const { data: bTen } = await clientB.from("tenants").select("id,slug");
  assert("user A sees only tenants they're a member of", (aTen ?? []).every((t) => t.id === tenantAId));
  assert("user B sees only tenants they're a member of", (bTen ?? []).every((t) => t.id === tenantBId));

  const { error: insErr } = await clientA.from("tenant_users").insert({
    user_id: userAId, tenant_id: tenantBId, role: "owner",
  });
  assert("direct INSERT on tenant_users denied (RLS+grants)", !!insErr);

  const { error: tenInsErr } = await clientA.from("tenants").insert({ slug: "evil", display_name: "Evil" });
  assert("direct INSERT on tenants denied", !!tenInsErr);

  const { data: osData, error: osErr } = await clientA.from("oauth_states").select("*");
  assert(
    "oauth_states invisible to authenticated client (denied or empty)",
    !!osErr || (osData?.length ?? 0) === 0,
  );

  const { data: secData, error: secErr } = await clientA.from("secrets").select("*");
  assert(
    "secrets invisible to authenticated client (denied or empty)",
    !!secErr || (secData?.length ?? 0) === 0,
  );

  const { error: actErr } = await clientA.rpc("set_active_tenant", { p_tenant_id: tenantBId });
  assert("set_active_tenant rejects non-member", !!actErr);

  const { error: actOwnErr } = await clientA.rpc("set_active_tenant", { p_tenant_id: tenantAId });
  assert("set_active_tenant accepts own tenant", !actOwnErr, actOwnErr?.message);

  const memA2 = { ...memA, company: "tenant A company UPDATED" };
  const { data: aTid2, error: aErr2 } = await clientA.rpc("activate_tenant", {
    p_slug: TENANT_A_SLUG, p_display_name: "Tenant A", p_rar: 1000, p_memory: memA2,
  });
  assert("activate_tenant idempotent (same tenant_id)", !aErr2 && aTid2 === tenantAId, `${aErr2?.message ?? `got=${aTid2}, expected=${tenantAId}`}`);

  const { data: runId, error: runErr } = await clientA.rpc("enqueue_agent_run", {
    p_tenant_id: tenantAId, p_agent_slug: "smoke-echo",
    p_agent_hash: "test-hash", p_trigger: "manual",
    p_payload: {}, p_cron_dedupe_key: null,
  });
  assert("enqueue_agent_run accepts own tenant", !runErr && !!runId, runErr?.message);

  const { error: crossErr } = await clientA.rpc("enqueue_agent_run", {
    p_tenant_id: tenantBId, p_agent_slug: "smoke-echo",
    p_agent_hash: "test-hash", p_trigger: "manual",
    p_payload: {}, p_cron_dedupe_key: null,
  });
  assert("enqueue_agent_run rejects non-member tenant", !!crossErr);

  console.log("[cleanup] purging test users + tenants");
  await svc.from("tenants").delete().eq("id", tenantAId);
  await svc.from("tenants").delete().eq("id", tenantBId);
  await svc.auth.admin.deleteUser(userAId);
  await svc.auth.admin.deleteUser(userBId);

  console.log("");
  console.log(`  ${pass} passed · ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("ERROR:", (e as Error).message);
  console.error((e as Error).stack);
  process.exit(1);
});
