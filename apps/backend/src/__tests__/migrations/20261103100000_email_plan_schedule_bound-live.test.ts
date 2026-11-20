import { readFileSync } from "node:fs";
import { join } from "node:path";
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
const at = (hours: number) => new Date(Date.now() + hours * H).toISOString();

describe.skipIf(!PG_URL)("20261103100000 email plan schedule bound, live", () => {
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

  beforeAll(async () => {
    db = new Client({ connectionString: PG_URL });
    await db.connect();
    const exists = await one<{ t: string | null }>("select to_regclass('public.channel_actions')::text t");
    if (exists.t) throw new Error("ZAVI_TEST_VANILLA_PG_URL must be a VANILLA throwaway database");
    await db.query("begin");
    await db.query(EMAIL_CARD_BOOTSTRAP);
    await db.query(EXTRA);
    for (const s of EMAIL_CARD_SQL) await db.query(s);
    await db.query(readFileSync(join(__dirname, "../../../../../supabase/migrations/20261103100000_email_plan_schedule_bound.sql"), "utf8").replace(/^(begin|commit);$/gm, ""));
  });
  afterAll(async () => {
    if (!db) return;
    await db.query("rollback").catch(() => {});
    await db.end();
  });

  const schedule = (w: W, id: string, o: { gen?: number; version?: number; key?: string; user?: string; variant?: number } = {}) =>
    r("select schedule_email_planned_send($1, $2, $3, $4, 180, $5, $6, $7) r", [
      w.t, o.user ?? w.owner, id, o.variant ?? 1, o.gen ?? 1, o.version ?? 1, o.key ?? randomUUID(),
    ]);

  it("must catch N1: an approval for the time names the generation and version it saw; a stale card is refused", async () => {
    const w = await workspace();
    const x = await ready(w, { list: "n1" });
    await tested(w, x.card);
    expect(await schedule(w, x.id, { gen: 2 })).toEqual({ ok: false, code: "plan_changed" });
    expect(await schedule(w, x.id, { version: 2 })).toEqual({ ok: false, code: "plan_changed" });
    expect(await item(x.id)).toMatchObject({ status: "ready", sched_at: null });
    expect(await schedule(w, x.id, { user: w.member })).toEqual({ ok: false, code: "not_authorized" });
    expect(await schedule(w, x.id)).toMatchObject({ ok: true, replayed: false });
    expect(await item(x.id)).toMatchObject({ status: "scheduled", sched_variant: 1 });
  });

  it("must catch N1: the same request again is replayed, never a second approval, and never again after Don't send", async () => {
    const w = await workspace();
    const x = await ready(w, { list: "n1r" });
    await tested(w, x.card);
    const key = randomUUID();
    expect(await schedule(w, x.id, { key })).toMatchObject({ ok: true, replayed: false });
    const at = (await item(x.id)).sched_at;
    expect(await schedule(w, x.id, { key })).toMatchObject({ ok: true, replayed: true, status: "scheduled" });
    expect((await item(x.id)).sched_at).toEqual(at);
    expect(await r("select withdraw_email_planned_send($1, $2, $3) r", [w.t, w.owner, x.id])).toEqual({ ok: true, schedule_gen: 2 });
    expect(await schedule(w, x.id, { key })).toMatchObject({ ok: true, replayed: true, status: "ready" });
    expect(await item(x.id)).toMatchObject({ status: "ready", sched_at: null });
  });

  it("must catch fd6: an approval sent before a Don't send (delayed, answer lost, or another approver's) cannot re-approve it", async () => {
    const w = await workspace();
    const x = await ready(w, { list: "fd6" });
    await tested(w, x.card);
    const landed = randomUUID();
    expect(await schedule(w, x.id, { key: landed })).toMatchObject({ ok: true, replayed: false });
    expect(await r("select withdraw_email_planned_send($1, $2, $3) r", [w.t, w.owner, x.id])).toEqual({ ok: true, schedule_gen: 2 });
    expect(await schedule(w, x.id, { gen: 1 })).toEqual({ ok: false, code: "plan_changed" });
    expect(await schedule(w, x.id, { key: landed, gen: 1 })).toMatchObject({ ok: true, replayed: true, status: "ready" });
    expect(await item(x.id)).toMatchObject({ status: "ready", schedule_gen: 2, sched_at: null });
    expect((await item(x.id)).vetoed_at).not.toBeNull();
    expect((await db.query("select job_key from email_plan_jobs where item_id = $1 and kind = 'deadline' and state <> 'done' order by job_key", [x.id])).rows.map((j) => j.job_key)).toContain(`deadline:${x.id}:g2`);
    await db.query("update email_planned_sends set planned_at = now() - interval '1 minute' where id = $1", [x.id]);
    expect(await r("select fire_email_planned_send($1, $2, 1, '{\"allow\": true, \"count\": 10}'::jsonb) r", [w.t, x.id])).toMatchObject({ ok: true, outcome: "noop" });
    expect(await r("select fire_email_planned_send($1, $2, 2, '{\"allow\": true, \"count\": 10}'::jsonb) r", [w.t, x.id])).toMatchObject({ ok: true });
    expect(await item(x.id)).toMatchObject({ status: "skipped", status_reason: "vetoed" });
    const y = await ready(w, { list: "fd6b" });
    await tested(w, y.card);
    expect(await r("select withdraw_email_planned_send($1, $2, $3) r", [w.t, w.owner, y.id])).toMatchObject({ ok: true });
    expect(await schedule(w, y.id, { gen: 2 })).toMatchObject({ ok: true, replayed: false });
  });

  it("fd9: the plan read says when a Draft now is queued, and which sends were released as not sent (the durable record)", async () => {
    const w = await workspace();
    const p = await plan(w, { list: "fd9", hours: 72 });
    const id = p.id as string;
    const read = () => r("select list_email_planned_sends($1, $2) r", [w.t, w.member]);
    const itemOf = (v: Record<string, unknown>) => (v.items as Array<Record<string, unknown>>).find((i) => i.id === id)!;
    expect(itemOf(await read())).toMatchObject({ draft_requested: false });
    expect(await r("select draft_email_planned_now($1, $2, $3) r", [w.t, w.owner, id])).toEqual({ ok: true });
    expect(itemOf(await read())).toMatchObject({ status: "planned", draft_requested: true });
    expect((await read()).released).toEqual([]);
    const card = randomUUID();
    await db.query("insert into email_send_reservations (tenant_id, list_key, card_rail, card_id) values ($1, 'mailchimp:fd9-held', 'channel_actions', $2)", [w.t, card]);
    expect(await r("select confirm_email_not_sent($1, $2, 'channel_actions', $3, 'Checked: draft') r", [w.t, w.owner, card])).toMatchObject({ ok: true, changed: true });
    expect((await read()).released).toEqual([card]);
    const other = await workspace();
    expect((await r("select list_email_planned_sends($1, $2) r", [other.t, other.member])).released).toEqual([]);
  });

  it("must catch N1: the unbound form approves nothing", async () => {
    const w = await workspace();
    const x = await ready(w, { list: "n1u" });
    await tested(w, x.card);
    expect(await r("select schedule_email_planned_send($1, $2, $3, 1, 180) r", [w.t, w.owner, x.id])).toEqual({ ok: false, code: "plan_changed" });
    expect(await item(x.id)).toMatchObject({ status: "ready" });
  });

  it("the card reads the content version; a replay reads the stored row, never another workspace's", async () => {
    const w = await workspace();
    const other = await workspace();
    const x = await ready(w, { list: "n8" });
    expect(await r("select email_planned_for_card($1, 'channel_actions', $2) r", [w.t, x.card])).toMatchObject({ content_version: 1, schedule_gen: 1 });
    expect(await r("select email_planned_send_row($1, $2) r", [w.t, x.id])).toMatchObject({ id: x.id, list_name: "Members", timezone: "America/Los_Angeles" });
    expect(await r("select email_planned_send_row($1, $2) r", [other.t, x.id])).toBeNull();
  });
});
