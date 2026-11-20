import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf-8");
const FILE = "20261112090000_plan_retires_off_plan_cards.sql";

function fn(file: string, name: string): string {
  const sql = read(file);
  const start = sql.indexOf(`create or replace function ${name}(`);
  const body = sql.indexOf("$$", start);
  const end = sql.indexOf("$$;", body + 2) + 3;
  if (start < 0 || body < 0 || end < 3) throw new Error(`missing SQL function ${name} in ${file}`);
  return sql.slice(start, end);
}

describe(FILE, () => {
  it("its card retirement survives in the latest definition of commit_growth_plan", () => {
    const defs = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => read(f).includes("create or replace function commit_growth_plan("))
      .sort();
    expect(defs).toContain(FILE);
    expect(fn(defs[defs.length - 1], "commit_growth_plan")).toContain("perform retire_cards_off_plan(p_tenant_id, v_plan_id, v_was)");
  });
});

type Db = {
  exec: (q: string) => Promise<unknown>;
  query: <R = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<{ rows: R[] }>;
  close: () => Promise<void>;
};

const SCHEMA = `
  create role anon; create role authenticated; create role service_role;
  create table tenants (id uuid primary key);
  create table praxis_logs (id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
    level text not null check (level in ('error','warn','info')), source text, code text, message text, tenant_id uuid, meta jsonb);
  create table growth_plan (id uuid primary key default gen_random_uuid(), tenant_id uuid, status text default 'live',
    objective text, north_star_metric text, constraint_statement text, constraint_confidence text, basis_evidence jsonb,
    version int default 1, created_at timestamptz default now(), updated_at timestamptz default now());
  create unique index one_live_plan on growth_plan (tenant_id) where status = 'live';
  create table growth_plan_bets (id uuid primary key default gen_random_uuid(), tenant_id uuid, plan_id uuid, channel_slug text,
    intent text, rationale text, expected_effect text, falsifier text, status text, rejected_reason text, sort_order int,
    updated_at timestamptz default now());
  create table growth_plan_changes (id uuid primary key default gen_random_uuid(), tenant_id uuid, plan_id uuid, entity text,
    entity_id uuid, field text, old_value text, new_value text, actor_kind text, actor_ref text, note text);
  create table tenant_channels (tenant_id uuid, channel_slug text, plan_selected boolean default false, plan_selected_set_by text,
    plan_sort_order int, autorun boolean default false, autorun_set_by text, primary key (tenant_id, channel_slug));
  create table agent_runs (id uuid primary key, tenant_id uuid not null, agent_slug text, trigger text, cron_dedupe_key text, enqueued_by uuid,
    enqueued_at timestamptz not null default clock_timestamp());
  create table decisions (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, agent_run_id uuid,
    decision_class text, status text, superseded_at timestamptz, body jsonb);
  create table channel_actions (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null, channel_slug text not null, run_id uuid not null,
    title text not null default 't',
    status text not null default 'pending', status_at timestamptz, note text, snoozed_until timestamptz,
    redo_of uuid, proposed_at timestamptz not null default clock_timestamp(),
    exec_class text, exec_status text, approved_by uuid, edited_body jsonb,
    body jsonb not null default '{}'::jsonb,
    steps_done jsonb not null default '[]'::jsonb, exec_claim_id uuid, approval_envelope jsonb, cgo_hold jsonb
  );
  create table channel_action_events (
    id bigint generated always as identity primary key,
    tenant_id uuid not null, action_id uuid not null references channel_actions(id) on delete cascade,
    event text not null, actor_kind text not null, actor_user_id uuid, run_id uuid, note text,
    event_key text not null, at timestamptz not null default now(),
    unique (action_id, event_key)
  );
`;

const modules = process.env.SITES_SQL_TEST_MODULES;

describe(`${FILE} executed in Postgres (pglite)`, () => {
  let db: Db;
  let T = "";
  const OLD_T = randomUUID();
  let oldOpen = "";
  let oldDone = "";

  beforeAll(async () => {
    const { PGlite } = modules
      ? createRequire(resolve(modules, "../package.json"))("@electric-sql/pglite")
      : await import("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(SCHEMA);
    for (const [file, name] of [
      ["20260906191500_growth_plan_tables.sql", "log_growth_plan_change"],
      ["20260919035833_growth_plan_north_star_and_retire_company_goals.sql", "set_growth_plan"],
      ["20260909160000_growth_plan_bet_rationale.sql", "set_growth_plan_bet"],
    ]) {
      await db.exec(fn(file, name));
    }
    const r = randomUUID();
    await db.query("insert into agent_runs (id, tenant_id, agent_slug, trigger, cron_dedupe_key) values ($1, $2, 'x_organic', 'channel_recipe', $3)", [r, OLD_T, `first-run-preview:${OLD_T}:x_organic`]);
    oldOpen = (await db.query<{ id: string }>("insert into channel_actions (tenant_id, channel_slug, run_id) values ($1, 'x_organic', $2) returning id", [OLD_T, r])).rows[0].id;
    oldDone = (await db.query<{ id: string }>("insert into channel_actions (tenant_id, channel_slug, run_id, status) values ($1, 'x_organic', $2, 'acted') returning id", [OLD_T, r])).rows[0].id;
    await db.exec(read(FILE));
  }, 30_000);
  afterAll(async () => {
    await db?.close();
  });
  const FIRST = ["x_organic", "seo", "geo", "linkedin_organic", "reddit_organic"];
  beforeEach(async () => {
    T = randomUUID();
    await db.query("insert into tenants values ($1)", [T]);
    await commit(FIRST);
  });

  const bet = (slug: string) => ({ channel_slug: slug, intent: `do ${slug}`, expected_effect: "more", falsifier: "no change", autorun: false });
  const commit = async (slugs: string[], tenant = T) =>
    (
      await db.query<{ id: string }>(
        "select commit_growth_plan($1, 'obj', 'signups', 'constraint', 'medium', $2::jsonb, '[]'::jsonb, 'agent', 'cgo') id",
        [tenant, JSON.stringify(slugs.map(bet))],
      )
    ).rows[0].id;

  const run = async (key: string | null, trigger = "channel_recipe", tenant = T, opts: { agent?: string; by?: string } = {}) => {
    const id = randomUUID();
    const agent = opts.agent ?? (key?.split(":")[2] || "x_organic");
    await db.query(
      "insert into agent_runs (id, tenant_id, agent_slug, trigger, cron_dedupe_key, enqueued_by) values ($1, $2, $3, $4, $5, $6)",
      [id, tenant, agent, trigger, key, opts.by ?? null],
    );
    return id;
  };
  const preview = (slug: string) => run(`first-run-preview:${T}:${slug}`);

  const card = async (channel: string, runId: string, cols: Record<string, unknown> = {}, tenant = T) => {
    const names = ["tenant_id", "channel_slug", "run_id", ...Object.keys(cols)];
    const vals = [tenant, channel, runId, ...Object.values(cols).map((v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v))];
    const r = await db.query<{ id: string }>(
      `insert into channel_actions (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      vals,
    );
    return r.rows[0].id;
  };
  const status = async (id: string) =>
    (await db.query<{ status: string; note: string | null }>("select status, note from channel_actions where id = $1", [id])).rows[0];
  const events = async (id: string) =>
    (await db.query<{ event: string; actor_kind: string; event_key: string; note: string }>(
      "select event, actor_kind, event_key, note from channel_action_events where action_id = $1 order by id",
      [id],
    )).rows;

  it("closes Zavi's untouched cards on a channel the new plan dropped, and keeps the plan's own", async () => {
    const dropped = await card("x_organic", await preview("x_organic"));
    const kept = await card("seo", await preview("seo"));
    const swept = await card("geo", await run(`channel:${T}:geo:2026-10-20`));

    const plan = await commit(["seo"]);

    expect(await status(dropped)).toMatchObject({ status: "stale", note: expect.stringContaining("no longer includes this channel") });
    expect(await status(swept)).toMatchObject({ status: "stale" });
    expect(await status(kept)).toMatchObject({ status: "pending", note: null });
    expect(await events(dropped)).toEqual([
      expect.objectContaining({ event: "stale_flagged", actor_kind: "system", event_key: `plan_off:${plan}` }),
    ]);
    const log = await db.query<{ code: string; meta: { cards: number } }>(
      "select code, meta from praxis_logs where meta->>'tenant_id' = $1 and level = 'info' and tenant_id is null",
      [T],
    );
    expect(log.rows).toEqual([expect.objectContaining({ code: "growth_plan.retired_off_plan_cards", meta: expect.objectContaining({ cards: 2 }) })]);
  });

  it("never touches a card a person or an execution has touched", async () => {
    const r = await preview("x_organic");
    const founder = randomUUID();
    const touched = [
      await card("x_organic", r, { status: "snoozed", snoozed_until: "2099-01-01" }),
      await card("x_organic", r, { approved_by: founder }),
      await card("x_organic", r, { edited_body: { text: "mine" } }),
      await card("x_organic", r, { steps_done: [0] }),
      await card("x_organic", r, { exec_status: "failed", approved_by: founder }),
      await card("x_organic", r, { exec_class: "x_ads.create_campaign" }),
      await card("x_organic", r, { exec_claim_id: randomUUID() }),
      await card("x_organic", r, { approval_envelope: { by: "cgo" } }),
      await card("x_organic", r, { cgo_hold: { why: "ask" } }),
      await card("x_organic", r, { redo_of: randomUUID() }),
      await card("x_organic", r, { status: "acted" }),
    ];
    const seen = await card("x_organic", r);
    await db.query(
      "insert into channel_action_events (tenant_id, action_id, event, actor_kind, event_key) values ($1, $2, 'snoozed', 'founder', 'snoozed:1')",
      [T, seen],
    );

    await commit(["seo"]);

    for (const id of [...touched, seen]) {
      expect((await status(id)).status).not.toBe("stale");
      expect(await events(id)).not.toContainEqual(expect.objectContaining({ event: "stale_flagged" }));
    }
  });

  it("a person's change that was undone still counts as a touch", async () => {
    const r = await preview("x_organic");
    const draft = await card("x_organic", r);
    const steps = await card("x_organic", r);
    const dated = await card("x_organic", r, { body: { step: { title: "post" } } });
    const untouched = await card("x_organic", r, { body: { step: { title: "post" } } });
    await db.query("update channel_actions set edited_body = '{\"text\":\"mine\"}' where id = $1", [draft]);
    await db.query("update channel_actions set edited_body = null where id = $1", [draft]);
    await db.query("update channel_actions set steps_done = '[0]' where id = $1", [steps]);
    await db.query("update channel_actions set steps_done = '[]' where id = $1", [steps]);
    await db.query("update channel_actions set body = jsonb_set(body, '{step,publish_on}', '\"2026-11-01\"') where id = $1", [dated]);
    await db.query("update channel_actions set body = jsonb_set(body, '{step,title}', '\"reworded\"') where id = $1", [untouched]);

    await commit(["seo"]);

    for (const id of [draft, steps, dated]) expect((await status(id)).status).toBe("pending");
    expect((await status(untouched)).status).toBe("stale");
  });

  it("a card filed before touch tracking counts as touched and never closes", async () => {
    const r = await db.query<{ id: string; founder_touched_at: string | null }>(
      "select id, founder_touched_at from channel_actions where id in ($1, $2)",
      [oldOpen, oldDone],
    );
    const by = new Map(r.rows.map((x) => [x.id, x.founder_touched_at]));
    expect(by.get(oldOpen)).not.toBeNull();
    expect(by.get(oldDone)).not.toBeNull();
    await db.query("insert into tenants values ($1) on conflict do nothing", [OLD_T]);
    await commit(FIRST, OLD_T);
    await commit(["seo"], OLD_T);
    expect((await status(oldOpen)).status).toBe("pending");
  });

  const underFirstPlan = (runId: string) =>
    db.query(
      "update agent_runs set enqueued_at = (select created_at from growth_plan where tenant_id = $2 and status = 'live') + interval '1 millisecond' where id = $1",
      [runId, T],
    );
  const lateClose = async (runId: string, tenant = T) =>
    (await db.query<{ n: number }>("select close_dropped_channel_run_cards($1, $2) n", [tenant, runId])).rows[0].n;

  it("a sweep run that started under the earlier plan has its late cards closed once filed", async () => {
    const r = await run(`channel:${T}:x_organic:2026-10-22`);
    await underFirstPlan(r);
    const plan = await commit(["seo"]);
    const late = await card("x_organic", r);
    expect((await status(late)).status).toBe("pending");
    expect(await lateClose(r)).toBe(1);
    expect(await status(late)).toMatchObject({ status: "stale", note: expect.stringContaining("no longer includes this channel") });
    expect(await events(late)).toEqual([expect.objectContaining({ event_key: `plan_off:${plan}` })]);
    expect(await lateClose(r)).toBe(0);
  });

  it("the late close leaves kept channels, a person's run, a signup-round run and a first plan alone", async () => {
    const kept = await run(`channel:${T}:seo:2026-10-22`);
    const asked = await run(null);
    const gallery = await preview("pinterest_organic");
    await commit(["seo"]);
    const cards = [await card("seo", kept), await card("x_organic", asked), await card("pinterest_organic", gallery)];
    for (const r of [kept, asked, gallery]) expect(await lateClose(r)).toBe(0);
    for (const c of cards) expect((await status(c)).status).toBe("pending");

    const U = randomUUID();
    await db.query("insert into tenants values ($1)", [U]);
    const early = await run(`channel:${U}:x_organic:2026-10-22`, "channel_recipe", U);
    await db.query("update agent_runs set enqueued_at = now() - interval '1 hour' where id = $1", [early]);
    await commit(["seo"], U);
    const c = await card("x_organic", early, {}, U);
    expect(await lateClose(early, U)).toBe(0);
    expect((await status(c)).status).toBe("pending");
  });

  it("the late close never reaches another tenant's run", async () => {
    const r = await run(`channel:${T}:x_organic:2026-10-22`);
    await underFirstPlan(r);
    await commit(["seo"]);
    await card("x_organic", r);
    expect(await lateClose(r, randomUUID())).toBe(0);
    expect(await lateClose(r)).toBe(1);
  });

  it("only the post card paired with a live staged post stays; the run's other cards close", async () => {
    const r = await preview("x_organic");
    const post = await card("x_organic", r, { body: { step: { deliverable: { content: "\ufeff  Our\u00a0  LAUNCH thread is live\n today" } } } });
    const other = await card("x_organic", r, { body: { step: { deliverable: { content: "A different post entirely" } } } });
    const task = await card("x_organic", r, { body: { step: { title: "Fix your bio" } } });
    await db.query(
      "insert into decisions (tenant_id, agent_run_id, decision_class, status, body) values ($1, $2, 'social.publish.v2', 'proposed', $3)",
      [T, r, JSON.stringify({ payload: { text: "our launch thread is live today" } })],
    );
    await commit(["seo"]);
    expect((await status(post)).status).toBe("pending");
    expect((await status(other)).status).toBe("stale");
    expect((await status(task)).status).toBe("stale");
  });

  it("re-checks the channel on the row: a founder re-add before the close keeps the card", async () => {
    const r = await run(`channel:${T}:x_organic:2026-10-22`);
    await underFirstPlan(r);
    const plan = await commit(["seo"]);
    const c = await card("x_organic", r);
    await db.query("update tenant_channels set plan_selected = true, plan_selected_set_by = 'founder' where tenant_id = $1 and channel_slug = 'x_organic'", [T]);
    const n = await db.query<{ n: number }>("select close_off_plan_cards($1, $2, array['x_organic'], null) n", [T, plan]);
    expect(n.rows[0].n).toBe(0);
    expect((await status(c)).status).toBe("pending");
  });

  it("keeps cards from work a person asked for, whatever the channel", async () => {
    const asked = [
      await card("x_organic", await run(null)),
      await card("x_organic", await run(null, "chat")),
      await card("x_organic", await run(null, "handoff")),
      await card("x_organic", await run(`${T}:x_organic:2026-10-20T09`)),
      await card("x_organic", await run(`first-run-preview:${T}:x_organic`, "chat")),
      await card("x_organic", await run(`first-run-preview:${T}:x_organic`, "channel_recipe", T, { by: randomUUID() })),
      await card("x_organic", await run(`first-run-preview:${randomUUID()}:x_organic`)),
      await card("x_organic", await run(`channel:${T}:seo:2026-10-20`)),
    ];
    await commit(["seo"]);
    for (const id of asked) expect((await status(id)).status).toBe("pending");
  });

  it("keeps cards on a channel the founder put in the plan or switched on", async () => {
    await db.query("update tenant_channels set plan_selected_set_by = 'founder' where tenant_id = $1 and channel_slug = 'linkedin_organic'", [T]);
    await db.query("update tenant_channels set autorun = true, autorun_set_by = 'founder' where tenant_id = $1 and channel_slug = 'reddit_organic'", [T]);
    const added = await card("linkedin_organic", await preview("linkedin_organic"));
    const switched = await card("reddit_organic", await preview("reddit_organic"));
    await commit(["seo"]);
    expect((await status(added)).status).toBe("pending");
    expect((await status(switched)).status).toBe("pending");
  });

  it("is idempotent: committing again closes nothing new and writes no second event", async () => {
    const c = await card("x_organic", await preview("x_organic"));
    const first = await commit(["seo"]);
    await commit(["seo"]);
    expect(await events(c)).toEqual([expect.objectContaining({ event_key: `plan_off:${first}` })]);
    const logs = await db.query("select 1 from praxis_logs where meta->>'tenant_id' = $1 and code = 'growth_plan.retired_off_plan_cards'", [T]);
    expect(logs.rows).toHaveLength(1);
  });

  it("never reaches another tenant's cards", async () => {
    const U = randomUUID();
    await db.query("insert into tenants values ($1)", [U]);
    const other = await card("x_organic", await run(`first-run-preview:${U}:x_organic`, "channel_recipe", U), {}, U);
    await commit(["seo"]);
    expect((await status(other)).status).toBe("pending");
  });

  it("a failed retirement never fails the plan; it leaves a warn row", async () => {
    const c = await card("x_organic", await preview("x_organic"));
    await db.exec(`
      create function boom() returns trigger language plpgsql as $$ begin raise exception 'injected'; end $$;
      create trigger boom before update on channel_actions for each row execute function boom();
    `);
    try {
      const plan = await commit(["seo"]);
      expect(plan).toBeTruthy();
      const live = await db.query("select 1 from growth_plan where id = $1 and status = 'live'", [plan]);
      expect(live.rows).toHaveLength(1);
      expect((await status(c)).status).toBe("pending");
      const warn = await db.query<{ code: string; message: string }>(
        "select code, message from praxis_logs where meta->>'tenant_id' = $1 and level = 'warn' and tenant_id is null",
        [T],
      );
      expect(warn.rows).toEqual([{ code: "growth_plan.retire_off_plan_failed", message: `workspace ${T}: injected` }]);
    } finally {
      await db.exec("drop trigger boom on channel_actions; drop function boom();");
    }
  });

  it("keeps cards on a channel no plan ever picked (the signup round's cards)", async () => {
    const gallery = await card("pinterest_organic", await preview("pinterest_organic"));
    await commit(["seo"]);
    expect((await status(gallery)).status).toBe("pending");
  });

  it("a workspace's first plan closes nothing", async () => {
    const U = randomUUID();
    await db.query("insert into tenants values ($1)", [U]);
    const c = await card("x_organic", await run(`first-run-preview:${U}:x_organic`, "channel_recipe", U), {}, U);
    await commit(["seo"], U);
    expect((await status(c)).status).toBe("pending");
  });

  it("leaves the caller's lock_timeout as it found it", async () => {
    await db.exec("set lock_timeout = '17s'");
    await card("x_organic", await preview("x_organic"));
    await commit(["seo"]);
    const r = await db.query<{ t: string }>("select current_setting('lock_timeout') t");
    expect(r.rows[0].t).toBe("17s");
    await db.exec("reset lock_timeout");
  });

  it("closes nothing for a plan that is not the tenant's live plan", async () => {
    const c = await card("x_organic", await preview("x_organic"));
    await commit(["seo"]);
    const stalePlan = (await db.query<{ id: string }>("insert into growth_plan (tenant_id, status) values ($1, 'superseded') returning id", [T])).rows[0].id;
    await db.query("update channel_actions set status = 'pending', note = null where id = $1", [c]);
    const n = await db.query<{ n: number }>("select retire_cards_off_plan($1, $2, array['x_organic']) n", [T, stalePlan]);
    expect(n.rows[0].n).toBe(0);
    expect((await status(c)).status).toBe("pending");
  });
});
