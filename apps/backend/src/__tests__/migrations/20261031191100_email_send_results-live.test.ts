import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EMAIL_CARD_BOOTSTRAP, EMAIL_CARD_SQL } from "./email-card-live-migrations";

const PG_URL = process.env.ZAVI_TEST_VANILLA_PG_URL;
const dir = join(__dirname, "../../../../../supabase/migrations");
const NEW_SQL = ["20261031191100_email_send_results.sql", "20261031191200_email_bulk_engagement.sql"].map((f) =>
  readFileSync(join(dir, f), "utf8").replace(/^(begin|commit);$/gm, ""),
);

const BULK_BOOTSTRAP = `
  create table email_contacts (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, email_norm text, unique (tenant_id, email_norm));
  create table email_bulk_sends (
    id uuid primary key default gen_random_uuid(), tenant_id uuid not null, decision_id uuid not null,
    status text not null default 'sending', hold_reason text, sent int not null default 0, total int not null default 0,
    created_at timestamptz not null default now(), finished_at timestamptz,
    unique (tenant_id, id)
  );
  create table email_bulk_send_recipients (send_id uuid not null, tenant_id uuid not null, contact_id uuid not null, status text not null default 'pending', primary key (send_id, contact_id));
  create table email_suppression (tenant_id uuid not null, email text not null, reason text not null, created_at timestamptz not null default now(), primary key (tenant_id, email));
`;

const T = randomUUID();
const OTHER = randomUUID();

describe.skipIf(!PG_URL)("20261031191100 email send results, live", () => {
  let db: Client;
  const one = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R> => (await db.query(sql, params)).rows[0] as R;
  const r = (sql: string, params: unknown[] = []) => one<{ r: Record<string, unknown> }>(sql, params).then((x) => x.r);

  const card = async (tenant = T): Promise<string> =>
    (await one<{ id: string }>("insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', '{}') returning id", [tenant])).id;
  const bulkDecision = async (status: string, hold: string | null, sent: number) => {
    const d = (await one<{ id: string }>("insert into decisions (tenant_id, decision_class, body) values ($1, 'bulk_outbound.send', '{}') returning id", [T])).id;
    const s = (await one<{ id: string }>("insert into email_bulk_sends (tenant_id, decision_id, status, hold_reason, sent, total) values ($1, $2, $3, $4, $5, $5) returning id", [T, d, status, hold, sent])).id;
    return { d, s };
  };
  const row = (over: Record<string, unknown> = {}) => ({
    route: "sendgrid",
    provider_ref: "123",
    account_ref: { kind: "sendgrid_key", key_digest: "a".repeat(64) },
    campaign_title: "Zavi: Hello (abcd1234)",
    list_id: "list-1",
    list_name: "Customers",
    subject: "Hello",
    campaign_slug: "hello-20261012-abcdefghij",
    sent_count: 100,
    total_count: 100,
    started_at: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    finished_at: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    win_line: { metric: "visitors", threshold: 0.02, basis: "median", n_past: 5 },
    provider_group: "sendgrid:aaaa",
    ...over,
  });
  const start = (id: string, over: Record<string, unknown> = {}, rail = "channel_actions", tenant = T) =>
    r("select start_email_send_result($1, $2, $3, $4) r", [tenant, rail, id, JSON.stringify(row(over))]);
  const claim = async (limit = 50) => (await db.query("select claim_email_result_tasks($1, 600) j", [limit])).rows.map((x) => x.j as Record<string, string>);
  const complete = (t: Record<string, string>, outcome: string, result: unknown = {}, extra: { next?: string; ga?: unknown; note?: string; error?: string } = {}) =>
    r("select complete_email_result_task($1, $2, $3, $4, $5, $6, $7, $8, $9) r", [
      t.tenant_id, t.task_id, t.lease_token, outcome, JSON.stringify(result), extra.next ?? null, extra.error ?? null, extra.ga ? JSON.stringify(extra.ga) : null, extra.note ?? null,
    ]);

  beforeAll(async () => {
    db = new Client({ connectionString: PG_URL });
    await db.connect();
    const exists = await one<{ t: string | null }>("select to_regclass('public.channel_actions')::text t");
    if (exists.t) throw new Error("ZAVI_TEST_VANILLA_PG_URL must be a VANILLA throwaway database");
    await db.query("begin");
    await db.query(EMAIL_CARD_BOOTSTRAP);
    await db.query(BULK_BOOTSTRAP);
    await db.query("insert into tenants values ($1), ($2)", [T, OTHER]);
    for (const sql of EMAIL_CARD_SQL) await db.query(sql);
    for (const sql of NEW_SQL) await db.query(sql);
  });
  afterAll(async () => {
    if (!db) return;
    await db.query("rollback").catch(() => undefined);
    await db.end();
  });
  beforeEach(async () => {
    await db.query("delete from email_result_tasks; delete from email_send_results;");
  });

  it("starts once per card: the row plus provider h1, provider d7 and GA d7", async () => {
    const id = await card();
    expect(await start(id)).toMatchObject({ ok: true, created: true });
    expect(await start(id)).toMatchObject({ ok: true, created: false });
    const tasks = (await db.query("select source, stage from email_result_tasks order by source, stage")).rows;
    expect(tasks).toEqual([
      { source: "ga", stage: "d7" },
      { source: "provider", stage: "d7" },
      { source: "provider", stage: "h1" },
    ]);
  });

  it("no GA check for an untagged email", async () => {
    await start(await card(), { campaign_slug: null });
    expect((await one<{ n: string }>("select count(*) n from email_result_tasks where source = 'ga'")).n).toBe("0");
  });

  it("a tag two sends share: both rows say so and neither keeps a GA check; another tenant's tag is not shared", async () => {
    await start(await card(), { campaign_slug: "same-20261012" });
    await start(await card(OTHER), { campaign_slug: "same-20261012" }, "channel_actions", OTHER);
    expect((await one<{ n: string }>("select count(*) n from email_result_tasks where source = 'ga' and state = 'pending'")).n).toBe("2");
    await start(await card(), { campaign_slug: "same-20261012" });
    const rows = (await db.query("select tenant_id, shared_tag, d7->>'ga_status' s from email_send_results order by created_at")).rows;
    expect(rows.filter((x) => x.tenant_id === T).map((x) => [x.shared_tag, x.s])).toEqual([[true, "shared_tag"], [true, "shared_tag"]]);
    expect(rows.find((x) => x.tenant_id === OTHER)!.shared_tag).toBe(false);
    const ga = (await db.query("select tenant_id, state from email_result_tasks where source = 'ga'")).rows;
    expect(ga.filter((x) => x.tenant_id === T).map((x) => x.state)).toEqual(["gave_up"]);
    expect(ga.find((x) => x.tenant_id === OTHER)!.state).toBe("pending");
  });

  it("a shared tag never keeps a visitors win line: decided at start under the tag's lock", async () => {
    for (const v of [2, 4, 6]) {
      const id = await card();
      await db.query(
        `insert into email_send_results (tenant_id, rail, card_id, route, provider_ref, list_id, sent_count, started_at, finished_at, win_line, d7, d7_published_at)
         values ($1, 'channel_actions', $2, 'sendgrid', 'x', 'list-1', 100, now() - interval '30 days', now() - interval '30 days', '{"metric":"clicks","basis":"median"}', $3, now() - interval '20 days')`,
        [T, id, JSON.stringify({ delivered: 100, clicks: v })],
      );
    }
    const visitors = { metric: "visitors", threshold: null, basis: "first_sends", n_past: 0 };
    const first = await card();
    await start(first, { campaign_slug: "shared-20261012", win_line: visitors });
    await start(await card(), { campaign_slug: "shared-20261012", win_line: visitors });
    const rows = (await db.query("select card_id, win_line from email_send_results where campaign_slug = 'shared-20261012'")).rows;
    expect(rows.map((x) => x.win_line)).toEqual([
      { metric: "clicks", threshold: 0.04, basis: "median", n_past: 3 },
      { metric: "clicks", threshold: 0.04, basis: "median", n_past: 3 },
    ]);
    const d1 = await bulkDecision("done", null, 5);
    const d2 = await bulkDecision("done", null, 5);
    await start(d1.d, { route: "zavi_list", provider_ref: d1.s, sent_count: 5, campaign_slug: "zl-20261012", win_line: visitors }, "decisions");
    await start(d2.d, { route: "zavi_list", provider_ref: d2.s, sent_count: 5, campaign_slug: "zl-20261012", win_line: visitors }, "decisions");
    const zl = (await db.query("select win_line from email_send_results where campaign_slug = 'zl-20261012'")).rows;
    expect(zl.map((x) => x.win_line.basis)).toEqual(["no_signal", "no_signal"]);
  });

  it("freezes the GA property given at start", async () => {
    await start(await card(), { ga_property_id: "555" });
    expect((await one<{ p: string }>("select ga_property_id p from email_send_results")).p).toBe("555");
  });

  it("the repair sweep finds sent emails with no row, never a resumable hold or a send still going", async () => {
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const done = await bulkDecision("done", null, 5);
    const held = await bulkDecision("held", "provider_refused", 5);
    const paused = await bulkDecision("held", "email_paused", 5);
    const stopped = await bulkDecision("held", "list_archived", 5);
    const going = await bulkDecision("sending", null, 5);
    await db.query("select set_config('zavi.email_card_approve', 'on', true)");
    const ca = (await one<{ id: string }>("insert into channel_actions (tenant_id, exec_class, exec_payload, exec_status, executed_at) values ($1, 'email_campaign.create_and_send', '{\"variants\":[]}', 'executed', now()) returning id", [T])).id;
    const old = (await one<{ id: string }>("insert into channel_actions (tenant_id, exec_class, exec_payload, exec_status, executed_at) values ($1, 'email_campaign.create_and_send', '{\"variants\":[]}', 'executed', now() - interval '30 days') returning id", [T])).id;
    const dec = (await one<{ id: string }>("insert into decisions (tenant_id, decision_class, body, status) values ($1, 'email_campaign.create_and_send', '{}', 'acted') returning id", [T])).id;
    await db.query("select set_config('zavi.email_card_approve', '', true)");
    await db.query("select record_email_send_ref($1, 'decisions', $2, 'klaviyo', 'K1')", [T, dec]);
    const missing = (await db.query("select * from email_results_missing($1, 100)", [since])).rows.map((x) => x.card_id);
    expect(missing).toEqual(expect.arrayContaining([done.d, stopped.d, ca, dec]));
    expect(missing).not.toContain(held.d);
    expect(missing).not.toContain(paused.d);
    expect(missing).not.toContain(going.d);
    expect(missing).not.toContain(old);
    await start(ca);
    expect((await db.query("select * from email_results_missing($1, 100)", [since])).rows.map((x) => x.card_id)).not.toContain(ca);
  });

  it("refuses another tenant's card, a wrong route and a send that reached nobody", async () => {
    expect(await start(await card(OTHER))).toMatchObject({ ok: false, code: "not_found" });
    expect(await start(await card(), { route: "zavi_list" })).toMatchObject({ ok: false, code: "bad_route" });
    expect(await start(await card(), { sent_count: 0 })).toMatchObject({ ok: false, code: "nothing_sent" });
  });

  it("a Zavi-list send is a result only when done or stopped for good with people emailed", async () => {
    const going = await bulkDecision("waiting_for_tomorrow", null, 40);
    expect(await start(going.d, { route: "zavi_list", provider_ref: going.s }, "decisions")).toMatchObject({ ok: false, code: "not_final" });
    for (const reason of ["abuse_complaints", "abuse_bounces", "provider_refused", "bulk_check_failed", "email_paused"]) {
      const held = await bulkDecision("held", reason, 40);
      expect(await start(held.d, { route: "zavi_list", provider_ref: held.s }, "decisions")).toMatchObject({ ok: false, code: "not_final" });
    }
    const stopped = await bulkDecision("held", "domain_unverified", 40);
    expect(await start(stopped.d, { route: "zavi_list", provider_ref: stopped.s, sent_count: 40 }, "decisions")).toMatchObject({ ok: true, created: true });
    const done = await bulkDecision("done", null, 90);
    expect(await start(done.d, { route: "zavi_list", provider_ref: randomUUID() }, "decisions")).toMatchObject({ ok: false, code: "not_found" });
    expect(await start(done.d, { route: "zavi_list", provider_ref: done.s, sent_count: 90 }, "decisions")).toMatchObject({ ok: true, created: true });
    const none = await bulkDecision("failed", null, 0);
    expect(await start(none.d, { route: "zavi_list", provider_ref: none.s }, "decisions")).toMatchObject({ ok: false, code: "nothing_sent" });
  });

  it("a held send staff resume loses its (raced) results row", async () => {
    const stopped = await bulkDecision("held", "domain_unverified", 40);
    await start(stopped.d, { route: "zavi_list", provider_ref: stopped.s, sent_count: 40 }, "decisions");
    await db.query("update email_bulk_sends set status = 'sending' where id = $1", [stopped.s]);
    expect((await one<{ n: string }>("select count(*) n from email_send_results where card_id = $1", [stopped.d])).n).toBe("0");
  });

  it("claims only due, unleased work, and a lease that ran out is claimed again", async () => {
    await start(await card());
    const first = await claim();
    expect(first.map((t) => `${t.source}:${t.stage}`).sort()).toEqual(["ga:d7", "provider:d7", "provider:h1"]);
    expect(await claim()).toEqual([]);
    await db.query("update email_result_tasks set lease_until = now() - interval '1 second'");
    expect(await claim()).toHaveLength(3);
    await start(await card(), { finished_at: new Date().toISOString(), started_at: new Date().toISOString() });
    await db.query("update email_result_tasks set lease_until = now() + interval '10 minutes'");
    expect(await claim()).toEqual([]);
  });

  it("a task reclaimed after its lease ran out: the old holder's late write is refused, nothing written twice", async () => {
    await start(await card());
    const old = (await claim()).find((t) => t.stage === "h1")!;
    await db.query("update email_result_tasks set lease_until = now() - interval '1 second'");
    const fresh = (await claim()).find((t) => t.stage === "h1")!;
    expect(fresh.lease_token).not.toBe(old.lease_token);
    expect(await complete(old, "done", { delivered: 1 })).toMatchObject({ ok: false, code: "not_owner" });
    expect(await complete(fresh, "done", { delivered: 2 })).toMatchObject({ ok: true });
    expect((await one<{ h1: Record<string, unknown> }>("select h1 from email_send_results")).h1).toMatchObject({ delivered: 2 });
  });

  it("only the lease holder completes; numbers merge; day 7 publishes with a verdict once both sources are done", async () => {
    await start(await card());
    const tasks = await claim();
    const by = (k: string) => tasks.find((t) => `${t.source}:${t.stage}` === k)!;
    expect(await complete({ ...by("provider:h1"), lease_token: randomUUID() }, "done", { opens: 1 })).toMatchObject({ ok: false, code: "not_owner" });
    expect(await complete(by("provider:h1"), "done", { delivered: 90, opens: 30 })).toMatchObject({ ok: true, state: "done" });
    expect(await complete(by("provider:d7"), "done", { delivered: 95, opens: 40, clicks: 5, unsubscribes: 1 })).toMatchObject({ state: "done" });
    const res = await one<{ d7_published_at: string | null; h1: Record<string, unknown> }>("select d7_published_at, h1 from email_send_results");
    expect(res.d7_published_at).toBeNull();
    expect(res.h1).toMatchObject({ delivered: 90, opens: 30, provider_status: "ok" });
    expect(await complete(by("ga:d7"), "done", { visitors: 3 }, { ga: { property_id: "123", timezone: "America/Los_Angeles" } })).toMatchObject({ state: "done" });
    const after = await one<{ d7: Record<string, unknown>; verdict: string; ga_property_id: string; ga_timezone: string }>("select d7_published_at, d7, verdict, ga_property_id, ga_timezone from email_send_results");
    expect(after).toMatchObject({ verdict: "beat", ga_property_id: "123", ga_timezone: "America/Los_Angeles" });
    expect(after.d7).toMatchObject({ delivered: 95, visitors: 3, ga_status: "ok", provider_status: "ok" });
    expect(await complete(by("ga:d7"), "done", { visitors: 9 })).toMatchObject({ ok: false, code: "not_owner" });
  });

  it("verdicts: below, first sends, no signal, unknown", async () => {
    const q = (w: unknown, d: unknown) => one<{ v: string }>("select _email_result_verdict($1, $2) v", [JSON.stringify(w), JSON.stringify(d)]).then((x) => x.v);
    expect(await q({ metric: "clicks", threshold: 0.05, basis: "median" }, { delivered: 100, clicks: 2 })).toBe("below");
    expect(await q({ metric: "clicks", threshold: 0.05, basis: "median" }, { delivered: 100, clicks: 5 })).toBe("beat");
    expect(await q({ metric: "visitors", threshold: null, basis: "first_sends" }, { delivered: 100 })).toBe("baseline");
    expect(await q({ metric: null, basis: "no_signal" }, { delivered: 100 })).toBe("no_signal");
    expect(await q({ metric: "visitors", threshold: 0.02, basis: "median" }, { delivered: 100, visitors: null })).toBe("unknown");
    expect(await q({ metric: "visitors", threshold: 0.02, basis: "median" }, { delivered: 0, visitors: 1 })).toBe("unknown");
  });

  it("GA not connected: day 7 waits (bounded by the give-up time), then goes out without visitors", async () => {
    await start(await card());
    let tasks = await claim();
    const by = (k: string) => tasks.find((t) => `${t.source}:${t.stage}` === k)!;
    await complete(by("provider:h1"), "done", { delivered: 100 });
    await complete(by("provider:d7"), "done", { delivered: 100 });
    const ga = by("ga:d7");
    const giveUp = (await one<{ g: Date }>("select give_up_at g from email_result_tasks where id = $1", [ga.task_id])).g;
    await complete(ga, "waiting", { visitors: null, ga_status: "not_connected" }, { next: new Date(giveUp.getTime() - 60_000).toISOString() });
    expect((await one<{ p: string | null }>("select d7_published_at p from email_send_results")).p).toBeNull();
    await db.query("update email_result_tasks set due_at = now() - interval '1 second' where id = $1", [ga.task_id]);
    tasks = await claim();
    expect(tasks.map((t) => t.state)).toEqual(["waiting"]);
    expect(await complete(tasks[0], "waiting", { visitors: null, ga_status: "not_connected" }, { next: new Date(giveUp.getTime() + 60_000).toISOString() })).toMatchObject({ state: "gave_up" });
    const res = await one<{ verdict: string; d7_published_at: string | null; d7: Record<string, unknown> }>("select verdict, d7_published_at, d7 from email_send_results");
    expect(res.d7_published_at).not.toBeNull();
    expect(res.d7).toMatchObject({ ga_status: "not_connected", visitors: null });
    expect(res.verdict).toBe("unknown");
  });

  it("GA connected while day 7 waits: visitors arrive before it is published", async () => {
    await start(await card());
    let tasks = await claim();
    const by = (k: string) => tasks.find((t) => `${t.source}:${t.stage}` === k)!;
    await complete(by("provider:h1"), "done", { delivered: 100 });
    await complete(by("provider:d7"), "done", { delivered: 100 });
    await complete(by("ga:d7"), "waiting", { visitors: null, ga_status: "not_connected" }, { next: new Date(Date.now() - 1000).toISOString() });
    tasks = await claim();
    await complete(tasks[0], "done", { visitors: 5, ga_status: "ok" }, { ga: { property_id: "9", timezone: "UTC" } });
    const res = await one<{ verdict: string; d7: Record<string, unknown> }>("select verdict, d7 from email_send_results");
    expect(res.verdict).toBe("beat");
    expect(res.d7).toMatchObject({ visitors: 5, ga_status: "ok" });
  });

  it("a GA answer after day 7 was published: the verdict follows and a changed verdict is told again", async () => {
    await start(await card());
    const tasks = await claim();
    const by = (k: string) => tasks.find((t) => `${t.source}:${t.stage}` === k)!;
    await complete(by("provider:h1"), "done", { delivered: 100 });
    await db.query("update email_send_results set d7 = '{\"delivered\":100}', d7_published_at = now(), verdict = 'unknown', d7_told_at = now()");
    await complete(by("ga:d7"), "done", { visitors: 1, ga_status: "ok" }, { ga: { property_id: "9", timezone: "UTC" } });
    const res = await one<{ verdict: string; d7_told_at: string | null }>("select verdict, d7_told_at from email_send_results");
    expect(res).toEqual({ verdict: "below", d7_told_at: null });
  });

  it("a disconnect at 1 hour on an email with no GA check publishes day 7 with the 1-hour numbers", async () => {
    await start(await card(), { campaign_slug: null });
    const tasks = await claim();
    const h1 = tasks.find((t) => t.stage === "h1")!;
    await complete(h1, "done", { delivered: 80, opens: 20, clicks: 4 });
    await db.query("update email_result_tasks set state = 'pending', lease_token = $2 where id = $1", [h1.task_id, h1.lease_token]);
    await complete(h1, "disconnected", {}, { error: "gone", note: "Mailchimp was disconnected; numbers stopped at 1 hour." });
    const res = await one<{ d7_published_at: string | null; d7: Record<string, unknown>; verdict: string }>("select d7_published_at, d7, verdict from email_send_results");
    expect(res.d7_published_at).not.toBeNull();
    expect(res.d7).toMatchObject({ delivered: 80, clicks: 4, from_h1: ["delivered", "opens", "clicks"], provider_status: "disconnected" });
    expect(res.verdict).toBe("unknown");
  });

  it("day 7 could not read the tool: the 1-hour counts carry over, labelled, and feed the verdict", async () => {
    await start(await card(), { campaign_slug: null, win_line: { metric: "clicks", threshold: 0.03, basis: "median", n_past: 5 } });
    const tasks = await claim();
    await complete(tasks.find((t) => t.stage === "h1")!, "done", { delivered: 100, clicks: 5, unsubscribes: 0 });
    await complete(tasks.find((t) => t.stage === "d7")!, "gave_up", {}, { error: "could not read" });
    const res = await one<{ d7: Record<string, unknown>; verdict: string }>("select d7, verdict from email_send_results");
    expect(res.d7).toMatchObject({ delivered: 100, clicks: 5, unsubscribes: 0, provider_status: "could_not_read", from_h1: ["delivered", "clicks", "unsubscribes"] });
    expect(res.verdict).toBe("beat");
  });

  it("a GA property other than the frozen one never writes into the row", async () => {
    await start(await card());
    await db.query("update email_send_results set ga_property_id = '111'");
    const ga = (await claim()).find((t) => t.source === "ga")!;
    await complete(ga, "done", { visitors: 50 }, { ga: { property_id: "222", timezone: "UTC" } });
    const res = await one<{ d7: Record<string, unknown>; ga_property_id: string }>("select d7, ga_property_id from email_send_results");
    expect(res.ga_property_id).toBe("111");
    expect(res.d7).toMatchObject({ visitors: null, ga_status: "property_changed" });
  });

  it("a retry past give-up gives up; a rate limit spends no attempt; a disconnect stops every provider check", async () => {
    await start(await card());
    const tasks = await claim();
    const h1 = tasks.find((t) => t.stage === "h1")!;
    expect(await complete(h1, "rate_limited", {}, { next: new Date(Date.now() + 60_000).toISOString() })).toMatchObject({ state: "pending" });
    expect((await one<{ attempts: number }>("select attempts from email_result_tasks where id = $1", [h1.task_id])).attempts).toBe(0);
    await db.query("update email_result_tasks set due_at = now() - interval '1 second', lease_until = null where id = $1", [h1.task_id]);
    const again = (await claim()).find((t) => t.task_id === h1.task_id)!;
    expect(await complete(again, "retry", {}, { next: new Date(Date.now() + 30 * 86_400_000).toISOString(), error: "SendGrid did not answer" })).toMatchObject({ state: "gave_up" });
    expect((await one<{ h1: Record<string, unknown> }>("select h1 from email_send_results")).h1).toMatchObject({ provider_status: "could_not_read" });

    await db.query("delete from email_result_tasks; delete from email_send_results;");
    await start(await card());
    const t2 = await claim();
    await complete(t2.find((t) => t.source === "provider" && t.stage === "h1")!, "disconnected", {}, { error: "different account", note: "SendGrid was disconnected; numbers stopped at 1 hour." });
    const states = (await db.query("select source, stage, state from email_result_tasks order by source, stage")).rows;
    expect(states).toEqual([
      { source: "ga", stage: "d7", state: "pending" },
      { source: "provider", stage: "d7", state: "gave_up" },
      { source: "provider", stage: "h1", state: "gave_up" },
    ]);
    expect((await one<{ note: string }>("select note from email_send_results")).note).toMatch(/disconnected/);
  });

  it("backlog: counts due work and flags each stuck task once", async () => {
    await start(await card(), { finished_at: new Date(Date.now() - 20 * 86_400_000).toISOString() });
    const b1 = await r("select email_results_backlog(72) r");
    expect(b1.due).toBe(3);
    expect((b1.newly_stuck as unknown[]).length).toBe(3);
    const b2 = await r("select email_results_backlog(72) r");
    expect((b2.newly_stuck as unknown[]).length).toBe(0);
  });

  it("the Growth note marks a published result told once, at the version it read, and only its own tenant's", async () => {
    await start(await card());
    const id = (await one<{ id: string }>("select id from email_send_results")).id;
    const mark = (tenant: string, version: number) =>
      one<{ n: number }>("select mark_email_results_told($1, $2) n", [tenant, JSON.stringify([{ id, version }])]).then((x) => x.n);
    expect(await mark(T, 0)).toBe(0);
    await db.query("update email_send_results set d7_published_at = now(), d7_version = 1");
    expect(await mark(OTHER, 1)).toBe(0);
    await db.query("update email_send_results set d7_version = 2");
    expect(await mark(T, 1)).toBe(0);
    expect(await mark(T, 2)).toBe(1);
    expect(await mark(T, 2)).toBe(0);
  });

  it("making a tag shared completes an earlier row whose only open day-7 check was GA (no 'Due' forever)", async () => {
    const first = await card();
    await start(first, { campaign_slug: "tag-20261012" });
    const tasks = await claim();
    const mine = tasks.filter((t) => t.card_id === first);
    await complete(mine.find((t) => t.stage === "h1")!, "done", { delivered: 100, clicks: 5 });
    await complete(mine.find((t) => t.source === "provider" && t.stage === "d7")!, "done", { delivered: 100, clicks: 5 });
    await complete(mine.find((t) => t.source === "ga")!, "waiting", { visitors: null, ga_status: "not_connected" }, { next: new Date(Date.now() + 86_400_000).toISOString() });
    expect((await one<{ p: string | null }>("select d7_published_at p from email_send_results where card_id = $1", [first])).p).toBeNull();
    await start(await card(), { campaign_slug: "tag-20261012" });
    const res = await one<{ d7_published_at: string | null; verdict: string; d7_version: number; shared_tag: boolean }>(
      "select d7_published_at, verdict, d7_version, shared_tag from email_send_results where card_id = $1",
      [first],
    );
    expect(res.d7_published_at).not.toBeNull();
    expect(res.shared_tag).toBe(true);
    expect(res.d7_version).toBe(1);
  });

  it("a tag shared with a published result whose GA window ended before the new send leaves it as it was", async () => {
    const first = await card();
    await start(first, { campaign_slug: "old-20261001", finished_at: new Date(Date.now() - 20 * 86_400_000).toISOString(), started_at: new Date(Date.now() - 20 * 86_400_000).toISOString() });
    await db.query("update email_send_results set d7 = '{\"delivered\":100,\"visitors\":4}', d7_published_at = now(), verdict = 'beat', d7_version = 1, d7_told_at = now() where card_id = $1", [first]);
    await start(await card(), { campaign_slug: "old-20261001" });
    const res = await one<{ shared_tag: boolean; d7: Record<string, unknown>; verdict: string; d7_version: number; d7_told_at: string | null }>(
      "select shared_tag, d7, verdict, d7_version, d7_told_at from email_send_results where card_id = $1",
      [first],
    );
    expect(res).toMatchObject({ shared_tag: false, verdict: "beat", d7_version: 1, d7: { visitors: 4 } });
    expect(res.d7_told_at).not.toBeNull();
  });

  it("a tag shared with a published result whose GA window holds the new send: visitors dropped, win line to clicks, verdict redone and told again", async () => {
    for (const v of [2, 4, 6]) {
      await db.query(
        `insert into email_send_results (tenant_id, rail, card_id, route, provider_ref, list_id, sent_count, started_at, finished_at, win_line, d7, d7_published_at)
         values ($1, 'channel_actions', $2, 'sendgrid', 'x', 'list-1', 100, now() - interval '60 days', now() - interval '60 days', '{"metric":"clicks","basis":"median"}', $3, now() - interval '50 days')`,
        [T, await card(), JSON.stringify({ delivered: 100, clicks: v })],
      );
    }
    const first = await card();
    const twelve = new Date(Date.now() - 12 * 86_400_000).toISOString();
    await start(first, { campaign_slug: "win-20261001", started_at: twelve, finished_at: twelve, win_line: { metric: "visitors", threshold: 0.02, basis: "median", n_past: 5 } });
    await db.query("update email_send_results set d7 = '{\"delivered\":100,\"clicks\":5,\"visitors\":9}', d7_published_at = now(), verdict = 'beat', d7_version = 1, d7_told_at = now() where card_id = $1", [first]);
    await start(await card(), { campaign_slug: "win-20261001" });
    const res = await one<{ shared_tag: boolean; d7: Record<string, unknown>; win_line: Record<string, unknown>; verdict: string; d7_version: number; d7_told_at: string | null }>(
      "select shared_tag, d7, win_line, verdict, d7_version, d7_told_at from email_send_results where card_id = $1",
      [first],
    );
    expect(res).toMatchObject({ shared_tag: true, d7: { visitors: null, ga_status: "shared_tag", clicks: 5 }, win_line: { metric: "clicks", threshold: 0.04 }, verdict: "beat", d7_version: 2 });
    expect(res.d7_told_at).toBeNull();
  });

  it("a shared set's replacement win lines all come from the same history, never from each other", async () => {
    for (const v of [2, 4, 6]) {
      await db.query(
        `insert into email_send_results (tenant_id, rail, card_id, route, provider_ref, list_id, sent_count, started_at, finished_at, win_line, d7, d7_published_at)
         values ($1, 'channel_actions', $2, 'sendgrid', 'x', 'list-1', 100, now() - interval '60 days', now() - interval '60 days', '{"metric":"clicks","basis":"median"}', $3, now() - interval '50 days')`,
        [T, await card(), JSON.stringify({ delivered: 100, clicks: v })],
      );
    }
    const visitors = { metric: "visitors", threshold: 0.02, basis: "median", n_past: 5 };
    const ten = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const a = await card();
    const b = await card();
    await start(a, { campaign_slug: "set-20261001", started_at: ten, finished_at: ten, win_line: visitors });
    await db.query("update email_send_results set d7 = '{\"delivered\":100,\"clicks\":50,\"visitors\":9}', d7_published_at = now(), verdict = 'beat', d7_version = 1 where card_id = $1", [a]);
    await db.query(
      `insert into email_send_results (tenant_id, rail, card_id, route, provider_ref, list_id, sent_count, started_at, finished_at, campaign_slug, win_line)
       values ($1, 'channel_actions', $2, 'sendgrid', 'y', 'list-1', 100, $3, $3, 'set-20261001', $4)`,
      [T, b, ten, JSON.stringify(visitors)],
    );
    await start(await card(), { campaign_slug: "set-20261001" });
    const lines = (await db.query("select card_id, win_line from email_send_results where card_id = any($1)", [[a, b]])).rows;
    expect(lines.map((x) => x.win_line)).toEqual([
      { metric: "clicks", threshold: 0.04, basis: "median", n_past: 3 },
      { metric: "clicks", threshold: 0.04, basis: "median", n_past: 3 },
    ]);
  });

  it("a published row of the tag that started AFTER the new send is left as it was", async () => {
    const later = await card();
    const two = new Date(Date.now() - 2 * 86_400_000).toISOString();
    await start(later, { campaign_slug: "late-20261001", started_at: two, finished_at: two });
    await db.query("update email_send_results set d7 = '{\"delivered\":100,\"visitors\":4}', d7_published_at = now(), verdict = 'beat', d7_version = 1 where card_id = $1", [later]);
    await start(await card(), { campaign_slug: "late-20261001" });
    const res = await one<{ shared_tag: boolean; d7: Record<string, unknown>; d7_version: number }>("select shared_tag, d7, d7_version from email_send_results where card_id = $1", [later]);
    expect(res).toMatchObject({ shared_tag: false, d7_version: 1, d7: { visitors: 4 } });
  });

  it("a published result whose numbers change is told again, even when the verdict stays the same", async () => {
    await start(await card(), { win_line: { metric: "visitors", threshold: null, basis: "first_sends", n_past: 0 } });
    const tasks = await claim();
    await complete(tasks.find((t) => t.stage === "h1")!, "done", { delivered: 100 });
    await db.query("update email_send_results set d7 = '{\"delivered\":100}', d7_published_at = now(), verdict = 'baseline', d7_told_at = now(), d7_version = 1");
    await complete(tasks.find((t) => t.source === "ga")!, "done", { visitors: 7, ga_status: "ok" }, { ga: { property_id: "9", timezone: "UTC" } });
    const res = await one<{ verdict: string; d7_told_at: string | null; d7_version: number }>("select verdict, d7_told_at, d7_version from email_send_results");
    expect(res).toEqual({ verdict: "baseline", d7_told_at: null, d7_version: 2 });
  });

  it("a day-7 read that answered keeps its own nulls: nothing is carried from 1 hour", async () => {
    await start(await card(), { campaign_slug: null, win_line: { metric: "clicks", threshold: 0.03, basis: "median", n_past: 5 } });
    const tasks = await claim();
    await complete(tasks.find((t) => t.stage === "h1")!, "done", { delivered: 100, clicks: 5 });
    await complete(tasks.find((t) => t.stage === "d7")!, "done", { delivered: 100, clicks: null });
    const res = await one<{ d7: Record<string, unknown>; verdict: string }>("select d7, verdict from email_send_results");
    expect(res.d7.clicks).toBeNull();
    expect(res.d7.from_h1).toBeUndefined();
    expect(res.verdict).toBe("unknown");
  });

  it("the send ref: recorded for this tenant's card, latest wins, never for another tenant", async () => {
    const id = await card();
    expect((await one<{ ok: boolean }>("select record_email_send_ref($1, 'channel_actions', $2, 'mailchimp', 'c1') ok", [T, id])).ok).toBe(true);
    expect((await one<{ ok: boolean }>("select record_email_send_ref($1, 'channel_actions', $2, 'mailchimp', 'c2') ok", [T, id])).ok).toBe(true);
    expect((await one<{ p: string }>("select provider_ref p from email_send_refs where card_id = $1", [id])).p).toBe("c2");
    expect((await one<{ ok: boolean }>("select record_email_send_ref($1, 'channel_actions', $2, 'mailchimp', 'c3') ok", [OTHER, id])).ok).toBe(false);
  });

  it("engagement: one count per event id across retried batches, machine opens apart, a mismatched tenant counts nothing", async () => {
    const { s } = await bulkDecision("done", null, 3);
    const ev = (id: string, kind: string, tenant = T, send = s) => ({ id, tenant_id: tenant, send_id: send, kind });
    const batch = [ev("e1", "delivered"), ev("e2", "delivered"), ev("e3", "open"), ev("e4", "machine_open"), ev("e5", "open", OTHER), ev("e1", "delivered")];
    expect(await r("select email_bulk_record_events($1) r", [JSON.stringify(batch)])).toMatchObject({ ok: true, new_events: 5 });
    expect(await r("select email_bulk_record_events($1) r", [JSON.stringify(batch)])).toMatchObject({ ok: true, new_events: 0 });
    const row = await one("select delivered, opens, machine_opens, clicks, delivered_seen_at is not null seen from email_bulk_sends where id = $1", [s]);
    expect(row).toEqual({ delivered: 2, opens: 1, machine_opens: 1, clicks: 0, seen: true });
    expect(await r("select email_bulk_record_events($1) r", [JSON.stringify([{ id: "x", tenant_id: "nope", send_id: s, kind: "open" }])])).toMatchObject({ new_events: 0 });
    await db.query("update email_bulk_event_ids set seen_at = now() - interval '4 days' where sg_event_id in ('e1','e2')");
    expect((await one<{ n: number }>("select email_bulk_purge_event_ids(100) n")).n).toBe(2);
  });

  it("unsubscribe: counted once on each not-final send that emailed the contact", async () => {
    const c = (await one<{ id: string }>("insert into email_contacts (tenant_id, email_norm) values ($1, 'pat@example.test') returning id", [T])).id;
    const a = await bulkDecision("done", null, 1);
    const b = await bulkDecision("done", null, 1);
    const old = await bulkDecision("done", null, 1);
    const skipped = await bulkDecision("done", null, 1);
    for (const x of [a, b, old]) await db.query("insert into email_bulk_send_recipients (send_id, tenant_id, contact_id, status) values ($1, $2, $3, 'sent')", [x.s, T, c]);
    await db.query("insert into email_bulk_send_recipients (send_id, tenant_id, contact_id, status) values ($1, $2, $3, 'skipped')", [skipped.s, T, c]);
    await start(old.d, { route: "zavi_list", provider_ref: old.s, sent_count: 1 }, "decisions");
    await db.query("update email_send_results set d7_published_at = now() where card_id = $1", [old.d]);
    expect(await r("select email_unsubscribe_and_count($1, ' Pat@Example.test ') r", [T])).toMatchObject({ ok: true, new: true, sends_counted: 2 });
    expect(await r("select email_unsubscribe_and_count($1, 'pat@example.test') r", [T])).toMatchObject({ new: false, sends_counted: 0 });
    const counts = (await db.query("select id, unsubscribes from email_bulk_sends where id = any($1)", [[a.s, b.s, old.s, skipped.s]])).rows;
    const of = (id: string) => counts.find((x) => x.id === id)!.unsubscribes;
    expect([of(a.s), of(b.s), of(old.s), of(skipped.s)]).toEqual([1, 1, 0, 0]);
    expect((await one<{ reason: string }>("select reason from email_suppression where email = 'pat@example.test'")).reason).toBe("unsubscribe");
    await db.query("update email_suppression set reason = 'bounce' where email = 'pat@example.test'");
    expect(await r("select email_unsubscribe_and_count($1, 'pat@example.test') r", [T])).toMatchObject({ new: false, sends_counted: 0 });
    expect(of(a.s)).toBe(1);
    expect((await one<{ u: number }>("select unsubscribes u from email_bulk_sends where id = $1", [a.s])).u).toBe(1);
  });

  it("unsubscribe: an address that is not a Zavi-list contact is suppressed, nothing counted", async () => {
    expect(await r("select email_unsubscribe_and_count($1, 'stranger@example.test') r", [T])).toMatchObject({ ok: true, new: false, sends_counted: 0 });
    expect((await one<{ reason: string }>("select reason from email_suppression where email = 'stranger@example.test'")).reason).toBe("unsubscribe");
  });

  it("the repair sweep answers at most its limit across all three sources, oldest first", async () => {
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
    for (let i = 0; i < 3; i++) await bulkDecision("done", null, 2);
    await db.query("select set_config('zavi.email_card_approve', 'on', true)");
    for (let i = 0; i < 3; i++) {
      await db.query("insert into channel_actions (tenant_id, exec_class, exec_payload, exec_status, executed_at) values ($1, 'email_campaign.create_and_send', '{\"variants\":[]}', 'executed', now() - make_interval(hours => $2))", [T, 10 + i]);
    }
    await db.query("select set_config('zavi.email_card_approve', '', true)");
    const rows = (await db.query("select * from email_results_missing($1, 2)", [since])).rows;
    expect(rows).toHaveLength(2);
  });
});
