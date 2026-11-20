import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf-8");
const FILE = "20261115000100_growth_j6_founder_stop_and_diagnosis.sql";

function fn(file: string, name: string): string {
  const sql = read(file);
  const start = sql.indexOf(`create or replace function ${name}(`);
  const body = sql.indexOf("$$", start);
  const end = sql.indexOf("$$;", body + 2) + 3;
  if (start < 0 || body < 0 || end < 3) throw new Error(`missing SQL function ${name} in ${file}`);
  return sql.slice(start, end);
}

const SCHEMA = `
  create role anon; create role authenticated; create role service_role;
  create table tenants (id uuid primary key);
  create table tenant_users (tenant_id uuid, user_id uuid, primary key (tenant_id, user_id));
  create table praxis_logs (id uuid primary key default gen_random_uuid(), level text, source text, code text, message text, tenant_id uuid, meta jsonb);
  create table growth_plan (id uuid primary key default gen_random_uuid(), tenant_id uuid, status text default 'live',
    objective text, north_star_metric text, constraint_statement text, constraint_confidence text, basis_evidence jsonb,
    version int default 1, created_at timestamptz default clock_timestamp(), updated_at timestamptz default now());
  create unique index one_live_plan on growth_plan (tenant_id) where status = 'live';
  create table growth_plan_bets (id uuid primary key default gen_random_uuid(), tenant_id uuid, plan_id uuid, channel_slug text,
    intent text, rationale text, expected_effect text, falsifier text, status text, rejected_reason text, sort_order int,
    created_at timestamptz default now(), updated_at timestamptz default now());
  create table growth_plan_changes (id uuid primary key default gen_random_uuid(), tenant_id uuid, plan_id uuid, entity text,
    entity_id uuid, field text, old_value text, new_value text, actor_kind text, actor_ref text, note text);
  create table tenant_channels (tenant_id uuid, channel_slug text, plan_selected boolean default false,
    plan_selected_set_by text check (plan_selected_set_by in ('plan', 'founder')),
    plan_sort_order int, autorun boolean default false, autorun_set_by text,
    cgo_reason text, cgo_set_at timestamptz, cgo_run_id uuid, primary key (tenant_id, channel_slug));
  create table channel_actions (
    id uuid primary key default gen_random_uuid(), tenant_id uuid not null, channel_slug text not null,
    status text not null default 'pending', status_at timestamptz, note text, snoozed_until timestamptz,
    exec_class text, exec_status text, approved_by uuid,
    run_id uuid, exec_claim_id uuid, exec_claimed_at timestamptz, exec_result jsonb, executed_at timestamptz, approved_by_source text
  );
  create function apply_exec_failure_verdict(uuid, uuid, uuid, jsonb) returns void language sql as 'select null';
  create table channel_action_events (
    id bigint generated always as identity primary key,
    tenant_id uuid not null, action_id uuid not null references channel_actions(id) on delete cascade,
    event text not null constraint channel_action_events_event_check check (event in ('proposed','acted','rejected','snoozed','redo_requested','redone','stale_flagged','displaced','revised','approved','executed','exec_failed')),
    actor_kind text not null, actor_user_id uuid, run_id uuid, note text, snoozed_until timestamptz,
    event_key text not null, at timestamptz not null default now(),
    unique (action_id, event_key)
  );
  create table cgo_hypotheses (id uuid primary key default gen_random_uuid(), tenant_id uuid, claim text, status text,
    plan_kept_at timestamptz, plan_kept_by uuid);
  create table decision_classes (slug text primary key, founder_managed boolean);
  create table decisions (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, decision_class text,
    status text, snoozed_until timestamptz);
  insert into decision_classes values ('meta_ads.update_ad_set_budget', true), ('internal.thing', false);
  create function retire_cards_off_plan(uuid, uuid, text[]) returns int language sql as 'select 0';
`;

type Db = {
  exec: (q: string) => Promise<unknown>;
  query: <R = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<{ rows: R[] }>;
  close: () => Promise<void>;
};

const modules = process.env.SITES_SQL_TEST_MODULES;

describe(`${FILE} executed in Postgres (pglite)`, () => {
  let db: Db;
  let T = "";
  let U = "";
  let OTHER = "";

  beforeAll(async () => {
    const { PGlite } = modules
      ? createRequire(resolve(modules, "../package.json"))("@electric-sql/pglite")
      : await import("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(SCHEMA);
    await db.exec(fn("20260906191500_growth_plan_tables.sql", "log_growth_plan_change"));
    await db.exec(fn("20260909160000_growth_plan_bet_rationale.sql", "set_growth_plan_bet"));
    await db.exec(read(FILE));
  }, 30_000);
  afterAll(async () => {
    await db?.close();
  });

  const bet = (slug: string) => ({ channel_slug: slug, intent: `do ${slug}`, expected_effect: "more", falsifier: "no change", autorun: false });
  const commit = async (slugs: string[], tenant = T, constraint = "constraint") =>
    (
      await db.query<{ id: string | null }>(
        "select commit_growth_plan($1, 'obj', 'signups', $3, 'medium', $2::jsonb, '[]'::jsonb, 'agent', 'cgo') id",
        [tenant, JSON.stringify(slugs.map(bet)), constraint],
      )
    ).rows[0].id;
  const inPlan = async (slug: string, on: boolean, tenant = T, actor: string | null = U) =>
    (await db.query<{ r: string }>("select set_channel_in_plan($1, $2, $3, $4) r", [tenant, slug, on, actor])).rows[0].r;
  const channel = async (slug: string, tenant = T) =>
    (await db.query<{ plan_selected: boolean; plan_selected_set_by: string | null; plan_sort_order: number | null }>(
      "select plan_selected, plan_selected_set_by, plan_sort_order from tenant_channels where tenant_id = $1 and channel_slug = $2",
      [tenant, slug],
    )).rows[0];
  const card = async (slug: string, cols: Record<string, unknown> = {}, tenant = T) => {
    const names = ["tenant_id", "channel_slug", ...Object.keys(cols)];
    const vals = [tenant, slug, ...Object.values(cols)];
    return (await db.query<{ id: string }>(
      `insert into channel_actions (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      vals,
    )).rows[0].id;
  };
  const cardRow = async (id: string) =>
    (await db.query<{ status: string; note: string | null; snoozed_until: string | null }>(
      "select status, note, snoozed_until from channel_actions where id = $1", [id],
    )).rows[0];
  const events = async (id: string) =>
    (await db.query<{ event: string; actor_kind: string; actor_user_id: string | null; event_key: string }>(
      "select event, actor_kind, actor_user_id, event_key from channel_action_events where action_id = $1 order by id", [id],
    )).rows;
  const plan = async (tenant = T) =>
    (await db.query<Record<string, unknown>>("select * from growth_plan where tenant_id = $1 and status = 'live'", [tenant])).rows[0];

  beforeEach(async () => {
    T = randomUUID();
    U = randomUUID();
    OTHER = randomUUID();
    await db.query("insert into tenants values ($1), ($2)", [T, OTHER]);
    await db.query("insert into tenant_users values ($1, $2)", [T, U]);
    await commit(["seo", "x_organic"]);
  });

  it("widens the plan_selected_set_by check to founder_stopped and nothing else", async () => {
    await expect(
      db.query("insert into tenant_channels (tenant_id, channel_slug, plan_selected_set_by) values ($1, 'geo', 'founder_stopped')", [T]),
    ).resolves.toBeTruthy();
    await expect(
      db.query("insert into tenant_channels (tenant_id, channel_slug, plan_selected_set_by) values ($1, 'pr', 'cgo')", [T]),
    ).rejects.toThrow();
  });

  it("stops Zavi's pick, closes its open cards as the founder, and leaves an executing card alone", async () => {
    const open = await card("seo");
    const snoozed = await card("seo", { status: "snoozed", snoozed_until: "2099-01-01" });
    const executing = await card("seo", { exec_status: "dispatching" });
    const done = await card("seo", { status: "acted" });
    const otherChannel = await card("x_organic");

    expect(await inPlan("seo", false)).toBe("stopped");
    expect(await channel("seo")).toMatchObject({ plan_selected: false, plan_selected_set_by: "founder_stopped", plan_sort_order: null });
    for (const id of [open, snoozed]) {
      expect(await cardRow(id)).toMatchObject({ status: "stale", note: "Closed when you stopped this channel" });
      expect(await events(id)).toEqual([
        expect.objectContaining({ event: "stale_flagged", actor_kind: "founder", actor_user_id: U, event_key: expect.stringMatching(/^founder_stop:/) }),
      ]);
    }
    expect((await cardRow(executing)).status).toBe("pending");
    expect((await cardRow(done)).status).toBe("acted");
    expect((await cardRow(otherChannel)).status).toBe("pending");
    expect(await inPlan("seo", false)).toBe("stopped");
  });

  it("never lets cgo, a plan commit or Start over put a stopped channel back", async () => {
    expect(await inPlan("seo", false)).toBe("stopped");

    expect((await db.query<{ r: string }>("select set_channel_in_plan_by_cgo($1, 'seo', true) r", [T])).rows[0].r).toBe("founder_stopped");
    expect((await db.query<{ r: string }>("select set_channel_in_plan_by_cgo($1, 'seo', false) r", [T])).rows[0].r).toBe("founder_stopped");

    const planId = await commit(["seo", "geo"]);
    expect(planId).toBeTruthy();
    expect(await channel("seo")).toMatchObject({ plan_selected: false, plan_selected_set_by: "founder_stopped" });
    expect(await channel("geo")).toMatchObject({ plan_selected: true, plan_selected_set_by: "plan" });
    const bets = await db.query<{ channel_slug: string }>("select channel_slug from growth_plan_bets where plan_id = $1", [planId]);
    expect(bets.rows.map((b) => b.channel_slug)).toEqual(["geo"]);

    expect(await commit(["seo"])).toBeNull();

    await db.query("update tenant_channels set autorun = true where tenant_id = $1 and channel_slug = 'seo'", [T]);
    await commit(["geo"]);
    expect((await channel("seo")).plan_selected_set_by).toBe("founder_stopped");
    await db.query("select retire_growth_plan($1)", [T]);
    expect((await channel("seo")).plan_selected_set_by).toBe("founder_stopped");
  });

  it("restores as Zavi's pick while the live plan bets on it, and reopens the cards the stop closed", async () => {
    const open = await card("seo");
    const before = await channel("seo");
    await inPlan("seo", false);

    expect(await inPlan("seo", true)).toBe("restored_plan");
    expect(await channel("seo")).toMatchObject({ plan_selected: true, plan_selected_set_by: "plan", plan_sort_order: before.plan_sort_order });
    expect(await cardRow(open)).toMatchObject({ status: "pending", note: null });
    expect((await events(open)).map((e) => e.event)).toEqual(["stale_flagged", "reopened"]);
  });

  it("restores as the founder's add when no live bet names it", async () => {
    await inPlan("geo", false);
    expect(await channel("geo")).toMatchObject({ plan_selected: false, plan_selected_set_by: "founder_stopped" });
    expect(await inPlan("geo", true)).toBe("restored_founder");
    expect(await channel("geo")).toMatchObject({ plan_selected: true, plan_selected_set_by: "founder" });
  });

  it("keeps the founder's own add a plain remove, and touches no other tenant", async () => {
    expect(await inPlan("pr", true)).toBe("ok");
    expect(await inPlan("pr", false)).toBe("ok");
    expect(await channel("pr")).toMatchObject({ plan_selected: false, plan_selected_set_by: null });

    const mine = await card("seo");
    await commit(["seo"], OTHER);
    expect(await inPlan("seo", false, OTHER, null)).toBe("stopped");
    expect((await cardRow(mine)).status).toBe("pending");
    expect((await channel("seo")).plan_selected_set_by).toBe("plan");
    expect(await inPlan("seo", false, T, randomUUID())).toBe("failed");
    expect((await channel("seo")).plan_selected_set_by).toBe("plan");
  });

  it("stores the founder's diagnosis, drops an earlier agreement, and carries both rules across a re-plan", async () => {
    const agree = await db.query<{ r: { ok: boolean } }>("select set_constraint_agreed($1, $2, true) r", [T, U]);
    expect(agree.rows[0].r.ok).toBe(true);
    expect((await plan()).constraint_agreed_at).toBeTruthy();

    const set = await db.query<{ r: { ok: boolean; founder_constraint: string } }>("select set_founder_constraint($1, $2, $3) r", [T, U, "  Hosts cancel too often  "]);
    expect(set.rows[0].r).toMatchObject({ ok: true, founder_constraint: "Hosts cancel too often" });
    let live = await plan();
    expect(live).toMatchObject({ founder_constraint: "Hosts cancel too often", founder_constraint_by: U, constraint_agreed_at: null });

    await commit(["seo"]);
    live = await plan();
    expect(live).toMatchObject({ founder_constraint: "Hosts cancel too often", founder_constraint_by: U });

    await db.query("select set_founder_constraint($1, $2, null)", [T, U]);
    await db.query("select set_constraint_agreed($1, $2, true)", [T, U]);
    await commit(["seo"], T, "constraint");
    expect((await plan()).constraint_agreed_at).toBeTruthy();
    await commit(["seo"], T, "a different constraint");
    expect((await plan()).constraint_agreed_at).toBeNull();

    const changes = await db.query<{ field: string; actor_kind: string }>(
      "select field, actor_kind from growth_plan_changes where tenant_id = $1 and field = 'founder_constraint'", [T],
    );
    expect(changes.rows.length).toBeGreaterThan(0);
  });

  it("refuses an empty or over-long diagnosis, a non-member, and a tenant with no plan", async () => {
    const r = async (args: unknown[]) => (await db.query<{ r: { ok: boolean; code?: string } }>("select set_founder_constraint($1, $2, $3) r", args)).rows[0].r;
    expect(await r([T, U, "   "])).toMatchObject({ ok: false, code: "bad_text" });
    expect(await r([T, U, "x".repeat(301)])).toMatchObject({ ok: false, code: "bad_text" });
    expect(await r([T, randomUUID(), "fine"])).toMatchObject({ ok: false, code: "not_member" });
    const lonely = randomUUID();
    await db.query("insert into tenant_users values ($1, $2)", [lonely, U]);
    expect(await r([lonely, U, "fine"])).toMatchObject({ ok: false, code: "no_plan" });
    expect((await db.query<{ r: { code: string } }>("select set_constraint_agreed($1, $2, true) r", [lonely, U])).rows[0].r.code).toBe("no_plan");
  });

  it("Switch to Zavi's clears the founder's words, the agreement and Keep mine, for a standing hypothesis of this tenant only", async () => {
    await db.query("select set_founder_constraint($1, $2, 'my view')", [T, U]);
    const h = (await db.query<{ id: string }>("insert into cgo_hypotheses (tenant_id, claim, status) values ($1, 'Hosts cancel', 'testing') returning id", [T])).rows[0].id;
    const ruledOut = (await db.query<{ id: string }>("insert into cgo_hypotheses (tenant_id, claim, status, plan_kept_at) values ($1, 'old', 'ruled_out', now()) returning id", [T])).rows[0].id;
    const theirs = (await db.query<{ id: string }>("insert into cgo_hypotheses (tenant_id, claim, status) values ($1, 'theirs', 'listed') returning id", [OTHER])).rows[0].id;
    const sw = async (id: string) => (await db.query<{ r: { ok: boolean; code?: string; claim?: string } }>("select switch_plan_constraint_to_hypothesis($1, $2, $3) r", [T, U, id])).rows[0].r;

    expect(await sw(ruledOut)).toMatchObject({ ok: false, code: "no_hypothesis" });
    expect(await sw(theirs)).toMatchObject({ ok: false, code: "no_hypothesis" });
    expect((await plan()).founder_constraint).toBe("my view");

    expect(await sw(h)).toEqual({ ok: true, claim: "Hosts cancel" });
    expect(await plan()).toMatchObject({ founder_constraint: null, constraint_agreed_at: null });
    const kept = await db.query<{ plan_kept_at: string | null }>("select plan_kept_at from cgo_hypotheses where id = $1", [ruledOut]);
    expect(kept.rows[0].plan_kept_at).toBeNull();
  });

  it("reopens a snoozed or a plain closed card, and refuses one that ran, was approved or can execute", async () => {
    const act = async (id: string, key = randomUUID(), tenant = T) =>
      (await db.query<{ r: { ok: boolean; code?: string; status?: string } }>(
        "select set_channel_action($1, $2, 'open', null, null, $3, $4) r", [tenant, id, key, U],
      )).rows[0].r;

    const snoozed = await card("seo", { status: "snoozed", snoozed_until: "2099-01-01" });
    expect(await act(snoozed)).toMatchObject({ ok: true, status: "pending" });
    expect(await cardRow(snoozed)).toMatchObject({ status: "pending", snoozed_until: null });
    expect((await events(snoozed)).map((e) => e.event)).toEqual(["reopened"]);

    const done = await card("seo", { status: "acted", note: "did it" });
    const key = randomUUID();
    expect(await act(done, key)).toMatchObject({ ok: true, status: "pending" });
    expect(await cardRow(done)).toMatchObject({ status: "pending", note: null });
    expect(await act(done, key)).toMatchObject({ ok: true });
    expect(await events(done)).toHaveLength(1);

    expect(await act(await card("seo", { status: "rejected", exec_class: "meta_ads.update_ad_set_budget" }))).toMatchObject({ ok: false, code: "not_reopenable" });
    expect(await act(await card("seo", { status: "acted", approved_by: U }))).toMatchObject({ ok: false, code: "not_reopenable" });
    expect(await act(await card("seo", { status: "snoozed", exec_status: "executed" }))).toMatchObject({ ok: false, code: "not_reopenable" });
    expect(await act(await card("seo", { status: "snoozed", exec_status: "queued" }))).toMatchObject({ ok: false, code: "exec_in_flight" });
    expect(await act(await card("seo"))).toMatchObject({ ok: false, code: "illegal_transition" });
    expect(await act(await card("seo", { status: "stale" }))).toMatchObject({ ok: false, code: "illegal_transition" });

    const theirs = await card("seo", { status: "snoozed", snoozed_until: "2099-01-01" }, OTHER);
    expect(await act(theirs)).toMatchObject({ ok: false, code: "not_found" });
    expect((await cardRow(theirs)).status).toBe("snoozed");
  });

  it("still refuses cgo and every old status rule on set_channel_action", async () => {
    const id = await card("seo");
    const r = await db.query<{ r: { ok: boolean; code?: string } }>(
      "select set_channel_action($1, $2, 'open', null, null, 'k1', null, 'cgo') r", [T, id],
    );
    expect(r.rows[0].r).toMatchObject({ ok: false, code: "invalid_source" });
    const snooze = await db.query<{ r: { ok: boolean } }>(
      "select set_channel_action($1, $2, 'snoozed', null, now() + interval '1 day', 'k2', $3) r", [T, id, U],
    );
    expect(snooze.rows[0].r.ok).toBe(true);
  });

  it("un-snoozes only this tenant's snoozed, founder-managed proposal", async () => {
    const mk = async (tenant: string, cls: string, snoozed: boolean) =>
      (await db.query<{ id: string }>(
        "insert into decisions (tenant_id, decision_class, status, snoozed_until) values ($1, $2, 'proposed', $3) returning id",
        [tenant, cls, snoozed ? "2099-01-01" : null],
      )).rows[0].id;
    const un = async (tenant: string, id: string) => (await db.query<{ r: boolean }>("select unsnooze_decision($1, $2) r", [tenant, id])).rows[0].r;

    const mine = await mk(T, "meta_ads.update_ad_set_budget", true);
    expect(await un(OTHER, mine)).toBe(false);
    expect(await un(T, mine)).toBe(true);
    expect((await db.query<{ s: string | null }>("select snoozed_until s from decisions where id = $1", [mine])).rows[0].s).toBeNull();
    expect(await un(T, mine)).toBe(false);
    expect(await un(T, await mk(T, "internal.thing", true))).toBe(false);
  });

  it("settles an approval refused for the founder's stop as a closed card, not an open failed one", async () => {
    const claim = randomUUID();
    const settle = async (id: string, code: string) =>
      (await db.query<{ r: { ok: boolean } }>(
        "select settle_channel_action_exec($1, $2, false, $3::jsonb, 'You stopped this channel', $4) r",
        [T, id, JSON.stringify({ code }), claim],
      )).rows[0].r;
    await inPlan("seo", false);
    const queued = await card("seo", { exec_class: "meta_ads.set_status", exec_status: "dispatching", exec_claim_id: claim, approved_by: U });
    expect(await settle(queued, "founder_stopped")).toMatchObject({ ok: true });
    expect(await cardRow(queued)).toMatchObject({ status: "stale", note: "Closed when you stopped this channel" });
    expect((await events(queued)).map((e) => e.event)).toEqual(["exec_failed", "stale_flagged"]);

    const other = await card("geo", { exec_class: "meta_ads.set_status", exec_status: "dispatching", exec_claim_id: claim, approved_by: U });
    expect(await settle(other, "rate_limited")).toMatchObject({ ok: true });
    expect((await cardRow(other)).status).toBe("pending");
  });
});
