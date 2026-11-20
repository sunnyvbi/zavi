import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";
import { runEmailResultsPass, type CheckDeps } from "@/services/email-results/check";
import { startEmailSendResult, type StartDeps } from "@/services/email-results/start";
import { computeWinLine } from "@/services/email-results/win-line";
import { sealVariants } from "@/services/email-cards/variants";

const MIGRATION = "20261117260000_email_results_repair_fair_and_backoff.sql";
const TEMPLATE = { logo_url: null, brand_color: "#1f6feb", button_color: "#1f6feb", font_key: "system", sign_off: "The Brightloop team", postal_address: "1 Example Way, Springfield", show_cards: false };
const CONTENT = { subject: "Shared workspaces are here", preview_text: "", title: "Work together", paragraphs: ["Invite your team."], button: { label: "Try it", url: "https://brightloop.test/workspaces" } };

describe.skipIf(!PGLITE_MODULES)("20261117260000 the results repair sweep: dead sends stop holding slots, fair across workspaces, GA errors back off (pglite)", () => {
  let db: Db;
  const q = async <R = Record<string, any>>(sql: string, p: unknown[] = []) => (await db.query<R>(sql, p)).rows;
  const one = async <R = Record<string, any>>(sql: string, p: unknown[] = []) => (await q<R>(sql, p))[0];

  let gaFails = false;
  const gaCalls: string[] = [];
  const startCalls: string[] = [];

  const startDeps: Partial<StartDeps> = {
    readCard: async (_t, rail, id) => {
      const r = rail === "channel_actions"
        ? await one<{ c: string; b: Record<string, unknown>; p: unknown; e: string | null }>("select exec_class c, exec_payload b, exec_progress p, executed_at::text e from channel_actions where id = $1", [id])
        : await one<{ c: string; b: Record<string, unknown>; p: unknown; e: string | null }>("select decision_class c, body b, null p, null e from decisions where id = $1", [id]);
      return r ? { class: r.c, body: r.b, progress: r.p, ended_at: r.e ? new Date(r.e).toISOString() : null } : null;
    },
    readRef: async (_t, rail, id) => (await one<{ p: string }>("select provider_ref p from email_send_refs where rail = $1 and card_id = $2", [rail, id]))?.p ?? null,
    readBulk: async () => null,
    gaProperty: async (t) => {
      gaCalls.push(t);
      if (gaFails) throw Object.assign(new Error("GA unavailable"), { code: "google_analytics_unavailable" });
      return "P1";
    },
    slugTaken: async (_t, slug, rail, id) => (await q("select 1 from email_send_results where campaign_slug = $1 and not (rail = $2 and card_id = $3)", [slug, rail, id])).length > 0,
    winLine: (t, a) => computeWinLine(t, a, { pastResults: async () => [] }),
    rpc: async (t, row, input) => (await one<{ r: { ok: boolean; created?: boolean; code?: string } }>("select start_email_send_result($1, $2, $3, $4) r", [t, input.rail, input.card_id, JSON.stringify(row)])).r,
    now: () => new Date(),
  };

  const deps: CheckDeps = {
    claim: async () => [],
    complete: async () => undefined,
    providerAccess: async () => ({ kind: "none" }),
    bulkCounts: async () => null,
    gaCreds: async () => null,
    gaReport: async () => ({}),
    missing: async (since, limit) => q("select tenant_id, rail, card_id, sent from email_results_missing($1, $2)", [since.toISOString(), limit]),
    start: (input) => {
      startCalls.push(input.card_id);
      return startEmailSendResult(input, startDeps);
    },
    holdRepair: async (m, reason) => {
      await q("select email_results_repair_hold($1, $2, $3, $4)", [m.tenant_id, m.rail, m.card_id, reason]);
    },
    backlog: async () => ({ due: 0, oldest_due_at: null, newly_stuck: [] }),
    purgeEventIds: async () => 0,
    alertStuck: async () => undefined,
    log: async () => undefined,
    now: () => new Date(),
  };

  const realBody = () => {
    const sealed = sealVariants(TEMPLATE, [CONTENT as never], { route: "mailchimp", companyName: "Brightloop", ownHost: "brightloop.test" });
    return {
      tool: "mailchimp",
      credential: { kind: "composio", connected_account_id: "acct-1", auth_config_id: "ac-1" },
      audience_id: "list-1", audience_name: "Customers", audience_count: 400, approved_count: 400,
      ...sealed, chosen_variant: 1,
      from_name: "Brightloop", from_email: "hello@brightloop.test", reply_to: null,
    };
  };
  const tenant = async () => {
    const t = randomUUID();
    await q("insert into tenants values ($1)", [t]);
    return t;
  };
  const realSend = async (t: string, ago: string) =>
    (await one<{ id: string }>(
      "insert into channel_actions (tenant_id, exec_class, exec_payload, exec_status, executed_at, exec_progress) values ($1, 'email_campaign.create_and_send', $2, 'executed', now() - $3::interval, $4) returning id",
      [t, JSON.stringify(realBody()), ago, JSON.stringify({ campaign_id: `mc-${randomUUID()}`, stage: "sent" })],
    )).id;
  const legacyDead = async (t: string, n: number, fromAgo: string, step: string) =>
    (await q<{ id: string }>(
      "insert into channel_actions (tenant_id, exec_class, exec_payload, exec_status, executed_at) select $1, 'email_campaign.create_and_send', '{\"variants\":[]}', 'executed', now() - $3::interval - (g * $4::interval) from generate_series(1, $2) g returning id",
      [t, n, fromAgo, step],
    )).map((r) => r.id);
  const noCampaignDead = async (t: string, n: number, fromAgo: string, step: string) =>
    (await q<{ id: string }>(
      "insert into channel_actions (tenant_id, exec_class, exec_payload, exec_status, executed_at) select $1, 'email_campaign.create_and_send', $5, 'executed', now() - $3::interval - (g * $4::interval) from generate_series(1, $2) g returning id",
      [t, n, fromAgo, step, JSON.stringify(realBody())],
    )).map((r) => r.id);
  const started = async (id: string) => (await one<{ n: number }>("select count(*)::int n from email_send_results where card_id = $1", [id])).n === 1;
  const missingFor = async (t: string) => (await q<{ card_id: string }>("select card_id from email_results_missing(now() - interval '14 days', 100) where tenant_id = $1", [t])).map((r) => r.card_id);
  const drain = async () => {
    for (let i = 0; i < 10 && (await q("select 1 from email_results_missing(now() - interval '14 days', 100)")).length > 0; i++) await runEmailResultsPass(deps);
  };

  beforeAll(async () => {
    db = await bootEmailPipeline(["20261111100100_email_paused_hold_reason_forward.sql", MIGRATION]);
    await db.query("select set_config('zavi.email_card_approve', 'on', false)");
  }, 180_000);
  afterAll(async () => db?.close());

  it("150 never-startable older sends: a fresh real send starts on the first pass, an even older real send within two, and the dead stop coming back", async () => {
    const t = await tenant();
    const veryOld = await realSend(t, "13 days");
    const legacy = await legacyDead(t, 100, "2 days", "1 minute");
    const noId = await noCampaignDead(t, 50, "4 days", "1 minute");
    const fresh = await realSend(t, "1 hour");

    startCalls.length = 0;
    expect((await runEmailResultsPass(deps)).repaired).toBe(1);
    expect(await started(fresh)).toBe(true);
    expect(startCalls).toHaveLength(100);
    expect(startCalls[0]).toBe(fresh);
    const firstPass = new Set(startCalls);

    startCalls.length = 0;
    await runEmailResultsPass(deps);
    expect(await started(veryOld)).toBe(true);
    expect(startCalls.filter((c) => firstPass.has(c))).toHaveLength(0);
    expect(startCalls).toHaveLength(52);

    expect(await missingFor(t)).toEqual([]);
    startCalls.length = 0;
    await runEmailResultsPass(deps);
    expect(startCalls).toHaveLength(0);

    for (let i = 0; i < 3; i++) await runEmailResultsPass(deps);
    expect(startCalls.filter((c) => noId.includes(c))).toHaveLength(0);

    const holds = await q<{ card_id: string; reason: string; attempts: number; forever: boolean; mins: number }>(
      "select card_id, reason, attempts, retry_at = 'infinity'::timestamptz forever, case when retry_at = 'infinity'::timestamptz then null else (extract(epoch from (retry_at - now())) / 60)::float8 end mins from email_results_repair_holds where tenant_id = $1",
      [t],
    );
    expect(holds).toHaveLength(150);
    expect(holds.every((h) => h.attempts === 1)).toBe(true);
    const legacyHolds = holds.filter((h) => legacy.includes(h.card_id));
    expect(legacyHolds).toHaveLength(legacy.length);
    expect(legacyHolds.every((h) => h.forever && h.reason === "not_a_versions_card")).toBe(true);
    const noIdHolds = holds.filter((h) => noId.includes(h.card_id));
    expect(noIdHolds).toHaveLength(noId.length);
    expect(noIdHolds.every((h) => !h.forever && h.reason === "no_campaign_id" && h.mins > 8 && h.mins < 11)).toBe(true);

    await q("update email_results_repair_holds set retry_at = now() - interval '1 second' where tenant_id = $1 and reason = 'no_campaign_id'", [t]);
    startCalls.length = 0;
    await runEmailResultsPass(deps);
    expect(startCalls.sort()).toEqual([...noId].sort());
    const again = await q<{ attempts: number; mins: number }>(
      "select attempts, (extract(epoch from (retry_at - now())) / 60)::float8 mins from email_results_repair_holds where card_id = any($1::uuid[])",
      [noId],
    );
    expect(again.every((h) => h.attempts === 2 && h.mins > 18 && h.mins < 21)).toBe(true);
    startCalls.length = 0;
    await runEmailResultsPass(deps);
    expect(startCalls).toHaveLength(0);
  }, 120_000);

  it("a workspace with 300 dead sends both older and newer than another workspace's real send cannot starve it", async () => {
    const noisy = await tenant();
    const quiet = await tenant();
    await legacyDead(noisy, 100, "1 hour", "1 minute");
    const noisyNoId = await noCampaignDead(noisy, 50, "3 hours", "1 minute");
    const real = await realSend(quiet, "5 days");
    await legacyDead(noisy, 150, "6 days", "1 minute");

    const first = await q<{ tenant_id: string; card_id: string }>("select tenant_id, card_id from email_results_missing(now() - interval '14 days', 100)");
    expect(first).toHaveLength(100);
    expect(first.slice(0, 2).map((r) => r.tenant_id).sort()).toEqual([noisy, quiet].sort());

    startCalls.length = 0;
    expect((await runEmailResultsPass(deps)).repaired).toBe(1);
    expect(await started(real)).toBe(true);

    await drain();
    expect(await missingFor(noisy)).toEqual([]);
    expect((await one<{ n: number }>("select count(*)::int n from email_results_repair_holds where tenant_id = $1", [noisy])).n).toBe(300);

    const later = await realSend(quiet, "7 days");
    startCalls.length = 0;
    expect((await runEmailResultsPass(deps)).repaired).toBe(1);
    expect(await started(later)).toBe(true);
    expect(startCalls).toEqual([later]);
    expect(startCalls.filter((c) => noisyNoId.includes(c))).toHaveLength(0);
  }, 120_000);

  it("GA throwing on every call backs off with growing waits instead of taking a slot each pass, and starts once GA reads again", async () => {
    await drain();
    const t = await tenant();
    const card = await realSend(t, "2 hours");
    gaFails = true;
    gaCalls.length = 0;

    await runEmailResultsPass(deps);
    expect(gaCalls).toEqual([t]);
    expect(await started(card)).toBe(false);
    const wait = async () => one<{ attempts: number; mins: number; reason: string }>(
      "select attempts, (extract(epoch from (retry_at - now())) / 60)::float8 mins, reason from email_results_repair_holds where card_id = $1",
      [card],
    );
    const h1 = await wait();
    expect(h1.attempts).toBe(1);
    expect(h1.reason).toContain("GA unavailable");
    expect(h1.mins).toBeGreaterThan(8);
    expect(h1.mins).toBeLessThan(11);

    for (let i = 0; i < 5; i++) await runEmailResultsPass(deps);
    expect(gaCalls).toHaveLength(1);
    expect(await missingFor(t)).toEqual([]);

    const mins: number[] = [h1.mins];
    for (let i = 0; i < 3; i++) {
      await q("update email_results_repair_holds set retry_at = now() - interval '1 second' where card_id = $1", [card]);
      await runEmailResultsPass(deps);
      mins.push((await wait()).mins);
    }
    expect(gaCalls).toHaveLength(4);
    expect((await wait()).attempts).toBe(4);
    for (let i = 1; i < mins.length; i++) expect(mins[i]).toBeGreaterThan(mins[i - 1] * 1.8);

    await q("update email_results_repair_holds set attempts = 40, retry_at = now() - interval '1 second' where card_id = $1", [card]);
    await runEmailResultsPass(deps);
    const capped = await wait();
    expect(capped.mins).toBeLessThanOrEqual(12 * 60 + 1);
    expect(capped.mins).toBeGreaterThan(12 * 60 - 1);

    gaFails = false;
    await q("update email_results_repair_holds set retry_at = now() - interval '1 second' where card_id = $1", [card]);
    expect((await runEmailResultsPass(deps)).repaired).toBe(1);
    expect(await started(card)).toBe(true);
    expect((await one<{ g: string | null }>("select ga_property_id g from email_send_results where card_id = $1", [card])).g).toBe("P1");
  }, 120_000);

  it("a send whose campaign id lands after its first sweep is held for a while, then retried and started", async () => {
    const t = await tenant();
    const [card] = await noCampaignDead(t, 1, "30 minutes", "1 minute");

    await runEmailResultsPass(deps);
    expect(await started(card)).toBe(false);
    const hold = await one<{ reason: string; forever: boolean }>("select reason, retry_at = 'infinity'::timestamptz forever from email_results_repair_holds where card_id = $1", [card]);
    expect(hold).toEqual({ reason: "no_campaign_id", forever: false });

    await q("update channel_actions set exec_progress = $2 where id = $1", [card, JSON.stringify({ campaign_id: "mc-late-1", stage: "sent" })]);
    startCalls.length = 0;
    await runEmailResultsPass(deps);
    expect(startCalls).not.toContain(card);
    expect(await started(card)).toBe(false);

    await q("update email_results_repair_holds set retry_at = now() - interval '1 second' where card_id = $1", [card]);
    expect((await runEmailResultsPass(deps)).repaired).toBe(1);
    expect((await one<{ p: string }>("select provider_ref p from email_send_results where card_id = $1", [card])).p).toBe("mc-late-1");
  });

  it("a hold written under one workspace cannot be moved by another, and the migration re-runs", async () => {
    const a = await tenant();
    const b = await tenant();
    const card = randomUUID();
    await q("select email_results_repair_hold($1, 'channel_actions', $2, 'GA unavailable')", [a, card]);
    await q("select email_results_repair_hold($1, 'channel_actions', $2, 'no_campaign_id')", [b, card]);
    expect(await one("select tenant_id, attempts, reason from email_results_repair_holds where card_id = $1", [card])).toEqual({ tenant_id: a, attempts: 1, reason: "GA unavailable" });
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    await db.exec(readFileSync(join(__dirname, "../../../../../supabase/migrations", MIGRATION), "utf8").replace(/^(begin|commit);$/gm, ""));
    expect((await one<{ n: number }>("select count(*)::int n from email_results_repair_holds")).n).toBeGreaterThan(450);
  });
});
