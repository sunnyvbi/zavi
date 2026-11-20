
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

const MIGRATION = "20260610194110_agent_run_stream_drafts.sql";
const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/", MIGRATION),
  "utf-8",
);

describe("20260610194110_agent_run_stream_drafts.sql (static)", () => {
  it("creates the agent_run_stream_drafts table", () => {
    expect(sql).toMatch(/create table (if not exists )?agent_run_stream_drafts/i);
  });

  it("run_id is the PK and FK to agent_runs ON DELETE CASCADE", () => {
    expect(sql).toMatch(
      /run_id uuid primary key references agent_runs\(id\) on delete cascade/i,
    );
  });

  it("tenant_id is NOT NULL (the scoping key for the RLS gate)", () => {
    expect(sql).toMatch(/tenant_id uuid not null/i);
  });

  it("carries thread_id, agent_slug, seq bigint, text, status, updated_at", () => {
    expect(sql).toMatch(/thread_id uuid/i);
    expect(sql).toMatch(/agent_slug text not null/i);
    expect(sql).toMatch(/seq bigint not null default 0/i);
    expect(sql).toMatch(/text text not null default ''/i);
    expect(sql).toMatch(/status text not null default 'streaming'/i);
    expect(sql).toMatch(/updated_at timestamptz not null default now\(\)/i);
  });

  it("enables RLS", () => {
    expect(sql).toMatch(
      /alter table agent_run_stream_drafts enable row level security/i,
    );
  });

  it("SELECT policy gates on tenant_users membership via auth.uid() — mirrors thread_event_member_select EXACTLY", () => {
    expect(sql).toMatch(/create policy agent_run_stream_drafts_member_select/i);
    expect(sql).toMatch(/for select using/i);
    const normalized = sql.replace(/\s+/g, " ");
    expect(normalized).toMatch(
      /exists \( select 1 from tenant_users tu where tu\.tenant_id = agent_run_stream_drafts\.tenant_id and tu\.user_id = auth\.uid\(\) \)/i,
    );
  });

  it("has NO insert/update/delete policy (service-role writes only — Codex C8)", () => {
    expect(sql).not.toMatch(
      /create policy[^;]*on agent_run_stream_drafts[^;]*for (insert|update|delete)/i,
    );
    const policyCount = (sql.match(/create policy/gi) ?? []).length;
    expect(policyCount).toBe(1);
  });

  it("adds the table to the supabase_realtime publication", () => {
    expect(sql).toMatch(
      /alter publication supabase_realtime add table public\.agent_run_stream_drafts/i,
    );
  });
});

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_ANON = process.env.SUPABASE_ANON_KEY;
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HAS_SUPABASE = !!(SUPA_URL && SUPA_ANON && SUPA_SERVICE);

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

describe.skipIf(!HAS_SUPABASE)(
  "agent_run_stream_drafts RLS — cross-tenant isolation (runtime)",
  () => {
    let tableExists = true;
    let tenantA = "";
    let tenantB = "";
    let memberAId = "";
    let memberAJwt = "";
    let memberBJwt = "";
    let runAId = "";

    beforeAll(async () => {
      const svc = createClient(SUPA_URL!, SUPA_SERVICE!);

      const probe = await svc
        .from("agent_run_stream_drafts")
        .select("run_id")
        .limit(1);
      if (
        probe.error &&
        /relation .*agent_run_stream_drafts.* does not exist|could not find the table|schema cache/i.test(
          probe.error.message,
        )
      ) {
        tableExists = false;
        return;
      }

      const ts = Date.now();
      const { data: tA } = await svc
        .from("tenants")
        .insert({ slug: `stream-rls-a-${ts}`, display_name: "Stream RLS A" })
        .select("id")
        .single();
      tenantA = (tA as { id: string }).id;
      const { data: tB } = await svc
        .from("tenants")
        .insert({ slug: `stream-rls-b-${ts}`, display_name: "Stream RLS B" })
        .select("id")
        .single();
      tenantB = (tB as { id: string }).id;

      const pw = "stream-rls-PW-1!Aa";
      const memberA = await signUpAndSignIn(
        svc,
        `stream-rls-member-a-${ts}@zavi.test`,
        pw,
      );
      memberAId = memberA.id;
      memberAJwt = memberA.jwt;
      const memberB = await signUpAndSignIn(
        svc,
        `stream-rls-member-b-${ts}@zavi.test`,
        pw,
      );
      memberBJwt = memberB.jwt;

      await svc.from("tenant_users").insert([
        { tenant_id: tenantA, user_id: memberAId, role: "owner" },
        { tenant_id: tenantB, user_id: memberB.id, role: "owner" },
      ]);

      const { data: run } = await svc
        .from("agent_runs")
        .insert({
          tenant_id: tenantA,
          agent_slug: "pm",
          enqueued_by: memberAId,
          trigger: "chat",
          agent_definition_hash: "stream-rls-" + ts,
          status: "running",
        })
        .select("id")
        .single();
      runAId = (run as { id: string }).id;

      const { error: draftErr } = await svc
        .from("agent_run_stream_drafts")
        .insert({
          run_id: runAId,
          tenant_id: tenantA,
          thread_id: null,
          agent_slug: "pm",
          seq: 1,
          text: "partial tokens for tenant A only",
          status: "streaming",
        });
      if (draftErr) throw new Error(`draft insert failed: ${draftErr.message}`);
    }, 120_000);

    afterAll(async () => {
      if (!HAS_SUPABASE || !tableExists) return;
      const svc = createClient(SUPA_URL!, SUPA_SERVICE!);
      if (tenantA) await svc.from("tenants").delete().eq("id", tenantA);
      if (tenantB) await svc.from("tenants").delete().eq("id", tenantB);
    });

    it("THE GATE — a NON-MEMBER (tenant B) selects ZERO rows of tenant A's draft", async () => {
      if (!tableExists) return;
      const c = clientWithJwt(memberBJwt);
      const { data, error } = await c
        .from("agent_run_stream_drafts")
        .select("run_id, text")
        .eq("run_id", runAId);
      expect(error).toBeNull();
      expect(data ?? []).toEqual([]);
    });

    it("a MEMBER of tenant A selects exactly their tenant's draft row (positive control)", async () => {
      if (!tableExists) return;
      const c = clientWithJwt(memberAJwt);
      const { data, error } = await c
        .from("agent_run_stream_drafts")
        .select("run_id, text")
        .eq("run_id", runAId);
      expect(error).toBeNull();
      expect((data ?? []).length).toBe(1);
      expect((data ?? [])[0]?.run_id).toBe(runAId);
    });
  },
);
