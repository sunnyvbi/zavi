import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Request, Response } from "express";

type Db = {
  exec: (q: string) => Promise<unknown>;
  query: <R = Record<string, any>>(q: string, p?: unknown[]) => Promise<{ rows: R[] }>;
  close: () => Promise<void>;
};
const modules = process.env.SITES_SQL_TEST_MODULES;
const DIR = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(DIR, f), "utf8").replace(/^(begin|commit);$/gm, "");

const TA = "00000000-0000-4000-8000-00000000ab01";
const TB = "00000000-0000-4000-8000-00000000ab02";
const USER_WEB = "00000000-0000-4000-8000-0000000000c1";
const CHANNEL = "email_marketing";
const ESTIMATE = 460;

const h = vi.hoisted(() => ({
  db: null as Db | null,
  enqueueCalls: 0,
  seq: 0,
  failSettle: false,
}));

async function call(fn: string, args: Record<string, unknown>, tenantId: string) {
  if (fn === "settle_channel_run_claim" && h.failSettle) throw new Error("network down");
  const names = Object.keys(args);
  const sql = `select public.${fn}(${["p_tenant_id => $1", ...names.map((k, i) => `${k} => $${i + 2}`)].join(", ")}) as r`;
  try {
    const { rows } = await h.db!.query<{ r: unknown }>(sql, [tenantId, ...names.map((k) => args[k])]);
    return { data: rows[0]?.r ?? null, error: null };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { data: null, error: { code: err.code, message: err.message ?? "error" } };
  }
}

function emptyChain(): any {
  const p: any = new Proxy(function () {}, {
    get: (_t, k) => (k === "then" ? (r: (v: unknown) => void) => r({ data: [], error: null }) : () => p),
    apply: () => p,
  });
  return p;
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => emptyChain(),
  tenantRpc: (tenantId: string, fn: string, args: Record<string, unknown>) => call(fn, args, tenantId),
}));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async (req: Request) => ({
    tenant_id: req.headers["x-tenant"] as string,
    user_id: req.headers["x-user"] as string,
  }),
}));
vi.mock("@/services/agents/runner", () => {
  class InsufficientCreditsError extends Error {}
  return {
    InsufficientCreditsError,
    enqueueAgentRun: async (input: { agent_slug: string; tenant_id: string; trigger: string; payload: Record<string, unknown> }) => {
      h.enqueueCalls++;
      const id = `30000000-0000-4000-8000-${String(++h.seq).padStart(12, "0")}`;
      await h.db!.query(
        "insert into agent_runs (id, tenant_id, agent_slug, trigger, status, reserved, payload) values ($1, $2, $3, $4, 'queued', $5, $6)",
        [id, input.tenant_id, input.agent_slug, input.trigger, ESTIMATE, JSON.stringify(input.payload)],
      );
      return { run_id: id };
    },
  };
});
vi.mock("@/services/agents/credits", () => ({ reserveEstimateFor: () => ESTIMATE }));
vi.mock("@/services/channels/lock", () => ({
  isChannelLocked: async () => false,
  comingSoonMessage: (n: string) => `${n} is coming soon.`,
}));
vi.mock("@/services/channels/context", () => ({ defaultChannelContext: async () => null }));
vi.mock("@/services/billing/tiers", () => ({ asPlanUpgradeRequired: () => null }));
vi.mock("@/services/agents/refusal", () => ({ refusalFor: () => ({ code: "credits", message: "out" }) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/analytics/action-events", () => ({ trackChannelRunStarted: () => {} }));
vi.mock("@/services/tenants/founder-activity-alert", () => ({ notifyFounderActivity: () => {} }));

import { channelRun } from "@/routes/channels/run";

type Reply = { status: number; body: any };

function fakeRes(): { res: Response; done: Promise<Reply> } {
  let finish: (r: Reply) => void = () => {};
  const done = new Promise<Reply>((r) => (finish = r));
  let status = 200;
  const res = {
    status(s: number) {
      status = s;
      return res;
    },
    json(b: unknown) {
      finish({ status, body: b });
      return res;
    },
  } as unknown as Response;
  return { res, done };
}

async function press(request_id: string | undefined, tenant = TA, user = USER_WEB): Promise<Reply> {
  const { res, done } = fakeRes();
  const req = {
    params: { slug: CHANNEL },
    body: request_id ? { request_id } : {},
    headers: { "x-tenant": tenant, "x-user": user },
  } as unknown as Request;
  await channelRun(req, res);
  return done;
}

const DONE_RUN = "30000000-0000-4000-8000-0000000000aa";

describe.skipIf(!modules)("20261117250000_channel_run_claim_stale_request_retries (pglite)", () => {
  let db: Db;
  const runs = async (tenant = TA) =>
    (await db.query<{ id: string }>("select id from agent_runs where tenant_id = $1 and id <> $2 order by enqueued_at, id", [tenant, DONE_RUN])).rows;
  const claims = async (request_id: string, tenant = TA) =>
    (await db.query<{ id: string; run_id: string | null }>(
      "select id, run_id from channel_run_claims where tenant_id = $1 and request_id = $2",
      [tenant, request_id],
    )).rows;
  const orphan = async (request_id: string, minutesAgo: number, tenant = TA, extra: { run_id?: string; joined?: string; lane?: string } = {}) =>
    (await db.query<{ id: string }>(
      `insert into channel_run_claims (tenant_id, channel_slug, request_id, estimate, claimed_at, run_id, joined_claim_id, join_lane)
       values ($1, $2, $3, $4, now() - make_interval(mins => $5), $6, $7, $8) returning id`,
      [tenant, CHANNEL, request_id, ESTIMATE, minutesAgo, extra.run_id ?? null, extra.joined ?? null, extra.lane ?? null],
    )).rows[0].id;

  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite() as Db;
    h.db = db;
    await db.exec(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
      end $$;
      create schema if not exists auth;
      create or replace function auth.uid() returns uuid language sql as 'select null::uuid';
      create or replace function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';
      create table public.tenants (id uuid primary key);
      create table public.tenant_users (tenant_id uuid references public.tenants(id), user_id uuid);
      create table public.agent_runs (
        id uuid primary key, tenant_id uuid not null, agent_slug text, trigger text, status text,
        channel_slug text, reserved int not null default 0, payload jsonb,
        enqueued_at timestamptz not null default clock_timestamp());
      create function public.channel_credits_30d(p_tenant_id uuid) returns int language sql as $$
        select coalesce(sum(reserved), 0)::int from agent_runs where tenant_id = p_tenant_id and channel_slug is not null $$;
      create function public.channel_budget_allows(p_tenant_id uuid, p_estimate int) returns boolean language sql as $$
        select channel_credits_30d(p_tenant_id) + p_estimate <= 2000 $$;
      create function public.stamp_channel_run(p_tenant_id uuid, p_run_id uuid, p_channel_slug text) returns boolean language sql as $$
        update agent_runs set channel_slug = p_channel_slug where id = p_run_id and tenant_id = p_tenant_id returning true $$;
      create function public.record_channel_run(p_tenant_id uuid, p_run_id uuid) returns boolean language sql as 'select true';
      insert into public.tenants values ('${TA}'), ('${TB}');
    `);
    for (const f of [
      "20260920083304_channel_run_claim_idempotency.sql",
      "20261111120000_channel_run_now_joins_in_flight.sql",
      "20261117250000_channel_run_claim_stale_request_retries.sql",
    ]) {
      await db.exec(read(f));
    }
  }, 120_000);
  afterAll(async () => db?.close());

  beforeEach(async () => {
    await db.exec("delete from channel_run_claims; delete from agent_runs;");
    await db.query("insert into agent_runs (id, tenant_id, agent_slug, status, channel_slug) values ($1, $2, 'email', 'success', $3)", [DONE_RUN, TA, CHANNEL]);
    h.enqueueCalls = 0;
    h.failSettle = false;
  });

  it("a press id whose claim never got a run starts a real run once the claim is stale, instead of 'still starting' forever", async () => {
    await orphan("press-orphan-0001", 6);
    const reply = await press("press-orphan-0001");
    const started = await runs();
    expect(h.enqueueCalls).toBe(1);
    expect(started).toHaveLength(1);
    expect(reply.body).toEqual({ ok: true, run_id: started[0].id, stamped: true, duplicate: false });
    const after = await claims("press-orphan-0001");
    expect(after).toHaveLength(1);
    expect(after[0].run_id).toBe(started[0].id);

    const again = await press("press-orphan-0001");
    expect(again.body).toEqual({ ok: true, run_id: started[0].id, stamped: true, duplicate: true });
    expect(h.enqueueCalls).toBe(1);
  });

  it("a claim still inside the stale window keeps answering duplicate and starts nothing", async () => {
    await orphan("press-fresh-00001", 2);
    const reply = await press("press-fresh-00001");
    expect(reply.body).toEqual({ ok: true, run_id: null, stamped: true, duplicate: true });
    expect(h.enqueueCalls).toBe(0);
    expect(await runs()).toHaveLength(0);
  });

  it("an old claim that did get its run answers with that run and never starts a second one", async () => {
    await orphan("press-done-000001", 60 * 24, TA, { run_id: DONE_RUN });
    const reply = await press("press-done-000001");
    expect(reply.body).toEqual({ ok: true, run_id: DONE_RUN, stamped: true, duplicate: true });
    expect(h.enqueueCalls).toBe(0);
  });

  it("a press that joined a run that never started is freed once the run it joined is stale", async () => {
    const parent = await orphan("press-parent-0001", 7, TA, { lane: "run_now" });
    await orphan("press-joined-0001", 1, TA, { joined: parent, lane: "run_now" });
    const reply = await press("press-joined-0001");
    const started = await runs();
    expect(started).toHaveLength(1);
    expect(reply.body).toMatchObject({ ok: true, run_id: started[0].id, duplicate: false });
  });

  it("another workspace's stale claim with the same press id is left alone", async () => {
    await orphan("press-shared-0001", 9, TB);
    const reply = await press("press-shared-0001", TA);
    expect(reply.body.duplicate).toBe(false);
    expect(await claims("press-shared-0001", TB)).toHaveLength(1);
    expect((await claims("press-shared-0001", TB))[0].run_id).toBeNull();
  });

  it("a press whose run started but whose claim was never settled answers with that run after the stale window, and starts no second run", async () => {
    h.failSettle = true;
    const first = await press("press-unsettled-01");
    h.failSettle = false;
    const started = await runs();
    expect(started).toHaveLength(1);
    expect(first.body).toMatchObject({ ok: true, run_id: started[0].id, duplicate: false });
    const before = await claims("press-unsettled-01");
    expect(before).toHaveLength(1);
    expect(before[0].run_id).toBeNull();
    await db.query("update channel_run_claims set claimed_at = now() - interval '6 minutes' where id = $1", [before[0].id]);

    const retry = await press("press-unsettled-01");
    expect(retry.body).toEqual({ ok: true, run_id: started[0].id, stamped: true, duplicate: true });
    expect(h.enqueueCalls).toBe(1);
    expect(await runs()).toHaveLength(1);
    const after = await claims("press-unsettled-01");
    expect(after).toEqual([{ id: before[0].id, run_id: started[0].id }]);
  });

  it("a stale unsettled claim from before runs carried their claim id is matched to the run enqueued right after it", async () => {
    const claimId = await orphan("press-legacy-0001", 8);
    const legacy = "30000000-0000-4000-8000-0000000000bb";
    await db.query(
      `insert into agent_runs (id, tenant_id, agent_slug, status, payload, enqueued_at)
       select $1, $2, 'email', 'queued', $3, claimed_at + interval '2 seconds' from channel_run_claims where id = $4`,
      [legacy, TA, JSON.stringify({ channel_slug: CHANNEL }), claimId],
    );
    const reply = await press("press-legacy-0001");
    expect(reply.body).toEqual({ ok: true, run_id: legacy, stamped: true, duplicate: true });
    expect(h.enqueueCalls).toBe(0);
    expect(await claims("press-legacy-0001")).toEqual([{ id: claimId, run_id: legacy }]);
  });
});
