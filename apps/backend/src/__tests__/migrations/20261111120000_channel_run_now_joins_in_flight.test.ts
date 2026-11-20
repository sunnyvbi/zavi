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
const USER_PHONE = "00000000-0000-4000-8000-0000000000c2";
const CHANNEL = "email_marketing";
const ESTIMATE = 460;

const h = vi.hoisted(() => {
  type Gate = { open: () => void; wait: Promise<void> };
  const mkGate = (): Gate => {
    let open = () => {};
    const wait = new Promise<void>((r) => (open = r));
    return { open, wait };
  };
  return {
    db: null as Db | null,
    gate: null as Gate | null,
    failNextEnqueue: false,
    enqueueCalls: 0,
    mkGate,
    notify: [] as Array<{ event: string; details: Record<string, unknown> }>,
    seq: 0,
  };
});

async function call(fn: string, args: Record<string, unknown>, tenantId: string) {
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
      if (h.gate) await h.gate.wait;
      if (h.failNextEnqueue) {
        h.failNextEnqueue = false;
        throw new Error("fleet halted");
      }
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
vi.mock("@/services/tenants/founder-activity-alert", () => ({
  notifyFounderActivity: (e: { event: string; details: Record<string, unknown> }) => {
    h.notify.push(e);
  },
}));

import { channelRun, RUN_NOW_LANE, startChannelRun } from "@/routes/channels/run";

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

async function topAction(request_id: string, subject: string): Promise<Reply> {
  const { res, done } = fakeRes();
  await startChannelRun(res, { tenant_id: TA, user_id: USER_WEB } as never, CHANNEL, {
    requestId: request_id,
    topAction: { key: "new_email", inputs: { subject }, instruction: `Write ${subject}`, by: USER_WEB },
  });
  return done;
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe.skipIf(!modules)("20261111120000_channel_run_now_joins_in_flight (pglite)", () => {
  let db: Db;
  const runs = async (tenant = TA) =>
    (await db.query<{ id: string; reserved: number; status: string; top: boolean }>(
      "select id, reserved, status, (payload ? 'top_action') as top from agent_runs where tenant_id = $1 order by enqueued_at, id",
      [tenant],
    )).rows;
  const charged = async (tenant = TA) => (await runs(tenant)).reduce((s, r) => s + Number(r.reserved), 0);

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
    for (const f of ["20260920083304_channel_run_claim_idempotency.sql", "20261111120000_channel_run_now_joins_in_flight.sql"]) {
      await db.exec(read(f));
    }
  }, 120_000);
  afterAll(async () => db?.close());

  beforeEach(async () => {
    await db.exec("delete from channel_run_claims; delete from agent_runs;");
    h.gate = null;
    h.failNextEnqueue = false;
    h.enqueueCalls = 0;
    h.notify.length = 0;
  });

  it("three presses with three NEW press ids racing the first run start ONE run and charge 460 once", async () => {
    h.gate = h.mkGate();
    const racing = Promise.all([
      press("press-web-000001", TA, USER_WEB),
      press("press-phone-00002", TA, USER_PHONE),
      press("press-api-0000003", TA, USER_WEB),
    ]);
    await settle();
    h.gate.open();
    const replies = await racing;

    expect(h.enqueueCalls).toBe(1);
    const all = await runs();
    expect(all).toHaveLength(1);
    expect(await charged()).toBe(ESTIMATE);
    for (const r of replies) {
      expect(r.status).toBe(200);
      expect(Object.keys(r.body).sort()).toEqual(["duplicate", "ok", "run_id", "stamped"]);
      expect(r.body.ok).toBe(true);
      expect([null, all[0].id]).toContain(r.body.run_id);
    }
    expect(replies.filter((r) => r.body.duplicate === false)).toHaveLength(1);
    expect(replies.filter((r) => r.body.duplicate === true)).toHaveLength(2);
    expect(h.notify.filter((n) => n.event === "first_channel_run")).toHaveLength(1);

    const retried = await press("press-phone-00002", TA, USER_PHONE);
    expect(retried.body).toEqual({ ok: true, run_id: all[0].id, stamped: true, duplicate: true });
    expect(await runs()).toHaveLength(1);
  });

  it("a press with a new id while the run is queued or running joins it with that run's id", async () => {
    const first = await press("press-first-0001");
    const [only] = await runs();
    expect(first.body).toEqual({ ok: true, run_id: only.id, stamped: true, duplicate: false });

    const queued = await press("press-second-002", TA, USER_PHONE);
    expect(queued.body).toEqual({ ok: true, run_id: only.id, stamped: true, duplicate: true });

    await db.query("update agent_runs set status = 'running' where id = $1", [only.id]);
    const running = await press(undefined, TA, USER_PHONE);
    expect(running.body).toEqual({ ok: true, run_id: only.id, stamped: true, duplicate: true });

    expect(h.enqueueCalls).toBe(1);
    expect(await charged()).toBe(ESTIMATE);
    const pending = await db.query<{ n: number }>(
      "select coalesce(sum(estimate), 0)::int as n from channel_run_claims where settled_at is null",
    );
    expect(pending.rows[0].n).toBe(0);
  });

  it.each(["success", "failed", "cancelled", "parse_failed", "error", "dispatch_error", "timed_out", "blocked"])(
    "once the run is %s, a new press starts a new run, and a joined press id retried later still answers the old run",
    async (terminal) => {
      await press("press-first-0001");
      const [old] = await runs();
      await press("press-joined-002");
      await db.query("update agent_runs set status = $2 where id = $1", [old.id, terminal]);

      const retried = await press("press-joined-002");
      expect(retried.body).toEqual({ ok: true, run_id: old.id, stamped: true, duplicate: true });

      const fresh = await press("press-fresh-0003");
      expect(fresh.body.duplicate).toBe(false);
      expect(fresh.body.run_id).not.toBe(old.id);
      expect(await runs()).toHaveLength(2);
    },
  );

  it("a run going longer than the join window no longer swallows presses", async () => {
    await press("press-first-0001");
    await db.query("update channel_run_claims set claimed_at = now() - interval '3 hours 1 minute'");
    const later = await press("press-later-0002");
    expect(later.body.duplicate).toBe(false);
    expect(await runs()).toHaveLength(2);
  });

  it("a claim whose enqueue never returned is joined only inside the stale window", async () => {
    await db.query(
      "insert into channel_run_claims (tenant_id, channel_slug, request_id, estimate, join_lane, claimed_at) values ($1, $2, 'press-crashed-01', 460, 'run_now', now() - interval '6 minutes')",
      [TA, CHANNEL],
    );
    const after = await press("press-after-0002");
    expect(after.body.duplicate).toBe(false);
    expect(await runs()).toHaveLength(1);
  });

  it("an enqueue that throws releases the claim, so the next press starts its own run instead of joining nothing", async () => {
    h.failNextEnqueue = true;
    const boom = await press("press-boom-00001");
    expect(boom.status).toBe(500);
    expect(await runs()).toHaveLength(0);

    const next = await press("press-next-00002");
    expect(next.body.duplicate).toBe(false);
    expect(next.body.run_id).toEqual(expect.any(String));
    expect(await runs()).toHaveLength(1);
  });

  it("joining is per tenant: another tenant's press during A's run starts B's own run", async () => {
    await press("press-tenant-a01", TA);
    const b = await press("press-tenant-b01", TB);
    expect(b.body.duplicate).toBe(false);
    expect((await runs(TB))).toHaveLength(1);
    expect((await runs(TB))[0].id).toBe(b.body.run_id);
    expect(await runs(TA)).toHaveLength(1);
  });

  it("a top action with its own inputs is a distinct request, in either order", async () => {
    await press("press-runnow-001");
    const top1 = await topAction("top-press-00001", "Spring sale");
    expect(top1.body.duplicate).toBe(false);
    const top2 = await topAction("top-press-00002", "Welcome series");
    expect(top2.body.duplicate).toBe(false);
    expect(new Set([top1.body.run_id, top2.body.run_id]).size).toBe(2);

    await db.exec("delete from channel_run_claims; delete from agent_runs;");
    const top = await topAction("top-press-00003", "Spring sale");
    const runNow = await press("press-runnow-002");
    expect(runNow.body.duplicate).toBe(false);
    expect(runNow.body.run_id).not.toBe(top.body.run_id);

    const sameTop = await topAction("top-press-00003", "Spring sale");
    expect(sameTop.body).toEqual({ ok: true, run_id: top.body.run_id, stamped: true, duplicate: true });
  });

  it("the engine never joins a top action or a redo, even when a caller hands it the Run now lane", async () => {
    const plain = await press("press-runnow-010");
    const top = fakeRes();
    await startChannelRun(top.res, { tenant_id: TA, user_id: USER_WEB } as never, CHANNEL, {
      requestId: "top-press-lane-01",
      joinLane: RUN_NOW_LANE,
      topAction: { key: "new_email", inputs: { subject: "x" }, instruction: "Write x", by: USER_WEB },
    });
    const redo = fakeRes();
    await startChannelRun(redo.res, { tenant_id: TA, user_id: USER_WEB } as never, CHANNEL, {
      requestId: "redo-press-lane-1",
      joinLane: RUN_NOW_LANE,
      redo: { action_key: "k1", action_title: "Subject line", note: "shorter" },
    });
    const [t, r] = [await top.done, await redo.done];
    expect(t.body.duplicate).toBe(false);
    expect(r.body.duplicate).toBe(false);
    expect(new Set([plain.body.run_id, t.body.run_id, r.body.run_id]).size).toBe(3);
    expect(await runs()).toHaveLength(3);
  });

  it("joined presses hold nothing against the cap, so the cap still admits the runs it should", async () => {
    await press("press-cap-000001");
    for (let i = 0; i < 5; i++) await press(`press-cap-join-${i}x`);
    await db.query("update agent_runs set status = 'success'");
    await press("press-cap-000002");
    await db.query("update agent_runs set status = 'success'");
    await press("press-cap-000003");
    await db.query("update agent_runs set status = 'success'");
    await press("press-cap-000004");
    await db.query("update agent_runs set status = 'success'");
    const fifth = await press("press-cap-000005");
    expect(await runs()).toHaveLength(4);
    expect(fifth.status).toBe(402);
    expect(fifth.body.error.code).toBe("cap_reached");
  });
});
