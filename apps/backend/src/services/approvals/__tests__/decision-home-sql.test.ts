import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHANNELS, GROWTH_DECISION_CLASSES, decisionHome } from "@zavi/shared";
import { renderDecisionHomeSql, DECISION_HOME_SQL_INPUTS } from "../decision-home-sql";
import { channelSlugForDecision, SOCIAL_ACTION_CHANNEL_SLUG } from "@/routes/approvals/decision-channel";
import { listingChannelOfRun, SITE_PR_CLASSES } from "@/services/channels/site-pr-run";
import { openPglite, type Pg } from "@/services/growth/booking-metrics/__tests__/pglite";

const MIGRATIONS = join(__dirname, "../../../../../../supabase/migrations");
const newestDefining = (): string =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql") && readFileSync(join(MIGRATIONS, f), "utf8").includes("function public.decision_home_of"))
    .sort()
    .at(-1)!;

describe("decision_home_of drift guard", () => {
  it("the renderer is built from CHANNELS and GROWTH_DECISION_CLASSES", () => {
    expect(DECISION_HOME_SQL_INPUTS.channelSlugs).toEqual(CHANNELS.map((c) => c.slug));
    expect(DECISION_HOME_SQL_INPUTS.growthPrefixes).toEqual([...GROWTH_DECISION_CLASSES.prefixes]);
    expect(DECISION_HOME_SQL_INPUTS.growthExact).toEqual([...GROWTH_DECISION_CLASSES.exact]);
    expect(DECISION_HOME_SQL_INPUTS.sitePrClasses).toEqual([...SITE_PR_CLASSES].sort());
    expect(Object.fromEntries(DECISION_HOME_SQL_INPUTS.socialActionChannel)).toEqual(SOCIAL_ACTION_CHANNEL_SLUG);
  });

  it("the renderer is deterministic", () => {
    expect(renderDecisionHomeSql()).toBe(renderDecisionHomeSql());
  });

  it("the newest migration defining decision_home_of contains the renderer's output", () => {
    const file = newestDefining();
    const text = readFileSync(join(MIGRATIONS, file), "utf8");
    expect(text.includes(renderDecisionHomeSql()), `${file} is stale; expected it to contain:\n${renderDecisionHomeSql()}`).toBe(true);
  });
});

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const USER = "aaaaaaaa-0000-4000-8000-000000000001";
let db: Pg | null = null;
let seq = 0;
const uid = (prefix: string) => `${prefix}-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

async function insertRun(r: { tenant?: string; channel?: string | null; enqueued_by?: string | null; site_pr_class?: string | null }) {
  const id = uid("bbbbbbbb");
  const payload = r.site_pr_class ? { site_pr_card: { exec_class: r.site_pr_class } } : {};
  await db!.query("insert into agent_runs (id, tenant_id, channel_slug, enqueued_by, payload) values ($1, $2, $3, $4, $5::jsonb)", [
    id,
    r.tenant ?? T1,
    r.channel ?? null,
    r.enqueued_by ?? null,
    JSON.stringify(payload),
  ]);
  return id;
}
async function insertDecision(d: { tenant?: string; run?: string | null; cls: string; body?: Record<string, unknown>; home?: string; status?: string }) {
  const id = uid("dddddddd");
  await db!.query(
    "insert into decisions (id, tenant_id, agent_run_id, decision_class, body, status, autonomy_at_emit, home) values ($1, $2, $3, $4, $5::jsonb, $6, 'approval', $7)",
    [id, d.tenant ?? T1, d.run ?? null, d.cls, JSON.stringify(d.body ?? {}), d.status ?? "proposed", d.home ?? null],
  );
  return id;
}
async function homeOf(id: string) {
  const r = await db!.query("select home, home_channel from decisions where id = $1", [id]);
  return r.rows[0] as { home: string; home_channel: string | null };
}

describe.skipIf(!process.env.CI && !process.env.PGLITE_DIR)("20261110140000_decisions_home.sql in Postgres", () => {
  beforeAll(async () => {
    db = await openPglite();
    await db!.exec(`
      create role anon; create role authenticated; create role service_role;
      create table agent_runs (id uuid primary key, tenant_id uuid not null, channel_slug text, enqueued_by uuid, payload jsonb not null default '{}');
      create table decisions (
        id uuid primary key, tenant_id uuid not null, agent_run_id uuid, decision_class text not null,
        body jsonb not null default '{}', status text not null default 'proposed', autonomy_at_emit text not null default 'approval',
        snoozed_until timestamptz, emitted_at timestamptz not null default now()
      );
    `);
    await db!.exec(`insert into decisions (id, tenant_id, decision_class) values ('cccccccc-0000-4000-8000-000000000001', '${T1}', 'google_ads.update_campaign_budget');`);
    const base = readFileSync(join(MIGRATIONS, "20261110140000_decisions_home.sql"), "utf8");
    const sql = readFileSync(join(MIGRATIONS, newestDefining()), "utf8");
    await db!.exec(base);
    await db!.exec(sql);
    await db!.exec(sql);
  }, 60_000);
  afterAll(async () => db?.close());
  beforeEach(async () => {
    await db!.exec("delete from decisions where id <> 'cccccccc-0000-4000-8000-000000000001'; delete from agent_runs;");
  });

  it("backfills a row that existed before the migration", async () => {
    expect(await homeOf("cccccccc-0000-4000-8000-000000000001")).toEqual({ home: "growth", home_channel: null });
  });

  it("rule matrix: the SQL agrees with decisionHome(channelSlugForDecision(...)) on every case", async () => {
    const classes = [
      ...GROWTH_DECISION_CLASSES.exact,
      ...GROWTH_DECISION_CLASSES.prefixes.map((p) => `${p}x`),
      "social.publish.v2",
      "human.application_review",
      "pm.ticket",
      "engineer.ship-pr",
      "chief-of-staff.brief",
    ];
    const runShapes: Array<{ channel?: string | null; enqueued_by?: string | null; site_pr_class?: string | null } | null> = [null];
    for (const channel of [CHANNELS[0].slug, "seo", "not_a_channel", null]) {
      for (const enqueued_by of [null, USER]) {
        for (const site_pr_class of [...SITE_PR_CLASSES, "other.create_pr.v1", null]) runShapes.push({ channel, enqueued_by, site_pr_class });
      }
    }
    const bodies: Array<Record<string, unknown>> = [{}, { brief_kind: "creative" }, { brief_kind: "nope" }, ...Object.keys(SOCIAL_ACTION_CHANNEL_SLUG).map((channel) => ({ channel })), { channel: "nope" }];
    let checked = 0;
    for (const run of runShapes) {
      const runId = run ? await insertRun(run) : null;
      for (const cls of classes) {
        for (const body of bodies) {
          const id = await insertDecision({ run: runId, cls, body });
          const expectedSlug = channelSlugForDecision(
            {
              agent_run_id: runId,
              decision_class: cls,
              brief_kind: typeof body.brief_kind === "string" ? body.brief_kind : null,
              social_channel: typeof body.channel === "string" ? body.channel : null,
            },
            () => listingChannelOfRun({ channel_slug: run?.channel ?? null, enqueued_by: run?.enqueued_by ?? null, site_pr_class: run?.site_pr_class ?? null }),
          );
          const expected = decisionHome({ decision_class: cls, channel_slug: expectedSlug });
          const got = await homeOf(id);
          expect(got, JSON.stringify({ run, cls, body })).toEqual({
            home: expected.kind,
            home_channel: expected.kind === "channel" ? expected.slug : null,
          });
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  }, 120_000);

  it("re-stamps a run's pending decisions when the run's channel stamp lands later, and leaves decided ones", async () => {
    const run = await insertRun({ channel: null, enqueued_by: USER });
    const pending = await insertDecision({ run, cls: "pm.ticket" });
    const decided = await insertDecision({ run, cls: "pm.ticket", status: "acted" });
    expect(await homeOf(pending)).toEqual({ home: "needs_you", home_channel: null });
    await db!.query("update agent_runs set channel_slug = 'seo' where id = $1", [run]);
    expect(await homeOf(pending)).toEqual({ home: "channel", home_channel: "seo" });
    expect(await homeOf(decided)).toEqual({ home: "needs_you", home_channel: null });
  });

  it("a client-supplied home is never kept, on insert or on update", async () => {
    const id = await insertDecision({ cls: "pm.ticket", home: "growth" });
    expect(await homeOf(id)).toEqual({ home: "needs_you", home_channel: null });
    await db!.query("update decisions set home = 'channel', home_channel = 'seo' where id = $1", [id]);
    expect(await homeOf(id)).toEqual({ home: "needs_you", home_channel: null });
  });

  it("another tenant's run never lends its channel", async () => {
    const run = await insertRun({ tenant: T2, channel: "seo" });
    const id = await insertDecision({ tenant: T1, run, cls: "pm.ticket" });
    expect(await homeOf(id)).toEqual({ home: "needs_you", home_channel: null });
  });

  it("the home index is partial on the pending predicate, and a pending-home query can use it", async () => {
    const idx = await db!.query("select indexdef from pg_indexes where indexname = 'decisions_tenant_home_recency'");
    expect(String(idx.rows[0].indexdef)).toMatch(/WHERE \(\(status = 'proposed'::text\) AND \(autonomy_at_emit = 'approval'::text\)\)/);
    await db!.exec("set enable_seqscan = off");
    const plan = await db!.query(
      `explain select id from customer_visible_pending_decisions where tenant_id = '${T1}' and home = 'needs_you' order by emitted_at desc, id desc limit 51`,
    );
    await db!.exec("reset enable_seqscan");
    expect(plan.rows.map((r) => Object.values(r)[0]).join("\n")).toContain("decisions_tenant_home_recency");
  });

  it("the pending view exposes home and keeps its predicate", async () => {
    await insertDecision({ cls: "pm.ticket" });
    await insertDecision({ cls: "cgo.dispatch-specialist" });
    await insertDecision({ cls: "pm.ticket", status: "acted" });
    const r = await db!.query("select decision_class, home from customer_visible_pending_decisions where id <> 'cccccccc-0000-4000-8000-000000000001'");
    expect(r.rows).toEqual([{ decision_class: "pm.ticket", home: "needs_you" }]);
  });
});
