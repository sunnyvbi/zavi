import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAIL_CARD_BOOTSTRAP, EMAIL_CARD_SQL } from "./email-card-live-migrations";

const PG_URL = process.env.ZAVI_TEST_VANILLA_PG_URL;

const EXTRA = `
  create table agent_runs (id uuid primary key, tenant_id uuid not null, payload jsonb);
  alter table email_lists add column active_version_id uuid;
  create table email_list_versions (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, list_id uuid not null, consent_confirmed_at timestamptz);
  -- The bulk send slice the freeze (H4) writes.
  create table email_contacts (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, email_norm text, erased_at timestamptz);
  create table email_list_version_contacts (tenant_id uuid not null, version_id uuid not null, contact_id uuid not null);
  create table email_bulk_abuse_holds (tenant_id uuid not null, cleared_at timestamptz);
  create table email_bulk_sends (
    id uuid primary key default gen_random_uuid(), tenant_id uuid not null, decision_id uuid not null unique, list_id uuid, list_version_id uuid,
    subject text, body_text text, body_html text, render_sha text, from_address text, reply_to text, total int, status text not null default 'sending'
  );
  create table email_bulk_send_recipients (send_id uuid not null, tenant_id uuid not null, contact_id uuid not null, email_at_send text);
  -- The provider campaign a chat-rail send records before its send call (20261031191100).
  create table email_send_refs (tenant_id uuid not null, rail text not null, card_id uuid not null, route text, provider_ref text, primary key (rail, card_id));
  -- The staff alert outbox (20261009100000), as the stuck-hold alert writes it.
  create table ops_alert_outbox (id bigserial primary key, dedupe_key text not null unique, source text, code text, tenant_id uuid, msg text, created_at timestamptz not null default now());
  create function enqueue_ops_alert(p_dedupe_key text, p_source text, p_code text, p_tenant_id uuid, p_msg text) returns boolean
  language plpgsql as $f$
  declare v_id bigint;
  begin
    insert into ops_alert_outbox (dedupe_key, source, code, tenant_id, msg) values (p_dedupe_key, p_source, p_code, p_tenant_id, p_msg)
    on conflict (dedupe_key) do nothing returning id into v_id;
    return v_id is not null;
  end $f$;
`;

const v = (n: number, html = `<p>version ${n}</p>`) => ({
  content: { subject: `Subject ${n}`, preview_text: "", title: `T${n}`, paragraphs: ["p"], button: { label: "Go", url: "https://example.test" } },
  html,
  text: `version ${n}`,
  render_sha: "a".repeat(64),
});
const toolBody = (over: Record<string, unknown> = {}) => ({
  tool: "mailchimp",
  credential: { kind: "composio", connected_account_id: "ca_1", digest: "b".repeat(64) },
  audience_id: "list-1",
  audience_name: "Members",
  audience_count: 200,
  from_name: "Brightloop",
  from_email: "hello@brightloop.test",
  reply_to: null,
  variants: [v(1), v(2)],
  template_snapshot: { brand_color: "#1a73e8" },
  renderer_version: "email-r1",
  ...over,
});

const H = 3_600_000;
const PRE = randomUUID();
const PRE_LIST = randomUUID();
const PRE_DEC = {
  frozen: "d1000000-0000-4000-8000-000000000001",
  nullTotal: "d1000000-0000-4000-8000-000000000002",
  empty: "d1000000-0000-4000-8000-000000000003",
  reffed: "d1000000-0000-4000-8000-000000000004",
  nothing: "d1000000-0000-4000-8000-000000000005",
  released: "d1000000-0000-4000-8000-000000000006",
  rejectedRef: "d1000000-0000-4000-8000-000000000007",
  rejectedNothing: "d1000000-0000-4000-8000-000000000008",
};
const at = (hours: number) => new Date(Date.now() + hours * H).toISOString();

describe.skipIf(!PG_URL)("20261101201000 email planned sends, live", () => {
  let db: Client;
  const one = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R> => (await db.query(sql, params)).rows[0] as R;
  const r = (sql: string, params: unknown[]) => one<{ r: Record<string, unknown> }>(sql, params).then((x) => x.r);

  const workspace = async () => {
    const t = randomUUID();
    const w = { t, owner: randomUUID(), admin: randomUUID(), member: randomUUID() };
    await db.query("insert into tenants values ($1)", [t]);
    await db.query("insert into tenant_users values ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'member')", [t, w.owner, w.admin, w.member]);
    await db.query("insert into tenant_channels values ($1, 'email_marketing')", [t]);
    return w;
  };
  type W = Awaited<ReturnType<typeof workspace>>;

  const plan = (w: W, o: { list?: string; route?: string; hours?: number; source?: string; actor?: string | null; key?: string; tz?: string } = {}) =>
    r("select plan_email_send($1, $2, $3, $4, $5, 'Members', $6, $7, 'Spring offer', 'Day-7 clicks beat the line on this list', $8) r", [
      w.t,
      o.actor === undefined ? w.owner : o.actor,
      o.source ?? "founder",
      o.route ?? "mailchimp",
      o.list ?? "list-1",
      at(o.hours ?? 48),
      o.tz ?? "America/Los_Angeles",
      o.key ?? randomUUID(),
    ]);
  const begin = async (tenant: string, id: string) => {
    await db.query("update email_plan_jobs set due_at = now() - interval '1 minute' where item_id = $1 and kind = 'draft' and state = 'pending'", [id]);
    const j = (await db.query("select * from claim_email_plan_jobs(100, 600) where item_id = $1 and kind = 'draft'", [id])).rows[0];
    return r("select begin_email_plan_draft($1, $2, $3, $4) r", [tenant, id, j?.id ?? null, j?.lease_token ?? null]);
  };
  const item = (id: string) => one<Record<string, unknown>>("select * from email_planned_sends where id = $1", [id]);

  const ready = async (w: W, o: { list?: string; hours?: number; body?: Record<string, unknown> } = {}) => {
    const p = await plan(w, { list: o.list, hours: o.hours });
    expect(p).toMatchObject({ ok: true });
    const id = p.id as string;
    expect(await begin(w.t, id)).toMatchObject({ ok: true, attempt: 1, version: 1 });
    const run = randomUUID();
    await db.query("insert into agent_runs values ($1, $2, $3)", [run, w.t, JSON.stringify({ email_plan: { mode: "planned_draft", item_id: id, version: 1 } })]);
    const card = (await one<{ id: string }>(
      "insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id",
      [w.t, JSON.stringify(toolBody({ audience_id: o.list ?? "list-1", planned_send_id: id, plan_version: 1, ...(o.body ?? {}) }))],
    )).id;
    expect(await r("select attach_email_planned_card($1, $2, 1, $3, 'channel_actions', $4) r", [w.t, id, run, card])).toEqual({ ok: true });
    return { id, card, run };
  };
  const tested = async (w: W, card: string, variant = 1, user = w.owner) => {
    const pre = await r("select email_card_for_test($1, 'channel_actions', $2, $3, $4) r", [w.t, card, variant, user]);
    return r("select record_email_test_send($1, 'channel_actions', $2, $3, $4, $5) r", [w.t, card, variant, user, pre.test_sha]);
  };
  const due = (id: string) => db.query("update email_planned_sends set planned_at = now() - interval '1 minute' where id = $1", [id]);
  const fire = (w: W, id: string, unattended: Record<string, unknown> = { allow: false }) =>
    one<{ g: number }>("select schedule_gen g from email_planned_sends where id = $1", [id]).then((x) =>
      r("select fire_email_planned_send($1, $2, $3, $4) r", [w.t, id, x.g, JSON.stringify(unattended)]),
    );

  beforeAll(async () => {
    db = new Client({ connectionString: PG_URL });
    await db.connect();
    const exists = await one<{ t: string | null }>("select to_regclass('public.channel_actions')::text t");
    if (exists.t) throw new Error("ZAVI_TEST_VANILLA_PG_URL must be a VANILLA throwaway database");
    await db.query("begin");
    await db.query(EMAIL_CARD_BOOTSTRAP);
    await db.query(EXTRA);
    for (const s of EMAIL_CARD_SQL.slice(0, -1)) await db.query(s);
    await db.query("insert into tenants values ($1)", [PRE]);
    await db.query("set local zavi.email_card_approve = 'on'");
    const ins = (status: string, extra: string, audience: string) =>
      db.query(
        `insert into channel_actions (tenant_id, exec_class, exec_payload, exec_status, approved_by, exec_claimed_at, executed_at, exec_progress, exec_result)
         values ($1, 'email_campaign.create_and_send', $2, $3, $4, ${extra}) returning id`,
        [PRE, JSON.stringify(toolBody({ audience_id: audience })), status, randomUUID()],
      );
    await ins("queued", "null, null, null, null", "pre-queued");
    await ins("executed", "now() - interval '2 days', now() - interval '2 days', null, null", "pre-sent");
    await ins("executed", "now() - interval '9 days', now() - interval '9 days', null, null", "pre-old");
    await ins("failed", "now() - interval '1 day', null, '{\"stage\":\"send_requested\"}', '{\"code\":\"exec_outcome_unknown\"}'", "pre-unknown");
    await ins("failed", "now() - interval '1 day', null, '{\"stage\":\"created\"}', '{\"code\":\"email_tool_refused\"}'", "pre-refused");
    await ins("failed", "now() - interval '1 day', null, '{\"stage\":\"send_requested\"}', '{\"code\":\"exec_partial\",\"not_sent\":true}'", "pre-notsent");
    await ins("failed", "now() - interval '1 day', null, '{\"stage\":\"send_requested\"}', '{\"code\":\"exec_partial\"}'", "pre-partial");
    await ins("failed", "now() - interval '1 day', null, '{\"stage\":\"send_requested\"}', '{\"interrupted\":true}'", "pre-interrupted");
    await ins("failed", "now() - interval '1 day', null, '{\"stage\":\"content_set\"}', '{\"interrupted\":true}'", "pre-early");
    await ins("failed", "now() - interval '1 day', null, '{\"stage\":\"content_set\"}', '{\"interrupted\":true,\"code\":\"exec_outcome_unknown\"}'", "pre-int-unknown");
    await ins("failed", "now() - interval '1 day', null, '{\"stage\":\"send_requested\"}', '{\"error\":\"x\"}'", "pre-nocode");
    await ins("failed", "now() - interval '1 day', null, null, '{\"error\":\"x\",\"bucket\":\"partial_risk\"}'", "pre-risk");
    await ins("failed", "now() - interval '1 day', null, '{\"stage\":\"send_requested\"}', null", "pre-noresult");
    await ins("failed", "now() - interval '1 day', null, '{\"stage\":\"created\"}', '{\"interrupted\":true,\"lease_expired\":true,\"code\":\"exec_outcome_unknown\"}'", "pre-lease");
    const failedDecision = async (list: string, then: (id: string) => Promise<unknown>, status = "dispatch_failed") => {
      const id = (await one<{ id: string }>(
        "insert into decisions (tenant_id, decision_class, body, status, approved_by, dispatched_at) values ($1, 'bulk_outbound.send', $2, $4, $3, now() - interval '1 day') returning id",
        [PRE, JSON.stringify({ list_id: list }), randomUUID(), status],
      )).id;
      await then(id);
    };
    const ref = (id: string) => db.query("insert into email_send_refs (tenant_id, rail, card_id, route, provider_ref) values ($1, 'decisions', $2, 'mailchimp', 'c0')", [PRE, id]);
    const frozen = (total: number | null) => (id: string) => db.query("insert into email_bulk_sends (tenant_id, decision_id, total) values ($1, $2, $3)", [PRE, id, total]);
    await failedDecision(PRE_DEC.frozen, frozen(5));
    await failedDecision(PRE_DEC.nullTotal, frozen(null));
    await failedDecision(PRE_DEC.empty, frozen(0));
    await failedDecision(PRE_DEC.reffed, (id) => db.query("insert into email_send_refs (tenant_id, rail, card_id, route, provider_ref) values ($1, 'decisions', $2, 'mailchimp', 'c0')", [PRE, id]));
    await failedDecision(PRE_DEC.nothing, async () => undefined);
    await failedDecision(PRE_DEC.released, async () => undefined, "proposed");
    await failedDecision(PRE_DEC.rejectedRef, ref, "rejected");
    await failedDecision(PRE_DEC.rejectedNothing, async () => undefined, "rejected");
    await ins("failed", "now() - interval '1 day', null, '{\"stage\":\"send_requested\"}', '{\"code\":\"exec_partial\",\"audience_mismatch\":true}'", "pre-mismatch");
    await db.query(
      "insert into decisions (tenant_id, decision_class, body, status, approved_by, dispatched_at) values ($1, 'bulk_outbound.send', $2, 'acted', $3, now() - interval '3 days')",
      [PRE, JSON.stringify({ list_id: PRE_LIST }), randomUUID()],
    );
    await db.query("set local zavi.email_card_approve = ''");
    await db.query(EMAIL_CARD_SQL[EMAIL_CARD_SQL.length - 1]);
  });
  afterAll(async () => {
    if (!db) return;
    await db.query("rollback").catch(() => {});
    await db.end();
  });

  it("plan rules: 26h to 14 days, owner/admin or an agent as no one, a known zone, replay by request key", async () => {
    const w = await workspace();
    expect(await plan(w, { hours: 20 })).toEqual({ ok: false, code: "too_soon" });
    expect(await plan(w, { hours: 24 * 15 })).toEqual({ ok: false, code: "too_far" });
    expect(await plan(w, { actor: w.member })).toEqual({ ok: false, code: "not_authorized" });
    expect(await plan(w, { source: "email_agent", actor: w.owner })).toEqual({ ok: false, code: "bad_request" });
    expect(await plan(w, { tz: "Mars/Olympus" })).toEqual({ ok: false, code: "bad_timezone" });
    expect(await plan(w, { list: "a b" })).toEqual({ ok: false, code: "list_not_found" });
    expect(await plan(w, { route: "zavi_list", list: randomUUID() })).toEqual({ ok: false, code: "list_not_found" });
    const first = await plan(w, { source: "email_agent", actor: null, key: "k1" });
    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(await plan(w, { source: "email_agent", actor: null, key: "k1" })).toEqual({ ok: true, replayed: true, id: first.id });
    const jobs = (await db.query("select kind, due_at from email_plan_jobs where item_id = $1 order by kind", [first.id])).rows;
    expect(jobs.map((j) => j.kind)).toEqual(["deadline", "draft"]);
    expect(new Date(jobs[0].due_at).getTime() - new Date(jobs[1].due_at).getTime()).toBe(24 * H);
  });

  it("F3: three a week per workspace, one per list per 7 days; a marked test list is refused", async () => {
    const w = await workspace();
    const base = await one<{ d: string }>(
      "select (date_trunc('week', (now() + interval '7 days') at time zone 'UTC') + interval '1 day 10 hours') at time zone 'UTC' d",
    );
    const day = (n: number) => new Date(new Date(base.d).getTime() + n * 24 * H).toISOString();
    const p = (list: string, when: string) =>
      r("select plan_email_send($1, $2, 'founder', 'mailchimp', $3, 'L', $4, 'UTC', 'A', null, $5) r", [w.t, w.owner, list, when, randomUUID()]);
    expect(await p("a", day(0))).toMatchObject({ ok: true });
    expect(await p("a", day(3))).toEqual({ ok: false, code: "list_spacing" });
    expect(await p("b", day(1))).toMatchObject({ ok: true });
    expect(await p("c", day(2))).toMatchObject({ ok: true });
    expect(await p("d", day(3))).toEqual({ ok: false, code: "week_full" });
    await db.query("insert into channel_settings (tenant_id, channel_slug, field_id, item) values ($1, 'email_marketing', 'email_test_lists', 'mailchimp:t')", [w.t]);
    expect(await p("t", day(4))).toEqual({ ok: false, code: "test_list" });
  });

  it("must catch R1: a planned card is never approved by Autopilot outside its deadline", async () => {
    const w = await workspace();
    const { card } = await ready(w);
    expect(await r("select approve_email_campaign_send_as_cgo($1, $2, 'cgo:x', $3, 100) r", [w.t, card, w.owner])).toEqual({
      ok: false,
      code: "planned_card_deadline_only",
    });
    expect(await one("select exec_status, approved_by from channel_actions where id = $1", [card])).toEqual({ exec_status: null, approved_by: null });
    expect(await one("select count(*)::int n from email_send_reservations where card_id = $1", [card])).toEqual({ n: 0 });
  });

  it("R7: only the run bound to this item and version may attach, once; a stale version is refused", async () => {
    const w = await workspace();
    const p = await plan(w);
    const id = p.id as string;
    await begin(w.t, id);
    const other = randomUUID();
    await db.query("insert into agent_runs values ($1, $2, '{}')", [other, w.t]);
    const card = (await one<{ id: string }>(
      "insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id",
      [w.t, JSON.stringify(toolBody({ planned_send_id: id, plan_version: 1 }))],
    )).id;
    expect(await r("select attach_email_planned_card($1, $2, 1, $3, 'channel_actions', $4) r", [w.t, id, other, card])).toEqual({ ok: false, code: "not_this_run" });
    const run = randomUUID();
    await db.query("insert into agent_runs values ($1, $2, $3)", [run, w.t, JSON.stringify({ email_plan: { mode: "planned_draft", item_id: id, version: 1 } })]);
    expect(await r("select email_plan_run_context($1, $2) r", [w.t, run])).toMatchObject({ mode: "planned_draft", item_id: id, version: 1, stale: false, briefed: false });
    expect(await r("select email_plan_run_context($1, $2) r", [w.t, other])).toEqual({ found: true, mode: null, briefed: false });
    expect(await r("select email_plan_run_context($1, $2) r", [w.t, randomUUID()])).toEqual({ found: false });
    const wrong = (await one<{ id: string }>(
      "insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id",
      [w.t, JSON.stringify(toolBody({ audience_id: "list-9", planned_send_id: id, plan_version: 1 }))],
    )).id;
    expect(await r("select attach_email_planned_card($1, $2, 1, $3, 'channel_actions', $4) r", [w.t, id, run, wrong])).toEqual({ ok: false, code: "wrong_list" });
    expect(await r("select attach_email_planned_card($1, $2, 1, $3, 'channel_actions', $4) r", [w.t, id, run, card])).toEqual({ ok: true });
    expect(await r("select attach_email_planned_card($1, $2, 1, $3, 'channel_actions', $4) r", [w.t, id, run, card])).toEqual({ ok: true, replayed: true });
    expect(await item(id)).toMatchObject({ status: "ready", card_id: card });
  });

  it("must catch: a run whose payload names ANOTHER workspace's planned email binds to nothing and attaches nothing", async () => {
    const mine = await workspace();
    const theirs = await workspace();
    const p = await plan(theirs);
    const foreign = p.id as string;
    await begin(theirs.t, foreign);
    const run = randomUUID();
    await db.query("insert into agent_runs values ($1, $2, $3)", [run, mine.t, JSON.stringify({ email_plan: { mode: "planned_draft", item_id: foreign, version: 1 } })]);
    expect(await r("select email_plan_run_context($1, $2) r", [mine.t, run])).toMatchObject({ mode: "planned_draft", stale: true });
    expect(await r("select email_plan_run_context($1, $2) r", [mine.t, run])).not.toHaveProperty("item_id");
    const card = (await one<{ id: string }>(
      "insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id",
      [mine.t, JSON.stringify(toolBody({ planned_send_id: foreign, plan_version: 1 }))],
    )).id;
    expect(await r("select attach_email_planned_card($1, $2, 1, $3, 'channel_actions', $4) r", [mine.t, foreign, run, card])).toEqual({ ok: false, code: "not_found" });
    expect(await r("select attach_email_planned_card($1, $2, 1, $3, 'channel_actions', $4) r", [theirs.t, foreign, run, card])).toEqual({ ok: false, code: "not_this_run" });
    expect(await item(foreign)).toMatchObject({ status: "drafting", card_id: null });
  });

  it("R2: Send at the planned time stamps the approval on the item, sends nothing, then goes through approve_email_card at the time", async () => {
    const w = await workspace();
    const { id, card } = await ready(w);
    expect(await r("select schedule_email_planned_send($1, $2, $3, 1, 180) r", [w.t, w.member, id])).toEqual({ ok: false, code: "not_authorized" });
    expect(await r("select schedule_email_planned_send($1, $2, $3, 1, 180) r", [w.t, w.owner, id])).toEqual({ ok: false, code: "test_required" });
    await tested(w, card);
    expect(await r("select schedule_email_planned_send($1, $2, $3, 1, 180) r", [w.t, w.owner, id])).toMatchObject({ ok: true });
    expect(await one("select exec_status, approved_by from channel_actions where id = $1", [card])).toEqual({ exec_status: null, approved_by: null });
    expect(await item(id)).toMatchObject({ status: "scheduled", sched_variant: 1, sched_count: 180, sched_by: w.owner });
    expect(await fire(w, id)).toEqual({ ok: true, outcome: "not_yet" });
    await due(id);
    const out = await fire(w, id);
    expect(out).toMatchObject({ ok: true, outcome: "queued", event: { id: `approve:${card}:1`, name: "channel-action.approved", data: { action_id: card } } });
    expect(await one("select exec_status, approved_by, approved_by_source, exec_payload->'chosen_variant' cv, exec_payload->'approved_count' ac from channel_actions where id = $1", [card])).toEqual({
      exec_status: "queued",
      approved_by: w.owner,
      approved_by_source: null,
      cv: 1,
      ac: 180,
    });
    expect(await item(id)).toMatchObject({ status: "sending", sched_at: null, unattended: false });
    expect(await one("select state, source from email_send_reservations where card_id = $1", [card])).toEqual({ state: "held", source: null });
    expect(await one("select count(*)::int n from email_plan_outbox where item_id = $1 and sent_at is null", [id])).toEqual({ n: 1 });
    expect(await fire(w, id)).toMatchObject({ ok: true, outcome: "noop" });
  });

  it("must catch: an edit after the scheduled approval voids it; the card stays open", async () => {
    const w = await workspace();
    const { id, card } = await ready(w);
    await tested(w, card);
    await r("select schedule_email_planned_send($1, $2, $3, 1, 180) r", [w.t, w.owner, id]);
    await db.query("update channel_actions set exec_payload = jsonb_set(exec_payload, '{variants,0,html}', '\"<p>edited</p>\"') where id = $1", [card]);
    await due(id);
    expect(await fire(w, id)).toEqual({ ok: true, outcome: "skipped", reason: "changed_after_approval" });
    expect(await one("select exec_status, status from channel_actions where id = $1", [card])).toEqual({ exec_status: null, status: "pending" });
  });

  it("must catch R3: Don't send survives the deadline, even with Auto send allowing; approving later sends now and clears it", async () => {
    const w = await workspace();
    const { id, card } = await ready(w);
    await tested(w, card);
    await r("select schedule_email_planned_send($1, $2, $3, 1, 180) r", [w.t, w.owner, id]);
    expect(await r("select withdraw_email_planned_send($1, $2, $3) r", [w.t, w.admin, id])).toEqual({ ok: true });
    expect(await item(id)).toMatchObject({ status: "ready", sched_at: null });
    await due(id);
    expect(await fire(w, id, { allow: true, count: 200 })).toEqual({ ok: true, outcome: "skipped", reason: "vetoed" });
    expect(await one("select exec_status from channel_actions where id = $1", [card])).toEqual({ exec_status: null });
    expect(await r("select approve_email_card($1, 'channel_actions', $2, 1, $3, 'later', 190) r", [w.t, card, w.owner])).toMatchObject({ ok: true });
    expect(await item(id)).toMatchObject({ status: "sending", vetoed_at: null });
  });

  it("must catch R4: a manual send to the list before the deadline blocks Autopilot's planned send", async () => {
    const w = await workspace();
    const { id, card } = await ready(w);
    const manual = (await one<{ id: string }>(
      "insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id",
      [w.t, JSON.stringify(toolBody())],
    )).id;
    await tested(w, manual);
    expect(await r("select approve_email_card($1, 'channel_actions', $2, 1, $3, 'm', 200) r", [w.t, manual, w.owner])).toMatchObject({ ok: true });
    expect(await one("select state from email_send_reservations where card_id = $1", [manual])).toEqual({ state: "held" });
    await due(id);
    expect(await fire(w, id, { allow: true, count: 200 })).toEqual({ ok: true, outcome: "skipped", reason: "list_sent_recently" });
    expect(await one("select exec_status from channel_actions where id = $1", [card])).toEqual({ exec_status: null });
    await db.query("update channel_actions set exec_status = 'dispatching' where id = $1", [manual]);
    await db.query("update channel_actions set exec_status = 'failed', exec_result = '{\"code\":\"email_tool_refused\"}' where id = $1", [manual]);
    expect(await one("select state from email_send_reservations where card_id = $1", [manual])).toEqual({ state: "released" });
  });

  it("F1: nobody acted and Auto send allows: Autopilot approves version 1 with the count it read; otherwise Skipped and the card stays open", async () => {
    const w = await workspace();
    const a = await ready(w, { list: "list-a" });
    await due(a.id);
    expect(await fire(w, a.id, { allow: false, reasons: ["autopilot_off"] })).toEqual({ ok: true, outcome: "skipped", reason: "not_approved_in_time" });
    expect(await one("select status, exec_status from channel_actions where id = $1", [a.card])).toEqual({ status: "pending", exec_status: null });

    const b = await ready(w, { list: "list-b" });
    await due(b.id);
    expect(await fire(w, b.id, { allow: true, count: 1001 })).toEqual({ ok: true, outcome: "skipped", reason: "audience_over_limit" });

    const c = await ready(w, { list: "list-c" });
    await due(c.id);
    expect(await fire(w, c.id, { allow: true, count: 640 })).toMatchObject({ ok: true, outcome: "queued", unattended: true });
    expect(await one("select approved_by, approved_by_source, exec_payload->'chosen_variant' cv, exec_payload->'approved_count' ac from channel_actions where id = $1", [c.card])).toEqual({
      approved_by: w.owner,
      approved_by_source: "cgo",
      cv: 1,
      ac: 640,
    });
    expect(await item(c.id)).toMatchObject({ status: "sending", unattended: true });
    expect(await one("select source from email_send_reservations where card_id = $1", [c.card])).toEqual({ source: "cgo" });
  });

  it("must catch R9: a planned Zavi-list send goes only through the deadline, and aborts when the list was imported again", async () => {
    const w = await workspace();
    const list = (await one<{ id: string }>("insert into email_lists (tenant_id) values ($1) returning id", [w.t])).id;
    const ver = (await one<{ id: string }>("insert into email_list_versions (tenant_id, list_id, consent_confirmed_at) values ($1, $2, now()) returning id", [w.t, list])).id;
    await db.query("update email_lists set active_version_id = $1 where id = $2", [ver, list]);
    const p = await plan(w, { route: "zavi_list", list });
    const id = p.id as string;
    await begin(w.t, id);
    const run = randomUUID();
    await db.query("insert into agent_runs values ($1, $2, $3)", [run, w.t, JSON.stringify({ email_plan: { mode: "planned_draft", item_id: id, version: 1 } })]);
    const card = (await one<{ id: string }>("insert into decisions (tenant_id, decision_class, body) values ($1, 'bulk_outbound.send', $2) returning id", [
      w.t,
      JSON.stringify({ list_id: list, list_version_id: ver, list_name: "Members", from_address: "hi@brightloop.test", variants: [v(1)], template_snapshot: {}, renderer_version: "email-r1", planned_send_id: id, plan_version: 1 }),
    ])).id;
    expect(await r("select attach_email_planned_card($1, $2, 1, $3, 'decisions', $4) r", [w.t, id, run, card])).toEqual({ ok: true });
    await db.query("savepoint s");
    await expect(db.query("update decisions set status = 'approved', approved_by = $2 where id = $1", [card, w.owner])).rejects.toThrow(/email_card_approve_required/);
    await db.query("rollback to savepoint s");
    await due(id);
    expect(await fire(w, id, { allow: true, count: 300 })).toMatchObject({
      ok: true,
      outcome: "queued",
      event: { id: `approve:${card}`, name: "decision.approved", data: { decision_id: card, tenant_id: w.t, decision_class: "bulk_outbound.send" } },
    });
    expect(await one("select status, approved_by, approved_by_source, body->'chosen_variant' cv from decisions where id = $1", [card])).toEqual({
      status: "approved",
      approved_by: w.owner,
      approved_by_source: "plan_autopilot",
      cv: 1,
    });
    expect(await r("select email_plan_unattended_ok($1, $2) r", [w.t, card])).toEqual({ ok: true, approved_count: 300 });
    const newer = (await one<{ id: string }>("insert into email_list_versions (tenant_id, list_id, consent_confirmed_at) values ($1, $2, now()) returning id", [w.t, list])).id;
    await db.query("update email_lists set active_version_id = $1 where id = $2", [newer, list]);
    expect(await r("select email_plan_unattended_ok($1, $2) r", [w.t, card])).toEqual({ ok: false, code: "list_version_changed" });
    await db.query("set local zavi.email_card_approve = 'on'");
    await db.query("update decisions set status = 'dispatching' where id = $1", [card]);
    await db.query("savepoint frozen");
    await db.query("insert into email_bulk_sends (tenant_id, decision_id, total) values ($1, $2, 300)", [w.t, card]);
    await db.query("update decisions set status = 'dispatch_failed', dispatch_error = 'worker died' where id = $1", [card]);
    expect(await item(id)).toMatchObject({ status: "reconciling", status_reason: "may_have_sent" });
    expect(await one("select state from email_send_reservations where card_id = $1", [card])).toEqual({ state: "held" });
    await db.query("rollback to savepoint frozen");
    await db.query("update decisions set status = 'dispatch_failed', dispatch_error = 'list_version_changed' where id = $1", [card]);
    await db.query("set local zavi.email_card_approve = ''");
    expect(await item(id)).toMatchObject({ status: "skipped", status_reason: "list_version_changed" });
    expect(await one("select state from email_send_reservations where card_id = $1", [card])).toEqual({ state: "released" });
  });

  it("must catch F4 + R5: a moved approved item keeps its approval and sends once, at the new time; the old deadline is a no-op", async () => {
    const w = await workspace();
    const { id, card } = await ready(w, { hours: 72 });
    await tested(w, card);
    await r("select schedule_email_planned_send($1, $2, $3, 1, 180) r", [w.t, w.owner, id]);
    const g1 = (await item(id)).schedule_gen as number;
    expect(await r("select move_email_planned_send($1, $2, $3, $4, $5, $6) r", [w.t, w.member, id, at(96), g1, "America/Los_Angeles"])).toEqual({ ok: false, code: "not_authorized" });
    expect(await r("select move_email_planned_send($1, $2, $3, $4, $5, $6) r", [w.t, w.owner, id, at(96), g1 + 5, "America/Los_Angeles"])).toEqual({ ok: false, code: "plan_changed" });
    expect(await r("select move_email_planned_send($1, $2, $3, $4, $5, $6) r", [w.t, w.owner, id, at(96), g1, "America/Los_Angeles"])).toMatchObject({ ok: true, schedule_gen: g1 + 1 });
    expect(await item(id)).toMatchObject({ status: "scheduled", sched_by: w.owner });
    await due(id);
    expect(await r("select fire_email_planned_send($1, $2, $3, '{}') r", [w.t, id, g1])).toMatchObject({ ok: true, outcome: "noop" });
    expect(await fire(w, id)).toMatchObject({ ok: true, outcome: "queued" });
    expect(await one("select count(*)::int n from channel_action_events where action_id = $1 and event = 'approved'", [card])).toEqual({ n: 1 });
  });

  it("must catch R4/F4: a move that lands within 7 days of another send to the list is refused and keeps its time", async () => {
    const w = await workspace();
    const { id, card } = await ready(w, { hours: 24 * 9 });
    await tested(w, card);
    await r("select schedule_email_planned_send($1, $2, $3, 1, 180) r", [w.t, w.owner, id]);
    const manual = (await one<{ id: string }>(
      "insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id",
      [w.t, JSON.stringify(toolBody())],
    )).id;
    await tested(w, manual);
    await r("select approve_email_card($1, 'channel_actions', $2, 1, $3, 'm2', 200) r", [w.t, manual, w.owner]);
    const before = (await item(id)).planned_at;
    const g = (await item(id)).schedule_gen as number;
    expect(await r("select move_email_planned_send($1, $2, $3, $4, $5, $6) r", [w.t, w.owner, id, at(48), g, "America/Los_Angeles"])).toMatchObject({ ok: false, code: "list_sent_recently" });
    expect((await item(id)).planned_at).toEqual(before);
  });

  it("must catch R5: a new angle rejects the open card, bumps the version and voids the schedule; a founder Skip closes it", async () => {
    const w = await workspace();
    const { id, card } = await ready(w);
    await tested(w, card);
    await r("select schedule_email_planned_send($1, $2, $3, 1, 180) r", [w.t, w.owner, id]);
    expect(await r("select change_email_planned_angle($1, $2, $3, 'Last week of the sale', 1) r", [w.t, w.admin, id])).toEqual({ ok: true, content_version: 2, schedule_gen: 2 });
    expect(await item(id)).toMatchObject({ status: "planned", card_id: null, sched_at: null, content_version: 2, angle: "Last week of the sale" });
    expect(await one("select status from channel_actions where id = $1", [card])).toEqual({ status: "rejected" });
    expect(await r("select change_email_planned_angle($1, $2, $3, 'x', 1) r", [w.t, w.admin, id])).toEqual({ ok: false, code: "plan_changed" });
    const s = await ready(w, { list: "list-s" });
    expect(await r("select skip_email_planned_send($1, $2, $3) r", [w.t, w.owner, s.id])).toEqual({ ok: true, changed: true });
    expect(await item(s.id)).toMatchObject({ status: "skipped", status_reason: "skipped_by_founder", card_id: null });
    expect(await one("select status from channel_actions where id = $1", [s.card])).toEqual({ status: "rejected" });
  });

  it("R8: the card's attempt settles the item: executed = sent, sent_requested then failed = reconciling (held), a pre-send failure = skipped (released)", async () => {
    const w = await workspace();
    const mk = async (list: string) => {
      const x = await ready(w, { list });
      await tested(w, x.card);
      await r("select approve_email_card($1, 'channel_actions', $2, 1, $3, $4, 200) r", [w.t, x.card, w.owner, randomUUID()]);
      await db.query("update channel_actions set exec_status = 'dispatching' where id = $1", [x.card]);
      return x;
    };
    const a = await mk("l-a");
    await db.query("update channel_actions set exec_status = 'executed', executed_at = now() where id = $1", [a.card]);
    expect(await item(a.id)).toMatchObject({ status: "sent" });
    expect(await one("select state from email_send_reservations where card_id = $1", [a.card])).toEqual({ state: "sent" });
    const b = await mk("l-b");
    await db.query(
      "update channel_actions set exec_status = 'failed', exec_progress = '{\"stage\":\"send_requested\"}', exec_result = '{\"code\":\"exec_outcome_unknown\"}' where id = $1",
      [b.card],
    );
    expect(await item(b.id)).toMatchObject({ status: "reconciling" });
    expect(await one("select state from email_send_reservations where card_id = $1", [b.card])).toEqual({ state: "held" });
    const c = await mk("l-c");
    await db.query("update channel_actions set exec_status = 'failed', exec_result = '{\"code\":\"email_test_list\",\"error\":\"marked\"}' where id = $1", [c.card]);
    expect(await item(c.id)).toMatchObject({ status: "blocked", status_reason: "marked" });
    expect(await one("select state from email_send_reservations where card_id = $1", [c.card])).toEqual({ state: "released" });
  });

  it("jobs: claimed once under a lease, settled only by the holder; repair recreates a missing deadline", async () => {
    const w = await workspace();
    const p = await plan(w);
    await db.query("update email_plan_jobs set due_at = now() - interval '1 minute' where item_id = $1", [p.id]);
    const claimed = (await db.query("select * from claim_email_plan_jobs(100, 600) where item_id = $1", [p.id])).rows;
    expect(claimed.length).toBe(2);
    expect((await db.query("select * from claim_email_plan_jobs(100, 600) where item_id = $1", [p.id])).rows.length).toBe(0);
    const j = claimed[0];
    expect(await one("select complete_email_plan_job($1, $2, $3, 'done', null, null) n", [w.t, j.id, randomUUID()])).toEqual({ n: 0 });
    expect(await one("select complete_email_plan_job($1, $2, $3, 'done', null, null) n", [w.t, j.id, j.lease_token])).toEqual({ n: 1 });
    await db.query("delete from email_plan_jobs where item_id = $1", [p.id]);
    await one("select repair_email_plan_jobs(1000)");
    expect((await db.query("select kind from email_plan_jobs where item_id = $1 and state = 'pending' order by kind", [p.id])).rows.map((x) => x.kind)).toEqual(["deadline", "draft"]);
  });

  it("the outbox holds the deadline's event until it is marked sent; a refused attach's card is closed", async () => {
    const w = await workspace();
    const { id, card } = await ready(w);
    await due(id);
    const out = await fire(w, id, { allow: true, count: 50 });
    const ev = (out.event as { id: string }).id;
    expect((await db.query("select event_id from email_plan_outbox_pending(200) where tenant_id = $1", [w.t])).rows).toEqual([{ event_id: ev }]);
    expect(await one("select mark_email_plan_outbox_sent($1, $2) n", [w.t, ev])).toEqual({ n: 1 });
    expect(await one("select mark_email_plan_outbox_sent($1, $2) n", [w.t, ev])).toEqual({ n: 0 });
    expect((await db.query("select 1 from email_plan_outbox_pending(200) where tenant_id = $1", [w.t])).rows).toEqual([]);
    const stray = (await one<{ id: string }>(
      "insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id",
      [w.t, JSON.stringify(toolBody({ planned_send_id: id, plan_version: 9 }))],
    )).id;
    expect(await one("select discard_email_planned_card($1, 'channel_actions', $2) ok", [w.t, stray])).toEqual({ ok: true });
    expect(await one("select status from channel_actions where id = $1", [stray])).toEqual({ status: "rejected" });
    expect(await one("select discard_email_planned_card($1, 'channel_actions', $2) ok", [w.t, card])).toEqual({ ok: false });
  });

  it("the weekly planning run: one row per workspace, claimed once under a lease, finished only by the holder", async () => {
    const w = await workspace();
    expect((await db.query("select * from email_plan_schedule_missing(500) x where x = $1", [w.t])).rows.length).toBe(1);
    await one("select set_email_plan_schedule($1, now() - interval '1 minute', 'America/Chicago')", [w.t]);
    expect((await db.query("select * from email_plan_schedule_missing(500) x where x = $1", [w.t])).rows.length).toBe(0);
    const claimed = (await db.query("select * from claim_email_plan_schedules(100) where tenant_id = $1", [w.t])).rows;
    expect(claimed.length).toBe(1);
    expect((await db.query("select * from claim_email_plan_schedules(100) where tenant_id = $1", [w.t])).rows.length).toBe(0);
    expect(await one("select finish_email_plan_schedule($1, $2, now() + interval '7 days', 'req') n", [w.t, randomUUID()])).toEqual({ n: 0 });
    expect(await one("select finish_email_plan_schedule($1, $2, now() + interval '7 days', 'req') n", [w.t, claimed[0].lease_token])).toEqual({ n: 1 });
    expect(await one("select last_request, lease_token from email_plan_schedule where tenant_id = $1", [w.t])).toEqual({ last_request: "req", lease_token: null });
  });

  it("must catch H2: the ledger starts with what was in flight or sent in the last 7 days", async () => {
    const rows = (await db.query("select list_key, state, settled_at is not null settled from email_send_reservations where tenant_id = $1 order by list_key collate \"C\"", [PRE])).rows;
    expect(rows).toEqual([
      { list_key: "mailchimp:pre-int-unknown", state: "held", settled: false },
      { list_key: "mailchimp:pre-interrupted", state: "held", settled: false },
      { list_key: "mailchimp:pre-lease", state: "held", settled: false },
      { list_key: "mailchimp:pre-mismatch", state: "held", settled: false },
      { list_key: "mailchimp:pre-nocode", state: "held", settled: false },
      { list_key: "mailchimp:pre-noresult", state: "held", settled: false },
      { list_key: "mailchimp:pre-partial", state: "held", settled: false },
      { list_key: "mailchimp:pre-queued", state: "held", settled: false },
      { list_key: "mailchimp:pre-risk", state: "held", settled: false },
      { list_key: "mailchimp:pre-sent", state: "sent", settled: true },
      { list_key: "mailchimp:pre-unknown", state: "held", settled: false },
      { list_key: `zavi_list:${PRE_LIST}`, state: "sent", settled: true },
      { list_key: `zavi_list:${PRE_DEC.frozen}`, state: "held", settled: false },
      { list_key: `zavi_list:${PRE_DEC.nullTotal}`, state: "held", settled: false },
      { list_key: `zavi_list:${PRE_DEC.reffed}`, state: "held", settled: false },
      { list_key: `zavi_list:${PRE_DEC.released}`, state: "held", settled: false },
      { list_key: `zavi_list:${PRE_DEC.rejectedRef}`, state: "held", settled: false },
    ].sort((a, b) => (a.list_key < b.list_key ? -1 : a.list_key > b.list_key ? 1 : 0)));
    expect(await one("select email_list_sent_recently($1, 'mailchimp:pre-sent', null, null) is not null x", [PRE])).toEqual({ x: true });
    expect(await one("select email_list_sent_recently($1, 'mailchimp:pre-old', null, null) is not null x", [PRE])).toEqual({ x: false });
  });

  it("must catch H1: a founder's send to a list blocks Autopilot's own approve there (the ledger, not cgo-only history)", async () => {
    const w = await workspace();
    const mk = async () =>
      (await one<{ id: string }>("insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id", [w.t, JSON.stringify(toolBody({ audience_id: "h1" }))])).id;
    const founder = await mk();
    await tested(w, founder);
    expect(await r("select approve_email_card($1, 'channel_actions', $2, 1, $3, 'f', 200) r", [w.t, founder, w.owner])).toMatchObject({ ok: true });
    const auto = await mk();
    expect(await r("select approve_email_campaign_send_as_cgo($1, $2, 'cgo:a', $3, 100) r", [w.t, auto, w.owner])).toEqual({ ok: false, code: "cgo_email_sent_recently" });
    const second = await mk();
    await tested(w, second);
    expect(await r("select approve_email_card($1, 'channel_actions', $2, 1, $3, 's', 200) r", [w.t, second, w.owner])).toMatchObject({ ok: true });
  });

  it("security: plan_autopilot can be set only by the planned deadline, not with the email approve flag alone", async () => {
    const w = await workspace();
    const d = (await one<{ id: string }>("insert into decisions (tenant_id, decision_class, body) values ($1, 'bulk_outbound.send', '{}') returning id", [w.t])).id;
    const ca = (await one<{ id: string }>("insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id", [w.t, JSON.stringify(toolBody({ audience_id: "sec" }))])).id;
    await db.query("set local zavi.email_card_approve = 'on'");
    for (const sql of [
      ["update decisions set approved_by_source = 'plan_autopilot', approved_by = $2, status = 'approved' where id = $1", [d, w.owner]],
      ["insert into decisions (tenant_id, decision_class, body, status, approved_by, approved_by_source) values ($1, 'bulk_outbound.send', '{}', 'approved', $2, 'plan_autopilot')", [w.t, w.owner]],
      ["update channel_actions set approved_by_source = 'plan_autopilot' where id = $1", [ca]],
    ] as Array<[string, unknown[]]>) {
      await db.query("savepoint g");
      await expect(db.query(sql[0], sql[1])).rejects.toThrow(/email_plan_autopilot_required/);
      await db.query("rollback to savepoint g");
    }
    await db.query("set local zavi.email_card_approve = ''");
    expect(await one("select approved_by_source from decisions where id = $1", [d])).toEqual({ approved_by_source: null });
  });

  it("security: Autopilot's approve asks the ledger on every call, a re-send of its own queued approval included", async () => {
    const w = await workspace();
    const mk = async () =>
      (await one<{ id: string }>("insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id", [w.t, JSON.stringify(toolBody({ audience_id: "resend" }))])).id;
    const auto = await mk();
    expect(await r("select approve_email_campaign_send_as_cgo($1, $2, 'cgo:1', $3, 100) r", [w.t, auto, w.owner])).toMatchObject({ ok: true });
    const founder = await mk();
    await tested(w, founder);
    expect(await r("select approve_email_card($1, 'channel_actions', $2, 1, $3, 'f2', 200) r", [w.t, founder, w.owner])).toMatchObject({ ok: true });
    expect(await r("select approve_email_campaign_send_as_cgo($1, $2, 'cgo:1', $3, 100) r", [w.t, auto, w.owner])).toEqual({ ok: false, code: "cgo_email_sent_recently" });
  });

  it("security: the approve superset keeps every earlier check (member, other workspace, test list)", async () => {
    const w = await workspace();
    const other = await workspace();
    const c = (await one<{ id: string }>("insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id", [w.t, JSON.stringify(toolBody({ audience_id: "keep" }))])).id;
    await tested(w, c);
    expect(await r("select approve_email_card($1, 'channel_actions', $2, 1, $3, 'm', 200) r", [w.t, c, w.member])).toEqual({ ok: false, code: "not_authorized" });
    expect(await r("select approve_email_card($1, 'channel_actions', $2, 1, $3, 'o', 200) r", [other.t, c, other.owner])).toEqual({ ok: false, code: "not_found" });
    await db.query("insert into channel_settings (tenant_id, channel_slug, field_id, item) values ($1, 'email_marketing', 'email_test_lists', 'mailchimp:keep')", [w.t]);
    expect(await r("select approve_email_card($1, 'channel_actions', $2, 1, $3, 't', 200) r", [w.t, c, w.owner])).toEqual({ ok: false, code: "test_list" });
    expect(await r("select approve_email_campaign_send_as_cgo($1, $2, 'cgo:t', $3, 10) r", [w.t, c, w.owner])).toEqual({ ok: false, code: "test_list" });
  });

  it("must catch J1: a replayed attach of the card already linked answers ok", async () => {
    const w = await workspace();
    const { id, card, run } = await ready(w, { list: "j1" });
    expect(await r("select attach_email_planned_card($1, $2, 1, $3, 'channel_actions', $4) r", [w.t, id, run, card])).toEqual({ ok: true, replayed: true });
    expect(await r("select discard_email_planned_card($1, 'channel_actions', $2) r", [w.t, card])).toBe(false);
    expect(await one("select status from channel_actions where id = $1", [card])).toEqual({ status: "pending" });
  });

  it("must catch J2: a superseded job (the angle changed) starts no draft and burns no attempt", async () => {
    const w = await workspace();
    const p = await plan(w, { list: "j2" });
    const id = p.id as string;
    await db.query("update email_plan_jobs set due_at = now() - interval '1 minute' where item_id = $1 and kind = 'draft'", [id]);
    const old = (await db.query("select * from claim_email_plan_jobs(100, 600) where item_id = $1 and kind = 'draft'", [id])).rows[0];
    expect(await r("select change_email_planned_angle($1, $2, $3, 'New angle', 1) r", [w.t, w.owner, id])).toMatchObject({ ok: true });
    expect(await r("select begin_email_plan_draft($1, $2, $3, $4) r", [w.t, id, old.id, old.lease_token])).toMatchObject({ attempt: null, reason: "superseded" });
    expect(await item(id)).toMatchObject({ draft_attempts: 0, status: "planned" });
    expect(await begin(w.t, id)).toMatchObject({ attempt: 1, version: 2 });
  });

  it("must catch K2: a holder whose lease ran out starts nothing", async () => {
    const w = await workspace();
    const id = (await plan(w, { list: "k2" })).id as string;
    await db.query("update email_plan_jobs set due_at = now() - interval '1 minute' where item_id = $1 and kind = 'draft'", [id]);
    const j = (await db.query("select * from claim_email_plan_jobs(100, 600) where item_id = $1 and kind = 'draft'", [id])).rows[0];
    await db.query("update email_plan_jobs set lease_until = now() - interval '1 second' where id = $1", [j.id]);
    expect(await r("select begin_email_plan_draft($1, $2, $3, $4) r", [w.t, id, j.id, j.lease_token])).toMatchObject({ attempt: null, reason: "superseded" });
    expect(await item(id)).toMatchObject({ draft_attempts: 0, status: "planned" });
    await db.query("update email_plan_jobs set lease_until = now() + interval '5 minutes' where id = $1", [j.id]);
    expect(await r("select begin_email_plan_draft($1, $2, $3, $4) r", [w.t, id, j.id, j.lease_token])).toMatchObject({ attempt: 1 });
  });

  it("must catch J3 (fail closed): only a campaign read back as a draft, or progress short of the send, releases the list", async () => {
    const sent = async (list: string) => {
      const w = await workspace();
      const x = await ready(w, { list });
      await tested(w, x.card);
      await r("select approve_email_card($1, 'channel_actions', $2, 1, $3, $4, 200) r", [w.t, x.card, w.owner, randomUUID()]);
      await db.query("update channel_actions set exec_status = 'dispatching' where id = $1", [x.card]);
      await db.query("update channel_actions set exec_status = 'failed', exec_progress = '{\"stage\":\"send_requested\"}', exec_result = '{\"code\":\"exec_outcome_unknown\"}' where id = $1", [x.card]);
      return x;
    };
    const state = (card: string) => one<{ state: string }>("select state from email_send_reservations where card_id = $1", [card]).then((x) => x.state);
    const a = await sent("j3a");
    expect(await state(a.card)).toBe("held");
    await db.query("update channel_actions set exec_result = '{\"error\":\"interrupted\",\"interrupted\":true}' where id = $1", [a.card]);
    expect(await state(a.card)).toBe("held");
    expect(await item(a.id)).toMatchObject({ status: "reconciling" });
    await db.query("update channel_actions set exec_result = '{\"error\":\"gone\",\"code\":\"exec_partial\"}' where id = $1", [a.card]);
    expect(await state(a.card)).toBe("held");
    expect(await item(a.id)).toMatchObject({ status: "reconciling" });
    const b = await sent("j3b");
    await db.query("update channel_actions set exec_result = '{\"error\":\"not sent\",\"code\":\"exec_partial\",\"not_sent\":true}' where id = $1", [b.card]);
    expect(await state(b.card)).toBe("released");
    expect(await item(b.id)).toMatchObject({ status: "skipped" });
    const e = await (async () => {
      const w = await workspace();
      const x = await ready(w, { list: "j3e" });
      await tested(w, x.card);
      await r("select approve_email_card($1, 'channel_actions', $2, 1, $3, $4, 200) r", [w.t, x.card, w.owner, randomUUID()]);
      await db.query("update channel_actions set exec_status = 'dispatching' where id = $1", [x.card]);
      await db.query("update channel_actions set exec_status = 'failed', exec_progress = '{\"stage\":\"content_set\"}', exec_result = '{\"error\":\"stopped\",\"interrupted\":true}' where id = $1", [x.card]);
      return x;
    })();
    expect(await state(e.card)).toBe("released");
    expect(await item(e.id)).toMatchObject({ status: "skipped" });
    const c = await sent("j3c");
    await db.query("update channel_actions set exec_result = '{\"error\":\"other list\",\"code\":\"exec_partial\",\"audience_mismatch\":true}' where id = $1", [c.card]);
    expect(await state(c.card)).toBe("held");
    expect(await item(c.id)).toMatchObject({ status: "blocked", status_reason: "audience_mismatch" });
    const d = await sent("j3d");
    expect(await state(d.card)).toBe("held");
    expect(await item(d.id)).toMatchObject({ status: "reconciling" });
  });

  it("must catch J3 (fail closed): a failed or held-back decision releases the list only when no send was started", async () => {
    const w = await workspace();
    const mk = async () => {
      const id = (await one<{ id: string }>("insert into decisions (tenant_id, decision_class, body) values ($1, 'bulk_outbound.send', $2) returning id", [w.t, JSON.stringify({ list_id: randomUUID() })])).id;
      await db.query("set local zavi.email_card_approve = 'on'");
      await db.query("update decisions set status = 'approved', approved_by = $2 where id = $1", [id, w.owner]);
      await db.query("update decisions set status = 'dispatching' where id = $1", [id]);
      return id;
    };
    const state = (id: string) => one<{ state: string }>("select state from email_send_reservations where card_id = $1", [id]).then((x) => x.state);
    const none = await mk();
    await db.query("update decisions set status = 'dispatch_failed' where id = $1", [none]);
    const frozen = await mk();
    await db.query("insert into email_bulk_sends (tenant_id, decision_id, total) values ($1, $2, 5)", [w.t, frozen]);
    await db.query("update decisions set status = 'dispatch_failed' where id = $1", [frozen]);
    const unknownTotal = await mk();
    await db.query("insert into email_bulk_sends (tenant_id, decision_id, total) values ($1, $2, null)", [w.t, unknownTotal]);
    await db.query("update decisions set status = 'dispatch_failed' where id = $1", [unknownTotal]);
    const empty = await mk();
    await db.query("insert into email_bulk_sends (tenant_id, decision_id, total) values ($1, $2, 0)", [w.t, empty]);
    await db.query("update decisions set status = 'dispatch_failed' where id = $1", [empty]);
    const reffed = await mk();
    await db.query("insert into email_send_refs (tenant_id, rail, card_id, route, provider_ref) values ($1, 'decisions', $2, 'mailchimp', 'c1')", [w.t, reffed]);
    await db.query("update decisions set status = 'dispatch_failed' where id = $1", [reffed]);
    const back = await mk();
    await db.query("update decisions set status = 'proposed' where id = $1", [back]);
    await db.query("set local zavi.email_card_approve = ''");
    expect(await state(none)).toBe("released");
    expect(await state(frozen)).toBe("held");
    expect(await state(unknownTotal)).toBe("held");
    expect(await state(empty)).toBe("released");
    expect(await state(reffed)).toBe("held");
    expect(await state(back)).toBe("held");
    expect(await one("select public._email_decision_send_started($1, $2) x", [randomUUID(), reffed])).toEqual({ x: false });
  });

  it("must catch: a stuck hold has a way out: an owner or admin says it was not sent (once, logged); nobody else, and never mid-send", async () => {
    const w = await workspace();
    const other = await workspace();
    const x = await ready(w, { list: "stuck" });
    await tested(w, x.card);
    await r("select approve_email_card($1, 'channel_actions', $2, 1, $3, $4, 200) r", [w.t, x.card, w.owner, randomUUID()]);
    const confirm = (t: string, user: string, reason = "Checked Mailchimp: still a draft") =>
      r("select confirm_email_not_sent($1, $2, 'channel_actions', $3, $4) r", [t, user, x.card, reason]);
    const state = () => one<{ state: string }>("select state from email_send_reservations where card_id = $1", [x.card]).then((s) => s.state);
    expect(await confirm(w.t, w.owner)).toEqual({ ok: false, code: "still_sending" });
    await db.query("update channel_actions set exec_status = 'dispatching' where id = $1", [x.card]);
    await db.query("update channel_actions set exec_status = 'failed', exec_progress = '{\"stage\":\"send_requested\"}', exec_result = '{\"code\":\"exec_partial\"}' where id = $1", [x.card]);
    expect(await state()).toBe("held");
    const listed = await r("select list_email_planned_sends($1, $2) r", [w.t, w.member]);
    expect((listed.items as Array<Record<string, unknown>>).find((i) => i.id === x.id)).toMatchObject({ status: "reconciling", hold: { unresolved: true } });
    expect(await confirm(w.t, w.member)).toEqual({ ok: false, code: "not_authorized" });
    expect(await confirm(other.t, other.owner)).toEqual({ ok: false, code: "not_found" });
    expect(await confirm(w.t, w.owner, "   ")).toEqual({ ok: false, code: "bad_request" });
    expect(await state()).toBe("held");
    expect(await confirm(w.t, w.admin)).toEqual({ ok: true, changed: true });
    expect(await confirm(w.t, w.owner)).toEqual({ ok: true, changed: false, state: "released" });
    expect(await state()).toBe("released");
    expect(await item(x.id)).toMatchObject({ status: "skipped", status_reason: "not_sent_confirmed" });
    expect((await db.query("select released_by, reason, item_id, list_key from email_send_release_log where card_id = $1", [x.card])).rows).toEqual([
      { released_by: w.admin, reason: "Checked Mailchimp: still a draft", item_id: x.id, list_key: "mailchimp:stuck" },
    ]);
    await db.query("update channel_actions set exec_status = 'executed', executed_at = now() where id = $1", [x.card]);
    expect(await state()).toBe("sent");
  });

  it("must catch L1: nothing is confirmable while something may still settle it, or when mail left", async () => {
    const w = await workspace();
    const code = (rail: string, id: string) =>
      r("select confirm_email_not_sent($1, $2, $3, $4, 'Checked: not sent') r", [w.t, w.owner, rail, id]).then((x) => x.code ?? (x.changed ? "released" : "no_change"));
    const card = async (list: string, set: string) => {
      const id = (await one<{ id: string }>(
        "insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id",
        [w.t, JSON.stringify(toolBody({ audience_id: list }))],
      )).id;
      await db.query("insert into email_send_reservations (tenant_id, list_key, card_rail, card_id) values ($1, $2, 'channel_actions', $3)", [w.t, `mailchimp:${list}`, id]);
      await db.query(`update channel_actions set ${set} where id = $1`, [id]);
      return id;
    };
    await db.query("set local zavi.email_card_approve = 'on'");
    expect(await code("channel_actions", await card("l1a", "exec_status = 'failed', exec_claimed_at = now() - interval '10 minutes', exec_result = '{\"code\":\"exec_outcome_unknown\"}'"))).toBe("still_sending");
    expect(await code("channel_actions", await card("l1b", "exec_status = 'failed', exec_claimed_at = now() - interval '3 hours', exec_result = '{\"code\":\"exec_outcome_unknown\"}'"))).toBe("released");
    expect(await code("channel_actions", await card("l1c", "exec_status = 'dispatching', exec_claimed_at = now() - interval '30 minutes'"))).toBe("still_sending");
    expect(await code("channel_actions", await card("l1d", "exec_status = 'dispatching', exec_claimed_at = now() - interval '3 hours'"))).toBe("released");
    expect(await code("channel_actions", await card("l1e", "exec_status = 'failed', exec_result = '{\"code\":\"exec_partial\",\"audience_mismatch\":true}'"))).toBe("mail_left");
    const decision = async (status: string, dispatchedAgo: string, frozenTotal: number | null | undefined = undefined) => {
      const id = (await one<{ id: string }>(
        "insert into decisions (tenant_id, decision_class, body, status, approved_by, dispatched_at) values ($1, 'bulk_outbound.send', $2, $3, $4, now() - $5::interval) returning id",
        [w.t, JSON.stringify({ list_id: randomUUID() }), status, w.owner, dispatchedAgo],
      )).id;
      await db.query("insert into email_send_reservations (tenant_id, list_key, card_rail, card_id) values ($1, $2, 'decisions', $3)", [w.t, `zavi_list:${id}`, id]);
      if (frozenTotal !== undefined) await db.query("insert into email_bulk_sends (tenant_id, decision_id, total) values ($1, $2, $3)", [w.t, id, frozenTotal]);
      return id;
    };
    expect(await code("decisions", await decision("proposed", "30 minutes"))).toBe("still_sending");
    expect(await code("decisions", await decision("dispatching", "30 minutes"))).toBe("still_sending");
    expect(await code("decisions", await decision("dispatching", "3 hours"))).toBe("released");
    expect(await code("decisions", await decision("dispatch_failed", "1 hour", 5))).toBe("zavi_sending");
    expect(await code("decisions", await decision("dispatch_failed", "1 hour", 0))).toBe("released");
    await db.query("set local zavi.email_card_approve = ''");
  });

  it("must catch M1: confirming closes the card for good: a stuck released claim is never claimed again, a channel card never tried again", async () => {
    const w = await workspace();
    await db.query("set local zavi.email_card_approve = 'on'");
    const d = (await one<{ id: string }>(
      "insert into decisions (tenant_id, decision_class, body, status, approved_by, dispatched_at) values ($1, 'bulk_outbound.send', $2, 'proposed', $3, now() - interval '3 hours') returning id",
      [w.t, JSON.stringify({ list_id: randomUUID() }), w.owner],
    )).id;
    await db.query("insert into email_send_reservations (tenant_id, list_key, card_rail, card_id) values ($1, $2, 'decisions', $3)", [w.t, `zavi_list:${d}`, d]);
    await db.query("set local zavi.email_card_approve = ''");
    expect(await r("select confirm_email_not_sent($1, $2, 'decisions', $3, 'Checked: nothing went out') r", [w.t, w.owner, d])).toEqual({ ok: true, changed: true });
    expect(await one("select status, dispatch_error from decisions where id = $1", [d])).toEqual({ status: "dispatch_failed", dispatch_error: "not_sent_confirmed" });
    expect((await db.query("update decisions set status = 'dispatching' where id = $1 and status in ('approved', 'proposed')", [d])).rowCount).toBe(0);
    await db.query("savepoint m1");
    await expect(db.query("update decisions set status = 'dispatching' where id = $1", [d])).rejects.toThrow(/email_card_approve_required/);
    await db.query("rollback to savepoint m1");
    expect(await one("select coalesce(current_setting('zavi.email_card_approve', true), '') f")).toEqual({ f: "" });
    expect(await one("select state from email_send_reservations where card_id = $1", [d])).toEqual({ state: "released" });

    const x = await ready(w, { list: "m1" });
    await tested(w, x.card);
    await r("select approve_email_card($1, 'channel_actions', $2, 1, $3, $4, 200) r", [w.t, x.card, w.owner, randomUUID()]);
    await db.query("update channel_actions set exec_status = 'dispatching' where id = $1", [x.card]);
    await db.query("update channel_actions set exec_status = 'failed', exec_progress = '{\"stage\":\"send_requested\"}', exec_result = '{\"error\":\"x\"}' where id = $1", [x.card]);
    expect(await one("select public._email_card_retryable(exec_result) x from channel_actions where id = $1", [x.card])).toEqual({ x: true });
    expect(await r("select confirm_email_not_sent($1, $2, 'channel_actions', $3, 'Checked: still a draft') r", [w.t, w.owner, x.card])).toEqual({ ok: true, changed: true });
    expect(await one("select exec_status, exec_result->>'code' code from channel_actions where id = $1", [x.card])).toEqual({ exec_status: "failed", code: "not_sent_confirmed" });
    expect(await r("select public._email_card_retry($1, $2, $3, $4, 200) r", [w.t, x.card, w.owner, randomUUID()])).toEqual({ ok: false, code: "exec_partial_no_retry" });
    expect(await item(x.id)).toMatchObject({ status: "skipped", status_reason: "not_sent_confirmed" });
    expect(await one("select state, released_reason from email_send_reservations where card_id = $1", [x.card])).toEqual({ state: "released", released_reason: "founder_not_sent" });
  });

  it("must catch L6: the unplanned holds list finds an unresolved hold behind 20 that may still settle", async () => {
    const w = await workspace();
    await db.query("set local zavi.email_card_approve = 'on'");
    for (let i = 0; i < 21; i++) {
      const id = (await one<{ id: string }>(
        "insert into channel_actions (tenant_id, exec_class, exec_payload, exec_status) values ($1, 'email_campaign.create_and_send', $2, 'queued') returning id",
        [w.t, JSON.stringify(toolBody({ audience_id: `l6-${i}` }))],
      )).id;
      await db.query("insert into email_send_reservations (tenant_id, list_key, card_rail, card_id, reserved_at) values ($1, $2, 'channel_actions', $3, now() - interval '2 days')", [w.t, `mailchimp:l6-${i}`, id]);
    }
    await db.query("set local zavi.email_card_approve = ''");
    const gone = randomUUID();
    await db.query("insert into email_send_reservations (tenant_id, list_key, card_rail, card_id) values ($1, 'mailchimp:l6-gone', 'channel_actions', $2)", [w.t, gone]);
    expect((await r("select list_email_planned_sends($1, $2) r", [w.t, w.member])).holds).toEqual([expect.objectContaining({ card_id: gone })]);
  });

  it("must catch L5: a card held again is alerted again (alerted_at cleared, a new key per hold)", async () => {
    const w = await workspace();
    const card = randomUUID();
    await db.query(
      "insert into email_send_reservations (tenant_id, list_key, card_rail, card_id, reserved_at) values ($1, 'mailchimp:l5', 'channel_actions', $2, now() - interval '25 hours')",
      [w.t, card],
    );
    await one("select alert_stuck_email_holds(200)");
    await db.query("update email_send_reservations set state = 'released' where card_id = $1", [card]);
    await db.query("select public._email_reserve($1, 'mailchimp:l5', 'channel_actions', $2, 'founder')", [w.t, card]);
    expect(await one("select alerted_at from email_send_reservations where card_id = $1", [card])).toEqual({ alerted_at: null });
    await db.query("update email_send_reservations set reserved_at = now() - interval '30 hours' where card_id = $1", [card]);
    await one("select alert_stuck_email_holds(200)");
    expect((await db.query("select dedupe_key from ops_alert_outbox where tenant_id = $1", [w.t])).rows).toHaveLength(2);
  });

  it("must catch: a held send that is not a planned item shows in the queue with the same way out", async () => {
    const w = await workspace();
    await db.query("set local zavi.email_card_approve = 'on'");
    const id = (await one<{ id: string }>("insert into decisions (tenant_id, decision_class, body) values ($1, 'bulk_outbound.send', $2) returning id", [w.t, JSON.stringify({ list_id: randomUUID() })])).id;
    await db.query("update decisions set status = 'approved', approved_by = $2 where id = $1", [id, w.owner]);
    await db.query("update decisions set status = 'dispatching' where id = $1", [id]);
    await db.query("insert into email_send_refs (tenant_id, rail, card_id, route, provider_ref) values ($1, 'decisions', $2, 'mailchimp', 'c9')", [w.t, id]);
    await db.query("update decisions set status = 'dispatch_failed' where id = $1", [id]);
    await db.query("set local zavi.email_card_approve = ''");
    const listed = await r("select list_email_planned_sends($1, $2) r", [w.t, w.member]);
    expect(listed.holds).toEqual([expect.objectContaining({ rail: "decisions", card_id: id })]);
    expect(await r("select confirm_email_not_sent($1, $2, 'decisions', $3, 'Checked: not sent') r", [w.t, w.owner, id])).toEqual({ ok: true, changed: true });
    expect((await r("select list_email_planned_sends($1, $2) r", [w.t, w.member])).holds).toEqual([]);
  });

  it("must catch: staff are told once about a send held over 24 hours", async () => {
    const w = await workspace();
    const card = randomUUID();
    await db.query(
      "insert into email_send_reservations (tenant_id, list_key, card_rail, card_id, source, reserved_at) values ($1, 'mailchimp:old-hold', 'channel_actions', $2, 'founder', now() - interval '25 hours')",
      [w.t, card],
    );
    const fresh = randomUUID();
    await db.query("insert into email_send_reservations (tenant_id, list_key, card_rail, card_id, reserved_at) values ($1, 'mailchimp:new-hold', 'channel_actions', $2, now() - interval '2 hours')", [w.t, fresh]);
    const alerts = () => db.query("select dedupe_key, code, tenant_id from ops_alert_outbox where tenant_id = $1", [w.t]).then((q) => q.rows);
    expect(await one("select alert_stuck_email_holds(200) >= 1 x")).toEqual({ x: true });
    expect(await alerts()).toEqual([{ dedupe_key: expect.stringMatching(new RegExp(`^email_hold_stuck:channel_actions:${card}:\\d+$`)), code: "email_send_hold_stuck", tenant_id: w.t }]);
    await one("select alert_stuck_email_holds(200)");
    expect(await alerts()).toHaveLength(1);
    expect(await one("select alerted_at is not null a from email_send_reservations where card_id = $1", [card])).toEqual({ a: true });
  });

  it("must catch H3: a held reservation blocks however old it is; a sent one ages from when it went out", async () => {
    const w = await workspace();
    const res = (key: string, state: string, reserved: string, settled: string | null) =>
      db.query("insert into email_send_reservations (tenant_id, list_key, card_rail, card_id, state, reserved_at, settled_at) values ($1, $2, 'channel_actions', $3, $4, now() - $5::interval, now() - $6::interval)", [w.t, key, randomUUID(), state, reserved, settled]);
    await res("mailchimp:held-old", "held", "30 days", null);
    await res("mailchimp:sent-late", "sent", "20 days", "2 days");
    await res("mailchimp:sent-old", "sent", "9 days", "8 days");
    const near = (k: string) => one<{ x: boolean }>("select email_list_sent_recently($1, $2, null, null) is not null x", [w.t, k]).then((r) => r.x);
    expect(await near("mailchimp:held-old")).toBe(true);
    expect(await near("mailchimp:sent-late")).toBe(true);
    expect(await near("mailchimp:sent-old")).toBe(false);
  });

  it("must catch H5: a planned card is approvable only as its item's card, at its current version", async () => {
    const w = await workspace();
    const p = await plan(w, { list: "h5" });
    const id = p.id as string;
    await begin(w.t, id);
    const unattached = (await one<{ id: string }>(
      "insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', $2) returning id",
      [w.t, JSON.stringify(toolBody({ audience_id: "h5", planned_send_id: id, plan_version: 1 }))],
    )).id;
    await tested(w, unattached);
    expect(await r("select approve_email_card($1, 'channel_actions', $2, 1, $3, 'x', 200) r", [w.t, unattached, w.owner])).toEqual({ ok: false, code: "plan_changed" });
    const ok = await ready(w, { list: "h5b" });
    await tested(w, ok.card);
    expect(await r("select approve_email_card($1, 'channel_actions', $2, 1, $3, 'y', 200) r", [w.t, ok.card, w.owner])).toMatchObject({ ok: true });
  });

  it("must catch H7: Don't send works after the planned time until the deadline fires; then it is refused", async () => {
    const w = await workspace();
    const a = await ready(w, { list: "h7a" });
    await due(a.id);
    expect(await r("select withdraw_email_planned_send($1, $2, $3) r", [w.t, w.owner, a.id])).toEqual({ ok: true });
    expect(await fire(w, a.id, { allow: true, count: 10 })).toEqual({ ok: true, outcome: "skipped", reason: "vetoed" });
    const b = await ready(w, { list: "h7b" });
    await due(b.id);
    expect(await fire(w, b.id, { allow: true, count: 10 })).toMatchObject({ outcome: "queued" });
    expect(await r("select withdraw_email_planned_send($1, $2, $3) r", [w.t, w.owner, b.id])).toMatchObject({ ok: false, code: "not_withdrawable" });
  });

  it("must catch H8 + H9: a move stores the zone it was picked in; the week cap counts every item (skipped too) in its own zone", async () => {
    const w = await workspace();
    const base = await one<{ d: string }>("select (date_trunc('week', (now() + interval '7 days') at time zone 'UTC') + interval '1 day 12 hours') at time zone 'UTC' d");
    const day = (n: number) => new Date(new Date(base.d).getTime() + n * 24 * H).toISOString();
    const p = (list: string, when: string, tz = "UTC") =>
      r("select plan_email_send($1, $2, 'founder', 'mailchimp', $3, 'L', $4, $5, 'A', null, $6) r", [w.t, w.owner, list, when, tz, randomUUID()]);
    const a = await p("w1", day(0));
    await p("w2", day(1));
    const c = await p("w3", day(2));
    await r("select skip_email_planned_send($1, $2, $3) r", [w.t, w.owner, c.id]);
    expect(await p("w4", day(3))).toEqual({ ok: false, code: "week_full" });
    const g = (await item(a.id as string)).schedule_gen as number;
    expect(await r("select move_email_planned_send($1, $2, $3, $4, $5, 'Mars/Olympus') r", [w.t, w.owner, a.id, day(4), g])).toEqual({ ok: false, code: "bad_timezone" });
    expect(await r("select move_email_planned_send($1, $2, $3, $4, $5, 'Asia/Kolkata') r", [w.t, w.owner, a.id, day(4), g])).toMatchObject({ ok: true });
    expect(await item(a.id as string)).toMatchObject({ planned_tz: "Asia/Kolkata" });
  });

  it("must catch H10: out of draft attempts is skipped at once and its draft work is closed (repair does not bring it back)", async () => {
    const w = await workspace();
    const p = await plan(w, { list: "h10" });
    const id = p.id as string;
    await db.query("update email_planned_sends set draft_attempts = 3 where id = $1", [id]);
    expect(await begin(w.t, id)).toMatchObject({ attempt: null, status: "skipped" });
    expect(await item(id)).toMatchObject({ status: "skipped", status_reason: "no_draft" });
    expect(await one("select count(*)::int n from email_plan_jobs where item_id = $1 and kind = 'draft' and state = 'pending'", [id])).toEqual({ n: 0 });
    await db.query("update email_plan_jobs set state = 'done' where item_id = $1 and kind = 'draft' and state = 'leased'", [id]);
    await one("select repair_email_plan_jobs(1000)");
    expect(await one("select count(*)::int n from email_plan_jobs where item_id = $1 and state <> 'done'", [id])).toEqual({ n: 1 });
  });

  it("must catch H11 + H12: a new angle moves to a new generation; the deadline waits for its draft; nothing fires before the exact time", async () => {
    const w = await workspace();
    const a = await ready(w, { list: "h11" });
    const g0 = (await item(a.id)).schedule_gen as number;
    expect(await r("select change_email_planned_angle($1, $2, $3, 'Last call', 1) r", [w.t, w.owner, a.id])).toMatchObject({ ok: true, schedule_gen: g0 + 1 });
    await due(a.id);
    expect(await r("select fire_email_planned_send($1, $2, $3, '{}') r", [w.t, a.id, g0])).toMatchObject({ outcome: "noop" });
    expect(await fire(w, a.id)).toEqual({ ok: true, outcome: "not_yet" });
    const b = await ready(w, { list: "h12" });
    await db.query("update email_planned_sends set planned_at = now() + interval '30 seconds' where id = $1", [b.id]);
    expect(await fire(w, b.id)).toEqual({ ok: true, outcome: "not_yet" });
  });

  it("H13: the ledger triggers fire only on a state change of an email card", async () => {
    const t = (await db.query("select tgname, pg_get_triggerdef(oid) d from pg_trigger where tgname in ('channel_actions_email_ledger', 'decisions_email_ledger') order by tgname")).rows;
    expect(t.length).toBe(2);
    for (const x of t) expect(x.d).toMatch(/WHEN/);
  });

  it("must catch H4 + H14: an unattended Zavi-list send needs its own reservation, a count of 1..1000, and the active version at the freeze", async () => {
    const w = await workspace();
    const list = (await one<{ id: string }>("insert into email_lists (tenant_id) values ($1) returning id", [w.t])).id;
    const ver = (await one<{ id: string }>("insert into email_list_versions (tenant_id, list_id, consent_confirmed_at) values ($1, $2, now()) returning id", [w.t, list])).id;
    await db.query("update email_lists set active_version_id = $1 where id = $2", [ver, list]);
    const contact = (await one<{ id: string }>("insert into email_contacts (tenant_id, email_norm) values ($1, 'a@x.test') returning id", [w.t])).id;
    await db.query("insert into email_list_version_contacts values ($1, $2, $3)", [w.t, ver, contact]);
    expect(await one("select email_list_version_freeze_count($1, $2) n", [w.t, ver])).toEqual({ n: 1 });
    const p = await plan(w, { route: "zavi_list", list });
    const id = p.id as string;
    await begin(w.t, id);
    const run = randomUUID();
    await db.query("insert into agent_runs values ($1, $2, $3)", [run, w.t, JSON.stringify({ email_plan: { mode: "planned_draft", item_id: id, version: 1 } })]);
    const card = (await one<{ id: string }>("insert into decisions (tenant_id, decision_class, body) values ($1, 'bulk_outbound.send', $2) returning id", [
      w.t,
      JSON.stringify({ list_id: list, list_version_id: ver, list_name: "Members", from_address: "hi@b.test", variants: [v(1)], template_snapshot: {}, renderer_version: "email-r1", planned_send_id: id, plan_version: 1 }),
    ])).id;
    await r("select attach_email_planned_card($1, $2, 1, $3, 'decisions', $4) r", [w.t, id, run, card]);
    await due(id);
    expect(await fire(w, id, { allow: true, count: 1 })).toMatchObject({ outcome: "queued" });
    expect(await r("select email_plan_unattended_ok($1, $2) r", [w.t, card])).toEqual({ ok: true, approved_count: 1 });
    await db.query("update email_send_reservations set state = 'released' where card_id = $1", [card]);
    expect(await r("select email_plan_unattended_ok($1, $2) r", [w.t, card])).toEqual({ ok: false, code: "not_planned" });
    await db.query("update email_send_reservations set state = 'held' where card_id = $1", [card]);
    const newer = (await one<{ id: string }>("insert into email_list_versions (tenant_id, list_id, consent_confirmed_at) values ($1, $2, now()) returning id", [w.t, list])).id;
    await db.query("update email_lists set active_version_id = $1 where id = $2", [newer, list]);
    const freeze = () =>
      r("select email_bulk_freeze_send($1, $2, $3, $4, 's', 'b', 'hi@b.test', null, 1000) r", [w.t, card, list, ver]);
    expect(await freeze()).toEqual({ ok: false, reason: "list_version_changed" });
    await db.query("update email_lists set active_version_id = $1 where id = $2", [ver, list]);
    expect(await freeze()).toMatchObject({ ok: true, created: true, total: 1 });
  });

  it("the queue reads as a member, never another workspace's; a card names its item", async () => {
    const w = await workspace();
    const { id, card } = await ready(w);
    const out = await r("select list_email_planned_sends($1, $2) r", [w.t, w.member]);
    expect(out).toMatchObject({ ok: true, role: "member" });
    expect((out.items as Array<{ id: string }>).map((x) => x.id)).toEqual([id]);
    const other = await workspace();
    expect(await r("select list_email_planned_sends($1, $2) r", [w.t, other.owner])).toEqual({ ok: false, code: "not_found" });
    expect(await r("select email_planned_for_card($1, 'channel_actions', $2) r", [w.t, card])).toMatchObject({ id, status: "ready" });
    expect(await r("select email_planned_for_card($1, 'channel_actions', $2) r", [other.t, card])).toBeNull();
  });
});
