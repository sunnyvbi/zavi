
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_ANON = process.env.SUPABASE_ANON_KEY;
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HAS_SUPABASE = !!(SUPA_URL && SUPA_ANON && SUPA_SERVICE);

let tenantA = "";
let tenantB = "";
let ownerAId = "";
let adminAId = "";
let memberAId = "";
let ownerAJwt = "";
let adminAJwt = "";
let memberAJwt = "";
let ownerBId = "";
let ownerBJwt = "";

let runOwnerAManualQaId = "";
let runMemberAManualQaId = "";
let runMemberAManualPmId = "";
let runSystemQaId = "";
let runSystemPmId = "";
let runAdminAManualQaId = "";
let runTenantBOwnerId = "";
let memberBId = "";

let decisionOnOwnerRunId = "";
let decisionOnSystemRunId = "";
let decisionOnSystemPmRunId = "";
let eventOnOwnerRunId = "";
let eventOnSystemRunId = "";

function clientWithJwt(jwt: string): SupabaseClient {
  return createClient(SUPA_URL!, SUPA_ANON!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
}

async function signUpAndSignIn(
  svc: SupabaseClient,
  email: string,
  password: string,
): Promise<{ id: string; jwt: string }> {
  const { data: created, error: cErr } = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (cErr || !created.user) {
    throw new Error(`createUser ${email} failed: ${cErr?.message}`);
  }
  const anon = createClient(SUPA_URL!, SUPA_ANON!);
  const { data: sess, error: sErr } = await anon.auth.signInWithPassword({
    email,
    password,
  });
  if (sErr || !sess.session) {
    throw new Error(`signIn ${email} failed: ${sErr?.message}`);
  }
  return { id: created.user.id, jwt: sess.session.access_token };
}

async function insertAgentRun(
  svc: SupabaseClient,
  args: {
    tenant_id: string;
    agent_slug: string;
    enqueued_by: string | null;
    trigger: string;
  },
): Promise<string> {
  const { data, error } = await svc
    .from("agent_runs")
    .insert({
      tenant_id: args.tenant_id,
      agent_slug: args.agent_slug,
      enqueued_by: args.enqueued_by,
      trigger: args.trigger,
      agent_definition_hash: "test-hash-" + Math.random().toString(36).slice(2, 10),
      status: "completed",
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`agent_runs insert failed: ${error?.message}`);
  }
  return data.id as string;
}

async function insertDecision(
  svc: SupabaseClient,
  args: { tenant_id: string; agent_run_id: string },
): Promise<string> {
  const { data, error } = await svc
    .from("decisions")
    .insert({
      tenant_id: args.tenant_id,
      agent_run_id: args.agent_run_id,
      decision_class: "test_decision",
      body: { note: "members-rls cross-member fixture" },
      status: "proposed",
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`decisions insert failed: ${error?.message}`);
  }
  return data.id as string;
}

async function insertRunEvent(
  svc: SupabaseClient,
  args: { tenant_id: string; agent_run_id: string },
): Promise<void> {
  const { error } = await svc.from("agent_run_events").insert({
    tenant_id: args.tenant_id,
    agent_run_id: args.agent_run_id,
    stage: "enqueued",
    meta: {},
  });
  if (error) {
    throw new Error(`agent_run_events insert failed: ${error.message}`);
  }
}

describe.skipIf(!HAS_SUPABASE)(
  "20260518000001 tenant_members RLS — owner/admin/member visibility",
  () => {
    beforeAll(async () => {
      const svc = createClient(SUPA_URL!, SUPA_SERVICE!);

      const ts = Date.now();
      const slugA = `members-rls-a-${ts}`;
      const slugB = `members-rls-b-${ts}`;

      const { data: tA, error: tAErr } = await svc
        .from("tenants")
        .insert({ slug: slugA, display_name: "Members RLS A" })
        .select("id")
        .single();
      if (tAErr || !tA) throw new Error(`tenant A: ${tAErr?.message}`);
      tenantA = tA.id;

      const { data: tB, error: tBErr } = await svc
        .from("tenants")
        .insert({ slug: slugB, display_name: "Members RLS B" })
        .select("id")
        .single();
      if (tBErr || !tB) throw new Error(`tenant B: ${tBErr?.message}`);
      tenantB = tB.id;

      const pw = "members-rls-PW-12345!Aa";

      const ownerA = await signUpAndSignIn(
        svc,
        `members-rls-owner-a-${ts}@zavi.test`,
        pw,
      );
      ownerAId = ownerA.id;
      ownerAJwt = ownerA.jwt;

      const adminA = await signUpAndSignIn(
        svc,
        `members-rls-admin-a-${ts}@zavi.test`,
        pw,
      );
      adminAId = adminA.id;
      adminAJwt = adminA.jwt;

      const memberA = await signUpAndSignIn(
        svc,
        `members-rls-member-a-${ts}@zavi.test`,
        pw,
      );
      memberAId = memberA.id;
      memberAJwt = memberA.jwt;

      const ownerB = await signUpAndSignIn(
        svc,
        `members-rls-owner-b-${ts}@zavi.test`,
        pw,
      );
      ownerBId = ownerB.id;
      ownerBJwt = ownerB.jwt;

      const memberB = await signUpAndSignIn(
        svc,
        `members-rls-member-b-${ts}@zavi.test`,
        pw,
      );
      memberBId = memberB.id;

      const { error: tuErr } = await svc.from("tenant_users").insert([
        { tenant_id: tenantA, user_id: ownerAId, role: "owner" },
        { tenant_id: tenantA, user_id: adminAId, role: "admin" },
        { tenant_id: tenantA, user_id: memberAId, role: "member" },
        { tenant_id: tenantB, user_id: ownerBId, role: "owner" },
        { tenant_id: tenantB, user_id: memberBId, role: "member" },
      ]);
      if (tuErr) throw new Error(`tenant_users seed: ${tuErr.message}`);

      const { error: maErr } = await svc.from("tenant_member_agents").insert([
        {
          tenant_id: tenantA,
          user_id: memberAId,
          agent_slug: "qa",
          added_by: ownerAId,
        },
        {
          tenant_id: tenantB,
          user_id: memberBId,
          agent_slug: "qa",
          added_by: ownerBId,
        },
      ]);
      if (maErr) throw new Error(`tenant_member_agents seed: ${maErr.message}`);

      runOwnerAManualQaId = await insertAgentRun(svc, {
        tenant_id: tenantA,
        agent_slug: "qa",
        enqueued_by: ownerAId,
        trigger: "manual",
      });
      runMemberAManualQaId = await insertAgentRun(svc, {
        tenant_id: tenantA,
        agent_slug: "qa",
        enqueued_by: memberAId,
        trigger: "manual",
      });
      runMemberAManualPmId = await insertAgentRun(svc, {
        tenant_id: tenantA,
        agent_slug: "pm",
        enqueued_by: memberAId,
        trigger: "manual",
      });
      runSystemQaId = await insertAgentRun(svc, {
        tenant_id: tenantA,
        agent_slug: "qa",
        enqueued_by: null,
        trigger: "scheduled",
      });
      runSystemPmId = await insertAgentRun(svc, {
        tenant_id: tenantA,
        agent_slug: "pm",
        enqueued_by: null,
        trigger: "scheduled",
      });
      runAdminAManualQaId = await insertAgentRun(svc, {
        tenant_id: tenantA,
        agent_slug: "qa",
        enqueued_by: adminAId,
        trigger: "manual",
      });
      runTenantBOwnerId = await insertAgentRun(svc, {
        tenant_id: tenantB,
        agent_slug: "qa",
        enqueued_by: ownerBId,
        trigger: "manual",
      });

      decisionOnOwnerRunId = await insertDecision(svc, {
        tenant_id: tenantA,
        agent_run_id: runOwnerAManualQaId,
      });
      decisionOnSystemRunId = await insertDecision(svc, {
        tenant_id: tenantA,
        agent_run_id: runSystemQaId,
      });
      decisionOnSystemPmRunId = await insertDecision(svc, {
        tenant_id: tenantA,
        agent_run_id: runSystemPmId,
      });
      eventOnOwnerRunId = runOwnerAManualQaId;
      await insertRunEvent(svc, {
        tenant_id: tenantA,
        agent_run_id: runOwnerAManualQaId,
      });
      eventOnSystemRunId = runSystemQaId;
      await insertRunEvent(svc, {
        tenant_id: tenantA,
        agent_run_id: runSystemQaId,
      });
    }, 120_000);

    afterAll(async () => {
      if (!HAS_SUPABASE) return;
      const svc = createClient(SUPA_URL!, SUPA_SERVICE!);
      if (tenantA) await svc.from("tenants").delete().eq("id", tenantA);
      if (tenantB) await svc.from("tenants").delete().eq("id", tenantB);
      for (const id of [
        ownerAId,
        adminAId,
        memberAId,
        ownerBId,
        memberBId,
      ]) {
        if (id) {
          await svc.auth.admin.deleteUser(id).catch(() => undefined);
        }
      }
    });

    describe("owner/admin baseline", () => {
      it("owner sees every agent_run in their tenant", async () => {
        const c = clientWithJwt(ownerAJwt);
        const { data, error } = await c
          .from("agent_runs")
          .select("id")
          .eq("tenant_id", tenantA);
        expect(error).toBeNull();
        const ids = (data ?? []).map((r) => r.id as string);
        for (const id of [
          runOwnerAManualQaId,
          runMemberAManualQaId,
          runMemberAManualPmId,
          runSystemQaId,
          runSystemPmId,
          runAdminAManualQaId,
        ]) {
          expect(ids).toContain(id);
        }
      });

      it("admin sees every agent_run in their tenant", async () => {
        const c = clientWithJwt(adminAJwt);
        const { data, error } = await c
          .from("agent_runs")
          .select("id")
          .eq("tenant_id", tenantA);
        expect(error).toBeNull();
        const ids = (data ?? []).map((r) => r.id as string);
        for (const id of [
          runOwnerAManualQaId,
          runMemberAManualQaId,
          runMemberAManualPmId,
          runSystemQaId,
          runSystemPmId,
          runAdminAManualQaId,
        ]) {
          expect(ids).toContain(id);
        }
      });
    });

    describe("member allowlist + enqueued_by visibility", () => {
      it("member with qa sees their own qa manual run", async () => {
        const c = clientWithJwt(memberAJwt);
        const { data } = await c
          .from("agent_runs")
          .select("id")
          .eq("id", runMemberAManualQaId);
        expect((data ?? []).length).toBe(1);
      });

      it("member with qa sees system qa runs (enqueued_by IS NULL)", async () => {
        const c = clientWithJwt(memberAJwt);
        const { data } = await c
          .from("agent_runs")
          .select("id")
          .eq("id", runSystemQaId);
        expect((data ?? []).length).toBe(1);
      });

      it("member with qa does NOT see other members' manual qa runs", async () => {
        const c = clientWithJwt(memberAJwt);
        const { data: ownerHidden } = await c
          .from("agent_runs")
          .select("id")
          .eq("id", runOwnerAManualQaId);
        expect((ownerHidden ?? []).length).toBe(0);
        const { data: adminHidden } = await c
          .from("agent_runs")
          .select("id")
          .eq("id", runAdminAManualQaId);
        expect((adminHidden ?? []).length).toBe(0);
      });

      it("member without pm sees ZERO pm runs (even system runs)", async () => {
        const c = clientWithJwt(memberAJwt);
        const { data: systemPm } = await c
          .from("agent_runs")
          .select("id")
          .eq("id", runSystemPmId);
        expect((systemPm ?? []).length).toBe(0);
        const { data: ownPm } = await c
          .from("agent_runs")
          .select("id")
          .eq("id", runMemberAManualPmId);
        expect((ownPm ?? []).length).toBe(0);
      });
    });

    describe("cross-tenant guard", () => {
      it("member from tenant A cannot SELECT anything from tenant B", async () => {
        const c = clientWithJwt(memberAJwt);
        const { data } = await c
          .from("agent_runs")
          .select("id")
          .eq("tenant_id", tenantB);
        expect(data).toEqual([]);
      });

      it("owner of tenant A cannot SELECT tenant B's agent_runs", async () => {
        const c = clientWithJwt(ownerAJwt);
        const { data } = await c
          .from("agent_runs")
          .select("id")
          .eq("id", runTenantBOwnerId);
        expect(data).toEqual([]);
      });
    });

    describe("cross-member decision visibility", () => {
      it("owner sees every decision in their tenant", async () => {
        const c = clientWithJwt(ownerAJwt);
        const { data, error } = await c
          .from("decisions")
          .select("id")
          .eq("tenant_id", tenantA);
        expect(error).toBeNull();
        const ids = (data ?? []).map((r) => r.id as string);
        for (const id of [
          decisionOnOwnerRunId,
          decisionOnSystemRunId,
          decisionOnSystemPmRunId,
        ]) {
          expect(ids).toContain(id);
        }
      });

      it("member with qa sees the decision on a SYSTEM qa run", async () => {
        const c = clientWithJwt(memberAJwt);
        const { data } = await c
          .from("decisions")
          .select("id")
          .eq("id", decisionOnSystemRunId);
        expect((data ?? []).length).toBe(1);
      });

      it("member does NOT see the decision on ANOTHER member's run (owner-enqueued)", async () => {
        const c = clientWithJwt(memberAJwt);
        const { data } = await c
          .from("decisions")
          .select("id")
          .eq("id", decisionOnOwnerRunId);
        expect((data ?? []).length).toBe(0);
      });

      it("member without pm does NOT see the decision on a system pm run", async () => {
        const c = clientWithJwt(memberAJwt);
        const { data } = await c
          .from("decisions")
          .select("id")
          .eq("id", decisionOnSystemPmRunId);
        expect((data ?? []).length).toBe(0);
      });

      it("member from tenant A cannot SELECT any decisions from tenant B", async () => {
        const c = clientWithJwt(memberAJwt);
        const { data } = await c
          .from("decisions")
          .select("id")
          .eq("tenant_id", tenantB);
        expect(data).toEqual([]);
      });
    });

    describe("cross-member run-event visibility", () => {
      it("member with qa sees events on a SYSTEM qa run", async () => {
        const c = clientWithJwt(memberAJwt);
        const { data } = await c
          .from("agent_run_events")
          .select("id")
          .eq("agent_run_id", eventOnSystemRunId);
        expect((data ?? []).length).toBeGreaterThan(0);
      });

      it("member does NOT see events on ANOTHER member's run (owner-enqueued)", async () => {
        const c = clientWithJwt(memberAJwt);
        const { data } = await c
          .from("agent_run_events")
          .select("id")
          .eq("agent_run_id", eventOnOwnerRunId);
        expect((data ?? []).length).toBe(0);
      });
    });

    describe("soft-revoke", () => {
      it("after soft-revoke, owner still sees the revoked member's past runs", async () => {
        const svc = createClient(SUPA_URL!, SUPA_SERVICE!);

        const ts = Date.now();
        const tempPw = "revoke-PW-1!Aa";
        const temp = await signUpAndSignIn(
          svc,
          `members-rls-tmp-${ts}@zavi.test`,
          tempPw,
        );
        await svc.from("tenant_users").insert({
          tenant_id: tenantA,
          user_id: temp.id,
          role: "member",
        });
        await svc.from("tenant_member_agents").insert({
          tenant_id: tenantA,
          user_id: temp.id,
          agent_slug: "qa",
          added_by: ownerAId,
        });
        const tempRunId = await insertAgentRun(svc, {
          tenant_id: tenantA,
          agent_slug: "qa",
          enqueued_by: temp.id,
          trigger: "manual",
        });

        await svc
          .from("tenant_users")
          .delete()
          .eq("tenant_id", tenantA)
          .eq("user_id", temp.id);

        const ownerC = clientWithJwt(ownerAJwt);
        const { data: ownerSees } = await ownerC
          .from("agent_runs")
          .select("id")
          .eq("id", tempRunId);
        expect((ownerSees ?? []).length).toBe(1);

        const revokedC = clientWithJwt(temp.jwt);
        const { data: revokedTu } = await revokedC
          .from("tenant_users")
          .select("user_id")
          .eq("tenant_id", tenantA);
        expect(revokedTu ?? []).toEqual([]);

        await svc.auth.admin.deleteUser(temp.id).catch(() => undefined);
      });
    });

    describe("F6 regression — single-tenant owner equivalence", () => {
      it("owner of a tenant where they are the only member sees own runs + system runs", async () => {
        const svc = createClient(SUPA_URL!, SUPA_SERVICE!);
        const ts = Date.now();
        const { data: tSolo } = await svc
          .from("tenants")
          .insert({
            slug: `members-rls-solo-${ts}`,
            display_name: "Solo Tenant",
          })
          .select("id")
          .single();
        const soloTenantId = (tSolo as { id: string }).id;
        const solo = await signUpAndSignIn(
          svc,
          `members-rls-solo-${ts}@zavi.test`,
          "solo-PW-1!Aa",
        );
        await svc.from("tenant_users").insert({
          tenant_id: soloTenantId,
          user_id: solo.id,
          role: "owner",
        });

        const ownRunId = await insertAgentRun(svc, {
          tenant_id: soloTenantId,
          agent_slug: "qa",
          enqueued_by: solo.id,
          trigger: "manual",
        });
        const sysRunId = await insertAgentRun(svc, {
          tenant_id: soloTenantId,
          agent_slug: "qa",
          enqueued_by: null,
          trigger: "scheduled",
        });

        const c = clientWithJwt(solo.jwt);
        const { data } = await c
          .from("agent_runs")
          .select("id")
          .eq("tenant_id", soloTenantId);
        const ids = (data ?? []).map((r) => r.id as string);
        expect(ids).toContain(ownRunId);
        expect(ids).toContain(sysRunId);

        await svc.from("tenants").delete().eq("id", soloTenantId);
        await svc.auth.admin.deleteUser(solo.id).catch(() => undefined);
      });
    });

    describe("Brain write-gate (F5/Q3)", () => {
      it("member calling memory_note_upsert raises 42501", async () => {
        const c = clientWithJwt(memberAJwt);
        const { error } = await c.rpc("memory_note_upsert", {
          p_tenant_id: tenantA,
          p_slug: "test-slug-" + Date.now(),
          p_title: "test",
          p_body_markdown: "test body",
        });
        expect(error).not.toBeNull();
        const code = (error as { code?: string } | null)?.code ?? "";
        const message = (error as { message?: string } | null)?.message ?? "";
        const hint =
          (error as { hint?: string; details?: string } | null)?.hint ??
          (error as { details?: string } | null)?.details ??
          "";
        const blob = `${code} ${message} ${hint}`.toLowerCase();
        expect(blob).toMatch(/42501|forbidden|cannot write|not.*admin/);
      });
    });

    describe("Admin role asymmetry (F5/Q4)", () => {
      it("admin can call invite_member with role='admin' (peer invite allowed)", async () => {
        const c = clientWithJwt(adminAJwt);
        const ts = Date.now();
        const peerEmail = `members-rls-peer-${ts}@zavi.test`;
        const { error } = await c.rpc("invite_member", {
          p_email: peerEmail,
          p_role: "admin",
          p_agent_slugs: [],
        });
        if (error) {
          const code = (error as { code?: string }).code ?? "";
          const message = (error as { message?: string }).message ?? "";
          expect(`${code} ${message}`.toLowerCase()).not.toMatch(/42501/);
        }
      });

      it("admin calling promote_member_to_admin fails 42501 (owner-only)", async () => {
        const c = clientWithJwt(adminAJwt);
        const { error } = await c.rpc("promote_member_to_admin", {
          p_user_id: memberAId,
        });
        expect(error).not.toBeNull();
        const blob = JSON.stringify(error ?? {}).toLowerCase();
        expect(blob).toMatch(/42501|forbidden|owner/);
      });

      it("admin cannot revoke another admin (revoke_member raises 42501)", async () => {
        const c = clientWithJwt(adminAJwt);
        const { error } = await c.rpc("revoke_member", {
          p_user_id: ownerAId,
        });
        expect(error).not.toBeNull();
        const blob = JSON.stringify(error ?? {}).toLowerCase();
        expect(blob).toMatch(/42501|forbidden|owner|cannot/);
      });
    });

    describe("owner cannot be revoked or demoted", () => {
      it("owner calling revoke_member on THEMSELVES fails (no self-leave for owner)", async () => {
        const c = clientWithJwt(ownerAJwt);
        const { error } = await c.rpc("revoke_member", {
          p_user_id: ownerAId,
        });
        expect(error).not.toBeNull();
        const blob = JSON.stringify(error ?? {}).toLowerCase();
        expect(blob).toMatch(/42501|forbidden|owner|cannot|transfer/);
      });

      it("owner is still the owner after the failed revoke (invariant holds)", async () => {
        const svc = createClient(SUPA_URL!, SUPA_SERVICE!);
        const { data } = await svc
          .from("tenant_users")
          .select("role")
          .eq("tenant_id", tenantA)
          .eq("user_id", ownerAId)
          .maybeSingle();
        expect((data as { role?: string } | null)?.role).toBe("owner");
      });

      it("demote_admin_to_member on the OWNER fails (owner is not an admin to demote)", async () => {
        const c = clientWithJwt(ownerAJwt);
        const { error } = await c.rpc("demote_admin_to_member", {
          p_user_id: ownerAId,
          p_agent_slugs: [],
        });
        expect(error).not.toBeNull();
        const blob = JSON.stringify(error ?? {}).toLowerCase();
        expect(blob).toMatch(/42501|forbidden|owner|cannot|not.*admin/);
      });
    });

    describe("member cannot call admin-gated settings/membership RPCs", () => {
      it("member calling set_member_agents raises 42501", async () => {
        const c = clientWithJwt(memberAJwt);
        const { error } = await c.rpc("set_member_agents", {
          p_user_id: memberAId,
          p_agent_slugs: ["pm"],
        });
        expect(error).not.toBeNull();
        const blob = JSON.stringify(error ?? {}).toLowerCase();
        expect(blob).toMatch(/42501|forbidden|owner|admin|cannot/);
      });

      it("member calling revoke_member raises 42501", async () => {
        const c = clientWithJwt(memberAJwt);
        const { error } = await c.rpc("revoke_member", {
          p_user_id: adminAId,
        });
        expect(error).not.toBeNull();
        const blob = JSON.stringify(error ?? {}).toLowerCase();
        expect(blob).toMatch(/42501|forbidden|owner|admin|cannot/);
      });

      it("member calling set_tenant_sandbox_keepalive raises 42501", async () => {
        const c = clientWithJwt(memberAJwt);
        const { error } = await c.rpc("set_tenant_sandbox_keepalive", {
          p_tenant_id: tenantA,
          p_enabled: true,
        });
        expect(error).not.toBeNull();
        const blob = JSON.stringify(error ?? {}).toLowerCase();
        expect(blob).toMatch(/42501|forbidden|owner|admin|cannot|not.*member/);
      });

      it("member calling update_tenant_notification_settings raises 42501", async () => {
        const c = clientWithJwt(memberAJwt);
        const { error } = await c.rpc("update_tenant_notification_settings", {
          p_notification_email: "x@x.test",
          p_timezone: "America/Los_Angeles",
          p_digest_frequency: "daily",
        });
        expect(error).not.toBeNull();
        const blob = JSON.stringify(error ?? {}).toLowerCase();
        expect(blob).toMatch(/42501|forbidden|owner|admin|cannot|not.*member/);
      });
    });

    describe("invite_member email normalization (F5/F2)", () => {
      it("'Bob@x.com' then 'bob@x.com' target the SAME open-invite row (UPSERT not INSERT)", async () => {
        const c = clientWithJwt(ownerAJwt);
        const ts = Date.now();
        const mixed = `Members-RLS-Bob-${ts}@PRAXIS.test`;
        const lower = mixed.toLowerCase();

        const first = await c.rpc("invite_member", {
          p_email: mixed,
          p_role: "member",
          p_agent_slugs: ["qa"],
        });
        if (first.error) {
          throw new Error(
            `first invite failed unexpectedly: ${first.error.message}`,
          );
        }

        const second = await c.rpc("invite_member", {
          p_email: lower,
          p_role: "member",
          p_agent_slugs: ["qa"],
        });
        if (second.error) {
          const code = (second.error as { code?: string }).code ?? "";
          expect(code === "23505" || code === "P0001").toBe(true);
        }

        const svc = createClient(SUPA_URL!, SUPA_SERVICE!);
        const { data: openRows } = await svc
          .from("tenant_member_invites")
          .select("id, email")
          .eq("tenant_id", tenantA)
          .is("accepted_at", null)
          .is("revoked_at", null);
        const matching = (openRows ?? []).filter(
          (r) =>
            ((r as { email: string }).email ?? "").toLowerCase() === lower,
        );
        expect(matching.length).toBe(1);
      });
    });
  },
);
