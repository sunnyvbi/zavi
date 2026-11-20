import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/analytics/mixpanel", () => ({ track: vi.fn() }));

import { stepDecisionBodies } from "@/agents/lib/channel-recipe-step";
import { recordChannelRunActions, type ScoreContext } from "@/services/channels/channel-actions";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf-8");
const FILE = "20261111090000_untargeted_card_layer1_dedupe.sql";
const PRIOR = "20261020160000_uncertain_failed_twin_stays_open.sql";
const modules = process.env.SITES_SQL_TEST_MODULES;

function fn(sql: string, name: string): string {
  const s = sql.indexOf(`create or replace function ${name}(`);
  const a = sql.indexOf("$$", s);
  const b = sql.indexOf("$$", a + 2);
  return sql.slice(s, sql.indexOf(";", b) + 1);
}

describe(FILE, () => {
  it("is the latest definition of record_channel_run_actions", () => {
    const defs = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => read(f).includes("create or replace function record_channel_run_actions("))
      .sort();
    expect(defs[defs.length - 1]).toBe(FILE);
  });

  it("is the prior definition with only Layer 1 widened to untargeted cards", () => {
    const prior = fn(read(PRIOR), "record_channel_run_actions")
      .split("\n")
      .filter((l) => !/^\s*--/.test(l))
      .join("\n");
    const widened = prior
      .replace("        if v_kept is null and v_tkey is not null then\n", "        if v_kept is null then\n")
      .replace(
        "               and target_key = v_tkey and action_type = v_type and title_key = v_title_key\n",
        "               and (target_key = v_tkey or (v_tkey is null and target_key is null))\n               and action_type = v_type and title_key = v_title_key\n",
      );
    expect(widened).not.toBe(prior);
    expect(fn(read(FILE), "record_channel_run_actions")).toBe(widened);
    expect(read(FILE)).toContain("grant execute on function record_channel_run_actions(uuid, uuid, jsonb, jsonb, jsonb) to service_role;");
  });

  it("rebuilds the variants lab copy of the writer, so lab_card_parity still holds after deploy", () => {
    const sql = read(FILE);
    const rebuild = sql.indexOf("execute public.lab_card_fn_def();");
    expect(rebuild).toBeGreaterThan(sql.indexOf("create or replace function record_channel_run_actions("));
    expect(sql).toContain("grant execute on function lab.record_channel_run_actions(uuid, uuid, jsonb, jsonb, jsonb) to service_role");
  });
});

type Db = {
  exec: (q: string) => Promise<unknown>;
  query: <R = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<{ rows: R[] }>;
  close: () => Promise<void>;
};

const CTX: ScoreContext = {
  channel_in_plan: true,
  goal_metric_keys: new Set(),
  rejected_title_keys: new Set(),
  rejected_ids: new Set(),
};

const SCHEMA = `
  create role anon; create role authenticated; create role service_role;
  create table agent_runs (id uuid primary key, tenant_id uuid not null, channel_slug text);
  create table channel_actions (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null,
    channel_slug text not null,
    run_id uuid not null,
    position int not null,
    run_of int not null,
    blocking boolean not null default false,
    action_type text not null,
    title text not null,
    title_key text not null,
    body jsonb not null,
    status text not null default 'pending',
    status_at timestamptz,
    note text,
    snoozed_until timestamptz,
    repeat_of uuid references channel_actions(id) on delete set null,
    redo_of uuid references channel_actions(id) on delete set null,
    baseline_metrics jsonb not null default '{}',
    impact smallint,
    impact_reason text,
    score numeric not null default 0,
    score_inputs jsonb not null default '{}',
    score_version smallint not null default 1,
    scored_at timestamptz,
    proposed_at timestamptz not null default clock_timestamp(),
    exec_class text,
    exec_payload jsonb,
    exec_status text,
    exec_result jsonb,
    edited_body jsonb,
    card_kind text,
    primary_label text,
    done_label text,
    how_to jsonb not null default '[]'::jsonb,
    steps_done jsonb not null default '[]'::jsonb,
    target_key text,
    unique (run_id, position)
  );
  create table channel_action_events (
    id bigint generated always as identity primary key,
    tenant_id uuid not null,
    action_id uuid not null references channel_actions(id) on delete cascade,
    event text not null,
    actor_kind text not null,
    actor_user_id uuid,
    run_id uuid,
    note text,
    event_key text not null,
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

const CH = "linkedin_organic";

const step = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  body: `why ${title}`,
  blocking: false,
  effort: "minutes",
  evidence: ["e"],
  ...extra,
});

describe.skipIf(!modules)(`${FILE} executed in Postgres (pglite), driven by the real card writer`, () => {
  let db: Db;
  let T = "";
  const matcherEnv = process.env.CHANNEL_CARD_MATCHER;

  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(SCHEMA);
    await db.exec(read(FILE));
  });
  afterAll(async () => {
    if (matcherEnv === undefined) delete process.env.CHANNEL_CARD_MATCHER;
    else process.env.CHANNEL_CARD_MATCHER = matcherEnv;
    await db?.close();
  });
  beforeEach(() => {
    T = randomUUID();
  });

  const newRun = async (tenant = T, channel = CH) => {
    const id = randomUUID();
    await db.query("insert into agent_runs (id, tenant_id, channel_slug) values ($1, $2, $3)", [id, tenant, channel]);
    return id;
  };

  const barrier = (n: number) => {
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    return async () => {
      arrived += 1;
      if (arrived >= n) open();
      await gate;
    };
  };

  const pgRpc = (wait: () => Promise<void> = async () => undefined) =>
    vi.fn(async (tid: unknown, name: string, args: Record<string, unknown>) => {
      if (name !== "record_channel_run_actions") return { data: { displaced: 0 }, error: null };
      await wait();
      try {
        const r = await db.query<{ r: unknown }>(
          "select record_channel_run_actions($1::uuid, $2::uuid, $3::jsonb, $4::jsonb, $5::jsonb) r",
          [tid, args.p_run_id, JSON.stringify(args.p_actions), JSON.stringify(args.p_metrics), JSON.stringify(args.p_stale)],
        );
        return { data: r.rows[0].r, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    });

  const file = (runId: string, steps: Array<ReturnType<typeof step>>, rpc: ReturnType<typeof pgRpc>, opts: { tenant?: string; channel?: string } = {}) => {
    const envelope = { rendered_markdown: "r", steps };
    return recordChannelRunActions(
      { tenantId: opts.tenant ?? T, runId, channelSlug: opts.channel ?? CH, envelope, bodies: stepDecisionBodies(envelope as never), redo: null },
      {
        rpc: rpc as never,
        loadScoreContext: async () => CTX,
        stagedPosts: async () => [],
        listOpen: (async () => ({ actions: [], more: 0 })) as never,
        loadOpenCards: async () => [],
        loadMatchPool: (async () => []) as never,
        matchCards: (async () => null) as never,
        log: (async () => undefined) as never,
        track: (() => undefined) as never,
        displace: async () => 0,
      },
    );
  };

  const open = async (title: string, tenant = T, channel = CH) =>
    (
      await db.query<{ id: string; run_id: string }>(
        "select id, run_id from channel_actions where tenant_id = $1 and channel_slug = $2 and title = $3 and status in ('pending','snoozed') order by proposed_at",
        [tenant, channel, title],
      )
    ).rows;

  for (const matcher of ["0", "1"]) {
    it(`two overlapping runs file one open card for the same untargeted work (matcher ${matcher === "0" ? "off" : "on"})`, async () => {
      process.env.CHANNEL_CARD_MATCHER = matcher;
      const title = "Post the weekly founder update";
      const [a, b] = [await newRun(), await newRun()];
      const rpc = pgRpc(barrier(2));
      const [ra, rb] = await Promise.all([file(a, [step(title)], rpc), file(b, [step(title)], rpc)]);

      expect(ra.inserted + rb.inserted).toBe(2);
      const live = await open(title);
      expect(live).toHaveLength(1);
      const all = (
        await db.query<{ id: string; status: string; repeat_of: string | null; note: string | null }>(
          "select id, status, repeat_of, note from channel_actions where tenant_id = $1 and title = $2 order by proposed_at",
          [T, title],
        )
      ).rows;
      expect(all.map((r) => r.status)).toEqual(["stale", "pending"]);
      expect(all[1].repeat_of).toBe(all[0].id);
      expect(all[0].note).toBe(`Replaced by a newer version: ${title}`);
      const ev = await db.query("select 1 from channel_action_events where action_id = $1 and event = 'stale_flagged'", [all[0].id]);
      expect(ev.rows).toHaveLength(1);
    });
  }

  it("a later run keeps the founder's touched untargeted card and files nothing beside it", async () => {
    process.env.CHANNEL_CARD_MATCHER = "0";
    const title = "Reply to the three open comment threads";
    const a = await newRun();
    await file(a, [step(title)], pgRpc());
    const [first] = await open(title);
    await db.query("update channel_actions set steps_done = '[0]'::jsonb where id = $1", [first.id]);

    const b = await newRun();
    const res = await file(b, [step(title)], pgRpc());
    expect(res.inserted).toBe(0);
    expect(res.kept).toEqual([{ position: 1, id: first.id }]);
    expect((await open(title)).map((r) => r.id)).toEqual([first.id]);
  });

  it("untargeted dedupe never reaches a targeted card, another channel or another tenant", async () => {
    process.env.CHANNEL_CARD_MATCHER = "0";
    const title = "Refresh the pinned post";
    const other = randomUUID();
    await file(await newRun(), [step(title, { target: { kind: "post", ref: "urn:li:1" } })], pgRpc());
    await file(await newRun(T, "x_organic"), [step(title)], pgRpc(), { channel: "x_organic" });
    await file(await newRun(other), [step(title)], pgRpc(), { tenant: other });

    await file(await newRun(), [step(title)], pgRpc());

    expect(await open(title)).toHaveLength(2);
    expect(await open(title, T, "x_organic")).toHaveLength(1);
    expect(await open(title, other)).toHaveLength(1);
  });

  it("two different untargeted cards from overlapping runs both stay open", async () => {
    process.env.CHANNEL_CARD_MATCHER = "0";
    const rpc = pgRpc(barrier(2));
    await Promise.all([file(await newRun(), [step("Write a hiring post")], rpc), file(await newRun(), [step("Write a launch post")], rpc)]);
    expect(await open("Write a hiring post")).toHaveLength(1);
    expect(await open("Write a launch post")).toHaveLength(1);
  });
});
