import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Client, Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const BUCKET = read("20261009100000_channel_action_exec_bucket.sql");
const APPROVE = read("20261009100050_approve_channel_action_refuse_blocked.sql");
const DEDUPE = read("20261009100200_channel_card_layered_dedupe.sql");
const DISPLACE = read("20261009100400_displace_channel_actions_card_lock.sql");

const PG_URL = process.env.ZAVI_TEST_PG_URL;
const host = (() => {
  try {
    return PG_URL ? new URL(PG_URL).hostname : null;
  } catch {
    return null;
  }
})();
const LOCAL = host === "127.0.0.1" || host === "localhost" || host === "::1";
const SHOULD_RUN = !!PG_URL && LOCAL;
if (process.env.REQUIRE_RLS_MATRIX === "1" && !SHOULD_RUN) {
  throw new Error(`[channel-card-dedupe-live] REQUIRE_RLS_MATRIX=1 but the suite would skip (url=${!!PG_URL}, local=${LOCAL}).`);
}

const BOOTSTRAP = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  create table tenant_users (tenant_id uuid not null, user_id uuid not null, primary key (tenant_id, user_id));
  create table agent_runs (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, channel_slug text);
  create table channel_actions (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null,
    channel_slug text not null,
    run_id uuid not null,
    position int not null check (position >= 1),
    run_of int not null check (run_of >= 1),
    blocking boolean not null default false,
    action_type text not null check (action_type in (
      'text_post','image_post','video_post','reply','send_message',
      'create_ad','update_ad','pause_ad','fix','check','setup','page','other')),
    title text not null check (char_length(title) between 1 and 300),
    title_key text not null,
    body jsonb not null,
    status text not null default 'pending'
      check (status in ('pending','acted','rejected','snoozed','redone','stale','displaced')),
    status_at timestamptz,
    note text check (note is null or char_length(note) <= 1000),
    snoozed_until timestamptz,
    repeat_of uuid references channel_actions(id) on delete set null,
    redo_of uuid references channel_actions(id) on delete set null,
    baseline_metrics jsonb not null default '{}',
    impact smallint check (impact between 1 and 5),
    impact_reason text,
    score numeric not null default 0,
    score_inputs jsonb not null default '{}',
    score_version smallint not null default 1,
    scored_at timestamptz,
    proposed_at timestamptz not null default clock_timestamp(),
    exec_class text,
    exec_payload jsonb,
    exec_status text check (exec_status in ('queued','dispatching','executed','failed')),
    exec_result jsonb,
    executed_at timestamptz,
    approved_by uuid,
    approved_by_source text,
    edited_body jsonb,
    exec_claim_id uuid,
    exec_claimed_at timestamptz,
    card_kind text,
    primary_label text,
    done_label text,
    how_to jsonb not null default '[]'::jsonb,
    steps_done jsonb not null default '[]'::jsonb,
    unique (run_id, position),
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
  create table channel_metrics (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null, channel_slug text not null, metric_key text not null,
    value numeric not null, unit text, window_kind text not null, day date not null,
    source text not null, grounded boolean not null default false, run_id uuid,
    unique (tenant_id, channel_slug, metric_key, window_kind, day)
  );
`;

const T = randomUUID();
const T2 = randomUUID();
const USER = randomUUID();
const CH = "youtube_ads";

type J = Record<string, unknown>;

describe.skipIf(!SHOULD_RUN)("channel card layered dedupe, live and concurrent", () => {
  let admin: Client;
  let pool: Pool;
  let dbName = "";
  let tearingDown = false;

  const q = async <R = J>(sql: string, params: unknown[] = []): Promise<R[]> => (await pool.query(sql, params)).rows as R[];
  const one = async <R = J>(sql: string, params: unknown[] = []): Promise<R> => (await q<R>(sql, params))[0];
  const newRun = async (tenant = T, channel = CH) => (await one<{ id: string }>("insert into agent_runs (tenant_id, channel_slug) values ($1, $2) returning id", [tenant, channel])).id;
  const execOn = (c: Pool | PoolClient, run: string, action: J, tenant = T) =>
    c.query("select record_channel_exec_action($1, $2, $3::jsonb) r", [tenant, run, JSON.stringify(action)]).then((x) => x.rows[0].r as J);
  const exec = (run: string, action: J, tenant = T) => execOn(pool, run, action, tenant);
  const proseOn = (c: Pool | PoolClient, run: string, actions: J[], tenant = T, stale: J[] = []) =>
    c
      .query("select record_channel_run_actions($1, $2, $3::jsonb, '[]'::jsonb, $4::jsonb) r", [tenant, run, JSON.stringify(actions), JSON.stringify(stale)])
      .then((x) => x.rows[0].r as J);
  const prose = (run: string, actions: J[], tenant = T, stale: J[] = []) => proseOn(pool, run, actions, tenant, stale);
  const row = (id: string) =>
    one<{ status: string; repeat_of: string | null; target_key: string | null; exec_status: string | null; note: string | null }>(
      "select status, repeat_of, target_key, exec_status, note from channel_actions where id = $1",
      [id],
    );
  const openOn = async (target: string, tenant = T) =>
    (await q<{ id: string }>("select id from channel_actions where tenant_id = $1 and channel_slug = $2 and target_key = $3 and status in ('pending','snoozed') order by proposed_at", [tenant, CH, target])).map((r) => r.id);

  let seq = 0;
  const target = () => `campaign:yt ${++seq}`;
  const budget = (tk: string, usd: number, extra: J = {}): J => ({
    exec_class: "google_ads.update_campaign_budget",
    exec_payload: { campaign_id: tk, daily_budget_usd: usd, expected_current_daily_budget_usd: 10, over_cap: false, rationale: `raise to ${usd}`, name: tk },
    action_type: "update_ad",
    title: `Budget ${usd}`,
    body: { step: { title: "t", body: "b" } },
    target_key: tk,
    ...extra,
  });
  const pause = (tk: string, extra: J = {}): J => ({
    exec_class: "google_ads.set_status",
    exec_payload: { campaign_id: tk, level: "campaign", status: "PAUSED", over_cap: false, rationale: "pause", name: tk },
    action_type: "pause_ad",
    title: "Pause it",
    body: { step: { title: "t", body: "b" } },
    target_key: tk,
    ...extra,
  });
  const card = (tk: string, title: string, extra: J = {}): J => ({
    title,
    action_type: "fix",
    body: { step: { title, body: "b" } },
    target_key: tk,
    ...extra,
  });
  const waitsOnAdvisory = async (pid: number) => {
    for (let i = 0; i < 100; i++) {
      const r = await one<{ w: string | null }>("select wait_event w from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'", [pid]);
      if (r?.w === "advisory") return true;
      await new Promise((res) => setTimeout(res, 20));
    }
    return false;
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: PG_URL });
    await admin.connect();
    dbName = `zavi_card_dedupe_${randomBytes(6).toString("hex")}`;
    await admin.query(`create database ${dbName}`);
    const u = new URL(PG_URL!);
    u.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: u.toString(), max: 8 });
    pool.on("error", (err: Error & { code?: string }) => {
      if (!(tearingDown && err.code === "57P01")) throw err;
    });
    await pool.query(BOOTSTRAP);
    await pool.query(BUCKET);
    await pool.query(APPROVE);
    await pool.query(DEDUPE);
    await pool.query(DISPLACE);
    await pool.query("insert into tenant_users values ($1, $2)", [T, USER]);
  });

  afterAll(async () => {
    tearingDown = true;
    await pool?.end().catch(() => {});
    if (admin) {
      if (dbName) await admin.query(`drop database if exists ${dbName} with (force)`).catch(() => {});
      await admin.end();
    }
  });

  it("schema: target_key column and both partial indexes exist", async () => {
    const idx = (await q<{ indexname: string }>("select indexname from pg_indexes where tablename = 'channel_actions'")).map((r) => r.indexname);
    expect(idx).toEqual(expect.arrayContaining(["channel_actions_open_target_idx", "channel_actions_open_by_channel_idx"]));
    await expect(pool.query("update channel_actions set target_key = repeat('x', 301) where false")).resolves.toBeDefined();
    const run = await newRun();
    await expect(exec(run, budget("x".repeat(301), 5))).resolves.toMatchObject({ ok: true });
  });

  it("exec/exec: the second writer waits on the lock, then Layer 1 retires and chains the first", async () => {
    const tk = target();
    const [r1, r2] = [await newRun(), await newRun()];
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("begin");
      const first = await execOn(a, r1, budget(tk, 50));
      const bPid = (await b.query("select pg_backend_pid() p")).rows[0].p as number;
      const second = execOn(b, r2, budget(tk, 60));
      expect(await waitsOnAdvisory(bPid)).toBe(true);
      await a.query("commit");
      const s = await second;
      expect(s).toMatchObject({ ok: true, replayed: false, replaced: 1, repeat_of: first.id });
      expect(await openOn(tk)).toEqual([s.id]);
      expect(await row(first.id as string)).toMatchObject({ status: "stale", note: "Replaced by a newer version: Budget 60" });
      const ev = await one<{ n: string }>("select count(*) n from channel_action_events where action_id = $1 and event_key = $2", [first.id, `replaced:${s.id}`]);
      expect(Number(ev.n)).toBe(1);
    } finally {
      a.release();
      b.release();
    }
  });

  it("exec/exec in parallel: exactly one open card, the other chained through repeat_of", async () => {
    const tk = target();
    const [r1, r2] = [await newRun(), await newRun()];
    const [x, y] = await Promise.all([exec(r1, budget(tk, 70)), exec(r2, budget(tk, 75))]);
    const open = await openOn(tk);
    expect(open).toHaveLength(1);
    const winner = open[0] === x.id ? x : y;
    const loser = winner === x ? y : x;
    expect(winner.repeat_of).toBe(loser.id);
    expect((await row(loser.id as string)).status).toBe("stale");
  });

  it("same-run replay in parallel, then an immediate approve, then a third replay", async () => {
    const tk = target();
    const r1 = await newRun();
    const A = budget(tk, 40);
    const [x, y] = await Promise.all([exec(r1, A), exec(r1, A)]);
    expect(x.id).toBe(y.id);
    expect([x.replayed, y.replayed].sort()).toEqual([false, true]);
    expect(Number((await one<{ n: string }>("select count(*) n from channel_actions where run_id = $1", [r1])).n)).toBe(1);
    const ap = await one<{ r: J }>("select approve_channel_action($1, $2, $3, $4) r", [T, x.id, randomUUID(), USER]);
    expect(ap.r).toMatchObject({ ok: true });
    expect((await row(x.id as string)).exec_status).toBe("queued");
    const z = await exec(r1, A);
    expect(z).toMatchObject({ ok: true, id: x.id, replayed: true });
    expect((await row(x.id as string)).exec_status).toBe("queued");
    const r2 = await newRun();
    expect(await exec(r2, budget(tk, 45))).toMatchObject({ ok: true, id: x.id, kept: true });
    expect(await openOn(tk)).toEqual([x.id]);
  });

  it("snapshot re-match: an unseen same-target card forces rematch; once judged, the card lands", async () => {
    const tk = target();
    const X = await exec(await newRun(), budget(tk, 30));
    const r2 = await newRun();
    expect(await exec(r2, pause(tk, { judged_ids: [] }))).toEqual({ ok: false, code: "rematch", reason: "unseen_same_target" });
    expect(Number((await one<{ n: string }>("select count(*) n from channel_actions where run_id = $1", [r2])).n)).toBe(0);
    const landed = await exec(r2, pause(tk, { judged_ids: [X.id, "not-a-uuid"] }));
    expect(landed).toMatchObject({ ok: true, replayed: false, replaced: 0 });
    expect(await openOn(tk)).toEqual([X.id, landed.id]);
  });

  it("repeat target closed -> rematch; touched -> kept; untouched -> retired and chained", async () => {
    const tk = target();
    const X = await exec(await newRun(), budget(tk, 30));
    await pool.query("update channel_actions set status = 'rejected' where id = $1", [X.id]);
    expect(await exec(await newRun(), pause(tk, { repeat_of: X.id, judged_ids: [X.id] }))).toMatchObject({ ok: false, code: "rematch", reason: "repeat_closed" });

    const X2 = await exec(await newRun(), budget(tk, 31));
    await pool.query("update channel_actions set edited_body = '{\"title\":\"mine\"}' where id = $1", [X2.id]);
    expect(await exec(await newRun(), pause(tk, { repeat_of: X2.id, judged_ids: [X2.id] }))).toEqual({ ok: true, id: X2.id, replayed: false, kept: true });
    expect(await openOn(tk)).toEqual([X2.id]);

    const tk3 = target();
    const P = await prose(await newRun(), [card(tk3, "Fix the YT campaign targeting")]);
    const oldId = ((P.ids as J[])[0].id) as string;
    const N = await exec(await newRun(), pause(tk3, { repeat_of: oldId, judged_ids: [oldId] }));
    expect(N).toMatchObject({ ok: true, replaced: 1, repeat_of: oldId });
    expect((await row(oldId)).status).toBe("stale");
  });

  it("a partial-risk failure, a snoozed card and a ticked step are never retired", async () => {
    for (const touch of [
      "exec_status = 'failed', exec_result = '{\"error\":\"x\",\"bucket\":\"partial_risk\"}'",
      "status = 'snoozed', snoozed_until = now() + interval '1 day'",
      "steps_done = '[0]'",
    ]) {
      const tk = target();
      const X = await exec(await newRun(), budget(tk, 20));
      await pool.query(`update channel_actions set ${touch} where id = $1`, [X.id]);
      expect(await exec(await newRun(), budget(tk, 25)), touch).toMatchObject({ ok: true, id: X.id, kept: true });
    }
  });

  it("a campaign name alone is never Layer 1: two different creates with one name both stay", async () => {
    const tk = target();
    const create = (usd: number): J => ({
      exec_class: "google_ads.create_campaign",
      exec_payload: { name: "Same Name", daily_budget_usd: usd, rationale: "r" },
      action_type: "create_ad",
      title: `Create ${usd}`,
      body: { step: {} },
      target_key: tk,
    });
    const a = await exec(await newRun(), create(10));
    const b = await exec(await newRun(), create(20));
    expect(await openOn(tk)).toEqual([a.id, b.id]);
    const nameOnly: J = { ...create(0), exec_payload: { name: "Only A Name" }, target_key: target() };
    const c = await exec(await newRun(), nameOnly);
    const d = await exec(await newRun(), nameOnly);
    expect(d).toMatchObject({ ok: true, replaced: 0 });
    expect((await row(c.id as string)).status).toBe("pending");
    const e = await exec(await newRun(), create(10));
    expect(e).toMatchObject({ replaced: 1, repeat_of: a.id });
    expect(await openOn(tk)).toEqual([b.id, e.id]);
  });

  it("prose/prose in parallel: one open card for the same target, type and title", async () => {
    const tk = target();
    const [r3, r4] = [await newRun(), await newRun()];
    const [x, y] = await Promise.all([prose(r3, [card(tk, "Fix the landing page")]), prose(r4, [card(tk, "Fix  the landing page")])]);
    const open = await openOn(tk);
    expect(open).toHaveLength(1);
    expect(Number(x.replaced) + Number(y.replaced)).toBe(1);
    const repeat = (await row(open[0])).repeat_of;
    expect(repeat).not.toBeNull();
    expect((await row(repeat!)).status).toBe("stale");
  });

  it("prose waits on the exec writer's lock (one key for both)", async () => {
    const tk = target();
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("begin");
      await execOn(a, await newRun(), budget(tk, 11));
      const bPid = (await b.query("select pg_backend_pid() p")).rows[0].p as number;
      const later = proseOn(b, await newRun(), [card(tk, "Raise the YT budget", { judged_ids: [] })]);
      expect(await waitsOnAdvisory(bPid)).toBe(true);
      await a.query("commit");
      expect(await later).toEqual({ rematch: true, positions: [1] });
    } finally {
      a.release();
      b.release();
    }
  });

  it("prose/exec in parallel on one target, each judged against nothing: exactly one lands, the other re-matches", async () => {
    const tk = target();
    const [rp, re] = [await newRun(), await newRun()];
    const [p, e] = await Promise.all([prose(rp, [card(tk, "Rethink the YT budget", { judged_ids: [] })]), exec(re, budget(tk, 99, { judged_ids: [] }))]);
    const proseLanded = Number(p.inserted ?? 0) === 1;
    const execLanded = e.ok === true;
    expect(proseLanded !== execLanded).toBe(true);
    expect(proseLanded ? e : p).toMatchObject(proseLanded ? { code: "rematch" } : { rematch: true });
    expect(await openOn(tk)).toHaveLength(1);
  });

  it("prose: a touched Layer-1 twin keeps the old card; a replay reports, never retires", async () => {
    const tk = target();
    const first = await prose(await newRun(), [card(tk, "Add FAQ")]);
    const oldId = (first.ids as J[])[0].id as string;
    await pool.query("update channel_actions set steps_done = '[1]' where id = $1", [oldId]);
    const r = await newRun();
    const second = await prose(r, [card(tk, "Add FAQ")]);
    expect(second).toMatchObject({ inserted: 0, replacements_refused: 1, ids: [{ position: 1, id: oldId, kept: true }] });
    await pool.query("update channel_actions set steps_done = '[]' where id = $1", [oldId]);
    const third = await prose(r, [card(tk, "Add FAQ")]);
    expect(third).toMatchObject({ inserted: 1, replaced: 1 });
    const replay = await prose(r, [card(tk, "Add FAQ", { judged_ids: [] })]);
    expect(replay).toMatchObject({ inserted: 0, replaced: 0 });
    expect(await openOn(tk)).toHaveLength(1);
  });

  it("prose: a matcher replacement whose old card closed re-matches; a model restatement of it does not", async () => {
    const tk = target();
    const first = await prose(await newRun(), [card(tk, "Write the launch post")]);
    const oldId = (first.ids as J[])[0].id as string;
    await pool.query("update channel_actions set status = 'acted' where id = $1", [oldId]);
    expect(await prose(await newRun(), [card(target(), "Write it again", { repeat_of: oldId, repeat_matched: true })])).toEqual({ rematch: true, positions: [1] });
    expect(await prose(await newRun(), [card(target(), "Write it again", { repeat_of: oldId })])).toMatchObject({ inserted: 1 });
  });

  it("cross-tenant: another tenant's repeat_of, judged ids and backfill calls do nothing", async () => {
    const tk = target();
    const X = await exec(await newRun(), budget(tk, 12));
    const P = await prose(await newRun(), [card(target(), "Tenant A card")]);
    const pid = (P.ids as J[])[0].id as string;
    const foreign = await exec(await newRun(T2), budget(tk, 13, { repeat_of: X.id, judged_ids: [X.id] }), T2);
    expect(foreign).toMatchObject({ ok: true, replaced: 0, repeat_of: null });
    const foreignProse = await prose(await newRun(T2), [card(tk, "Budget 12", { repeat_of: pid, repeat_matched: true, judged_ids: [X.id, foreign.id] })], T2);
    expect(foreignProse).toMatchObject({ inserted: 1, replaced: 0 });
    expect((await row(X.id as string)).status).toBe("pending");
    expect((await row(pid)).status).toBe("pending");
    expect(await one("select chain_channel_action_repeat($1, $2, $3) r", [T2, X.id, foreign.id])).toEqual({ r: { ok: false, code: "not_found" } });
    expect(await one("select stamp_channel_action_target_keys($1, $2::jsonb) r", [T2, JSON.stringify([{ id: pid, target_key: "page:/x" }])])).toEqual({ r: 0 });
    expect((await row(pid)).target_key).not.toBe("page:/x");
    await expect(exec(await newRun(T2), budget(tk, 1), T)).rejects.toThrow(/belongs to tenant/);
  });

  it("backfill: stamp keys only where missing; chain an old duplicate; replay; refuse a touched or newer old card", async () => {
    const run = await newRun();
    const ins = async (title: string, over = ""): Promise<string> =>
      (await one<{ id: string }>(
        `insert into channel_actions (tenant_id, channel_slug, run_id, position, run_of, action_type, title, title_key, body${over ? ", " + over.split("=")[0] : ""})
         values ($1, $2, $3, (select coalesce(max(position), 0) + 1 from channel_actions where run_id = $3), 1, 'fix', $4, lower($4), '{}'${over ? ", " + over.split("=")[1] : ""}) returning id`,
        [T, CH, run, title],
      )).id;
    const old = await ins("Dup");
    const keyed = await ins("Keyed", "target_key='page:/keep'");
    const newer = await ins("Dup");
    expect(await one("select stamp_channel_action_target_keys($1, $2::jsonb) r", [T, JSON.stringify([{ id: old, target_key: "page:/dup" }, { id: newer, target_key: "page:/dup" }, { id: keyed, target_key: "page:/other" }])])).toEqual({ r: 2 });
    expect((await row(keyed)).target_key).toBe("page:/keep");
    expect(await one("select chain_channel_action_repeat($1, $2, $3) r", [T, newer, old])).toEqual({ r: { ok: false, code: "not_newer" } });
    expect(await one("select chain_channel_action_repeat($1, $2, $3) r", [T, old, newer])).toEqual({ r: { ok: true, replayed: false, chained: true } });
    expect(await row(old)).toMatchObject({ status: "stale" });
    expect((await row(newer)).repeat_of).toBe(old);
    expect(await one("select chain_channel_action_repeat($1, $2, $3) r", [T, old, newer])).toEqual({ r: { ok: true, replayed: true } });
    const touched = await ins("Dup2", "edited_body='{\"a\":1}'");
    const twin = await ins("Dup2");
    expect(await one("select chain_channel_action_repeat($1, $2, $3) r", [T, touched, twin])).toEqual({ r: { ok: false, code: "touched" } });
    expect((await row(twin)).repeat_of).toBeNull();
    expect((await row(touched)).status).toBe("pending");
  });

  it("list_open_card_channels pages by (tenant, channel) and counts keyless cards", async () => {
    const all = await q<{ tenant_id: string; channel_slug: string; open_count: number; keyless_count: number }>("select * from list_open_card_channels(null, null, 500)");
    const sorted = [...all].sort((a, b) => (a.tenant_id + a.channel_slug).localeCompare(b.tenant_id + b.channel_slug));
    expect(all.map((r) => r.tenant_id + r.channel_slug)).toEqual(sorted.map((r) => r.tenant_id + r.channel_slug));
    expect(all.find((r) => r.tenant_id === T && r.channel_slug === CH)!.open_count).toBeGreaterThan(1);
    const first = all[0];
    const rest = await q<{ tenant_id: string }>("select * from list_open_card_channels($1, $2, 500)", [first.tenant_id, first.channel_slug]);
    expect(rest).toHaveLength(all.length - 1);
  });

  const displaceOn = (c: Pool | PoolClient, run: string, losers: string[], channel = CH, tenant = T) =>
    c
      .query("select displace_channel_actions($1, $2, $3, $4::uuid[], 'Winner') r", [tenant, channel, run, losers])
      .then((x) => x.rows[0].r as J);

  it("displacement waits for a writer that holds the card lock, holding no row lock while it waits", async () => {
    const tk = target();
    const other = target();
    const x = await exec(await newRun(), budget(tk, 50));
    const y = await exec(await newRun(), budget(other, 20));
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("begin");
      const w = await execOn(a, await newRun(), budget(tk, 60));
      expect(w).toMatchObject({ ok: true, replaced: 1, repeat_of: x.id });
      const bPid = (await b.query("select pg_backend_pid() p")).rows[0].p as number;
      const displacing = displaceOn(b, await newRun(), [y.id as string, x.id as string]);
      expect(await waitsOnAdvisory(bPid)).toBe(true);
      await expect(a.query("select id from channel_actions where id = $1 for update nowait", [y.id])).resolves.toBeDefined();
      await a.query("commit");
      expect(await displacing).toEqual({ ok: true, displaced: 1, skipped: 1 });
      expect((await row(y.id as string)).status).toBe("displaced");
      expect((await row(x.id as string)).status).toBe("stale");
    } finally {
      await a.query("rollback").catch(() => {});
      a.release();
      b.release();
    }
  });

  it("a writer waits for a displacement that holds the card lock, then lands", async () => {
    const loser = await exec(await newRun(), budget(target(), 15));
    const tk = target();
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await b.query("begin");
      expect(await displaceOn(b, await newRun(), [loser.id as string])).toEqual({ ok: true, displaced: 1, skipped: 0 });
      const aPid = (await a.query("select pg_backend_pid() p")).rows[0].p as number;
      const writing = execOn(a, await newRun(), budget(tk, 40));
      expect(await waitsOnAdvisory(aPid)).toBe(true);
      await b.query("commit");
      expect(await writing).toMatchObject({ ok: true, replayed: false });
      expect(await openOn(tk)).toHaveLength(1);
    } finally {
      await b.query("rollback").catch(() => {});
      a.release();
      b.release();
    }
  });

  it("writer and displacement in parallel, both orders, many times: no deadlock", async () => {
    for (let i = 0; i < 12; i++) {
      const tk = target();
      const old = await exec(await newRun(), budget(tk, 30 + i));
      const loser = await exec(await newRun(), budget(target(), 5 + i));
      const losers = i % 2 ? [loser.id as string, old.id as string] : [old.id as string, loser.id as string];
      const writeRun = await newRun();
      const displaceRun = await newRun();
      const startWrite = () => exec(writeRun, budget(tk, 80 + i));
      const startDisplace = () => displaceOn(pool, displaceRun, losers);
      const [w, d] =
        i % 2
          ? await Promise.all([startWrite(), startDisplace()])
          : await Promise.all([startDisplace(), startWrite()]).then(([dd, ww]) => [ww, dd] as const);
      expect(w).toMatchObject({ ok: true });
      expect(d).toMatchObject({ ok: true });
      expect((d.displaced as number) + (d.skipped as number)).toBe(2);
      expect((await row(loser.id as string)).status).toBe("displaced");
      expect(await openOn(tk)).toHaveLength(1);
    }
  });

  it("displacement never row-locks a loser of another channel or tenant", async () => {
    const otherChannel = "meta_ads";
    const run = await newRun(T, otherChannel);
    const foreign = await one<{ id: string }>(
      `insert into channel_actions (tenant_id, channel_slug, run_id, position, run_of, action_type, title, title_key, body)
       values ($1, $2, $3, 1, 1, 'fix', 'Other channel', 'other channel', '{}') returning id`,
      [T, otherChannel, run],
    );
    const a = await pool.connect();
    try {
      await a.query("begin");
      await a.query("select id from channel_actions where id = $1 for update", [foreign.id]);
      const d = await Promise.race([
        displaceOn(pool, await newRun(), [foreign.id]),
        new Promise<J>((res) => setTimeout(() => res({ timed_out: true }), 2000)),
      ]);
      expect(d).toEqual({ ok: true, displaced: 0, skipped: 1 });
      const d2 = await displaceOn(pool, await newRun(), [foreign.id], CH, T2);
      expect(d2).toEqual({ ok: true, displaced: 0, skipped: 1 });
    } finally {
      await a.query("rollback").catch(() => {});
      a.release();
    }
    expect((await row(foreign.id)).status).toBe("pending");
  });

  it("grants: service_role only on every new or changed function", async () => {
    const can = async (role: string, sig: string) => (await one<{ c: boolean }>("select has_function_privilege($1, $2, 'execute') c", [role, sig])).c;
    for (const sig of [
      "record_channel_exec_action(uuid, uuid, jsonb)",
      "record_channel_run_actions(uuid, uuid, jsonb, jsonb, jsonb)",
      "list_open_card_channels(uuid, text, int)",
      "stamp_channel_action_target_keys(uuid, jsonb)",
      "chain_channel_action_repeat(uuid, uuid, uuid)",
      "displace_channel_actions(uuid, text, uuid, uuid[], text)",
    ]) {
      expect(await can("service_role", sig), sig).toBe(true);
      expect(await can("authenticated", sig), sig).toBe(false);
      expect(await can("anon", sig), sig).toBe(false);
    }
  });
});
