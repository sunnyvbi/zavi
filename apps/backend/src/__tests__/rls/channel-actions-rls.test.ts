import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_ANON = process.env.SUPABASE_ANON_KEY;
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
const HAS_ALL = !!(SUPA_URL && SUPA_ANON && SUPA_SERVICE && DB_URL);
const PROD_PROJECT_HOST = "wmycgyjsenvgtczlupoe.supabase.co";
const IS_PROD =
  (!!SUPA_URL && SUPA_URL.includes(PROD_PROJECT_HOST)) ||
  (!!DB_URL && DB_URL.includes(PROD_PROJECT_HOST));
const SHOULD_RUN = HAS_ALL && !IS_PROD;

if (process.env.REQUIRE_RLS_MATRIX === "1" && !SHOULD_RUN) {
  throw new Error(
    `[channel-actions-rls] REQUIRE_RLS_MATRIX=1 but the suite would skip (HAS_ALL=${HAS_ALL}, IS_PROD=${IS_PROD}).`,
  );
}

const svc = (): SupabaseClient =>
  createClient(SUPA_URL!, SUPA_SERVICE!, { auth: { persistSession: false, autoRefreshToken: false } });
const asUser = (jwt: string): SupabaseClient =>
  createClient(SUPA_URL!, SUPA_ANON!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });

async function member(sb: SupabaseClient, email: string, tenantId: string): Promise<{ id: string; jwt: string }> {
  const pw = "chan-actions-PW-12345!Aa";
  const { data, error } = await sb.auth.admin.createUser({
    email,
    password: pw,
    email_confirm: true,
    app_metadata: { active_tenant_id: tenantId },
  });
  if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message}`);
  const { error: tuErr } = await sb.from("tenant_users").insert({ tenant_id: tenantId, user_id: data.user.id, role: "owner" });
  if (tuErr) throw new Error(`tenant_users: ${tuErr.message}`);
  const { data: s, error: sErr } = await createClient(SUPA_URL!, SUPA_ANON!).auth.signInWithPassword({ email, password: pw });
  if (sErr || !s.session) throw new Error(`signIn ${email}: ${sErr?.message}`);
  return { id: data.user.id, jwt: s.session.access_token };
}

describe.skipIf(!SHOULD_RUN)("channel actions: RLS matrix + status machine (live)", () => {
  let tenantA = "";
  let tenantB = "";
  let jwtA = "";
  let jwtB = "";
  let userA = "";
  let runA = "";
  let actionA1 = "";
  let actionA2 = "";

  beforeAll(async () => {
    const sb = svc();
    const ts = Date.now();
    const tA = await sb.from("tenants").insert({ slug: `chact-a-${ts}`, display_name: "CA A" }).select("id").single();
    const tB = await sb.from("tenants").insert({ slug: `chact-b-${ts}`, display_name: "CA B" }).select("id").single();
    if (tA.error || tB.error) throw new Error(`tenants: ${tA.error?.message ?? tB.error?.message}`);
    tenantA = tA.data!.id;
    tenantB = tB.data!.id;
    const a = await member(sb, `chact-a-${ts}@zavi.test`, tenantA);
    const b = await member(sb, `chact-b-${ts}@zavi.test`, tenantB);
    jwtA = a.jwt;
    jwtB = b.jwt;
    userA = a.id;

    const run = await sb
      .from("agent_runs")
      .insert({
        tenant_id: tenantA,
        agent_slug: "google_ads",
        trigger: "channel_recipe",
        agent_definition_hash: `chact-${ts}`,
        status: "success",
        channel_slug: "google_ads",
        payload: { recipe_body: "r" },
      })
      .select("id")
      .single();
    if (run.error) throw new Error(`agent_runs: ${run.error.message}`);
    runA = run.data!.id;

    const rec = await sb.rpc("record_channel_run_actions", {
      p_tenant_id: tenantA,
      p_run_id: runA,
      p_actions: [
        { position: 1, run_of: 2, blocking: true, action_type: "fix", title: "Enable tag", title_key: "enable tag", body: {} },
        { position: 2, run_of: 2, action_type: "pause_ad", title: "Pause campaign", title_key: "pause campaign", body: {} },
      ],
      p_metrics: [{ key: "spend_7d", value: 1410, source: "t", grounded: true }],
      p_stale: [],
    });
    if (rec.error) throw new Error(`record: ${rec.error.message}`);
    const ids = (rec.data as { ids: Array<{ position: number; id: string }> }).ids;
    actionA1 = ids.find((r) => r.position === 1)!.id;
    actionA2 = ids.find((r) => r.position === 2)!.id;
  }, 120_000);

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const sb = svc();
    if (tenantA) await sb.from("tenants").delete().eq("id", tenantA);
    if (tenantB) await sb.from("tenants").delete().eq("id", tenantB);
  });

  it.each(["channel_actions", "channel_action_events", "channel_metrics", "channel_runs"])(
    "%s: tenant B's JWT reads zero of tenant A's rows; A's own JWT reads them",
    async (rel) => {
      const b = await asUser(jwtB).from(rel).select("tenant_id").eq("tenant_id", tenantA);
      expect(b.error ? [] : b.data).toEqual([]);
      const a = await asUser(jwtA).from(rel).select("tenant_id").eq("tenant_id", tenantA);
      expect(a.error, a.error?.message).toBeNull();
      expect((a.data ?? []).length).toBeGreaterThan(0);
    },
  );

  it("an authenticated JWT cannot call the write RPCs directly", async () => {
    for (const [fn, args] of [
      ["set_channel_action", { p_tenant_id: tenantA, p_action_id: actionA1, p_status: "acted", p_note: null, p_snoozed_until: null, p_event_key: "direct-0001" }],
      ["record_channel_run_actions", { p_tenant_id: tenantA, p_run_id: runA, p_actions: [], p_metrics: [], p_stale: [] }],
      ["mark_channel_action_redone", { p_tenant_id: tenantA, p_old_action_id: actionA1, p_new_action_id: actionA2, p_note: null }],
      ["record_channel_exec_action", { p_tenant_id: tenantA, p_run_id: runA, p_action: {} }],
      ["approve_channel_action", { p_tenant_id: tenantA, p_action_id: actionA1, p_event_key: "direct-0002", p_actor_user_id: userA, p_source: null }],
      ["claim_channel_action_exec", { p_action_id: actionA1 }],
      ["settle_channel_action_exec", { p_tenant_id: tenantA, p_action_id: actionA1, p_ok: true, p_result: {}, p_error: null }],
    ] as const) {
      const r = await asUser(jwtA).rpc(fn, args as never);
      expect(r.error, `${fn} must be refused to authenticated`).not.toBeNull();
    }
  });

  it("an authenticated JWT cannot write the tables directly", async () => {
    const u = await asUser(jwtA).from("channel_actions").update({ status: "acted" }).eq("id", actionA1).select("id");
    expect(u.error ? [] : u.data).toEqual([]);
    const row = await svc().from("channel_actions").select("status").eq("id", actionA1).single();
    expect(row.data?.status).toBe("pending");
  });

  it("set_channel_action refuses another tenant's id (reads as not_found)", async () => {
    const r = await svc().rpc("set_channel_action", {
      p_tenant_id: tenantB,
      p_action_id: actionA1,
      p_status: "acted",
      p_note: null,
      p_snoozed_until: null,
      p_event_key: "xt-00000001",
    });
    expect(r.data).toMatchObject({ ok: false, code: "not_found" });
    const redo = await svc().rpc("mark_channel_action_redone", {
      p_tenant_id: tenantB,
      p_old_action_id: actionA1,
      p_new_action_id: actionA2,
      p_note: null,
    });
    expect(redo.data).toMatchObject({ ok: false, code: "not_found" });
  });

  it("PR 2: the exec RPCs refuse another tenant's action (money path)", async () => {
    const approve = await svc().rpc("approve_channel_action", {
      p_tenant_id: tenantB,
      p_action_id: actionA1,
      p_event_key: "cross-approve-1",
      p_actor_user_id: userA,
      p_source: null,
    });
    expect(approve.data).toMatchObject({ ok: false, code: "not_found" });

    const settle = await svc().rpc("settle_channel_action_exec", {
      p_tenant_id: tenantB,
      p_action_id: actionA1,
      p_ok: true,
      p_result: {},
      p_error: null,
    });
    expect(settle.data).toMatchObject({ ok: false, code: "not_found" });

    const rec = await svc().rpc("record_channel_exec_action", {
      p_tenant_id: tenantB,
      p_run_id: runA,
      p_action: {
        exec_class: "google_ads.update_campaign_budget",
        action_type: "update_ad",
        title: "cross-tenant",
        body: {},
        exec_payload: {},
      },
    });
    expect(rec.error, "a cross-tenant exec write must raise").not.toBeNull();
  });

  it("PR 2: nothing reaches 'queued' without an approve, and a claim needs 'queued'", async () => {
    const before = await svc().rpc("claim_channel_action_exec", { p_action_id: actionA1 });
    expect(before.data).toMatchObject({ ok: false, code: "not_queued" });

    const notExec = await svc().rpc("approve_channel_action", {
      p_tenant_id: tenantA,
      p_action_id: actionA1,
      p_event_key: "approve-not-exec-1",
      p_actor_user_id: userA,
      p_source: null,
    });
    expect(notExec.data).toMatchObject({ ok: false, code: "not_executable" });
    const row = await svc().from("channel_actions").select("exec_status").eq("id", actionA1).single();
    expect(row.data?.exec_status).toBeNull();
  });

  it("#8 a replayed event_key is a no-op; a terminal action refuses further moves", async () => {
    const call = (status: string, key: string) =>
      svc().rpc("set_channel_action", {
        p_tenant_id: tenantA,
        p_action_id: actionA2,
        p_status: status,
        p_note: "not for us",
        p_snoozed_until: null,
        p_event_key: key,
        p_actor_user_id: userA,
      });
    expect((await call("rejected", "req-reject-1")).data).toMatchObject({ ok: true, status: "rejected", replayed: false });
    expect((await call("rejected", "req-reject-1")).data).toMatchObject({ ok: true, replayed: true });
    expect((await call("acted", "req-acted-1")).data).toMatchObject({ ok: false, code: "illegal_transition", from: "rejected" });
    const ev = await svc().from("channel_action_events").select("event").eq("action_id", actionA2).eq("event", "rejected");
    expect(ev.data).toHaveLength(1);
  });

  it("#8 nothing moves an action whose execution is queued or dispatching", async () => {
    for (const st of ["queued", "dispatching"]) {
      const up = await svc().from("channel_actions").update({ exec_status: st }).eq("id", actionA1);
      expect(up.error, up.error?.message).toBeNull();
      const r = await svc().rpc("set_channel_action", {
        p_tenant_id: tenantA, p_action_id: actionA1, p_status: "rejected", p_note: null,
        p_snoozed_until: null, p_event_key: `req-inflight-${st}`,
      });
      expect(r.data).toMatchObject({ ok: false, code: "exec_in_flight", exec_status: st });
    }
    await svc().from("channel_actions").update({ exec_status: null }).eq("id", actionA1);
    const row = await svc().from("channel_actions").select("status").eq("id", actionA1).single();
    expect(row.data?.status).toBe("pending");
  });

  it("#8 snooze needs a future date; status outside the machine is refused", async () => {
    const r1 = await svc().rpc("set_channel_action", {
      p_tenant_id: tenantA, p_action_id: actionA1, p_status: "snoozed", p_note: null, p_snoozed_until: null, p_event_key: "req-snooze-1",
    });
    expect(r1.data).toMatchObject({ ok: false, code: "snooze_until_required" });
    const r2 = await svc().rpc("set_channel_action", {
      p_tenant_id: tenantA, p_action_id: actionA1, p_status: "redone", p_note: null, p_snoozed_until: null, p_event_key: "req-bad-1",
    });
    expect(r2.data).toMatchObject({ ok: false, code: "invalid_status" });
  });
});
