import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHANNELS } from "@zavi/shared";
import { DEFAULT_TIER_AGENT_MIN } from "@/services/billing/tiers";
import { openPglite, type Pg } from "@/services/growth/booking-metrics/__tests__/pglite";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261112130000_remove_influencer_channel.sql";
const sql = readFileSync(join(DIR, FILE), "utf-8");
const HOME_FIX = readFileSync(join(DIR, "20261112130050_decision_home_without_influencer.sql"), "utf-8");
const HOME = readFileSync(join(DIR, "20261110140000_decisions_home.sql"), "utf-8");

const T = "91111230-0000-4000-8000-000000000001";
const INF_RUN = "91111230-0000-4000-8000-0000000000a1";
const UGC_RUN = "91111230-0000-4000-8000-0000000000a2";
const INF_AGENT_RUN = "91111230-0000-4000-8000-0000000000a3";
const D_INF_OPEN = "91111230-0000-4000-8000-0000000000d1";
const D_INF_DONE = "91111230-0000-4000-8000-0000000000d2";
const D_UGC_OPEN = "91111230-0000-4000-8000-0000000000d3";
const D_INF_AGENT_OPEN = "91111230-0000-4000-8000-0000000000d4";
const A_INF_OPEN = "91111230-0000-4000-8000-0000000000c1";
const A_INF_SNOOZED = "91111230-0000-4000-8000-0000000000c2";
const A_INF_QUEUED = "91111230-0000-4000-8000-0000000000c3";
const A_INF_ACTED = "91111230-0000-4000-8000-0000000000c4";
const A_UGC_OPEN = "91111230-0000-4000-8000-0000000000c5";

let db: Pg | null = null;
const rows = async (q: string, p: unknown[] = []) => (await db!.query(q, p)).rows as Record<string, any>[];
const one = async (q: string, p: unknown[] = []) => (await rows(q, p))[0];

describe.skipIf(!process.env.CI && !process.env.PGLITE_DIR)(`${FILE} (pglite)`, () => {
  beforeAll(async () => {
    db = await openPglite();
    await db!.exec(`
      create role anon; create role authenticated; create role service_role;
      create table system_config (id int primary key, blob jsonb not null, updated_at timestamptz);
      create table agent_runs (id uuid primary key, tenant_id uuid not null, agent_slug text, channel_slug text, enqueued_by uuid, payload jsonb not null default '{}', status text, finished_at timestamptz, needs_run_end_emit boolean not null default false, stop_requested boolean not null default false);
      create table decisions (
        id uuid primary key, tenant_id uuid not null, agent_run_id uuid, decision_class text not null,
        body jsonb not null default '{}', status text not null default 'proposed', autonomy_at_emit text not null default 'approval',
        snoozed_until timestamptz, emitted_at timestamptz not null default now(), archived_at timestamptz
      );
      create table channel_actions (
        id uuid primary key, tenant_id uuid not null, channel_slug text not null, status text not null default 'pending',
        status_at timestamptz, note text, exec_status text
      );
      create table channel_action_events (
        id bigint generated always as identity primary key, tenant_id uuid not null,
        action_id uuid not null references channel_actions(id) on delete cascade, event text not null,
        actor_kind text not null, note text, event_key text not null, unique (action_id, event_key)
      );
      create table growth_plan_bets (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, channel_slug text, status text not null, updated_at timestamptz not null default now());
      create table tenant_channels (tenant_id uuid not null, channel_slug text not null, primary key (tenant_id, channel_slug));
      create table channel_settings (
        id uuid primary key default gen_random_uuid(), tenant_id uuid not null, channel_slug text not null, field_id text not null, item text not null,
        foreign key (tenant_id, channel_slug) references tenant_channels (tenant_id, channel_slug) on delete cascade
      );
      create table tenant_agent_schedules (tenant_id uuid not null, agent_slug text not null, cron_expression text not null, primary key (tenant_id, agent_slug));
      create table tenant_agent_kill_switch (tenant_id uuid not null, agent_slug text not null, primary key (tenant_id, agent_slug));
      create table agent_reminders (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, agent_slug text not null, status text not null);
      create table custom_agent_reserved_names (name_norm text primary key);
    `);
  }, 60_000);
  afterAll(async () => db?.close());

  beforeEach(async () => {
    await db!.exec(`
      delete from channel_action_events; delete from channel_actions; delete from decisions; delete from agent_runs;
      delete from system_config; delete from growth_plan_bets; delete from channel_settings; delete from tenant_channels;
      delete from tenant_agent_schedules; delete from tenant_agent_kill_switch; delete from agent_reminders; delete from custom_agent_reserved_names;
    `);
    await db!.exec(HOME);
    await db!.query("insert into system_config (id, blob) values (1, $1::jsonb)", [
      JSON.stringify({
        tier_gate_enforced: true,
        tier_agent_min: { influencer: "pro", ugc: "growth", email_marketing: "pro" },
        locked_channel_slugs: ["ugc", "influencer", "email_marketing"],
        disabled_agent_slugs: ["influencer"],
        free_daily_credits: 5000,
      }),
    ]);
    await db!.exec(`
      insert into agent_runs (id, tenant_id, agent_slug, channel_slug, status) values
        ('${INF_RUN}', '${T}', 'influencer', 'influencer', 'success'),
        ('${UGC_RUN}', '${T}', 'ugc', 'ugc', 'success'),
        ('${INF_AGENT_RUN}', '${T}', 'influencer', null, 'success'),
        ('91111230-0000-4000-8000-0000000000f1', '${T}', 'influencer', 'influencer', 'queued'),
        ('91111230-0000-4000-8000-0000000000f2', '${T}', 'research', 'influencer', 'queued'),
        ('91111230-0000-4000-8000-0000000000f3', '${T}', 'influencer', null, 'running'),
        ('91111230-0000-4000-8000-0000000000f4', '${T}', 'ugc', 'ugc', 'queued'),
        ('91111230-0000-4000-8000-0000000000f5', '${T}', 'ugc', 'ugc', 'running');
      insert into decisions (id, tenant_id, agent_run_id, decision_class, status) values
        ('${D_INF_OPEN}', '${T}', '${INF_RUN}', 'channel.recipe_step', 'proposed'),
        ('${D_INF_DONE}', '${T}', '${INF_RUN}', 'channel.recipe_step', 'acted'),
        ('${D_UGC_OPEN}', '${T}', '${UGC_RUN}', 'channel.recipe_step', 'proposed'),
        ('${D_INF_AGENT_OPEN}', '${T}', '${INF_AGENT_RUN}', 'channel.recipe_step', 'proposed');
      insert into channel_actions (id, tenant_id, channel_slug, status, exec_status, note) values
        ('${A_INF_OPEN}', '${T}', 'influencer', 'pending', null, null),
        ('${A_INF_SNOOZED}', '${T}', 'influencer', 'snoozed', null, 'founder note'),
        ('${A_INF_QUEUED}', '${T}', 'influencer', 'pending', 'queued', null),
        ('${A_INF_ACTED}', '${T}', 'influencer', 'acted', 'executed', null),
        ('${A_UGC_OPEN}', '${T}', 'ugc', 'pending', null, null);
      insert into growth_plan_bets (tenant_id, channel_slug, status) values
        ('${T}', 'influencer', 'proposed'), ('${T}', 'influencer', 'accepted'), ('${T}', 'influencer', 'rejected'),
        ('${T}', 'ugc', 'proposed'), ('${T}', null, 'proposed');
      insert into tenant_channels (tenant_id, channel_slug) values ('${T}', 'influencer'), ('${T}', 'ugc');
      insert into channel_settings (tenant_id, channel_slug, field_id, item) values
        ('${T}', 'influencer', 'creators', '@someone'), ('${T}', 'ugc', 'brief', 'keep');
      insert into tenant_agent_schedules (tenant_id, agent_slug, cron_expression) values ('${T}', 'influencer', '0 9 * * 1'), ('${T}', 'research', '0 9 * * 1');
      insert into tenant_agent_kill_switch (tenant_id, agent_slug) values ('${T}', 'influencer'), ('${T}', 'engineer');
      insert into agent_reminders (tenant_id, agent_slug, status) values
        ('${T}', 'influencer', 'pending'), ('${T}', 'influencer', 'fired'), ('${T}', 'ugc', 'pending');
      insert into custom_agent_reserved_names (name_norm) values ('influencer'), ('influencers'), ('ugc videos'), ('operator');
    `);
    expect((await one("select home, home_channel from decisions where id = $1", [D_INF_DONE])).home_channel).toBe("influencer");
    await db!.exec(sql);
    await db!.exec(HOME_FIX);
    await db!.exec(sql);
    await db!.exec(HOME_FIX);
  });

  it("the tier functions no longer know influencer and match the TypeScript contract", async () => {
    expect((await one("select _tier_channel_gated('influencer') as g")).g).toBe(false);
    for (const c of CHANNELS) expect((await one("select _tier_channel_gated($1) as g", [c.slug])).g, c.slug).toBe(true);
    const def = (await one("select _tier_agent_min_default() as m")).m;
    expect(def).not.toHaveProperty("influencer");
    expect(def).toEqual(DEFAULT_TIER_AGENT_MIN);
  });

  it("decision_home_of treats an influencer run as no channel and still homes real channels", async () => {
    expect(await one("select * from decision_home_of('channel.recipe_step', 'influencer', null, null, null, null)")).toEqual({ home: "growth", home_channel: null });
    expect(await one("select * from decision_home_of('pm.ticket', 'influencer', null, null, null, null)")).toEqual({ home: "needs_you", home_channel: null });
    expect(await one("select * from decision_home_of('channel.recipe_step', 'ugc', null, null, null, null)")).toEqual({ home: "channel", home_channel: "ugc" });
  });

  it("strips influencer from every stored config list and leaves every other key alone", async () => {
    const blob = (await one("select blob from system_config where id = 1")).blob;
    expect(blob).toEqual({
      tier_gate_enforced: true,
      tier_agent_min: { ugc: "growth", email_marketing: "pro" },
      locked_channel_slugs: ["ugc", "email_marketing"],
      disabled_agent_slugs: [],
      free_daily_credits: 5000,
    });
  });

  it("archives open influencer decisions, restamps their home, and leaves history and other channels alone", async () => {
    const d = Object.fromEntries((await rows("select id, status, home, home_channel, archived_at from decisions")).map((r) => [r.id, r]));
    expect(d[D_INF_OPEN]).toMatchObject({ status: "archived", home: "growth", home_channel: null });
    expect(d[D_INF_OPEN].archived_at).not.toBeNull();
    expect(d[D_INF_AGENT_OPEN]).toMatchObject({ status: "archived" });
    expect(d[D_INF_DONE]).toMatchObject({ status: "acted", home: "growth", home_channel: null, archived_at: null });
    expect(d[D_UGC_OPEN]).toMatchObject({ status: "proposed", home: "channel", home_channel: "ugc", archived_at: null });
    expect(await rows("select id from decisions where home_channel = 'influencer'")).toEqual([]);
    expect((await one("select count(*)::int as n from agent_runs")).n).toBe(8);
  });

  it("cancels queued influencer runs and asks running ones to stop, leaving every other run alone", async () => {
    const r = Object.fromEntries(
      (await rows("select id, status, needs_run_end_emit, stop_requested, finished_at from agent_runs")).map((x) => [x.id.slice(-2), x]),
    );
    expect(r.f1).toMatchObject({ status: "cancelled", needs_run_end_emit: true, stop_requested: false });
    expect(r.f1.finished_at).not.toBeNull();
    expect(r.f2).toMatchObject({ status: "cancelled", needs_run_end_emit: true });
    expect(r.f3).toMatchObject({ status: "running", stop_requested: true, needs_run_end_emit: false, finished_at: null });
    expect(r.f4).toMatchObject({ status: "queued", needs_run_end_emit: false, stop_requested: false, finished_at: null });
    expect(r.f5).toMatchObject({ status: "running", stop_requested: false });
    expect(Object.values(r as Record<string, Record<string, any>>).filter((x) => x.status === "success")).toHaveLength(3);
  });

  it("closes open influencer cards as stale exactly once and never touches one mid-execution", async () => {
    const a = Object.fromEntries((await rows("select id, status, note, exec_status from channel_actions")).map((r) => [r.id, r]));
    expect(a[A_INF_OPEN]).toMatchObject({ status: "stale", note: "Influencers removed: UGC Videos covers creator work." });
    expect(a[A_INF_SNOOZED]).toMatchObject({ status: "stale", note: "founder note" });
    expect(a[A_INF_QUEUED]).toMatchObject({ status: "pending", exec_status: "queued" });
    expect(a[A_INF_ACTED]).toMatchObject({ status: "acted" });
    expect(a[A_UGC_OPEN]).toMatchObject({ status: "pending" });
    const events = await rows("select action_id, event, actor_kind from channel_action_events order by action_id");
    expect(events).toEqual([
      { action_id: A_INF_OPEN, event: "stale_flagged", actor_kind: "system" },
      { action_id: A_INF_SNOOZED, event: "stale_flagged", actor_kind: "system" },
    ]);
  });

  it("supersedes influencer bets, deletes its channel and schedule config, frees its reserved names, and keeps history and every other row", async () => {
    expect(await rows("select channel_slug, status from growth_plan_bets order by channel_slug nulls last, status")).toEqual([
      { channel_slug: "influencer", status: "rejected" },
      { channel_slug: "influencer", status: "superseded" },
      { channel_slug: "influencer", status: "superseded" },
      { channel_slug: "ugc", status: "proposed" },
      { channel_slug: null, status: "proposed" },
    ]);
    expect(await rows("select channel_slug from tenant_channels")).toEqual([{ channel_slug: "ugc" }]);
    expect(await rows("select channel_slug, item from channel_settings")).toEqual([{ channel_slug: "ugc", item: "keep" }]);
    expect(await rows("select agent_slug from tenant_agent_schedules")).toEqual([{ agent_slug: "research" }]);
    expect(await rows("select agent_slug from tenant_agent_kill_switch")).toEqual([{ agent_slug: "engineer" }]);
    expect(await rows("select agent_slug, status from agent_reminders order by agent_slug, status")).toEqual([
      { agent_slug: "influencer", status: "cancelled" },
      { agent_slug: "influencer", status: "fired" },
      { agent_slug: "ugc", status: "pending" },
    ]);
    expect(await rows("select name_norm from custom_agent_reserved_names order by name_norm")).toEqual([{ name_norm: "operator" }, { name_norm: "ugc videos" }]);
  });
});
