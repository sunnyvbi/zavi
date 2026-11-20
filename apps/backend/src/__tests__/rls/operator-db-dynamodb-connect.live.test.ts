import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_ANON = process.env.SUPABASE_ANON_KEY;
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PROD_REF = "wmycgyjsenvgtczlupoe";
const SHOULD_RUN = !!(SUPA_URL && SUPA_ANON && SUPA_SERVICE) && !SUPA_URL!.includes(PROD_REF);

describe.skipIf(!SHOULD_RUN)("set_operator_db_connection accepts dynamodb (live)", () => {
  let svc: SupabaseClient;
  let tenantId = "";
  let userId = "";
  let jwt = "";

  beforeAll(async () => {
    svc = createClient(SUPA_URL!, SUPA_SERVICE!, { auth: { persistSession: false } });
    const email = `dyn-${Date.now()}@test.zavi.local`;
    const password = `pw-${Math.random().toString(36).slice(2)}A1!`;
    const { data: created, error: cErr } = await svc.auth.admin.createUser({ email, password, email_confirm: true });
    if (cErr || !created.user) throw new Error(`createUser failed: ${cErr?.message}`);
    userId = created.user.id;
    const { data: t, error: tErr } = await svc
      .from("tenants")
      .insert({ display_name: "dyn-live", kind: "test", slug: `dyn-live-${Date.now()}` })
      .select("id")
      .single();
    if (tErr || !t) throw new Error(`tenant insert failed: ${tErr?.message}`);
    tenantId = t.id as string;
    const { error: mErr } = await svc.from("tenant_users").insert({ tenant_id: tenantId, user_id: userId, role: "owner" });
    if (mErr) throw new Error(`tenant_users insert failed: ${mErr.message}`);
    await svc.from("profiles").upsert({ user_id: userId, active_tenant_id: tenantId }, { onConflict: "user_id" });
    const anon = createClient(SUPA_URL!, SUPA_ANON!, { auth: { persistSession: false } });
    const { data: sess, error: sErr } = await anon.auth.signInWithPassword({ email, password });
    if (sErr || !sess.session) throw new Error(`signIn failed: ${sErr?.message}`);
    jwt = sess.session.access_token;
  });

  afterAll(async () => {
    if (tenantId) await svc.from("tenants").delete().eq("id", tenantId);
    if (userId) await svc.auth.admin.deleteUser(userId);
  });

  it("stores type dynamodb", async () => {
    const asUser = createClient(SUPA_URL!, SUPA_ANON!, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false },
    });
    const { error } = await asUser.rpc("set_operator_db_connection", {
      p_tenant_id: tenantId,
      p_type: "dynamodb",
      p_connection_string: "dynamodb://us-west-1?table=live",
      p_schema_map: {},
    });
    expect(error).toBeNull();
    const { data } = await svc.from("tenant_db_config").select("type").eq("tenant_id", tenantId).single();
    expect(data?.type).toBe("dynamodb");
  });
});
