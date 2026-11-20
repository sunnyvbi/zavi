import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

const pg = vi.hoisted(() => ({ db: null as null | { query: (q: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }, reads: [] as string[] }));

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/analytics/mixpanel", () => ({ track: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: () => {
    throw new Error("tenantRpc is not used here");
  },
  tenantClient: (tid: string) => ({
    from: (table: string) => {
      const where: string[] = ["tenant_id = $1"];
      const params: unknown[] = [tid];
      let cols = "*";
      const bind = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      const q = {
        select: (c: string) => {
          cols = c;
          return q;
        },
        eq: (c: string, v: unknown) => {
          where.push(`${c} = ${bind(v)}`);
          return q;
        },
        in: (c: string, vs: unknown[]) => {
          where.push(`${c}::text = any(${bind(vs.map(String))}::text[])`);
          return q;
        },
        is: (c: string, v: null) => {
          if (v !== null) throw new Error("is() only supports null here");
          where.push(`${c} is null`);
          return q;
        },
        then: (ok: (r: { data: unknown[] | null; error: { message: string } | null }) => unknown, bad?: (e: unknown) => unknown) => {
          const sql = `select ${cols} from ${table} where ${where.join(" and ")}`;
          pg.reads.push(sql);
          return pg
            .db!.query(sql, params)
            .then((r) => ({ data: r.rows, error: null }), (e: Error) => ({ data: null, error: { message: e.message } }))
            .then(ok, bad);
        },
      };
      return q;
    },
  }),
}));

import { stepDecisionBodies } from "@/agents/lib/channel-recipe-step";
import { projectChannelPanel, recordChannelRunActions, type PanelRow, type ScoreContext } from "@/services/channels/channel-actions";
import { supersededOpenCards, type OpenCard } from "@/services/channels/supersede-actions";

const MIGRATIONS = join(__dirname, "../../../../../../supabase/migrations");
const WRITER = "20261111090000_untargeted_card_layer1_dedupe.sql";
const CH = "email_marketing";
const CTX: ScoreContext = { channel_in_plan: true, goal_metric_keys: new Set(), rejected_title_keys: new Set(), rejected_ids: new Set() };

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
    approved_by uuid,
    approved_by_source text,
    cgo_hold jsonb,
    exec_claimed_at timestamptz,
    executed_at timestamptz,
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

const OLD = "Publish a DMARC record reporting to rua=mailto:dmarc@reports-old.yopmail.com";
const NEW = "Publish a DMARC record reporting to rua=mailto:dmarc@reports-new.yopmail.com";
const step = (title: string, extra: Record<string, unknown> = {}) => ({ title, body: `why ${title}`, blocking: false, effort: "minutes", evidence: ["dns lookup"], ...extra });

describe("a channel run that repeats a snoozed card (pglite, real writer, real open-card read)", () => {
  let db: PGlite;
  let T = "";
  const matcherEnv = process.env.CHANNEL_CARD_MATCHER;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(SCHEMA);
    await db.exec(readFileSync(join(MIGRATIONS, WRITER), "utf-8"));
    pg.db = db as never;
  });
  afterAll(async () => {
    if (matcherEnv === undefined) delete process.env.CHANNEL_CARD_MATCHER;
    else process.env.CHANNEL_CARD_MATCHER = matcherEnv;
    await db?.close();
  });
  beforeEach(() => {
    T = randomUUID();
    pg.reads.length = 0;
  });

  const newRun = async () => {
    const id = randomUUID();
    await db.query("insert into agent_runs (id, tenant_id, channel_slug) values ($1, $2, $3)", [id, T, CH]);
    return id;
  };

  const rpc = vi.fn(async (tid: unknown, name: string, args: Record<string, unknown>) => {
    if (name !== "record_channel_run_actions") return { data: { displaced: 0 }, error: null };
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

  const file = (runId: string, steps: Array<ReturnType<typeof step>>, match: { oldId: string } | null = null) => {
    const envelope = { rendered_markdown: "r", steps };
    return recordChannelRunActions(
      { tenantId: T, runId, channelSlug: CH, envelope, bodies: stepDecisionBodies(envelope as never), redo: null },
      {
        rpc: rpc as never,
        loadScoreContext: async () => CTX,
        stagedPosts: async () => [],
        listOpen: (async () => ({ actions: [], more: 0 })) as never,
        loadMatchPool: (async () =>
          match ? [{ id: match.oldId, channel: CH, status: "open", title: OLD, summary: `why ${OLD}` }] : []) as never,
        matchCards: (async () =>
          match
            ? { verdicts: [{ ref: "n0", decision: "same_open", match_id: match.oldId, changed: true, reason: "same DMARC setup" }], input_tokens: 0, output_tokens: 0 }
            : null) as never,
        log: (async () => undefined) as never,
        track: (() => undefined) as never,
        displace: async () => 0,
      },
    );
  };

  const snoozedOld = async (until: string) => {
    await file(await newRun(), [step(OLD)]);
    const { rows } = await db.query<{ id: string }>("select id from channel_actions where tenant_id = $1 and title = $2", [T, OLD]);
    await db.query("update channel_actions set status = 'snoozed', snoozed_until = $2::timestamptz, status_at = now() where id = $1", [rows[0].id, until]);
    return rows[0].id;
  };

  const cards = async () =>
    (
      await db.query<{ id: string; title: string; status: string; repeat_of: string | null; note: string | null }>(
        "select id, title, status, repeat_of, note from channel_actions where tenant_id = $1 order by proposed_at",
        [T],
      )
    ).rows;

  const fixFirst = async () => {
    const { rows } = await db.query<PanelRow>(
      "select * from channel_actions where tenant_id = $1 and channel_slug = $2 and status in ('pending', 'snoozed') order by proposed_at",
      [T, CH],
    );
    const nowMs = Date.now();
    const visible = rows.filter((r) => !(r.status === "snoozed" && r.snoozed_until !== null && Date.parse(String(r.snoozed_until)) > nowMs));
    return projectChannelPanel(CH, visible, CTX, { nowMs, all: true }).actions.map((a) => a.title);
  };

  const past = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const future = () => new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

  it("the model's repeat of a card whose snooze has ended retires it, so Fix first shows one DMARC card", async () => {
    process.env.CHANNEL_CARD_MATCHER = "0";
    const oldId = await snoozedOld(past());

    const res = await file(await newRun(), [step(NEW, { repeat_of: oldId })]);

    expect(res.inserted).toBe(1);
    const [old, fresh] = await cards();
    expect(old).toMatchObject({ id: oldId, status: "stale", note: `Replaced by a newer card: ${NEW}` });
    expect(fresh).toMatchObject({ title: NEW, status: "pending", repeat_of: oldId });
    const ev = await db.query("select 1 from channel_action_events where action_id = $1 and event = 'stale_flagged'", [oldId]);
    expect(ev.rows).toHaveLength(1);
    expect(await fixFirst()).toEqual([NEW]);
    expect(pg.reads.some((s) => s.includes("from channel_actions") && s.includes("snoozed_until"))).toBe(true);
  });

  it("a matcher replacement of a card whose snooze has ended lands and retires the old one", async () => {
    process.env.CHANNEL_CARD_MATCHER = "1";
    const oldId = await snoozedOld(past());

    const res = await file(await newRun(), [step(NEW)], { oldId });

    expect(res.inserted).toBe(1);
    const [old, fresh] = await cards();
    expect(old).toMatchObject({ id: oldId, status: "stale" });
    expect(fresh).toMatchObject({ title: NEW, status: "pending", repeat_of: oldId });
    expect(await fixFirst()).toEqual([NEW]);
  });

  for (const matcher of ["0", "1"]) {
    it(`a card still snoozed into the future stays the founder's and its repeat is not filed (matcher ${matcher === "0" ? "off" : "on"})`, async () => {
      process.env.CHANNEL_CARD_MATCHER = matcher;
      const until = future();
      const oldId = await snoozedOld(until);

      const res = await file(await newRun(), [step(NEW, matcher === "0" ? { repeat_of: oldId } : {})], matcher === "1" ? { oldId } : null);

      expect(res.inserted).toBe(0);
      const all = await cards();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ id: oldId, status: "snoozed", note: null });
      const ev = await db.query("select 1 from channel_action_events where action_id = $1 and event = 'stale_flagged'", [oldId]);
      expect(ev.rows).toHaveLength(0);
      expect(await fixFirst()).toEqual([]);
    });
  }
});

describe("supersededOpenCards on snoozed cards", () => {
  const NOW = Date.parse("2026-10-29T12:00:00Z");
  const card = (id: string, extra: Partial<OpenCard>): OpenCard => ({
    id,
    run_id: "run-old",
    status: "snoozed",
    exec_status: null,
    approved_by: null,
    steps_done: [],
    edited_body: null,
    exec_class: null,
    customer: true,
    ...extra,
  });

  it("retires a snooze that ended or has no end, keeps one still running or not read", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const ids = ["ended", "endless", "running", "unread", "garbage", "now"];
      const flags = supersededOpenCards(
        "run-new",
        ids.map((id) => ({ title: "Restated", repeat_of: id, customer: true })),
        [
          card("ended", { snoozed_until: "2026-10-29T11:59:59Z" }),
          card("endless", { snoozed_until: null }),
          card("running", { snoozed_until: "2026-10-29T12:00:01Z" }),
          card("unread", {}),
          card("garbage", { snoozed_until: "not a date" }),
          card("now", { snoozed_until: "2026-10-29T12:00:00Z" }),
        ],
      );
      expect(flags.map((f) => f.action_id).sort()).toEqual(["ended", "endless", "now"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an ended snooze the founder edited, ticked or approved stays", () => {
    const past = "2020-01-01T00:00:00Z";
    const flags = supersededOpenCards(
      "run-new",
      ["edited", "ticked", "approved", "queued"].map((id) => ({ title: "Restated", repeat_of: id, customer: true })),
      [
        card("edited", { snoozed_until: past, edited_body: { text: "mine" } }),
        card("ticked", { snoozed_until: past, steps_done: [0] }),
        card("approved", { snoozed_until: past, approved_by: "u1" }),
        card("queued", { snoozed_until: past, exec_status: "queued" }),
      ],
    );
    expect(flags).toEqual([]);
  });
});
