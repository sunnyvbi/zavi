import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verdictFor } from "@/services/channels/exec-failure";

const dir = join(__dirname, "../../../../../supabase/migrations");
const BUCKET = readFileSync(join(dir, "20261009100000_channel_action_exec_bucket.sql"), "utf8");
const PER_CODE = readFileSync(join(dir, "20261031090000_exec_blocked_alert_per_code.sql"), "utf8");
const CODE_GROUPS = readFileSync(join(dir, "20261031150000_exec_blocked_code_groups.sql"), "utf8");

const BOOTSTRAP = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  create table tenant_users (tenant_id uuid not null, user_id uuid not null, primary key (tenant_id, user_id));
  create table channel_actions (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null,
    channel_slug text not null,
    run_id uuid not null,
    title text not null default 't',
    body jsonb not null default '{}',
    status text not null default 'pending'
      check (status in ('pending','acted','rejected','snoozed','redone','stale','displaced')),
    status_at timestamptz,
    note text check (note is null or char_length(note) <= 1000),
    exec_class text,
    exec_payload jsonb,
    exec_status text check (exec_status in ('queued','dispatching','executed','failed')),
    exec_result jsonb,
    executed_at timestamptz,
    approved_by uuid,
    approved_by_source text,
    exec_claim_id uuid,
    exec_claimed_at timestamptz,
    unique (tenant_id, id)
  );
  create table channel_action_events (
    id bigint generated always as identity primary key,
    tenant_id uuid not null,
    action_id uuid not null references channel_actions(id) on delete cascade,
    event text not null check (event in (
      'proposed','acted','rejected','snoozed','redo_requested','redone','stale_flagged',
      'displaced','revised','approved','executed','exec_failed')),
    actor_kind text not null check (actor_kind in ('founder','channel_run','system')),
    actor_user_id uuid,
    run_id uuid,
    note text check (note is null or char_length(note) <= 1000),
    event_key text not null check (char_length(event_key) between 1 and 200),
    at timestamptz not null default now(),
    unique (action_id, event_key)
  );
`;

const PG_URL = process.env.ZAVI_TEST_VANILLA_PG_URL;
const BID_REFUSAL =
  'Meta Ads write failed: 400 {"error":{"message":"Invalid parameter","type":"OAuthException","code":100,"error_subcode":2490487,"is_transient":false}}';
const OTHER_REFUSAL =
  'Meta Ads write failed: 400 {"error":{"message":"Invalid parameter","type":"OAuthException","code":100,"error_subcode":1885097,"is_transient":false}}';

describe.skipIf(!PG_URL)("one alert per platform code per 24 hours, live", () => {
  let db: Client;
  const one = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R> =>
    (await db.query(sql, params)).rows[0] as R;

  const failWith = async (tenant: string, error: string, status = "pending", execClass = "meta_ads.create_ad_set") => {
    const claim = randomUUID();
    const { id } = await one<{ id: string }>(
      `insert into channel_actions (tenant_id, channel_slug, run_id, status, exec_class, exec_status, exec_claim_id, exec_claimed_at)
       values ($1, 'meta_ads', $2, $3, $4, 'dispatching', $5, now()) returning id`,
      [tenant, randomUUID(), status, execClass, claim],
    );
    const v = verdictFor({ error }, execClass)!;
    const { note, ...stamp } = v;
    await db.query("select settle_channel_action_exec($1, $2, false, $3::jsonb, $4, $5)", [tenant, id, JSON.stringify({ error, ...stamp }), note, claim]);
    return id;
  };
  const alertsFor = async (tenant: string) =>
    (await db.query<{ dedupe_key: string; msg: string }>("select dedupe_key, msg from ops_alert_outbox where tenant_id = $1 order by id", [tenant])).rows;

  beforeAll(async () => {
    db = new Client({ connectionString: PG_URL });
    await db.connect();
    const exists = await one<{ t: string | null }>("select to_regclass('public.channel_actions')::text t");
    if (exists.t) throw new Error("ZAVI_TEST_VANILLA_PG_URL must be a VANILLA throwaway database (channel_actions already exists)");
    await db.query("begin");
    await db.query(BOOTSTRAP);
    await db.query(BUCKET);
    await db.query(PER_CODE);
    await db.query(CODE_GROUPS);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query("rollback").catch(() => {});
    await db.end();
  });

  it("must catch: the same Meta refusal on three ad sets of one tenant is ONE alert, naming the code", async () => {
    const t = randomUUID();
    const ids = [await failWith(t, BID_REFUSAL), await failWith(t, BID_REFUSAL), await failWith(t, BID_REFUSAL)];
    const rows = await alertsFor(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe(`blocked_code:${t}:meta_100_2490487:${ids[0]}`);
    expect(rows[0].msg).toContain("platform_code=meta_100_2490487");
    for (const id of ids) expect((await one<{ status: string }>("select status from channel_actions where id = $1", [id])).status).toBe("stale");
  });

  it("must catch: a refusal on a card that was no longer open (approved) still alerts once", async () => {
    const t = randomUUID();
    await failWith(t, BID_REFUSAL, "acted");
    expect(await alertsFor(t)).toHaveLength(1);
  });

  it("must not catch: a different code, or another tenant, gets its own alert", async () => {
    const t = randomUUID();
    const t2 = randomUUID();
    await failWith(t, BID_REFUSAL);
    await failWith(t, OTHER_REFUSAL);
    await failWith(t2, BID_REFUSAL);
    expect((await alertsFor(t)).map((r) => r.dedupe_key.split(":")[2]).sort()).toEqual(["meta_100_1885097", "meta_100_2490487"]);
    expect(await alertsFor(t2)).toHaveLength(1);
  });

  it("must not catch: the same code again after 24 hours alerts again", async () => {
    const t = randomUUID();
    await failWith(t, BID_REFUSAL);
    await db.query("update ops_alert_outbox set created_at = now() - interval '25 hours' where tenant_id = $1", [t]);
    await failWith(t, BID_REFUSAL);
    expect(await alertsFor(t)).toHaveLength(2);
  });

  it("a blocked failure with no platform code keeps the per-card alert on close", async () => {
    const t = randomUUID();
    const claim = randomUUID();
    const { id } = await one<{ id: string }>(
      `insert into channel_actions (tenant_id, channel_slug, run_id, status, exec_class, exec_status, exec_claim_id, exec_claimed_at)
       values ($1, 'meta_ads', $2, 'pending', 'meta_ads.create_ad_set', 'dispatching', $3, now()) returning id`,
      [t, randomUUID(), claim],
    );
    await db.query("select settle_channel_action_exec($1, $2, false, $3::jsonb, 'x', $4)", [t, id, JSON.stringify({ no_handler: true, error: "No handler is registered for x.y." }), claim]);
    expect((await alertsFor(t)).map((r) => r.dedupe_key)).toEqual([`blocked:${id}`]);
  });

  it("must catch: Zavi's own blocked code repeated across ad sets is ONE alert, grouped by the code", async () => {
    const t = randomUUID();
    const settleCode = async () => {
      const claim = randomUUID();
      const { id } = await one<{ id: string }>(
        `insert into channel_actions (tenant_id, channel_slug, run_id, status, exec_class, exec_status, exec_claim_id, exec_claimed_at)
         values ($1, 'meta_ads', $2, 'pending', 'meta_ads.create_ad_set', 'dispatching', $3, now()) returning id`,
        [t, randomUUID(), claim],
      );
      const error = "the campaign's bid strategy is COST_CAP, which needs a bid amount on every ad set";
      const v = verdictFor({ code: "meta_ads_bid_unavailable", error }, "meta_ads.create_ad_set")!;
      const { note, ...stamp } = v;
      await db.query("select settle_channel_action_exec($1, $2, false, $3::jsonb, $4, $5)", [t, id, JSON.stringify({ code: "meta_ads_bid_unavailable", error, ...stamp }), note, claim]);
      return id;
    };
    const first = await settleCode();
    await settleCode();
    await settleCode();
    expect((await alertsFor(t)).map((r) => r.dedupe_key)).toEqual([`blocked_code:${t}:meta_ads_bid_unavailable:${first}`]);
  });

  it("the SQL classifier sorts meta_ads_bid_unavailable as blocked_on_us", async () => {
    const r = await one<{ v: Record<string, unknown> }>("select classify_exec_failure($1::jsonb) v", [JSON.stringify({ code: "meta_ads_bid_unavailable", error: "e" })]);
    expect(r.v).toEqual({ bucket: "blocked_on_us", fix: null, platform_code: "meta_ads_bid_unavailable" });
  });
});
