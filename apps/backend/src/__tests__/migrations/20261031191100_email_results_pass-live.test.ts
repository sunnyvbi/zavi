import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAIL_CARD_BOOTSTRAP, EMAIL_CARD_SQL } from "./email-card-live-migrations";
import { runEmailResultsPass, type CheckDeps, type ClaimedTask } from "@/services/email-results/check";
import { startEmailSendResult, type StartDeps } from "@/services/email-results/start";
import { computeWinLine } from "@/services/email-results/win-line";
import { rowFromResult } from "@/services/email-results/view";
import { day7Line } from "@/services/email-results/note";
import { sealVariants } from "@/services/email-cards/variants";
import type { ComposioExecResult } from "@/services/connectors/composio/api";

const PG_URL = process.env.ZAVI_TEST_VANILLA_PG_URL;
const dir = join(__dirname, "../../../../../supabase/migrations");
const NEW_SQL = ["20261031191100_email_send_results.sql", "20261031191200_email_bulk_engagement.sql"].map((f) =>
  readFileSync(join(dir, f), "utf8").replace(/^(begin|commit);$/gm, ""),
);
const BULK_BOOTSTRAP = `
  create table email_contacts (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, email_norm text, unique (tenant_id, email_norm));
  create table email_bulk_sends (
    id uuid primary key default gen_random_uuid(), tenant_id uuid not null, decision_id uuid not null, subject text not null default '',
    status text not null default 'sending', hold_reason text, sent int not null default 0, total int not null default 0,
    created_at timestamptz not null default now(), finished_at timestamptz, unique (tenant_id, id)
  );
  create table email_bulk_send_recipients (send_id uuid not null, tenant_id uuid not null, contact_id uuid not null, status text not null default 'pending', primary key (send_id, contact_id));
  create table email_suppression (tenant_id uuid not null, email text not null, reason text not null, created_at timestamptz not null default now(), primary key (tenant_id, email));
  alter table decisions add column if not exists dispatched_at timestamptz;
`;

const T = randomUUID();
const TEMPLATE = { logo_url: null, brand_color: "#1f6feb", button_color: "#1f6feb", font_key: "system", sign_off: "The Brightloop team", postal_address: "1 Example Way, Springfield", show_cards: false };
const CONTENT = { subject: "Shared workspaces are here", preview_text: "", title: "Work together", paragraphs: ["Invite your team."], button: { label: "Try it", url: "https://brightloop.test/workspaces" } };

describe.skipIf(!PG_URL)("email results, worker pass over the real SQL", () => {
  let db: Client;
  let clock = Date.now();
  const q = async <R = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as R[];
  const one = async <R = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await q<R>(sql, p))[0];
  const rpc = async <R>(sql: string, p: unknown[]) => (await one<{ r: R }>(sql, p)).r;

  const reportCalls: string[] = [];
  const mailchimp = async (slug: string): Promise<ComposioExecResult> => {
    reportCalls.push(slug);
    if (slug !== "MAILCHIMP_GET_CAMPAIGN_REPORT") return { ok: true, status: 200, data: {}, error: null, outcome_unknown: false };
    return { ok: true, status: 200, data: { data: { emails_sent: 400, unsubscribed: 2, bounces: { hard_bounces: 4 }, opens: { unique_opens: 150 }, clicks: { unique_subscriber_clicks: 20 } } }, error: null, outcome_unknown: false };
  };

  const startDeps: Partial<StartDeps> = {
    readCard: async (_t, rail, id) => {
      const r = rail === "channel_actions"
        ? await one<{ c: string; b: Record<string, unknown>; p: unknown; e: string | null }>("select exec_class c, exec_payload b, exec_progress p, executed_at::text e from channel_actions where id = $1", [id])
        : await one<{ c: string; b: Record<string, unknown>; p: unknown; e: string | null }>("select decision_class c, body b, null p, dispatched_at::text e from decisions where id = $1", [id]);
      return r ? { class: r.c, body: r.b, progress: r.p, ended_at: r.e ? new Date(r.e).toISOString() : null } : null;
    },
    readRef: async (_t, rail, id) => (await one<{ p: string }>("select provider_ref p from email_send_refs where rail = $1 and card_id = $2", [rail, id]))?.p ?? null,
    readBulk: async (_t, d) => {
      const r = await one<{ id: string; status: string; sent: number; total: number; c: string; f: string | null }>("select id, status, sent, total, created_at::text c, finished_at::text f from email_bulk_sends where decision_id = $1", [d]);
      return r ? { id: r.id, status: r.status, sent: r.sent, total: r.total, created_at: new Date(r.c).toISOString(), finished_at: r.f ? new Date(r.f).toISOString() : null } : null;
    },
    gaProperty: async () => "P1",
    slugTaken: async (_t, slug, rail, id) => (await q("select 1 from email_send_results where campaign_slug = $1 and not (rail = $2 and card_id = $3)", [slug, rail, id])).length > 0,
    winLine: (t, a) => computeWinLine(t, a, { pastResults: async (_t, route, list) => q("select win_line, d7 from email_send_results where route = $1 and list_id = $2 and d7_published_at is not null order by d7_published_at desc limit 20", [route, list]) }),
    rpc: async (t, row, input) => rpc("select start_email_send_result($1, $2, $3, $4) r", [t, input.rail, input.card_id, JSON.stringify(row)]),
    now: () => new Date(clock),
  };

  const alerts: unknown[] = [];
  const deps: CheckDeps = {
    claim: async (limit, lease) => (await q<{ j: ClaimedTask }>("select claim_email_result_tasks($1, $2) j", [limit, lease])).map((x) => x.j),
    complete: async (t, c) => {
      await rpc("select complete_email_result_task($1, $2, $3, $4, $5, $6, $7, $8, $9) r", [
        t.tenant_id, t.task_id, t.lease_token, c.outcome, JSON.stringify(c.result ?? {}), c.next_due?.toISOString() ?? null, c.error ?? null, c.ga ? JSON.stringify(c.ga) : null, c.note ?? null,
      ]);
    },
    providerAccess: async () => ({ kind: "ok", call: mailchimp, sameCredential: true, cacheKey: "mc" }),
    bulkCounts: async (_t, id) => one("select sent, delivered, opens, machine_opens, unsubscribes, delivered_seen_at from email_bulk_sends where id = $1", [id]),
    gaCreds: async () => ({ property_id: "P1", auth: { kind: "native", access_token: "x" } }) as never,
    gaReport: async (_c, body) => (body.dimensionFilter ? { rows: [{ metricValues: [{ value: "12" }] }] } : { metadata: { timeZone: "America/New_York" } }),
    missing: async (since, limit) => q("select tenant_id, rail, card_id, sent from email_results_missing($1, $2)", [since.toISOString(), limit]),
    start: (input) => startEmailSendResult(input, startDeps),
    holdRepair: async () => undefined,
    backlog: async (h) => rpc("select email_results_backlog($1) r", [h]),
    purgeEventIds: async (n) => (await one<{ n: number }>("select email_bulk_purge_event_ids($1) n", [n])).n,
    alertStuck: async (s) => void alerts.push(s),
    log: async () => undefined,
    now: () => new Date(clock),
  };
  const dueNow = () => db.query("update email_result_tasks set due_at = now() - interval '1 second' where state in ('pending', 'waiting')");

  beforeAll(async () => {
    db = new Client({ connectionString: PG_URL });
    await db.connect();
    const exists = await one<{ t: string | null }>("select to_regclass('public.channel_actions')::text t");
    if (exists.t) throw new Error("ZAVI_TEST_VANILLA_PG_URL must be a VANILLA throwaway database");
    await db.query("begin");
    await db.query(EMAIL_CARD_BOOTSTRAP);
    await db.query(BULK_BOOTSTRAP);
    await db.query("insert into tenants values ($1)", [T]);
    for (const sql of EMAIL_CARD_SQL) await db.query(sql);
    for (const sql of NEW_SQL) await db.query(sql);
  });
  afterAll(async () => {
    if (!db) return;
    await db.query("rollback").catch(() => undefined);
    await db.end();
  });

  it("a Mailchimp send: found by the sweep, checked at 1 hour and day 7, judged against the list's own history", async () => {
    for (const [i, v] of [[1, 1], [2, 2], [3, 3]] as const) {
      const c = (await one<{ id: string }>("insert into channel_actions (tenant_id, exec_class, exec_payload) values ($1, 'email_campaign.create_and_send', '{}') returning id", [T])).id;
      await db.query(
        `insert into email_send_results (tenant_id, rail, card_id, route, provider_ref, list_id, subject, sent_count, started_at, finished_at, win_line, d7, d7_published_at, d7_told_at)
         values ($1, 'channel_actions', $2, 'mailchimp', $3, 'list-1', 'Earlier', 100, now() - make_interval(days => 30 + $4), now() - make_interval(days => 30 + $4),
                 '{"metric":"visitors","threshold":null,"basis":"first_sends","n_past":0}', $5, now() - make_interval(days => 20 + $4), now())`,
        [T, c, `old-${i}`, i, JSON.stringify({ delivered: 100, visitors: v })],
      );
    }
    const sealed = sealVariants(TEMPLATE, [CONTENT as never], { route: "mailchimp", companyName: "Brightloop", ownHost: "brightloop.test" });
    const body = {
      tool: "mailchimp",
      credential: { kind: "composio", connected_account_id: "acct-1", auth_config_id: "ac-1" },
      audience_id: "list-1", audience_name: "Customers", audience_count: 400, approved_count: 400,
      ...sealed, chosen_variant: 1,
      from_name: "Brightloop", from_email: "hello@brightloop.test", reply_to: null,
    };
    await db.query("select set_config('zavi.email_card_approve', 'on', true)");
    const card = (await one<{ id: string }>(
      "insert into channel_actions (tenant_id, exec_class, exec_payload, exec_status, executed_at, exec_progress) values ($1, 'email_campaign.create_and_send', $2, 'executed', now() - interval '8 days', $3) returning id",
      [T, JSON.stringify(body), JSON.stringify({ campaign_id: "mc-live-1", stage: "sent" })],
    )).id;
    await db.query("select set_config('zavi.email_card_approve', '', true)");

    const report = await runEmailResultsPass(deps);
    expect(report).toMatchObject({ repaired: 1, claimed: 3 });
    const row = await one<Record<string, any>>("select * from email_send_results where card_id = $1", [card]);
    expect(row).toMatchObject({ route: "mailchimp", provider_ref: "mc-live-1", list_id: "list-1", list_name: "Customers", ga_property_id: "P1", subject: "Shared workspaces are here" });
    expect(row.campaign_slug).toMatch(/^shared-workspaces-are-here-\d{8}-[a-z0-9]{10}$/);
    expect(row.win_line).toEqual({ metric: "visitors", threshold: 0.02, basis: "median", n_past: 3 });
    const done = await one<Record<string, any>>("select h1, d7, d7_published_at, verdict, ga_timezone from email_send_results where card_id = $1", [card]);
    expect(done.h1).toMatchObject({ recipients: 400, delivered: 396, opens: 150, clicks: 20, unsubscribes: 2, provider_status: "ok" });
    expect(done.d7).toMatchObject({ delivered: 396, visitors: 12, ga_status: "ok" });
    expect(done.d7_published_at).not.toBeNull();
    expect(done.verdict).toBe("beat");
    expect(done.ga_timezone).toBe("America/New_York");
    expect(reportCalls.filter((s) => s === "MAILCHIMP_GET_CAMPAIGN_REPORT")).toHaveLength(2);

    const full = await one<Record<string, any>>("select rail, card_id, route, subject, list_name, campaign_slug, shared_tag, sent_count, total_count, started_at::text, finished_at::text, win_line, h1, d7, d7_published_at::text, verdict, note from email_send_results where card_id = $1", [card]);
    const view = rowFromResult({ ...full, started_at: new Date(full.started_at).toISOString(), finished_at: new Date(full.finished_at).toISOString() } as never);
    expect(view).toMatchObject({ as_of: "d7", verdict_text: "Beat the win line", visitors: { value: 12 }, win_line: { text: "2.0% of delivered visit your site" } });
    expect(day7Line({ route: full.route, subject: full.subject, list_name: full.list_name, win_line: full.win_line, d7: full.d7, verdict: full.verdict, note: null })).toBe(
      'Email "Shared workspaces are here" to Customers, day 7: 3.0% visited your site, win line 2.0%. Beat it.',
    );
    expect((await runEmailResultsPass(deps)).claimed).toBe(0);
  });

  it("Zavi's own sender: delivered and opens from webhook events (a retried batch counts once), an unsubscribe counted once", async () => {
    const sealed = sealVariants(TEMPLATE, [CONTENT as never], { route: "zavi_list", companyName: "Brightloop", ownHost: "brightloop.test" });
    const body = { list_id: randomUUID(), list_version_id: randomUUID(), list_name: "Members", from_address: "news@brightloop.test", ...sealed, chosen_variant: 1 };
    const d = (await one<{ id: string }>("insert into decisions (tenant_id, decision_class, body) values ($1, 'bulk_outbound.send', $2) returning id", [T, JSON.stringify(body)])).id;
    const s = (await one<{ id: string }>("insert into email_bulk_sends (tenant_id, decision_id, subject, status, sent, total, finished_at) values ($1, $2, 'Shared workspaces are here', 'done', 3, 3, now()) returning id", [T, d])).id;
    const c = (await one<{ id: string }>("insert into email_contacts (tenant_id, email_norm) values ($1, 'pat@example.test') returning id", [T])).id;
    await db.query("insert into email_bulk_send_recipients (send_id, tenant_id, contact_id, status) values ($1, $2, $3, 'sent')", [s, T, c]);

    const ev = (id: string, kind: string) => ({ id, tenant_id: T, send_id: s, kind });
    const batch = [ev("d1", "delivered"), ev("d2", "delivered"), ev("d3", "delivered"), ev("o1", "open"), ev("o2", "machine_open")];
    await rpc("select email_bulk_record_events($1) r", [JSON.stringify(batch)]);
    await rpc("select email_bulk_record_events($1) r", [JSON.stringify(batch)]);
    await rpc("select email_unsubscribe_and_count($1, $2) r", [T, "Pat@Example.test"]);
    await rpc("select email_unsubscribe_and_count($1, $2) r", [T, "pat@example.test"]);

    expect(await startEmailSendResult({ tenant_id: T, rail: "decisions", card_id: d, sent: 3 }, startDeps)).toEqual({ started: true });
    const w = await one<{ win_line: Record<string, unknown> }>("select win_line from email_send_results where card_id = $1", [d]);
    expect(w.win_line).toMatchObject({ metric: "visitors", basis: "first_sends" });
    await dueNow();
    await runEmailResultsPass(deps);
    const r = await one<Record<string, any>>("select h1, d7, verdict from email_send_results where card_id = $1", [d]);
    expect(r.h1).toMatchObject({ recipients: 3, delivered: 3, opens: 1, machine_opens: 1, clicks: null, clicks_off: true, unsubscribes: 1 });
    expect(r.verdict).toBe("baseline");
  });
});
