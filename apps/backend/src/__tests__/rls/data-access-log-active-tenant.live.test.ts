import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_ANON = process.env.SUPABASE_ANON_KEY;
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PROD_REF = "wmycgyjsenvgtczlupoe";
const SHOULD_RUN = !!(SUPA_URL && SUPA_ANON && SUPA_SERVICE) && !SUPA_URL!.includes(PROD_REF);

describe.skipIf(!SHOULD_RUN)("data_access_log / tenant_db_config: admins of the active tenant only (live)", () => {
  let svc: SupabaseClient;
  const tenants: string[] = [];
  const users: string[] = [];
  let adminJwt = "";
  let memberJwt = "";
  let tenantA = "";
  let tenantB = "";

  async function makeUser(tag: string): Promise<{ id: string; email: string; password: string }> {
    const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.zavi.local`;
    const password = `pw-${Math.random().toString(36).slice(2)}A1!`;
    const { data, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
    users.push(data.user.id);
    return { id: data.user.id, email, password };
  }
  async function signIn(email: string, password: string): Promise<string> {
    const anon = createClient(SUPA_URL!, SUPA_ANON!, { auth: { persistSession: false } });
    const { data, error } = await anon.auth.signInWithPassword({ email, password });
    if (error || !data.session) throw new Error(`signIn failed: ${error?.message}`);
    return data.session.access_token;
  }
  const asUser = (jwt: string) =>
    createClient(SUPA_URL!, SUPA_ANON!, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false } });

  beforeAll(async () => {
    svc = createClient(SUPA_URL!, SUPA_SERVICE!, { auth: { persistSession: false } });
    for (const tag of ["dal-a", "dal-b"]) {
      const { data, error } = await svc.from("tenants").insert({ display_name: tag, kind: "test", slug: `${tag}-${Date.now()}` }).select("id").single();
      if (error || !data) throw new Error(`tenant insert failed: ${error?.message}`);
      tenants.push(data.id as string);
    }
    [tenantA, tenantB] = tenants as [string, string];
    const admin = await makeUser("dal-admin");
    const member = await makeUser("dal-member");
    await svc.from("tenant_users").insert([
      { tenant_id: tenantA, user_id: admin.id, role: "admin" },
      { tenant_id: tenantB, user_id: admin.id, role: "owner" },
      { tenant_id: tenantA, user_id: member.id, role: "member" },
    ]);
    const { error: pErr } = await svc.from("profiles").upsert(
      [admin.id, member.id].map((user_id) => ({ user_id, active_tenant_id: tenantA })),
      { onConflict: "user_id" },
    );
    if (pErr) throw new Error(`profiles upsert failed: ${pErr.message}`);
    for (const t of tenants) {
      await svc.from("tenant_db_config").insert({ tenant_id: t, type: "postgres", schema_map: {} });
      await svc.from("data_access_log").insert({
        tenant_id: t, caller_kind: "agent", mode: "direct", dialect: "postgres", query_text: `SELECT 1 -- ${t}`, result: "allowed",
      });
    }
    adminJwt = await signIn(admin.email, admin.password);
    memberJwt = await signIn(member.email, member.password);
  });

  afterAll(async () => {
    for (const t of tenants) await svc.from("tenants").delete().eq("id", t);
    for (const u of users) await svc.auth.admin.deleteUser(u);
  });

  it("admin of A and B, active in A, sees only A", async () => {
    const c = asUser(adminJwt);
    const log = await c.from("data_access_log").select("tenant_id");
    expect(log.error).toBeNull();
    expect(new Set((log.data ?? []).map((r) => r.tenant_id))).toEqual(new Set([tenantA]));
    const cfg = await c.from("tenant_db_config").select("tenant_id");
    expect(new Set((cfg.data ?? []).map((r) => r.tenant_id))).toEqual(new Set([tenantA]));
    expect(tenantB).not.toBe(tenantA);
  });

  it("a member of A sees zero rows of both", async () => {
    const c = asUser(memberJwt);
    expect((await c.from("data_access_log").select("id")).data ?? []).toHaveLength(0);
    expect((await c.from("tenant_db_config").select("tenant_id")).data ?? []).toHaveLength(0);
  });
});
