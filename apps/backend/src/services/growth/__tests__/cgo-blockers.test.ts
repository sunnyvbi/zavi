import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  alertHeadline,
  alertUrgentBlockers,
  blockerChange,
  blockerItem,
  blockerSeverity,
  cardBlockerId,
  deriveBlockers,
  incidentKey,
  defaultBlockerDeps,
  loadBlockerSources,
  markReviewBlockers,
  adReadFailedBlocker,
  overspendBlocker,
  rankBlockers,
  readToldNotes,
  reducesAdSpend,
  toldMemory,
  uncertainDecisionBlocker,
  urgentToAlert,
  URGENT_KEY,
  type Blocker,
  type BlockerDeps,
  type BlockerSources,
} from "../cgo-blockers";
import { BLOCKER_NOTE_KEY } from "../cgo-note-items";
import { flushPendingCgoNotes } from "../cgo-note-notifications";

const db = vi.hoisted(() => ({ from: vi.fn(), send: vi.fn(), tables: new Map<string, Array<Record<string, unknown>>>() }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (id: string) => id, tenantClient: () => ({ from: db.from }), tenantMarkerAt: async () => null }));
vi.mock("@/../workers/client", () => ({ inngest: { send: db.send } }));
vi.mock("../goal-owner", () => ({ readChainRoots: async () => new Map() }));
vi.mock("../cgo-ads", () => ({ cgoAdBudget: async () => null }));

const T = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-07T14:00:00.000Z");
const DAYS_AGO = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function sources(over: Partial<BlockerSources> = {}): BlockerSources {
  return {
    questions: [],
    failedCards: [],
    leftCards: [],
    chainRoots: new Map(),
    connectors: [],
    metaNotReady: null,
    metaAccountBlocked: null,
    runningAds: false,
    spendStaleSince: null,
    stoppedBudgets: [],
    stuck: [],
    ...over,
  };
}

const failed = (id: string, exec_class: string, exec_result: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  id,
  channel_slug: exec_class.split(".")[0],
  title: `Card ${id}`,
  exec_class,
  exec_payload: {},
  exec_result,
  stake: null,
  proposed_at: DAYS_AGO(5),
  failed_at: DAYS_AGO(2),
  ...over,
});

const PAUSE = { object_id: "as1", level: "adset", status: "PAUSED", over_cap: false };
const RESUME = { ...PAUSE, status: "ACTIVE" };
const CUT = { ad_set_id: "as1", daily_budget_usd: 20, expected_current_daily_budget_usd: 50, over_cap: false };
const RAISE = { ...CUT, daily_budget_usd: 80 };

const blocker = (over: Partial<Blocker> = {}): Blocker => ({
  id: "card:c1",
  kind: "card",
  what: "Raise the Bay Area budget",
  who: "you",
  since: DAYS_AGO(3),
  usd_at_stake: null,
  at_risk_now: false,
  meanwhile: "it waits for you",
  ...over,
});

describe("stored blockers", () => {
  type Row = Record<string, unknown>;
  class Query {
    filters: Array<(row: Row) => boolean> = [];
    start = 0;
    end = Infinity;
    orders: Array<{ key: string; ascending: boolean }> = [];
    patch: Row | null = null;
    inserted: Row | null = null;
    constructor(readonly table: string) {}
    select() { return this; }
    eq(key: string, value: unknown) { this.filters.push((r) => r[key] === value); return this; }
    or(expr: string) {
      const keyset = /^dispatched_at\.lt\."([^"]+)",and\(dispatched_at\.eq\."([^"]+)",id\.lt\.([^)]+)\)$/.exec(expr);
      if (keyset) {
        this.filters.push((r) => String(r.dispatched_at) < keyset[1] || (String(r.dispatched_at) === keyset[2] && String(r.id) < keyset[3]));
        return this;
      }
      const lt = /queued_at\.lt\.([^,]+)/.exec(expr);
      if (lt) this.filters.push((r) => r.queued_at == null || String(r.queued_at) < lt[1]);
      else this.filters.push((r) => r.notified === true || r.notification_key != null);
      return this;
    }
    in(key: string, values: unknown[]) { this.filters.push((r) => values.includes(r[key])); return this; }
    like(key: string, pattern: string) { const re = new RegExp(`^${pattern.replace(/[.]/g, "\\.").replace(/%/g, ".*")}$`); this.filters.push((r) => re.test(String(r[key] ?? ""))); return this; }
    not(key: string, _op: string, value: unknown) { this.filters.push((r) => (r[key] ?? null) !== value); return this; }
    gte(key: string, value: string) { this.filters.push((r) => String(r[key]) >= value); return this; }
    lte(key: string, value: string) { this.filters.push((r) => String(r[key]) <= value); return this; }
    order(key: string, opts: { ascending: boolean }) { this.orders.push({ key, ...opts }); return this; }
    limit(n: number) { this.end = n; return this; }
    range(start: number, end: number) { this.start = start; this.end = end + 1; return this; }
    update(patch: Row) { this.patch = patch; return this; }
    insert(row: Row) { this.inserted = row; return this; }
    result() {
      const stored = db.tables.get(this.table) ?? [];
      if (this.inserted) {
        if (this.inserted.notification_key != null && stored.some(r => r.tenant_id === this.inserted!.tenant_id && r.notification_key === this.inserted!.notification_key)) return {data: [] as Row[], error: {code: "23505", message: "notification key already exists"}};
        stored.push({ id: `note-${stored.length + 1}`, created_at: NOW.toISOString(), ...this.inserted });
        db.tables.set(this.table, stored);
      }
      const rows = stored.filter((r) => this.filters.every((filter) => filter(r)));
      if (this.patch) rows.forEach((r) => Object.assign(r, this.patch));
      rows.sort((a, b) => {
        for (const { key, ascending } of this.orders) {
          const result = String(a[key]).localeCompare(String(b[key]));
          if (result) return ascending ? result : -result;
        }
        return 0;
      });
      return { data: rows.slice(this.start, this.end), error: null };
    }
    async maybeSingle() { const result = this.result(); return { ...result, data: result.data[0] ?? null }; }
    then(resolve: (value: ReturnType<Query["result"]>) => unknown) { return Promise.resolve(this.result()).then(resolve); }
  }

  beforeEach(() => {
    db.tables.clear();
    db.from.mockImplementation((table: string) => new Query(table));
    db.send.mockReset().mockResolvedValue({ ids: ["queued"] });
  });

  it("retains the original alert for retry, never repeats its ask, and re-sends it before the next alert check", async () => {
    const deps = { now: () => NOW, sources: async () => sources({ metaAccountBlocked: { since: DAYS_AGO(1), reason: "billing" } }) };
    db.send.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(alertUrgentBlockers(T, deps)).rejects.toThrow("queue unavailable");
    expect(db.tables.get("cgo_notes")?.[0].notified).toBe(false);
    expect(await readToldNotes(T, NOW)).toEqual([]);
    expect((await alertUrgentBlockers(T, deps)).sent).toBe(0);
    expect(db.tables.get("cgo_notes")?.[0]).toMatchObject({ notified: false, queued_at: expect.any(String) });
    expect(await readToldNotes(T, NOW)).toEqual([]);
    expect(await flushPendingCgoNotes(T, NOW)).toBe(0);
    expect(db.send).toHaveBeenCalledTimes(2);
    expect(db.tables.get("cgo_notes")).toHaveLength(1);
    expect(db.send.mock.calls[0][0].id).toBe(db.send.mock.calls[1][0].id);
  });

  it("a caller's same-id blocker lends its words: Composio's reason reaches the founder", async () => {
    const since = DAYS_AGO(0);
    const deps = { now: () => NOW, flush: async () => 0, sources: async () => sources({ adReadFailed: [{ budget_id: "b-1", platform: "reddit", since, kind: "auth" }] }) };
    const extra = adReadFailedBlocker({ budget_id: "b-1", platform: "reddit", name: "Reddit Ads", day: NOW.toISOString().slice(0, 10), since, kind: "auth", reason: "Reddit Ads connection stopped working on Oct 15" });
    expect(await alertUrgentBlockers(T, deps, [extra])).toMatchObject({ sent: 1 });
    expect(db.tables.get("cgo_notes")?.[0].headline).toBe("Needs you now: Reconnect Reddit Ads: Reddit Ads connection stopped working on Oct 15");
  });

  it("a new blocker does not repeat an urgent alert still waiting to queue", async () => {
    const pending = sources({ metaAccountBlocked: { since: DAYS_AGO(1), reason: "billing" } });
    const deps = { now: () => NOW, flush: async () => 0, sources: async () => pending };
    db.send.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(alertUrgentBlockers(T, deps)).rejects.toThrow("queue unavailable");
    pending.failedCards.push(failed("p1", "meta_ads.set_status", { bucket: "temporary" }, { exec_payload: PAUSE, title: "Pause Turo" }));
    expect(await alertUrgentBlockers(T, deps)).toMatchObject({ sent: 1 });
    expect(db.tables.get("cgo_notes")).toHaveLength(2);
    expect(db.tables.get("cgo_notes")?.[1].items).toEqual([expect.objectContaining({ blocker_id: "card:p1" })]);
  });

  it("a delivery that fails for good leaves the ask untold, and the next alert tells it again (F3)", async () => {
    const deps = { now: () => NOW, flush: async () => 0, sources: async () => sources({ metaAccountBlocked: { since: DAYS_AGO(1), reason: "billing" } }) };
    expect(await alertUrgentBlockers(T, deps)).toMatchObject({ sent: 1 });
    expect(await readToldNotes(T, NOW)).toEqual([]);
    Object.assign(db.tables.get("cgo_notes")![0], { notification_key: null, queued_at: null });
    expect(await alertUrgentBlockers(T, deps)).toMatchObject({ sent: 1 });
    expect(db.tables.get("cgo_notes")).toHaveLength(2);
    db.tables.get("cgo_notes")![1].notified = true;
    expect(await readToldNotes(T, NOW)).toHaveLength(1);
    expect(await alertUrgentBlockers(T, deps)).toMatchObject({ sent: 0, why: "nothing_new" });
  });

  it("two settlements at the same moment tell one incident once (F6)", async () => {
    const pause = failed("p1", "meta_ads.set_status", { bucket: "temporary" }, { exec_payload: PAUSE, title: "Pause Turo" });
    const cut = failed("c1", "google_ads.set_status", { bucket: "temporary" }, { exec_payload: { campaign_id: "1", status: "PAUSED", over_cap: false, rationale: "" }, title: "Pause Brand" });
    const a = { now: () => NOW, flush: async () => 0, sources: async () => sources({ failedCards: [pause] }) };
    const b = { now: () => NOW, flush: async () => 0, sources: async () => sources({ failedCards: [pause, cut] }) };
    const [ra, rb] = await Promise.all([alertUrgentBlockers(T, a), alertUrgentBlockers(T, b)]);
    expect(ra.sent + rb.sent).toBe(2);
    const told = (db.tables.get("cgo_notes") ?? []).flatMap((n) => (n.items as Array<{ blocker_id: string }>).map((i) => i.blocker_id));
    expect(told.sort()).toEqual(["card:c1", "card:p1"]);
    expect(db.send).toHaveBeenCalledTimes(2);
  });

  it("ignores blocker notes that were never queued", async () => {
    db.tables.set("cgo_notes", [{ tenant_id: T, created_at: NOW.toISOString(), items: [], alarm_keys: [BLOCKER_NOTE_KEY, URGENT_KEY], notified: false }]);
    expect(await defaultBlockerDeps.told(T, NOW)).toEqual([]);
  });

  it("retries a persisted review notification after restart without sending quiet notes", async () => {
    db.tables.set("cgo_notes", [
      { id: "pending", tenant_id: T, run_id: "run-pending", notification_key: "review:run-pending", notified: false },
      { id: "quiet", tenant_id: T, run_id: "run-quiet", notification_key: null, notified: false },
    ]);
    db.send.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(flushPendingCgoNotes(T)).rejects.toThrow("queue unavailable");
    db.tables.set("cgo_notes", JSON.parse(JSON.stringify(db.tables.get("cgo_notes"))));
    expect(await flushPendingCgoNotes(T)).toBe(1);
    expect(await flushPendingCgoNotes(T)).toBe(0);
    expect(await flushPendingCgoNotes(T, new Date(Date.now() + 7 * 3_600_000))).toBe(1);
    expect(db.send.mock.calls[2][0].id).toMatch(/^cgo-note-email:run-pending:\d+$/);
    expect(db.send.mock.calls.slice(0, 2).map(([event]) => event.id)).toEqual(["cgo-note-email:run-pending", "cgo-note-email:run-pending"]);
    expect(db.tables.get("cgo_notes")?.find((n) => n.id === "quiet")?.notified).toBe(false);
  });

  it("reads failed Meta decisions the founder can fix, past a page of other failures", async () => {
    const graph33 = `Meta Ads write failed: 400 {"error":{"message":"Object with ID '1' does not exist, cannot be loaded due to missing permissions","type":"GraphMethodException","code":100,"error_subcode":33}}`;
    db.tables.set("decisions", [
      ...Array.from({ length: 60 }, (_, i) => ({ id: `x${i}`, tenant_id: T, status: "dispatch_failed", decision_class: "github.open_pr", dispatched_at: DAYS_AGO(0), dispatch_error: "push failed: 422" })),
      ...Array.from({ length: 70 }, (_, i) => ({ id: `b${i}`, tenant_id: T, status: "dispatch_failed", decision_class: "meta_ads.create_ad_set", dispatched_at: DAYS_AGO(0.5), dispatch_error: 'Meta Ads write failed: 400 {"error":{"message":"Invalid parameter","code":100,"error_subcode":1885097}}' })),
      { id: "m33", tenant_id: T, status: "dispatch_failed", decision_class: "meta_ads.set_status_review", dispatched_at: DAYS_AGO(1), dispatch_error: graph33 },
      { id: "old", tenant_id: T, status: "dispatch_failed", decision_class: "meta_ads.set_status_review", dispatched_at: DAYS_AGO(9), dispatch_error: graph33 },
    ]);
    expect((await loadBlockerSources(T, NOW)).failedDecisionFixes).toEqual([
      { id: "m33", decision_class: "meta_ads.set_status_review", since: DAYS_AGO(1), fix: "permission", platform_code: "meta_100_33", cut: false },
    ]);
  });

  it("keeps old pending cards beyond the first page of notes, including alert hints, and removes resolved cards", async () => {
    const card = (id: string, status: string): Row => ({ id, tenant_id: T, status, channel_slug: "meta_ads", title: "Approve the budget", exec_class: "meta_ads.update_ad_set_budget", exec_status: null, proposed_at: DAYS_AGO(21) });
    db.tables.set("channel_actions", [card("old", "pending"), card("digest", "pending"), card("resolved", "acted")]);
    db.tables.set("cgo_notes", [
      ...Array.from({ length: 101 }, (_, id) => ({ id: String(id), tenant_id: T, created_at: NOW.toISOString(), items: [] })),
      { id: "original", tenant_id: T, created_at: DAYS_AGO(21), items: [{ section: "needs_you", text: "Approve", action_id: "old", usd_at_stake: 300 }, { section: "needs_you", text: "Approve", action_id: "resolved" }] },
      { id: "digest", tenant_id: T, created_at: DAYS_AGO(20), alarm_keys: [BLOCKER_NOTE_KEY, URGENT_KEY], items: [{ section: "needs_you", text: "Approve", action_id: "digest" }] },
    ]);
    expect((await loadBlockerSources(T, NOW)).leftCards).toEqual([
      expect.objectContaining({ id: "old", usd_hint: 300 }),
      expect.objectContaining({ id: "digest" }),
    ]);
    db.tables.get("channel_actions")![0].status = "acted";
    expect((await loadBlockerSources(T, NOW)).leftCards.map((c) => c.id)).toEqual(["digest"]);
  });
});

describe("cardBlockerId", () => {
  it("names the ask, not the card, whenever many cards wait on one fix", () => {
    const id = (bucket: string | null, fix: string | null, exec_class = "meta_ads.set_status") => cardBlockerId({ bucket, fix, exec_class, chain_root_id: "root" });
    expect(id("needs_founder", "reconnect")).toBe("connector:meta_ads");
    expect(id("needs_founder", "reconnect", "google_ads.update_campaign_budget")).toBe("connector:google_ads");
    for (const fix of ["page_grant", "page", "permission", "billing"]) expect(id("needs_founder", fix)).toBe("account:meta_ads");
    expect(id("needs_founder", "credits")).toBe("plan:credits");
    expect(id("needs_founder", "plan")).toBe("plan:plan");
    expect(id("partial_risk", null)).toBe("check:root");
    expect(id(null, null)).toBe("card:root");
    expect(id("temporary", null)).toBe("card:root");
  });
});

describe("blockerSeverity", () => {
  it("urgent only when money is at risk right now, whatever the amount", () => {
    expect(blockerSeverity({ at_risk_now: true })).toBe("urgent");
    expect(blockerSeverity({ at_risk_now: false })).toBe("normal");
  });
});

describe("toldMemory and blockerChange", () => {
  const notes = [
    { created_at: "2026-10-05T00:00:00Z", items: [{ section: "needs_you", text: "x", blocker_id: "card:c1", blocker_severity: "normal", usd_at_stake: 200 }] },
    { created_at: "2026-10-06T00:00:00Z", items: [{ section: "needs_you", text: "x", blocker_id: "card:c1", blocker_severity: "normal", usd_at_stake: 300 }, { section: "needs_you", text: "y" }] },
  ];

  it("remembers the last time each blocker was told, by its id", () => {
    const told = toldMemory(notes);
    expect(told.get("card:c1")).toEqual({ severity: "normal", usd: 300, at: "2026-10-06T00:00:00Z" });
    expect(told.size).toBe(1);
  });

  it("new once, then unchanged until severity rises or a card's money moves enough", () => {
    const told = toldMemory(notes);
    expect(blockerChange("card:c9", { severity: "normal", usd: 1 }, told.get("card:c9"))).toBe("new");
    expect(blockerChange("card:c1", { severity: "normal", usd: 320 }, told.get("card:c1"))).toBe("unchanged");
    expect(blockerChange("card:c1", { severity: "normal", usd: 380 }, told.get("card:c1"))).toBe("changed");
    expect(blockerChange("card:c1", { severity: "normal", usd: 200 }, told.get("card:c1"))).toBe("changed");
    expect(blockerChange("card:c1", { severity: "urgent", usd: 300 }, told.get("card:c1"))).toBe("changed");
  });

  it("a blocker whose episode began after it was told is back again: it resolved and reopened", () => {
    const told = { severity: "urgent" as const, usd: null, at: "2026-10-05T10:00:00Z" };
    expect(blockerChange("budget_stop:b1", { severity: "urgent", usd: null, since: "2026-10-05T09:00:00Z" }, told)).toBe("unchanged");
    expect(blockerChange("budget_stop:b1", { severity: "urgent", usd: null, since: "2026-10-07T08:00:00Z" }, told)).toBe("reopened");
    expect(blockerChange("budget_stop:b1", { severity: "urgent", usd: null }, told)).toBe("unchanged");
  });

  it("an ask that groups many cards compares on severity only, so a total never flips against one card's share", () => {
    const told = { severity: "urgent" as const, usd: 1200, at: "x" };
    expect(blockerChange("connector:meta_ads", { severity: "urgent", usd: 400 }, told)).toBe("unchanged");
    expect(blockerChange("connector:meta_ads", { severity: "urgent", usd: null }, { ...told, severity: "normal" })).toBe("changed");
  });
});

describe("deriveBlockers", () => {
  it("one ask per fix: two Meta cards waiting on a reconnect, and the dead token, are one blocker", () => {
    const out = deriveBlockers(
      sources({
        runningAds: true,
        connectors: [
          { slug: "meta_ads", token_expires_at: DAYS_AGO(1) },
          { slug: "google_ads", token_expires_at: new Date(NOW.getTime() + 86_400_000).toISOString() },
        ],
        failedCards: [
          failed("c1", "meta_ads.update_ad_set_budget", { bucket: "needs_founder", fix: "reconnect" }, { failed_at: DAYS_AGO(4) }),
          failed("c2", "meta_ads.set_status", { bucket: "needs_founder", fix: "reconnect" }),
        ],
      }),
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "connector:meta_ads", who: "you", at_risk_now: true, since: DAYS_AGO(4), what: "Reconnect Meta Ads" });
    expect(out[0].action_id).toBeUndefined();
  });

  it("each source becomes its own blocker with who, since, money and what happens meanwhile", () => {
    const out = deriveBlockers(
      sources({
        questions: [{ topic_key: "channel:reddit_organic", ask: "Keep Reddit?", asked_at: DAYS_AGO(2), default_line: "If I don't hear back by Oct 9, I'll pause Reddit.", ordinal: 1 }],
        failedCards: [
          failed("p1", "meta_ads.duplicate_ad_set", { bucket: "partial_risk", code: "exec_outcome_unknown" }),
          failed("t1", "meta_ads.set_status", { bucket: "temporary" }),
          failed("b1", "google_ads.create_campaign", { bucket: "blocked_on_us" }),
        ],
        leftCards: [{ id: "l1", channel_slug: "google_ads", title: "Cut the Brand campaign", exec_class: "google_ads.update_campaign_budget", exec_payload: {}, stake: null, proposed_at: DAYS_AGO(6), usd_hint: 700 }],
        stoppedBudgets: [{ budget_id: "bud1", still_running: 2, platforms: ["meta"], since: DAYS_AGO(0) }],
        stuck: [{ id: "s1", title: "Raise Turo", exec_class: "meta_ads.update_ad_set_budget", since: DAYS_AGO(0) }],
      }),
      NOW,
    );
    const byId = new Map(out.map((b) => [b.id, b]));
    expect([...byId.keys()].sort()).toEqual(["budget_stop:bud1", "card:l1", "check:p1", "question:channel:reddit_organic", "stuck:s1"]);
    expect(byId.get("question:channel:reddit_organic")).toMatchObject({ who: "you", question_ordinal: 1, meanwhile: "If I don't hear back by Oct 9, I'll pause Reddit." });
    expect(byId.get("check:p1")).toMatchObject({ at_risk_now: true, action_id: "p1" });
    expect(byId.get("card:l1")).toMatchObject({ usd_at_stake: 700, at_risk_now: false, action_id: "l1" });
    expect(byId.get("budget_stop:bud1")).toMatchObject({ who: "you", at_risk_now: true, what: expect.stringContaining("Pause 2 ads in Meta Ads yourself") });
    expect(byId.get("stuck:s1")).toMatchObject({ who: "zavi" });
  });

  it("a Page Zavi cannot use holds new ads; a disabled or unpaid account puts money at risk now", () => {
    const page = deriveBlockers(sources({ metaNotReady: { since: DAYS_AGO(1), reason: "page_permission_missing" } }), NOW);
    expect(page[0]).toMatchObject({ id: "account:meta_ads", at_risk_now: false, what: expect.stringContaining("allow access to your Facebook Page") });
    const unpaid = deriveBlockers(sources({ metaAccountBlocked: { since: DAYS_AGO(1), reason: "unsettled" } }), NOW);
    expect(unpaid[0]).toMatchObject({ id: "account:meta_ads", at_risk_now: true, what: expect.stringContaining("status and billing") });
    const missing = deriveBlockers(sources({ metaNotReady: { since: DAYS_AGO(1), reason: "connector_missing" } }), NOW);
    expect(missing[0].id).toBe("connector:meta_ads");
  });

  it("a suspended Google Ads account is the founder's to fix, with money at risk now", () => {
    const out = deriveBlockers(sources({ googleAccountBlocked: { since: DAYS_AGO(0), reason: "suspended" } }), NOW);
    expect(out).toEqual([expect.objectContaining({ id: "account:google_ads", who: "you", at_risk_now: true, what: expect.stringContaining("Google Ads says: suspended") })]);
  });

  it("unread spend is Zavi's blocker (never an alert), unless a dead connection already explains it", () => {
    const stale = deriveBlockers(sources({ runningAds: true, spendStaleSince: DAYS_AGO(0) }), NOW);
    expect(stale).toEqual([expect.objectContaining({ id: "spend_data", who: "zavi", at_risk_now: false })]);
    const explained = deriveBlockers(sources({ runningAds: true, spendStaleSince: DAYS_AGO(0), connectors: [{ slug: "meta_ads", token_expires_at: DAYS_AGO(0) }] }), NOW);
    expect(explained.map((b) => b.id)).toEqual(["connector:meta_ads"]);
    expect(deriveBlockers(sources({ runningAds: false, spendStaleSince: DAYS_AGO(0) }), NOW)).toEqual([]);
  });

  it("an ad change sent on the decisions rail whose outcome is unknown asks the founder to check, with money at risk", () => {
    const out = deriveBlockers(sources({ uncertainDecisions: [{ id: "d1", decision_class: "meta_ads.update_ad_set_budget", since: DAYS_AGO(1) }] }), NOW);
    expect(out).toEqual([expect.objectContaining({ id: "check:decision:d1", who: "you", at_risk_now: true, what: expect.stringContaining("Check Meta Ads") })]);
  });

  it("a pause or budget cut that did not go through keeps money going out: at risk now, on either rail", () => {
    const out = deriveBlockers(
      sources({
        failedCards: [
          failed("p1", "meta_ads.set_status", { bucket: "temporary" }, { exec_payload: PAUSE, title: "Pause Turo" }),
          failed("c1", "meta_ads.update_ad_set_budget_review", { bucket: "needs_founder", fix: "credits" }, { exec_payload: CUT }),
          failed("b1", "meta_ads.set_status", { bucket: "blocked_on_us" }, { exec_payload: PAUSE, title: "Pause Bay Area", closed: true }),
          failed("r1", "meta_ads.set_status", { bucket: "temporary" }, { exec_payload: RESUME }),
          failed("u1", "meta_ads.update_ad_set_budget", { bucket: "temporary" }, { exec_payload: RAISE }),
          failed("x1", "meta_ads.update_ad_set_budget", { bucket: "blocked_on_us" }, { exec_payload: RAISE, closed: true }),
        ],
        failedDecisionCuts: [{ id: "d1", decision_class: "google_ads.set_status", since: DAYS_AGO(0) }],
        stuck: [
          { id: "s1", title: "Pause Brand", exec_class: "google_ads.set_status", exec_payload: { campaign_id: "1", status: "PAUSED", over_cap: false, rationale: "" }, since: DAYS_AGO(0) },
          { id: "s2", title: "Raise Brand", exec_class: "meta_ads.update_ad_set_budget", exec_payload: RAISE, since: DAYS_AGO(0) },
        ],
      }),
      NOW,
    );
    const byId = new Map(out.map((b) => [b.id, b]));
    expect([...byId.keys()].sort()).toEqual(["card:b1", "card:decision:d1", "card:p1", "plan:credits", "stuck:s1", "stuck:s2"]);
    expect(byId.get("card:p1")).toMatchObject({ who: "you", at_risk_now: true, what: '"Pause Turo" did not go through: press Try again, or do it in Meta Ads yourself', meanwhile: "the ads keep spending until it goes through" });
    expect(byId.get("plan:credits")).toMatchObject({ at_risk_now: true });
    expect(byId.get("card:b1")).toMatchObject({ who: "zavi", at_risk_now: true, what: expect.stringContaining("pause them in Meta Ads if they must stop now") });
    expect(byId.get("card:decision:d1")).toMatchObject({ who: "you", at_risk_now: true, what: "A pause Zavi sent to Google Ads did not go through: do it in Google Ads yourself" });
    expect(byId.get("stuck:s1")).toMatchObject({ who: "zavi", at_risk_now: true, what: expect.stringContaining("A pause did not finish, so the ads keep spending") });
    expect(byId.get("stuck:s2")).toMatchObject({ at_risk_now: false, what: "A change did not finish: Raise Brand" });
  });

  it("a repeat card speaks for its whole chain", () => {
    const out = deriveBlockers(
      sources({
        chainRoots: new Map([["c2", "c1"]]),
        failedCards: [failed("c2", "meta_ads.duplicate_ad_set", { bucket: "partial_risk" })],
      }),
      NOW,
    );
    expect(out[0].id).toBe("check:c1");
  });
});

describe("ranking, lines and headlines", () => {
  it("money at risk now first, then the founder's before Zavi's, then the most money, then the oldest", () => {
    const ranked = rankBlockers(
      [
        blocker({ id: "card:small", usd_at_stake: 100, since: DAYS_AGO(9) }),
        blocker({ id: "stuck:s1", who: "zavi", at_risk_now: true }),
        blocker({ id: "card:big", usd_at_stake: 2000 }),
        blocker({ id: "card:mid", usd_at_stake: 300 }),
        blocker({ id: "spend_data", who: "zavi", at_risk_now: false }),
      ],
      new Map(),
    );
    expect(ranked.map((r) => [r.b.id, r.severity])).toEqual([
      ["stuck:s1", "urgent"],
      ["card:big", "normal"],
      ["card:mid", "normal"],
      ["card:small", "normal"],
      ["spend_data", "normal"],
    ]);
  });

  it("an alert line says what keeps running meanwhile, the money and how long, in plain sentences", () => {
    const item = blockerItem(blocker({ usd_at_stake: 1200, action_id: "c1", channel_slug: "meta_ads" }), "urgent", "new", NOW);
    expect(item).toMatchObject({
      section: "needs_you",
      text: "Raise the Bay Area budget",
      reason: "It waits for you. $1,200 a month at stake. Waiting 3 days",
      blocker_id: "card:c1",
      blocker_severity: "urgent",
      usd_at_stake: 1200,
      action_id: "c1",
    });
    const ours = blockerItem(blocker({ id: "stuck:s1", who: "zavi", at_risk_now: true, since: NOW.toISOString() }), "urgent", "unchanged", NOW);
    expect(ours).toMatchObject({ section: "blocked", reason: "It waits for you. Money is at risk until this is fixed" });
  });

  it("the alert headline leads with the first thing that needs the founder", () => {
    expect(alertHeadline([{ b: blocker({ what: "Reconnect Meta Ads." }), severity: "urgent", state: "new" }])).toBe("Needs you now: Reconnect Meta Ads");
  });

  it("only urgent blockers that are new or changed alert at once", () => {
    const ranked = [
      { b: blocker({ id: "a" }), severity: "urgent" as const, state: "new" as const },
      { b: blocker({ id: "b" }), severity: "urgent" as const, state: "unchanged" as const },
      { b: blocker({ id: "c" }), severity: "normal" as const, state: "new" as const },
      { b: blocker({ id: "d" }), severity: "urgent" as const, state: "changed" as const },
    ];
    expect(urgentToAlert(ranked).map((x) => x.b.id)).toEqual(["a", "d"]);
  });
});

describe("markReviewBlockers", () => {
  const cards = new Map<string, { exec_class: string | null; exec_status: string | null; exec_result: unknown; exec_payload?: unknown }>([
    ["c1", { exec_class: "meta_ads.set_status", exec_status: "failed", exec_result: { bucket: "needs_founder", fix: "reconnect" } }],
    ["c2", { exec_class: "google_ads.update_campaign_budget", exec_status: null, exec_result: null }],
    ["c4", { exec_class: "meta_ads.set_status", exec_status: "failed", exec_result: { bucket: "temporary" }, exec_payload: PAUSE }],
    ["c5", { exec_class: "meta_ads.set_status_review", exec_status: null, exec_result: null, exec_payload: PAUSE }],
  ]);

  it("tags each ask with its blocker and drops one the founder was already told, unchanged", () => {
    const told = new Map([["card:c2", { severity: "normal" as const, usd: 100, at: "x" }]]);
    const out = markReviewBlockers(
      [
        { section: "needs_you", text: "Turn Turo back on", action_id: "c1", chain_root_id: "c1" },
        { section: "needs_you", text: "Raise Brand", action_id: "c2", chain_root_id: "c2", usd_at_stake: 110 },
        { section: "needs_you", text: "Keep Reddit?", question_ordinal: 1 },
        { section: "changed", text: "Applied: x", action_id: "c3" },
        { section: "needs_you", text: "Pick where your Meta ads show", channel_slug: "meta_ads", locations: true },
      ],
      cards,
      told,
    );
    expect(out).toEqual([
      { section: "needs_you", text: "Turn Turo back on", action_id: "c1", chain_root_id: "c1", blocker_id: "connector:meta_ads", blocker_severity: "urgent" },
      { section: "needs_you", text: "Keep Reddit?", question_ordinal: 1 },
      { section: "changed", text: "Applied: x", action_id: "c3" },
      { section: "needs_you", text: "Pick where your Meta ads show", channel_slug: "meta_ads", locations: true },
    ]);
  });

  it("a big ask is a normal ask; a pause that failed is urgent; a pause still waiting for approval is an ask", () => {
    const out = markReviewBlockers(
      [
        { section: "needs_you", text: "Raise Brand", action_id: "c2", chain_root_id: "c2", usd_at_stake: 5000 },
        { section: "needs_you", text: "Pause Turo", action_id: "c4", chain_root_id: "c4" },
        { section: "needs_you", text: "Pause Bay Area?", action_id: "c5", chain_root_id: "c5" },
      ],
      cards,
      new Map(),
    );
    expect(out.map((i) => [i.blocker_id, i.blocker_severity])).toEqual([
      ["card:c2", "normal"],
      ["card:c4", "urgent"],
      ["card:c5", "normal"],
    ]);
  });
});

describe("senders", () => {
  function deps(over: Partial<BlockerDeps> = {}, told: Array<{ items: unknown; created_at: string; alarm_keys: string[] }> = []) {
    const written: Array<{ headline: string; items: unknown[]; keys: string[] }> = [];
    const sent: string[] = [];
    const d: Partial<BlockerDeps> = {
      now: () => NOW,
      flush: async () => 0,
      sources: async () =>
        sources({
          runningAds: true,
          connectors: [{ slug: "meta_ads", token_expires_at: DAYS_AGO(1) }],
          questions: [{ topic_key: "ad_budget", ask: "Raise the budget to $3,000?", asked_at: DAYS_AGO(1), default_line: null, ordinal: 2 }],
        }),
      told: async () => told,
      writeNote: async (_t, note) => {
        written.push(note);
        return `note-${written.length}`;
      },
      send: async (_t, id) => {
        sent.push(id);
      },
      ...over,
    };
    return { d, written, sent };
  }

  it("an urgent blocker the founder has not heard about goes out at once, alone", async () => {
    const { d, written, sent } = deps();
    expect(await alertUrgentBlockers(T, d)).toEqual({ sent: 1, urgent_ids: ["connector:meta_ads"] });
    expect(written).toEqual([{ headline: "Needs you now: Reconnect Meta Ads", items: [expect.objectContaining({ blocker_id: "connector:meta_ads", blocker_severity: "urgent" })], keys: [URGENT_KEY], notification_key: expect.stringMatching(/^blocker:/) }]);
    expect(sent).toEqual(["note-1"]);
  });

  it("is not sent again while unchanged, and a new incident is never held back by a daily limit", async () => {
    const told = [{ created_at: DAYS_AGO(0), alarm_keys: [BLOCKER_NOTE_KEY, URGENT_KEY], items: [{ section: "needs_you", text: "x", blocker_id: "connector:meta_ads", blocker_severity: "urgent" }] }];
    expect(await alertUrgentBlockers(T, deps({}, told).d)).toMatchObject({ sent: 0, why: "nothing_new" });
    const many = Array.from({ length: 5 }, () => ({ created_at: NOW.toISOString(), alarm_keys: [BLOCKER_NOTE_KEY, URGENT_KEY], items: [] }));
    expect(await alertUrgentBlockers(T, deps({}, many).d)).toMatchObject({ sent: 1 });
  });

  it("a big ask alone never alerts at once; money at risk now alerts at once, with no amount needed", async () => {
    const big = {
      sources: async () =>
        sources({
          leftCards: [{ id: "l1", channel_slug: "google_ads", title: "Move $5,000 to Brand", exec_class: "google_ads.update_campaign_budget", exec_payload: {}, stake: null, proposed_at: DAYS_AGO(1), usd_hint: 5000 }],
        }),
    };
    expect(await alertUrgentBlockers(T, deps(big).d)).toMatchObject({ sent: 0, why: "nothing_new" });

    const risk = deps({
      sources: async () =>
        sources({
          leftCards: [{ id: "l1", channel_slug: "google_ads", title: "Move $5,000 to Brand", exec_class: "google_ads.update_campaign_budget", exec_payload: {}, stake: null, proposed_at: DAYS_AGO(1), usd_hint: 5000 }],
          failedCards: [failed("p1", "meta_ads.set_status", { bucket: "temporary" }, { exec_payload: PAUSE, title: "Pause Turo" })],
        }),
    });
    expect(await alertUrgentBlockers(T, risk.d)).toMatchObject({ sent: 1 });
    expect(risk.written[0].items).toEqual([expect.objectContaining({ blocker_id: "card:p1", blocker_severity: "urgent", reason: expect.stringContaining("Money is at risk until this is fixed") })]);
  });

  it("one money-risk incident alerts once until it changes, resolves or reopens", async () => {
    const stop = (since: string) => sources({ stoppedBudgets: [{ budget_id: "b1", still_running: 2, platforms: ["meta"], since }] });
    const notes: Array<{ items: unknown; created_at: string; alarm_keys: string[] }> = [];
    const run = async (src: BlockerSources, at: Date) => {
      const written: Array<{ items: unknown[] }> = [];
      const r = await alertUrgentBlockers(T, {
        now: () => at,
        flush: async () => 0,
        sources: async () => src,
        told: async () => [...notes].reverse(),
        writeNote: async (_t, note) => {
          written.push(note);
          notes.push({ items: note.items, created_at: at.toISOString(), alarm_keys: [BLOCKER_NOTE_KEY, ...note.keys] });
          return "n";
        },
        send: async () => undefined,
      });
      return { r, written };
    };
    const first = await run(stop(DAYS_AGO(2)), new Date(NOW.getTime() - 86_400_000));
    expect(first.r).toMatchObject({ sent: 1 });
    expect(first.written[0].items).toEqual([expect.objectContaining({ blocker_id: "budget_stop:b1", reason: expect.not.stringMatching(/\bNew\b|Who:|Meanwhile:/) })]);
    expect((await run(stop(DAYS_AGO(2)), NOW)).r).toMatchObject({ sent: 0, why: "nothing_new" });
    expect((await run(sources(), NOW)).r).toMatchObject({ sent: 0, why: "nothing_new" });
    const again = await run(stop(NOW.toISOString()), new Date(NOW.getTime() + 3_600_000));
    expect(again.r).toMatchObject({ sent: 1 });
    expect(again.written[0].items).toEqual([expect.objectContaining({ blocker_id: "budget_stop:b1", reason: expect.stringMatching(/^This came back\./) })]);
    expect((await run(stop(NOW.toISOString()), new Date(NOW.getTime() + 7_200_000))).r).toMatchObject({ sent: 0, why: "nothing_new" });
  });

  it("is on for every tenant: there is no setting, and the default deps read none", () => {
    expect(Object.keys(defaultBlockerDeps).sort()).toEqual(["flush", "now", "send", "sources", "told", "writeNote"]);
  });

  it("an incident the caller just saw goes out once; the stored state wins when both name it", async () => {
    const notes: Array<{ items: unknown; created_at: string; alarm_keys: string[] }> = [];
    const run = async (extra: Blocker[], src: BlockerSources = sources(), at: Date = NOW) => {
      const r = await alertUrgentBlockers(
        T,
        {
          now: () => at,
          flush: async () => 0,
          sources: async () => src,
          told: async () => [...notes].reverse(),
          writeNote: async (_t, note) => {
            notes.push({ items: note.items, created_at: at.toISOString(), alarm_keys: [BLOCKER_NOTE_KEY, ...note.keys] });
            return "n";
          },
          send: async () => undefined,
        },
        extra,
      );
      return { r };
    };
    const unknown = uncertainDecisionBlocker({ id: "d1", decision_class: "meta_ads.update_ad_set_budget", since: NOW.toISOString() });
    expect((await run([unknown])).r).toMatchObject({ sent: 1 });
    const later = new Date(NOW.getTime() + 3_600_000);
    const stored = sources({ uncertainDecisions: [{ id: "d1", decision_class: "meta_ads.update_ad_set_budget", since: DAYS_AGO(0) }] });
    expect((await run([], stored, later)).r).toMatchObject({ sent: 0, why: "nothing_new" });
  });
});

describe("overspend (the brake, Autopilot on)", () => {
  const notes: Array<{ items: unknown; created_at: string; alarm_keys: string[] }> = [];
  const alert = async (projected_usd: number, day = "2026-10-07") => {
    const written: Array<{ headline: string; items: unknown[] }> = [];
    const r = await alertUrgentBlockers(
      T,
      {
        now: () => new Date(`${day}T14:00:00.000Z`),
        flush: async () => 0,
        sources: async () => sources(),
        told: async () => [...notes].reverse(),
        writeNote: async (_t, note) => {
          written.push(note);
          notes.push({ items: note.items, created_at: `${day}T14:00:00.000Z`, alarm_keys: [BLOCKER_NOTE_KEY, ...note.keys] });
          return "n";
        },
        send: async () => undefined,
      },
      [overspendBlocker({ budget_id: "b1", day, projected_usd, cap_usd: 1000 })],
    );
    return { r, written };
  };

  it("says what is projected, the money over the cap and the fix", () => {
    const b = overspendBlocker({ budget_id: "b1", day: "2026-10-07", projected_usd: 1400, cap_usd: 1000 });
    expect(b).toMatchObject({ id: "budget_brake:b1:2026-10", who: "you", at_risk_now: true, usd_at_stake: 400 });
    expect(b.what).toBe("Your ads are on track to spend $1,400 this month, $400 over your $1,000 cap");
    expect(b.meanwhile).toBe("Zavi doesn't lower budgets on its own when the month runs over. To stop it, lower daily budgets in your ad accounts or raise the cap on your Ad budget page");
  });

  it("alerts once per budget per month, and again only when the overspend moves by 25% or $50", async () => {
    notes.length = 0;
    expect((await alert(1400)).r).toMatchObject({ sent: 1 });
    expect((await alert(1420, "2026-10-08")).r).toMatchObject({ sent: 0, why: "nothing_new" });
    const moved = await alert(1600, "2026-10-09");
    expect(moved.r).toMatchObject({ sent: 1 });
    expect(moved.written[0].items).toEqual([expect.objectContaining({ blocker_id: "budget_brake:b1:2026-10", reason: expect.stringMatching(/^This has changed since I last told you\./) })]);
    expect((await alert(1400, "2026-11-02")).r).toMatchObject({ sent: 1 });
  });
});

describe("reducesAdSpend", () => {
  it("a pause, a budget cut or a removal reduces spend; a resume or a raise does not", () => {
    expect(reducesAdSpend("meta_ads.set_status", PAUSE)).toBe(true);
    expect(reducesAdSpend("meta_ads.set_status_review", PAUSE)).toBe(true);
    expect(reducesAdSpend("meta_ads.update_ad_set_budget", CUT)).toBe(true);
    expect(reducesAdSpend("google_ads.remove_resource", {})).toBe(true);
    expect(reducesAdSpend("meta_ads.set_status", RESUME)).toBe(false);
    expect(reducesAdSpend("meta_ads.update_ad_set_budget", RAISE)).toBe(false);
  });
});

describe("adReadFailed is a DERIVED blocker: Reconnect only for a login problem", () => {
  const base = {
    questions: [], failedCards: [], leftCards: [], chainRoots: new Map(),
    connectors: [], metaNotReady: null, metaAccountBlocked: null,
    runningAds: false, spendStaleSince: null, stoppedBudgets: [], stuck: [],
  };
  const at = new Date("2026-10-12T20:00:00Z");
  const derive = (since: string, kind?: string | null) =>
    deriveBlockers({ ...base, adReadFailed: [{ budget_id: "b-1", platform: "linkedin", since, kind }] } as never, at);

  it("auth: the urgent Reconnect blocker, at once", () => {
    const [b] = derive("2026-10-12T19:07:00Z", "auth");
    expect(b.id).toBe("ad_read_failed:b-1:linkedin:2026-10");
    expect(b.at_risk_now).toBe(true);
    expect(b.what).toBe("Reconnect LinkedIn Ads: LinkedIn Ads connection stopped working");
  });

  it("auth with Composio's reason: the Reconnect line names it, with the date", () => {
    const b = adReadFailedBlocker({ budget_id: "b-1", platform: "reddit", name: "Reddit Ads", day: "2026-10-15", since: "2026-10-15T15:07:00Z", kind: "auth", reason: "Reddit Ads connection stopped working on Oct 15" });
    expect(b.what).toBe("Reconnect Reddit Ads: Reddit Ads connection stopped working on Oct 15");
    expect(adReadFailedBlocker({ budget_id: "b-1", platform: "reddit", name: "Reddit Ads", day: "2026-10-15", since: "2026-10-15T15:07:00Z", kind: "auth", reason: null }).what)
      .toBe("Reconnect Reddit Ads: Reddit Ads connection stopped working");
  });

  it("account_gone says what to do: reconnect with a login that can see the account, and it is a Reconnect, never 'keep trying'", () => {
    const b = adReadFailedBlocker({ budget_id: "b-1", platform: "linkedin", name: "LinkedIn Ads", day: "2026-10-15", since: "2026-10-15T15:07:00Z", kind: "account_gone" });
    expect(b.what).toBe("Reconnect LinkedIn Ads with a login that can see all your ad accounts: an ad account that spent this month or runs a campaign is no longer in Zavi's connection");
    expect(b.id).toBe("ad_read_failed:b-1:linkedin:2026-10");
  });

  it("not a login problem (or no stored kind), under 3 hours: no blocker", () => {
    expect(derive("2026-10-12T17:30:00Z", "timeout")).toEqual([]);
    expect(derive("2026-10-12T17:30:00Z", null)).toEqual([]);
  });

  it("not a login problem, 3 hours or more: the 'hasn't answered' blocker, no Reconnect", () => {
    for (const kind of ["rate_limited", "vendor_error", "timeout", "unknown", null]) {
      const [b] = derive("2026-10-12T17:00:00Z", kind);
      expect(b.id).toBe("ad_read_slow:b-1:linkedin:2026-10");
      expect(b.what).toBe("LinkedIn Ads hasn't answered for 3 hours. I'll keep trying");
      expect(b.what).not.toMatch(/Reconnect/);
      expect(blockerSeverity(b)).toBe("urgent");
    }
  });

  it("disconnected: no blocker (its spend still counts; the reconcile sent the FYI)", () => {
    expect(derive("2026-10-01T00:00:00Z", "disconnected")).toEqual([]);
  });

  it("a slow read or a disconnect is told once a month; a login problem that comes back is told again", () => {
    const told = { severity: "urgent" as const, usd: null, at: "2026-10-12T10:00:00Z" };
    for (const id of ["ad_read_slow:b-1:reddit:2026-10", "ad_disconnected:b-1:reddit:2026-10"])
      expect(blockerChange(id, { severity: "urgent", usd: null, since: "2026-10-12T15:00:00Z" }, told)).toBe("unchanged");
    expect(blockerChange("ad_read_failed:b-1:reddit:2026-10", { severity: "urgent", usd: null, since: "2026-10-12T15:00:00Z" }, told)).toBe("reopened");
    expect(blockerChange("ad_read_failed:b-1:reddit:2026-10", { severity: "urgent", usd: null, since: "2026-10-12T09:00:00Z" }, told)).toBe("unchanged");
  });

  const sentAt = (hour: string, rows: Array<{ since: string; kind: string | null }>, notes: Array<{ items: unknown; created_at: string }>) => {
    const now = new Date(hour);
    const derived = deriveBlockers({ ...base, adReadFailed: rows.map((r) => ({ budget_id: "b-1", platform: "reddit", ...r })) } as never, now);
    const alerts = urgentToAlert(rankBlockers(derived, toldMemory(notes)));
    for (const a of alerts) notes.push({ items: [blockerItem(a.b, a.severity, a.state, now)], created_at: now.toISOString() });
    return alerts.map((a) => `${a.b.id.split(":")[0]}:${a.state}`);
  };

  it("auth, then a whole read, then auth again in the same month: told twice", () => {
    const notes: Array<{ items: unknown; created_at: string }> = [];
    expect(sentAt("2026-10-12T10:07:00Z", [{ since: "2026-10-12T10:07:00Z", kind: "auth" }], notes)).toEqual(["ad_read_failed:new"]);
    expect(sentAt("2026-10-12T11:07:00Z", [{ since: "2026-10-12T10:07:00Z", kind: "auth" }], notes)).toEqual([]);
    expect(sentAt("2026-10-12T12:07:00Z", [], notes)).toEqual([]);
    expect(sentAt("2026-10-12T13:07:00Z", [{ since: "2026-10-12T13:07:00Z", kind: "auth" }], notes)).toEqual(["ad_read_failed:reopened"]);
    expect(notes).toHaveLength(2);
  });

  it("short blips (each under 3h) and a slow read right after a login problem: nothing sent", () => {
    const notes: Array<{ items: unknown; created_at: string }> = [];
    expect(sentAt("2026-10-12T10:07:00Z", [{ since: "2026-10-12T10:07:00Z", kind: "vendor_error" }], notes)).toEqual([]);
    expect(sentAt("2026-10-12T12:07:00Z", [{ since: "2026-10-12T10:07:00Z", kind: "vendor_error" }], notes)).toEqual([]);
    expect(sentAt("2026-10-12T13:07:00Z", [], notes)).toEqual([]);
    expect(sentAt("2026-10-12T14:07:00Z", [{ since: "2026-10-12T14:07:00Z", kind: "timeout" }], notes)).toEqual([]);
    expect(sentAt("2026-10-12T15:07:00Z", [{ since: "2026-10-12T15:07:00Z", kind: "auth" }], notes)).toEqual(["ad_read_failed:new"]);
    expect(sentAt("2026-10-12T16:07:00Z", [], notes)).toEqual([]);
    expect(sentAt("2026-10-12T17:07:00Z", [{ since: "2026-10-12T17:07:00Z", kind: "rate_limited" }], notes)).toEqual([]);
    expect(sentAt("2026-10-12T20:07:00Z", [{ since: "2026-10-12T17:07:00Z", kind: "rate_limited" }], notes)).toEqual(["ad_read_slow:new"]);
    expect(sentAt("2026-10-12T21:07:00Z", [], notes)).toEqual([]);
    expect(sentAt("2026-10-13T03:07:00Z", [{ since: "2026-10-13T00:07:00Z", kind: "rate_limited" }], notes)).toEqual([]);
  });

  it("a told-once-a-month incident keeps one claim key across episodes and told memory", () => {
    const b = (since: string): Blocker => ({ id: "ad_disconnected:b1:linkedin:2026-10", kind: "connector", who: "you", what: "x", since, usd_at_stake: null, at_risk_now: false, meanwhile: "m" });
    const a = incidentKey({ b: b("2026-10-02T00:00:00Z"), severity: "normal", state: "new" }, new Map());
    const later = incidentKey({ b: b("2026-10-20T00:00:00Z"), severity: "normal", state: "new" }, new Map([["ad_disconnected:b1:linkedin:2026-10", { severity: "normal", usd: null, at: "2026-10-02T01:00:00Z" }]]));
    expect(later).toBe(a);
    const auth = (since: string): Blocker => ({ ...b(since), id: "ad_read_failed:b1:reddit:2026-10" });
    expect(incidentKey({ b: auth("2026-10-02T00:00:00Z"), severity: "urgent", state: "new" }, new Map()))
      .not.toBe(incidentKey({ b: auth("2026-10-20T00:00:00Z"), severity: "urgent", state: "reopened" }, new Map()));
  });
});
