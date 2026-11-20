import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const failing = new Set<string>();
const failingRead: Array<{ table: string; cols: string; mode: "error" | "throw" }> = [];

function field(row: Row, col: string): unknown {
  const m = /^(\w+)->>(\w+)$/.exec(col);
  if (m) {
    const v = (row[m[1]] as Row | null | undefined)?.[m[2]];
    return v == null ? null : String(v);
  }
  return row[col];
}

class Query {
  private filters: Array<(r: Row) => boolean> = [];
  private lim = Infinity;
  private ord: { col: string; asc: boolean; nullsFirst: boolean } | null = null;
  private cols: Array<{ as: string; path: string }> | null = null;
  private rawCols = "";
  constructor(private table: string) {}
  select(cols?: string) {
    this.rawCols = cols ?? "*";
    if (cols && cols !== "*") {
      this.cols = cols.split(",").map((c) => {
        const t = c.trim();
        const i = t.indexOf(":");
        return i > 0 ? { as: t.slice(0, i), path: t.slice(i + 1) } : { as: t, path: t };
      });
    }
    return this;
  }
  eq(col: string, v: unknown) {
    this.filters.push((r) => field(r, col) === v);
    return this;
  }
  in(col: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(field(r, col)));
    return this;
  }
  not(col: string, op: string, v: unknown) {
    if (op === "is" && v === null) this.filters.push((r) => field(r, col) != null);
    return this;
  }
  gte(col: string, v: string) {
    this.filters.push((r) => String(field(r, col) ?? "") >= v);
    return this;
  }
  order(col: string, o?: { ascending?: boolean; nullsFirst?: boolean }) {
    const asc = o?.ascending !== false;
    this.ord = { col, asc, nullsFirst: o?.nullsFirst ?? !asc };
    return this;
  }
  limit(n: number) {
    this.lim = n;
    return this;
  }
  private off = 0;
  range(from: number, to: number) {
    this.off = from;
    this.lim = to - from + 1;
    return this;
  }
  is(col: string, v: null) {
    this.filters.push((r) => (field(r, col) ?? null) === v);
    return this;
  }
  then(res: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, rej?: (e: unknown) => unknown) {
    if (failing.has(this.table)) return Promise.resolve({ data: null, error: { message: `${this.table} is down` } }).then(res, rej);
    const hit = failingRead.find((f) => f.table === this.table && this.rawCols === f.cols);
    if (hit?.mode === "throw") return Promise.reject(new Error(`${this.table} socket hang up`)).then(res, rej);
    if (hit) return Promise.resolve({ data: null, error: { message: `${this.table} is down` } }).then(res, rej);
    let rows = (db[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)));
    if (this.ord) {
      const { col, asc, nullsFirst } = this.ord;
      rows = [...rows].sort((a, b) => {
        const x = field(a, col);
        const y = field(b, col);
        if (x == null || y == null) return x == null && y == null ? 0 : (x == null) === nullsFirst ? -1 : 1;
        return String(x).localeCompare(String(y)) * (asc ? 1 : -1);
      });
    }
    rows = rows.slice(this.off, this.off + this.lim);
    const cols = this.cols;
    const data = cols ? rows.map((r) => Object.fromEntries(cols.map((c) => [c.as, field(r, c.path)]))) : rows;
    return Promise.resolve({ data, error: null }).then(res, rej);
  }
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: (t: string) => new Query(t) }),
}));

const fbGet = vi.fn();
vi.mock("@/services/tools/meta-ads/_client", () => ({
  metaAdsCreds: async (t: string) => {
    if (t !== A) throw Object.assign(new Error("not connected"), { code: "meta_ads_not_connected" });
    return { access_token: "t", ad_account_id: "act_1" };
  },
  fbGet: (...a: unknown[]) => fbGet(...a),
}));
vi.mock("@/services/tools/meta-ads/daily_series", () => ({
  fetchMetaDailySeries: async () => ({
    truncated: false,
    rows: [
      { ad_set_id: "aw1", spend_usd: 210, conversions: 0, leads: 0 },
      { ad_set_id: "cv1", spend_usd: 90, conversions: 3, leads: 0 },
    ],
  }),
}));
vi.mock("@/services/tools/meta-ads/pixel_health", () => ({
  metaPixelHealthTool: { execute: async () => ({ overall_status: "healthy", pixels: [{ pixel_id: "px1", event_coverage: { Purchase: 12 } }] }) },
}));

const gadsSearch = vi.fn();
const linkedinAccounts = vi.fn();
const linkedinCampaigns = vi.fn();
const linkedinAnalytics = vi.fn();
const instagramInsights = vi.fn();
const tiktokVideos = vi.fn();
vi.mock("@/services/connectors/linkedin-ads/client", () => ({
  listLinkedInAdAccounts: (...a: unknown[]) => linkedinAccounts(...a),
  listLinkedInCampaigns: (...a: unknown[]) => linkedinCampaigns(...a),
  readLinkedInAdAnalytics: (...a: unknown[]) => linkedinAnalytics(...a),
}));
vi.mock("@/services/connectors/linkedin-ads/own-accounts", () => ({ ownLinkedinAccounts: async (_t: string, listed: unknown[]) => listed }));
vi.mock("@/services/tools/instagram/read_insights", () => ({ instagramReadInsightsTool: { execute: (...a: unknown[]) => instagramInsights(...a) } }));
vi.mock("@/services/connectors/tiktok/api", () => ({ queryVideoList: (...a: unknown[]) => tiktokVideos(...a) }));
vi.mock("@/services/tools/google-ads/_client", () => ({ gadsSearch: (...a: unknown[]) => gadsSearch(...a) }));
vi.mock("@/services/tools/google-ads/conversion_tracking_health", () => ({
  conversionTrackingHealthTool: { execute: async () => ({ overall_status: "healthy" }) },
}));

import {
  PAID_LABELS,
  NO_PER_ITEM_LABEL,
  NOTHING_PUBLISHED_LABEL,
  NO_NUMBERS_LABEL,
  JUDGE_ON_ITEMS_LABEL,
  EVIDENCE_CHAR_BUDGET,
  AD_EVIDENCE_CHAR_BUDGET,
  CUT_HOLD_WORDS,
  OVER_BUDGET_NOTE,
  adSetEvidence,
  budgetEvidence,
  campaignEvidence,
  cutHeldByEvidence,
  pauseEvidenceLine,
  evidenceSize,
  loadCgoEvidence,
  organicChannel,
  ownMoveLines,
  founderOwedLines,
  readFounderOwed,
  FOUNDER_OWED_MAX,
  type OwedAction,
  paidChannel,
  paidUnread,
  socialItems,
  creatorItems,
  emailItems,
  unsupportedLabel,
  CREATOR_POST_NO_NUMBERS,
  EMAIL_NO_NUMBERS,
  type CgoEvidence,
  type PaidLabel,
  type OrganicItem,
} from "../cgo-evidence";
import { composeGoalOwnerContext, channelCardCutHeld, CGO_CARD_CLASS } from "../goal-owner";
import type { AdObjectFacts } from "../unattended-policy";
import type { ActiveAdBudget } from "@/services/decisions/ad-budget";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const NOW = new Date("2026-09-28T12:00:00Z");

function facts(p: Partial<AdObjectFacts>): AdObjectFacts {
  return {
    id: "as1",
    conversionObjective: true,
    objective: "OFFSITE_CONVERSIONS",
    learning: false,
    daysSinceEdit: 20,
    lockDays: 7,
    spend7dUsd: 140,
    conversions7d: 3,
    targetCpaUsd: null,
    conversionEvent: "PURCHASE",
    conversionPixelId: "px1",
    conversionEventFiring: true,
    ...p,
  };
}

const AD_BUDGET: ActiveAdBudget = {
  id: "b-1",
  monthly_usd: 7500,
  month_cap_usd: 7500,
  spent_usd: 2000,
  held_usd: 500,
  creator_held_usd: 0,
  creator_spent_usd: 0,
  left_usd: 5000,
  daily_limit_usd: null,
  next_month_start: "2026-10-01",
  days_left: 3,
  days_in_month: 30,
};

function compose(evidence?: CgoEvidence, adBudget: ActiveAdBudget | null = null) {
  return composeGoalOwnerContext({
    adBudget,
    today: "2026-09-28",
    goals: [],
    channels: [],
    founder: { last_active_at: null, days_since_active: null, approved_14d: 0, rejected_14d: 0 },
    lastNote: null,
    cards: [],
    steps: [],
    agents: [],
    wake: { kind: "scheduled", reason: "daily_check", check_reasons: [], autopilot: true },
    evidence,
  });
}

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  failing.clear();
  failingRead.length = 0;
});

describe("paid evidence labels", () => {
  it("awareness, conversion, learning and broken tracking each get their own label in the review context", () => {
    const aware = adSetEvidence(facts({ id: "aw", conversionObjective: false, objective: "REACH", conversions7d: 0 }), "Awareness set", true);
    const conv = adSetEvidence(facts({ id: "cv" }), "Bookings set", true);
    const learning = adSetEvidence(facts({ id: "ln", learning: true }), "New set", true);
    const edited = adSetEvidence(facts({ id: "ed", daysSinceEdit: 2 }), "Edited set", true);
    const broken = adSetEvidence(facts({ id: "br", conversionEventFiring: false, conversions7d: 0 }), "Dead pixel set", true);
    const unverified = adSetEvidence(facts({ id: "uv", conversionEventFiring: null }), "Unverified", null);
    const ctx = compose({
      paid: [paidChannel("meta_ads", [
        campaignEvidence({ id: "c1", name: "Brand awareness", objective: "OUTCOME_AWARENESS" }, [aware]),
        campaignEvidence({ id: "c2", name: "Bookings", objective: "OUTCOME_SALES" }, [conv, learning, edited, broken, unverified]),
      ])],
      organic: [],
      own_moves: [],
    });
    const camps = ctx.evidence!.paid[0].campaigns!;
    expect(camps.find((c) => c.id === "c1")!.label).toBe(PAID_LABELS.awareness);
    const sets = new Map(camps.flatMap((c) => c.ad_sets).map((s) => [s.id, s.label]));
    expect(sets.get("aw")).toBe("not set up to optimise for conversions, so judged on its own objective");
    expect(sets.get("cv")).toBe(PAID_LABELS.conversion);
    expect(sets.get("ln")).toBe("too early to judge (learning)");
    expect(sets.get("ed")).toBe(PAID_LABELS.learning);
    expect(sets.get("br")).toBe("tracking broken, don't trust conversions");
    const c2 = camps.find((c) => c.id === "c2")!;
    expect(c2.label).toBe("mixed: see each ad set");
    expect(c2.ad_sets.length + (c2.more_ad_sets ?? 0)).toBe(5);
    expect(unverified.label).toBe(PAID_LABELS.trackingUnknown);
  });

  it("the platform saying tracking is broken wins over a firing event; awareness is still judged on reach", () => {
    expect(adSetEvidence(facts({}), null, false).label).toBe(PAID_LABELS.trackingBroken);
    expect(adSetEvidence(facts({ conversionObjective: false }), null, false).label).toBe(PAID_LABELS.awareness);
    expect(adSetEvidence(facts({ conversionObjective: null }), null, true).label).toBe(PAID_LABELS.purposeUnknown);
  });

  it("a failed or unconnected read says so, never an empty list", () => {
    expect(paidUnread("meta_ads", Object.assign(new Error("x"), { code: "meta_ads_not_connected" }))).toEqual({ channel_slug: "meta_ads", status: "not connected" });
    const e = paidUnread("google_ads", new Error("503 upstream"));
    expect(e.status).toBe("could not read");
    expect(e.campaigns).toBeUndefined();
  });
});

describe("organic evidence", () => {
  it("a channel with items is judged on them; one without a per-item record is insufficient", () => {
    const items: OrganicItem[] = [1, 2, 3, 4, 5, 6].map((i) => ({ first_line: `post ${i}`, url: `https://x.com/p/${i}`, published_on: `2026-09-2${i}`, metrics: "impressions 10" }));
    const x = organicChannel("x_organic", items);
    expect(x.evidence).toBe("per_item");
    expect(x.label).toBe(JUDGE_ON_ITEMS_LABEL);
    expect(x.items!.map((i) => i.first_line)).toEqual(["post 6", "post 5", "post 4", "post 3", "post 2"]);
    expect(x.more_items).toBe(1);
    expect(x.clock).toMatch(/^days/);

    const blog = organicChannel("blog", null);
    expect(blog).toMatchObject({ evidence: "insufficient", label: NO_PER_ITEM_LABEL });
    expect(blog.clock).toMatch(/^months/);
    expect(organicChannel("email_marketing", null).clock).toMatch(/^per send/);
    expect(organicChannel("linkedin_organic", [])).toMatchObject({ evidence: "insufficient", label: NOTHING_PUBLISHED_LABEL });
    expect(organicChannel("linkedin_organic", null, "boom")).toMatchObject({ evidence: "could not read" });
    const tt = organicChannel("tiktok_organic", [{ first_line: "clip", url: null, published_on: "2026-09-20", metrics: "not recorded (TikTok posts keep no per-post numbers here)" }]);
    expect(tt).toMatchObject({ evidence: "insufficient", label: NO_NUMBERS_LABEL });
    expect(tt.items).toHaveLength(1);
  });

  it("orders same-day email evidence by its full timestamp", () => {
    const items: OrganicItem[] = [
      { first_line: "single", url: null, published_on: "2026-10-08", metrics: EMAIL_NO_NUMBERS, as_of: "2026-10-08T09:00:00Z" },
      { first_line: "campaign", url: null, published_on: "2026-10-08", metrics: EMAIL_NO_NUMBERS, as_of: "2026-10-08T12:00:00Z" },
    ];
    expect(organicChannel("email_marketing", items).items?.map((item) => item.first_line)).toEqual(["campaign", "single"]);
  });

  it("X items merge the ledger and the account snapshots, latest numbers first", () => {
    const items = socialItems(
      [{ channel: "x", external_post_id: "1", external_url: "https://x.com/a/1", approved_payload_snapshot: { payload: { text: "Launch day\nmore" } }, metrics: null, metrics_read_at: null, scheduled_at: null, updated_at: "2026-09-25T10:00:00Z" }],
      [
        { external_post_id: "1", captured_on: "2026-09-26", posted_at: "2026-09-25T10:00:00Z", text: "Launch day", url: null, metrics: { public: { impression_count: 900, like_count: 12 } } },
        { external_post_id: "1", captured_on: "2026-09-27", posted_at: "2026-09-25T10:00:00Z", text: "Launch day", url: null, metrics: { public: { impression_count: 1200, like_count: 14 } } },
        { external_post_id: "9", captured_on: "2026-09-27", posted_at: "2026-09-26T08:00:00Z", text: "Written by hand", url: "https://x.com/a/9", metrics: {} },
      ],
      ["x"],
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ first_line: "Launch day more", url: "https://x.com/a/1", metrics: "impressions 1200, likes 14 (read 2026-09-27)" });
    expect(items[1]).toMatchObject({ first_line: "Written by hand", metrics: "not read yet" });
  });
});

describe("own moves by lineage", () => {
  it("shows cgo's dispatch -> run -> outcome and its own approvals; never a founder's or another agent's", () => {
    const lines = ownMoveLines({
      cards: [
        { id: "d1", status: "approved", emitted_at: "2026-09-21T09:00:00Z", body: { dispatched_by: "cgo", target_agent_slug: "meta_ads", intent: "test a $30/day ad set on the best creative" } },
        { id: "d2", status: "approved", emitted_at: "2026-09-22T09:00:00Z", body: { dispatched_by: "growth-lead", target_agent_slug: "meta_ads", intent: "not cgo's" } },
      ],
      runs: [{ id: "r1", status: "success", source_decision_id: "d1" }],
      actions: [{ id: "a1", run_id: "r1", channel_slug: "meta_ads", title: "New ad set $30/day", status: "acted", exec_status: "executed", approved_by_source: "cgo", status_at: "2026-09-21T12:00:00Z" }],
      decisions: [{ id: "m1", agent_run_id: "r1", decision_class: "meta_ads.update_ad_set_budget", status: "approved", approved_by_source: "cgo", approved_at: "2026-09-21T12:00:00Z" }],
      outcomes: [
        { decision_id: "m1", reconcile_status: "measured", delta_metrics: { spend: 40, conversions: 2 }, measured_at: "2026-09-27T00:00:00Z" },
        { decision_id: "f1", reconcile_status: "measured", delta_metrics: { spend: -99 }, measured_at: "2026-09-27T00:00:00Z" },
      ],
      approvedActions: [
        { id: "a1", run_id: "r1", channel_slug: "meta_ads", title: "dup of a1", status: "acted", exec_status: "executed", approved_by_source: "cgo", status_at: "2026-09-21T12:00:00Z" },
        { id: "a2", run_id: "rX", channel_slug: "google_ads", title: "Raise budget", status: "acted", exec_status: "failed", approved_by_source: "cgo", status_at: "2026-09-24T12:00:00Z" },
        { id: "a3", run_id: "rX", channel_slug: "google_ads", title: "Founder clicked", status: "acted", exec_status: "executed", approved_by_source: null, status_at: "2026-09-25T12:00:00Z" },
      ],
      approvedDecisions: [
        { id: "f1", agent_run_id: "rY", decision_class: "meta_ads.set_status", status: "approved", approved_by_source: null, approved_at: "2026-09-26T12:00:00Z" },
      ],
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('Sep 24: cgo approved google_ads card "Raise budget" -> failed; no outcome record for channel cards');
    expect(lines[1]).toContain("Sep 21: cgo asked meta_ads to test a $30/day ad set");
    expect(lines[1]).toContain("run success");
    expect(lines[1]).toContain("meta_ads.update_ad_set_budget: measured Sep 27: spend +$40, conversions +2");
    const all = lines.join("\n");
    expect(all).not.toContain("not cgo's");
    expect(all).not.toContain("Founder clicked");
    expect(all).not.toContain("-$99");
  });

  it("an approved move with no measurement yet says not yet measured", () => {
    const lines = ownMoveLines({
      cards: [{ id: "d1", status: "approved", emitted_at: "2026-09-21T09:00:00Z", body: { dispatched_by: "cgo", target_agent_slug: "google_ads", intent: "raise the search budget" } }],
      runs: [{ id: "r1", status: "success", source_decision_id: "d1" }],
      actions: [],
      decisions: [{ id: "m1", agent_run_id: "r1", decision_class: "google_ads.update_campaign_budget", status: "approved", approved_by_source: "cgo", approved_at: null }],
      outcomes: [],
      approvedActions: [],
      approvedDecisions: [],
    });
    expect(lines[0]).toContain("not yet measured");
  });

  it("names the spend controller, not cgo, on the controller's own orders, with its reason", () => {
    const lines = ownMoveLines({
      cards: [],
      runs: [],
      actions: [],
      decisions: [],
      outcomes: [],
      approvedActions: [
        {
          id: "c1",
          run_id: "anchor",
          channel_slug: "meta_ads",
          title: "Raise Weekend Deep Clean to $80/day",
          status: "acted",
          exec_status: "executed",
          approved_by_source: "cgo",
          status_at: "2026-10-02T12:42:00Z",
          origin: "ad_spend_controller",
          why: "Autopilot budget is behind pace: $900/day is needed live and $400/day is.",
        },
        { id: "c2", run_id: "rX", channel_slug: "meta_ads", title: "Pause Trial Broad", status: "acted", exec_status: "executed", approved_by_source: "cgo", status_at: "2026-10-01T12:00:00Z" },
      ],
      approvedDecisions: [],
    });
    expect(lines[0]).toBe('Oct 2: Zavi\'s spend controller (not you) ordered meta_ads "Raise Weekend Deep Clean to $80/day" -> executed; why: Autopilot budget is behind pace: $900/day is needed live and $400/day is.');
    expect(lines[1]).toBe('Oct 1: cgo approved meta_ads card "Pause Trial Broad" -> executed; no outcome record for channel cards');
  });
});

describe("waiting_on_founder: person-only steps with no recorded completion", () => {
  const NOW = new Date("2026-10-07T12:00:00Z");
  const act = (id: string, run: string, title: string, status: string, over: Partial<OwedAction> = {}): OwedAction => ({
    id, run_id: run, channel_slug: "email_marketing", title, status, status_at: "2026-10-07T09:00:00Z", proposed_at: "2026-10-02T01:26:00Z", ...over,
  });
  const intentByRun = new Map([["r1", "Draft one short email from Ravi to hosts who cancelled"], ["r2", "Draft the host-cancel rebook email"]]);

  it("open drafts carry their age; closed ones say Zavi recorded no completion (not that nobody did it); each line has its stable id", () => {
    const { lines, more } = founderOwedLines({ actions: [
      act("a1", "r1", "Fill the address and calendar link, then send the host calendar email", "pending"),
      act("a2", "r2", "Fill the postal address and paste the host-cancel rebook email", "stale", { proposed_at: "2026-10-02T05:27:00Z" }),
    ], intentByRun }, NOW);
    expect(more).toBe(0);
    expect(lines[0]).toMatch(/^\[a1\] Oct 2 email_marketing: .*host calendar email.* waiting on the founder 5 days$/);
    expect(lines[1]).toMatch(/^\[a2\] .* closed Oct 7 with no completion recorded in Zavi$/);
  });
  it("waiting steps first (oldest first), then closed ones (most recently closed first)", () => {
    const { lines } = founderOwedLines({ actions: [
      act("closed-old", "r1", "c1", "stale", { proposed_at: "2026-09-28T00:00:00Z", status_at: "2026-09-28T01:00:00Z" }),
      act("closed-new", "r1", "c2", "stale", { proposed_at: "2026-10-02T00:00:00Z", status_at: "2026-10-07T09:00:00Z" }),
      act("open-new", "r2", "o2", "pending", { proposed_at: "2026-10-06T00:00:00Z" }),
      act("open-old", "r2", "o1", "pending", { proposed_at: "2026-10-01T00:00:00Z" }),
    ], intentByRun }, NOW);
    expect(lines.map((l) => l.slice(1, l.indexOf("]")))).toEqual(["open-old", "open-new", "closed-new", "closed-old"]);
  });
  it("oldest unresolved first, capped, with an overflow count", () => {
    const many = Array.from({ length: 8 }, (_, i) => act(`m${i}`, "r1", `Draft ${i}`, "pending", { proposed_at: `2026-10-0${i + 1}T00:00:00Z` }));
    const { lines, more } = founderOwedLines({ actions: many.reverse(), intentByRun }, NOW);
    expect(lines).toHaveLength(FOUNDER_OWED_MAX);
    expect(lines[0]).toContain("[m0]");
    expect(more).toBe(3);
  });
  it("superseded (replaced by a newer version) and non-cgo runs are not owed; a prior ask is shown", () => {
    const { lines } = founderOwedLines({
      actions: [
        act("s1", "r1", "old version", "stale", { note: "Replaced by a newer version: x" }),
        act("s2", "r1", "had a successor", "displaced"),
        act("f1", "r-foreign", "foreign draft", "pending"),
        act("k1", "r2", "still owed", "pending"),
      ],
      intentByRun,
      successors: new Set(["s2"]),
      askedOn: new Map([["k1", "2026-10-06T10:00:00Z"]]),
    }, NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[k1]");
    expect(lines[0]).toContain("you asked Oct 6");
  });
  it("a card closed because cgo paused its channel is not owed", () => {
    const { lines } = founderOwedLines({
      actions: [act("p1", "r1", "paused", "stale", { note: "Closed when Zavi paused this channel: x" }), act("k1", "r2", "still owed", "pending")],
      intentByRun,
    }, NOW);
    expect(lines.map((l) => l.slice(1, l.indexOf("]")))).toEqual(["k1"]);
  });
  it("the size budget never cuts it", () => {
    const owed = ["[a1] Oct 2 email_marketing: x -> waiting on the founder 5 days"];
    const big = { paid: [], organic: [], own_moves: Array.from({ length: 10 }, (_, i) => "x".repeat(400) + i), waiting_on_founder: owed };
    expect(budgetEvidence(big as never, 1000).waiting_on_founder).toEqual(owed);
  });
});

describe("readFounderOwed: read on its own, not through the own_moves window", () => {
  beforeEach(() => {
    for (const t of ["agent_runs", "channel_actions", "decisions", "cgo_questions"]) db[t] = [];
  });
  it("REVIEW CASE: an unfinished host email survives 20 newer cgo moves", async () => {
    const at = (d: number) => new Date(Date.UTC(2026, 9, 1) + d * 3_600_000).toISOString();
    const runs = Array.from({ length: 21 }, (_, i) => ({ id: `run-${i}`, tenant_id: A, enqueued_at: at(i), payload: { dispatched_by: "cgo", source_decision_id: `card-${i}` } }));
    db.agent_runs = runs;
    db.decisions = runs.map((r, i) => ({ id: `card-${i}`, tenant_id: A, body: { dispatched_by: "cgo", intent: i === 0 ? "Draft the host calendar email" : `ad move ${i}` } }));
    db.channel_actions = [
      { id: "host-email", tenant_id: A, run_id: "run-0", channel_slug: "email_marketing", title: "Send the host calendar email", status: "pending", exec_class: null, proposed_at: at(0), status_at: at(0), note: null, repeat_of: null },
      ...runs.slice(1).map((r, i) => ({ id: `ad-${i}`, tenant_id: A, run_id: r.id, channel_slug: "meta_ads", title: "Raise budget", status: "acted", exec_class: "meta_ads.update_ad_set_budget", proposed_at: r.enqueued_at, status_at: r.enqueued_at, note: null, repeat_of: null })),
    ];
    db.cgo_questions = [{ tenant_id: A, topic_key: "action:host-email", status: "open", asked_at: "2026-10-06T00:00:00Z" }];
    const r = await readFounderOwed(A, new Date("2026-10-07T12:00:00Z"));
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain("[host-email]");
    expect(r.lines[0]).toContain("you asked Oct 6");
  });
  it("an ask closed outside the re-ask window no longer reads as 'you asked'", async () => {
    db.agent_runs = [{ id: "run-0", tenant_id: A, enqueued_at: "2026-09-10T00:00:00Z", payload: { dispatched_by: "cgo", source_decision_id: "card-0" } }];
    db.decisions = [{ id: "card-0", tenant_id: A, body: { dispatched_by: "cgo", intent: "Draft the host email" } }];
    db.channel_actions = [{ id: "e1", tenant_id: A, run_id: "run-0", channel_slug: "email_marketing", title: "Send it", status: "pending", exec_class: null, proposed_at: "2026-09-10T00:00:00Z", status_at: "2026-09-10T00:00:00Z", note: null, repeat_of: null }];
    db.cgo_questions = [{ tenant_id: A, topic_key: "action:e1", status: "expired", asked_at: "2026-09-12T00:00:00Z", expires_at: "2026-09-15T00:00:00Z", answered_at: null }];
    const r = await readFounderOwed(A, new Date("2026-10-07T12:00:00Z"));
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).not.toContain("you asked");
  });
  it("another tenant's runs and cards never appear", async () => {
    db.agent_runs = [{ id: "run-b", tenant_id: B, enqueued_at: "2026-10-05T00:00:00Z", payload: { dispatched_by: "cgo", source_decision_id: "card-b" } }];
    db.decisions = [{ id: "card-b", tenant_id: B, body: { dispatched_by: "cgo", intent: "theirs" } }];
    db.channel_actions = [{ id: "b-draft", tenant_id: B, run_id: "run-b", channel_slug: "blog", title: "theirs", status: "pending", exec_class: null, proposed_at: "2026-10-05T00:00:00Z" }];
    expect(await readFounderOwed(A, new Date("2026-10-07T12:00:00Z"))).toEqual({ lines: [], more: 0 });
  });
});

describe("size budget", () => {
  function big(): CgoEvidence {
    const sets = (c: number) => [0, 1, 2, 3].map((i) => adSetEvidence(facts({ id: `as${c}-${i}`, spend7dUsd: 100 - i }), `Ad set number ${i} of campaign ${c} with a long name`, true));
    const items = (ch: string) => [0, 1, 2, 3, 4].map((i) => ({ first_line: `${ch} post ${i} `.repeat(6).slice(0, 99), url: `https://example.com/${ch}/${i}`, published_on: `2026-09-${10 + i}`, metrics: "impressions 1200, likes 14, replies 3, reposts 2 (read 2026-09-27)" }));
    return {
      paid: [
        paidChannel("meta_ads", [0, 1, 2, 3, 4, 5, 6, 7].map((c) => campaignEvidence({ id: `c${c}`, name: `Campaign ${c} long descriptive name`, objective: "OUTCOME_SALES" }, sets(c)))),
        paidChannel("google_ads", [0, 1, 2].map((c) => campaignEvidence({ id: `g${c}`, name: `Search ${c}`, objective: "SEARCH/MAXIMIZE_CONVERSIONS" }, sets(c).slice(0, 1)))),
      ],
      organic: ["x_organic", "linkedin_organic", "instagram_organic", "reddit_organic"].map((s) => organicChannel(s, items(s))).concat([organicChannel("blog", null)]),
      own_moves: Array.from({ length: 10 }, (_, i) => `Sep ${10 + i}: asked meta_ads to do a fairly long described thing number ${i} -> run success; 2 cards`),
    };
  }

  it("cuts lowest-value items first, stays under the budget and says what it cut", () => {
    const e = big();
    expect(evidenceSize(e)).toBeGreaterThan(EVIDENCE_CHAR_BUDGET);
    const cut = budgetEvidence(e);
    expect(evidenceSize(cut)).toBeLessThanOrEqual(EVIDENCE_CHAR_BUDGET);
    expect(cut.cut?.left_out["paid.meta_ads.ad_sets"]).toBeGreaterThan(0);
    expect(cut.paid.map((p) => p.channel_slug)).toEqual(["meta_ads", "google_ads"]);
    expect(cut.organic.find((o) => o.channel_slug === "blog")!.label).toBe(NO_PER_ITEM_LABEL);
    for (const c of cut.paid[0].campaigns ?? []) expect(c.ad_sets[0].id).toMatch(/-0$/);
    expect(evidenceSize(compose(e).evidence!)).toBeLessThanOrEqual(EVIDENCE_CHAR_BUDGET);
  });

  it("must-catch: while cgo runs the ads the pack keeps every campaign (20,000) and records the uncut size", () => {
    const e = big();
    const full = evidenceSize(e);
    expect(full).toBeGreaterThan(EVIDENCE_CHAR_BUDGET);
    expect(full).toBeLessThanOrEqual(AD_EVIDENCE_CHAR_BUDGET);
    expect(AD_EVIDENCE_CHAR_BUDGET).toBe(20000);
    const ads = compose(e, AD_BUDGET).evidence!;
    expect(ads.paid[0].campaigns).toHaveLength(8);
    expect(ads.paid[1].campaigns).toHaveLength(3);
    expect(ads).not.toHaveProperty("cut");
    const plain = compose(e).evidence!;
    expect(evidenceSize(plain)).toBeLessThanOrEqual(EVIDENCE_CHAR_BUDGET);
    expect(plain.cut?.full_chars).toBe(full);
  });

  it("full_chars is measured before the first cut and kept on a second pass", () => {
    const e = big();
    const full = evidenceSize(e);
    const once = budgetEvidence(e);
    expect(once.cut?.full_chars).toBe(full);
    const twice = budgetEvidence(once);
    expect(twice.cut?.full_chars).toBe(full);
    expect(twice).toEqual(once);
    const huge = budgetEvidence(e, 3000);
    expect(huge.cut?.full_chars).toBe(full);
  });

  it("a small section is untouched", () => {
    const e: CgoEvidence = { paid: [], organic: [organicChannel("blog", null)], own_moves: [] };
    expect(budgetEvidence(e)).toEqual(e);
  });
});

describe("reads (real tenantClient, two tenants)", () => {
  function seed() {
    db.social_posts = [
      { tenant_id: A, channel: "x", status: "published", external_post_id: "a1", external_url: "https://x.com/a/1", approved_payload_snapshot: { payload: { text: "Tenant A post" } }, metrics: { public: { impression_count: 50 } }, metrics_read_at: "2026-09-27T00:00:00Z", scheduled_at: null, updated_at: "2026-09-26T00:00:00Z" },
      { tenant_id: B, channel: "x", status: "published", external_post_id: "b1", external_url: "https://x.com/b/1", approved_payload_snapshot: { payload: { text: "SECRET tenant B post" } }, metrics: null, metrics_read_at: null, scheduled_at: null, updated_at: "2026-09-27T00:00:00Z" },
      { tenant_id: A, channel: "x", status: "failed", external_post_id: null, external_url: null, approved_payload_snapshot: { payload: { text: "never published" } }, metrics: null, metrics_read_at: null, scheduled_at: null, updated_at: "2026-09-27T00:00:00Z" },
    ];
    db.social_post_metric_snapshots = [
      { tenant_id: B, channel: "x", external_post_id: "b9", captured_on: "2026-09-27", posted_at: "2026-09-27T00:00:00Z", text: "SECRET tenant B hand post", url: null, metrics: {} },
    ];
    db.decisions = [
      { id: "dB", tenant_id: B, decision_class: CGO_CARD_CLASS, status: "approved", emitted_at: "2026-09-25T00:00:00Z", body: { dispatched_by: "cgo", target_agent_slug: "meta_ads", intent: "SECRET tenant B move" } },
      { id: "dA", tenant_id: A, decision_class: CGO_CARD_CLASS, status: "proposed", emitted_at: "2026-09-26T00:00:00Z", body: { dispatched_by: "cgo", target_agent_slug: "research", intent: "find the top three competitor offers" } },
    ];
    db.channel_actions = [];
    db.agent_runs = [];
    db.action_outcomes = [];
  }

  it("another tenant's posts and moves never appear", async () => {
    seed();
    const e = await loadCgoEvidence({ tenant_id: A, channelSlugs: ["x_organic", "blog"], now: NOW, cardClass: CGO_CARD_CLASS });
    const text = JSON.stringify(e);
    expect(text).not.toContain("SECRET");
    const x = e.organic.find((o) => o.channel_slug === "x_organic")!;
    expect(x.items!.map((i) => i.first_line)).toEqual(["Tenant A post"]);
    expect(e.organic.find((o) => o.channel_slug === "blog")!.label).toBe(NO_PER_ITEM_LABEL);
    expect(e.own_moves).toEqual(["Sep 26: cgo asked research to find the top three competitor offers -> waiting for the founder"]);
  });

  it("failed reads say could not read, never 0 or nothing", async () => {
    seed();
    failing.add("social_posts");
    failing.add("decisions");
    linkedinAccounts.mockRejectedValueOnce(Object.assign(new Error("not connected"), { code: "linkedin_ads_not_connected" }));
    const e = await loadCgoEvidence({ tenant_id: A, channelSlugs: ["x_organic", "linkedin_ads"], now: NOW, cardClass: CGO_CARD_CLASS });
    expect(e.organic[0]).toMatchObject({ channel_slug: "x_organic", evidence: "could not read" });
    expect(e.organic[0].items).toBeUndefined();
    expect(e.own_moves).toMatchObject({ status: "could not read" });
    expect(e.paid).toEqual([{ channel_slug: "linkedin_ads", status: "not connected" }]);
  });

  it("Meta: live ad sets grouped by campaign, each judged on what it is for", async () => {
    fbGet.mockResolvedValueOnce({
      data: [
        { id: "aw1", name: "Reach LA", optimization_goal: "REACH", updated_time: "2026-09-01T00:00:00Z", campaign: { id: "c1", name: "Awareness", objective: "OUTCOME_AWARENESS" } },
        { id: "cv1", name: "Bookings", optimization_goal: "OFFSITE_CONVERSIONS", updated_time: "2026-09-01T00:00:00Z", promoted_object: { custom_event_type: "PURCHASE", pixel_id: "px1" }, campaign: { id: "c2", name: "Sales", objective: "OUTCOME_SALES" } },
        { id: "ln1", name: "Fresh", optimization_goal: "OFFSITE_CONVERSIONS", learning_stage_info: { status: "LEARNING" }, updated_time: "2026-09-27T00:00:00Z", promoted_object: { custom_event_type: "PURCHASE", pixel_id: "px1" }, campaign: { id: "c2", name: "Sales", objective: "OUTCOME_SALES" } },
      ],
    });
    const e = await loadCgoEvidence({ tenant_id: A, channelSlugs: ["meta_ads"], now: NOW, cardClass: CGO_CARD_CLASS });
    const meta = e.paid[0];
    expect(meta.status).toBe("read");
    expect(fbGet.mock.calls[0][1]).toBe("act_1/adsets");
    const c1 = meta.campaigns!.find((c) => c.id === "c1")!;
    expect(c1.label).toBe(PAID_LABELS.awareness);
    expect(c1.ad_sets[0]).toMatchObject({ spend_7d_usd: 210, conversions_7d: 0 });
    const c2 = meta.campaigns!.find((c) => c.id === "c2")!;
    expect(new Map(c2.ad_sets.map((s) => [s.id, s.label]))).toEqual(new Map([["cv1", PAID_LABELS.conversion], ["ln1", PAID_LABELS.learning]]));
    expect(c2.ad_sets.find((s) => s.id === "cv1")!.tracking).toBe("ok");
  });

  it("Meta not connected says not connected", async () => {
    const e = await loadCgoEvidence({ tenant_id: B, channelSlugs: ["meta_ads"], now: NOW, cardClass: CGO_CARD_CLASS });
    expect(e.paid).toEqual([{ channel_slug: "meta_ads", status: "not connected" }]);
  });

  it("a busy channel never crowds another out: each channel is read on its own", async () => {
    seed();
    for (let i = 0; i < 100; i++) {
      db.social_posts.push({ tenant_id: A, channel: "x", status: "published", external_post_id: `x${i}`, external_url: null, approved_payload_snapshot: { payload: { text: `x ${i}` } }, metrics: null, metrics_read_at: null, scheduled_at: null, updated_at: `2026-09-27T${String(i % 24).padStart(2, "0")}:00:00Z` });
    }
    db.social_posts.push({ tenant_id: A, channel: "linkedin", status: "published", external_post_id: "a1", external_url: "https://linkedin.com/p/1", approved_payload_snapshot: { payload: { text: "LinkedIn post" } }, metrics: { impressions: 40 }, metrics_read_at: null, scheduled_at: null, updated_at: "2026-09-01T00:00:00Z" });
    db.social_post_metric_snapshots.push({ tenant_id: A, channel: "x", external_post_id: "a1", captured_on: "2026-09-27", posted_at: "2026-09-27T00:00:00Z", text: "an X post", url: null, metrics: { public: { impression_count: 99999 } } });
    const e = await loadCgoEvidence({ tenant_id: A, channelSlugs: ["x_organic", "linkedin_organic"], now: NOW, cardClass: CGO_CARD_CLASS });
    const li = e.organic.find((o) => o.channel_slug === "linkedin_organic")!;
    expect(li.evidence).toBe("per_item");
    expect(li.items![0]).toMatchObject({ first_line: "LinkedIn post", metrics: "impressions 40" });
  });

  it("Google: biggest spenders first, the rest counted, an unreadable campaign said", async () => {
    const enabled = Array.from({ length: 9 }, (_, i) => ({ campaign: { id: String(100 + i), name: `C${i}` } }));
    gadsSearch.mockImplementation(async (_t: string, q: string) => {
      if (q.startsWith("SELECT campaign.id, campaign.name FROM campaign")) return enabled;
      if (q.includes("ORDER BY metrics.cost_micros")) return [{ campaign: { id: "108" }, metrics: { costMicros: "90000000" } }, { campaign: { id: "107" }, metrics: { costMicros: "50000000" } }];
      const id = /campaign\.id = (\d+)/.exec(q)?.[1];
      if (id === "107") return [];
      return [{ campaign: { resourceName: `customers/1/campaigns/${id}`, advertisingChannelType: "SEARCH", biddingStrategyType: "MAXIMIZE_CONVERSIONS" }, metrics: { costMicros: "10000000", conversions: 1 } }];
    });
    const e = await loadCgoEvidence({ tenant_id: A, channelSlugs: ["google_ads"], now: NOW, cardClass: CGO_CARD_CLASS });
    const g = e.paid[0];
    expect(g.status).toBe("read");
    expect(g.campaigns![0].id).toBe("108");
    expect(g.campaigns!.map((c) => c.id)).not.toContain("107");
    expect(g.more_campaigns).toBe(3);
    expect(g.reason).toBe("1 campaign could not read");
    expect(g.campaigns![0].label).toBe(PAID_LABELS.conversion);
  });
});

describe("cutHeldByEvidence (S4)", () => {
  const set = (id: string, name: string, label: PaidLabel) => ({ id, name, goal: null, learning: null, days_since_edit: 20, spend_7d_usd: 140, conversions_7d: 0, tracking: "ok" as const, label });
  const ev = {
    paid: [
      {
        channel_slug: "meta_ads",
        status: "read" as const,
        campaigns: [
          { id: "111", name: "Upcar - All States - Awareness", objective: "OUTCOME_AWARENESS", label: PAID_LABELS.awareness, ad_sets: [set("112", "All States - Reach", PAID_LABELS.awareness)] },
          { id: "221", name: "Hosts - Phoenix", objective: "OUTCOME_LEADS", label: PAID_LABELS.learning, ad_sets: [set("222", "Phoenix - Leads", PAID_LABELS.learning)] },
          { id: "331", name: "Guests - Bookings", objective: "OUTCOME_SALES", label: PAID_LABELS.trackingBroken, ad_sets: [set("332", "Bookings - CA", PAID_LABELS.trackingBroken)] },
          { id: "441", name: "Hosts - SF", objective: "OUTCOME_LEADS", label: PAID_LABELS.conversion, ad_sets: [set("442", "SF - Leads", PAID_LABELS.conversion)] },
          { id: "551", name: "Newsletter - Leads", objective: "OUTCOME_LEADS", label: PAID_LABELS.notGoal, ad_sets: [set("552", "Newsletter signups", PAID_LABELS.notGoal)] },
        ],
      },
      { channel_slug: "google_ads", status: "could not read" as const },
    ],
    organic: [
      { channel_slug: "blog", clock: "months", evidence: "insufficient" as const, label: NO_PER_ITEM_LABEL },
      { channel_slug: "x_organic", clock: "days", evidence: "per_item" as const, label: JUDGE_ON_ITEMS_LABEL },
    ],
    own_moves: [],
  };
  const held = (target: string, intent: string, why = "") => cutHeldByEvidence({ target, intent, why, evidence: ev })?.reasons ?? null;

  it("paid: learning holds any cut; reach, broken tracking hold a conversions cut", () => {
    expect(held("meta_ads", 'Pause "Upcar - All States - Awareness": zero bookings in 7 days.')).toEqual(["judged_on_reach"]);
    expect(held("meta_ads", 'Cut "Phoenix - Leads" in half.')).toEqual(["too_early_learning"]);
    expect(held("meta_ads", 'Lower "Bookings - CA": $320 and no purchases, CPA is infinite.')).toEqual(["tracking_not_trusted"]);
    expect(held("meta_ads", 'Lower "Upcar - All States - Awareness": frequency is 9, reach has flattened.')).toBeNull();
    expect(held("meta_ads", 'Lower "SF - Leads": no leads for $140, CPA past target.')).toBeNull();
  });

  it("goal match: brand search holds any cut; results that are not the goal hold a conversions cut", () => {
    const g = {
      ...ev,
      paid: [
        ev.paid[0],
        {
          channel_slug: "google_ads",
          status: "read" as const,
          campaigns: [{ id: "901", name: "Acme | Brand Search", objective: "SEARCH/MAXIMIZE_CONVERSIONS", label: PAID_LABELS.brand, ad_sets: [set("901", "Acme | Brand Search", PAID_LABELS.brand)] }],
        },
      ],
    };
    const heldG = (intent: string, why = "") => cutHeldByEvidence({ target: "google_ads", intent, why, evidence: g })?.reasons ?? null;
    expect(cutHeldByEvidence({ target: "google_ads", intent: "Halve a search campaign that booked nothing in 7 days: Acme | Brand Search", evidence: g, basisUnknown: true })?.reasons).toEqual(["brand_campaign"]);
    expect(heldG('Halve "Acme | Brand Search": $168 in 7 days and 0 conversions.')).toEqual(["brand_campaign"]);
    expect(heldG('Lower "Acme | Brand Search" to $10/day: impression share is 100%.')).toEqual(["brand_campaign"]);
    expect(cutHeldByEvidence({ target: "google_ads", intent: 'Cut "Acme | Brand Search" in half', evidence: g, basisUnknown: true })?.reasons).toEqual(["brand_campaign"]);
    expect(held("meta_ads", 'Pause "Newsletter signups": $900 and the cost per lead is twice the account.')).toEqual(["results_not_goal"]);
    expect(held("meta_ads", 'Lower "Newsletter signups": frequency is 9.')).toBeNull();
  });

  it("not a cut, or a channel it cannot read", () => {
    expect(held("meta_ads", 'Raise "Phoenix - Leads" to $30/day.')).toBeNull();
    expect(held("google_ads", "Pause Search - Hosts: no sign-ups.")).toEqual(["evidence_unreadable"]);
    expect(cutHeldByEvidence({ target: "meta_ads", intent: "Pause the awareness campaign", evidence: null })?.reasons).toEqual(["evidence_unreadable"]);
    expect(held("meta_ads", "Pause whatever underperforms this week.")).toEqual(["object_not_in_evidence"]);
    expect(held("meta_ads", 'Pause "Hosts - Dallas": no leads.')).toEqual(["object_not_in_evidence"]);
  });

  it("organic: a cut needs per-item numbers; directing drafts is never held", () => {
    expect(held("blog", "Stop the weekly blog post.")).toEqual(["insufficient_evidence"]);
    expect(held("x_organic", "Stop the thread series.")).toBeNull();
    expect(held("blog", "Draft two posts on host insurance.")).toBeNull();
  });

  it("R1: a held pause's numbers for the founder", () => {
    const o = { id: "1", conversionObjective: false, objective: "REACH", learning: false, daysSinceEdit: 30, lockDays: 7, spend7dUsd: 140, conversions7d: 0, targetCpaUsd: null };
    expect(pauseEvidenceLine([o], true)).toBe("Last 7 days: $140 spent, 0 conversions; not set up to optimise for conversions, so judged on its own objective.");
    expect(pauseEvidenceLine([{ ...o, spend7dUsd: null }], true)).toBeNull();
    expect(pauseEvidenceLine(null, true)).toBeNull();
  });
});

describe("outcome stores: ugc, email, sms", () => {
  const order = (id: string, tenant: string, kind: string, created_at = "2026-09-20T00:00:00Z") => ({ id, tenant_id: tenant, package_snapshot: { kind }, created_at });
  const pub = (tenant: string, order_id: string, o: Record<string, unknown>) => ({
    tenant_id: tenant, order_id, platform: "tiktok", account: "@maker", post_url: "https://tiktok.com/@maker/video/1", status: "published",
    published_at: "2026-09-22T00:00:00Z", verification: "verified", verified_at: "2026-09-23T00:00:00Z", created_at: "2026-09-22T00:00:00Z", ...o,
  });
  const send = (id: string, tenant: string, run: string | null, o: Record<string, unknown>) => ({
    id, tenant_id: tenant, agent_run_id: run, decision_class: "outbound.send", status: "acted", body: { subject: `Subject ${id}` },
    dispatched_at: "2026-09-25T00:00:00Z", dispatch_error: null, emitted_at: "2026-09-24T00:00:00Z", ...o,
  });

  function seed() {
    db.creator_orders = [order("oU", A, "ugc_video"), order("oI", A, "audience_post"), order("oB", B, "ugc_video")];
    db.creator_publications = [
      pub(A, "oU", { verification: "failed", verified_at: "2026-09-23T00:00:00Z", platform: "youtube" }),
      pub(A, "oU", { status: "scheduled", post_url: null, published_at: null, scheduled_for: "2026-10-01T00:00:00Z" }),
      pub(A, "oI", { platform: "instagram", verification: "manual", verified_at: null }),
      pub(B, "oB", { account: "SECRET-B" }),
    ];
    db.creator_library_assets = [
      { tenant_id: A, order_id: "oU", meta_ad_id: "ad1", meta_auto_paused_at: null, metrics: { spend_usd: 40, impressions: 5200, clicks: 61 }, metrics_read_at: "2026-09-27T04:00:00Z", created_at: "2026-09-21T00:00:00Z" },
      { tenant_id: A, order_id: "oU", meta_ad_id: null, meta_auto_paused_at: null, metrics: null, metrics_read_at: null, created_at: "2026-09-21T00:00:00Z" },
      { tenant_id: B, order_id: "oB", meta_ad_id: "adB", meta_auto_paused_at: null, metrics: { impressions: 99999 }, metrics_read_at: "2026-09-27T04:00:00Z", created_at: "2026-09-21T00:00:00Z" },
    ];
    db.agent_runs = [
      { id: "rEm", tenant_id: A, agent_slug: "email_marketing", enqueued_at: "2026-09-24T00:00:00Z" },
      { id: "rOp", tenant_id: A, agent_slug: "operator" },
      { id: "rEmB", tenant_id: B, agent_slug: "email_marketing" },
    ];
    db.decisions = [
      send("sent", A, "rEm", {}),
      send("bounced", A, "rEm", { status: "dispatch_failed", dispatch_error: "comms safety net blocked send: suppressed" }),
      send("waiting", A, "rEm", { status: "proposed", dispatched_at: null }),
      send("approved", A, "rEm", { status: "approved", dispatched_at: null }),
      send("bulk", A, "rEm", { decision_class: "bulk_outbound.send", status: "dispatch_failed", dispatch_error: "gated" }),
      send("operator", A, "rOp", {}),
      send("SECRETB", B, "rEmB", {}),
    ];
    db.social_posts = [];
    db.channel_actions = [];
    db.action_outcomes = [];
  }

  const load = (tenant: string) => loadCgoEvidence({ tenant_id: tenant, channelSlugs: ["ugc", "email_marketing", "sms"], now: NOW, cardClass: CGO_CARD_CLASS });
  const ch = (e: CgoEvidence, slug: string) => e.organic.find((o) => o.channel_slug === slug)!;

  it("ugc is judged on the creator video's own Meta numbers; an unconfirmed post keeps its real outcome and no numbers", async () => {
    seed();
    const ugc = ch(await load(A), "ugc");
    expect(ugc.evidence).toBe("per_item");
    expect(ugc.items).toHaveLength(2);
    const ad = ugc.items!.find((i) => i.source === "Meta ads")!;
    expect(ad).toMatchObject({ outcome: "running as a Meta ad", metrics: "impressions 5200, clicks 61, spend usd 40 (read 2026-09-27)", as_of: "2026-09-27T04:00:00Z" });
    const post = ugc.items!.find((i) => i.source === "creator publication log")!;
    expect(post).toMatchObject({ outcome: "not found on youtube, publishing unconfirmed", metrics: CREATOR_POST_NO_NUMBERS, as_of: "2026-09-23T00:00:00Z" });
  });

  it("email counts only this channel's dispatched sends: a proposal, an approval waiting to send, a gated bulk send and another agent's mail are not delivery", async () => {
    seed();
    const em = ch(await load(A), "email_marketing");
    expect(em.items!.map((i) => i.first_line).sort()).toEqual(["Subject bounced", "Subject sent"]);
    expect(em.items!.find((i) => i.first_line === "Subject sent")).toMatchObject({ outcome: "accepted by the email provider, delivery not confirmed", metrics: EMAIL_NO_NUMBERS, as_of: "2026-09-25T00:00:00Z" });
    expect(em.items!.find((i) => i.first_line === "Subject bounced")!.outcome).toMatch(/^not sent: comms safety net blocked/);
    expect(em).toMatchObject({ evidence: "insufficient", label: NO_NUMBERS_LABEL });
  });

  it("email also counts list sends: an approved campaign in the founder's tool and Zavi's own bulk send, never one held for the founder or another tenant's", async () => {
    seed();
    const card = (o: Record<string, unknown>) => ({
      tenant_id: A, channel_slug: "email_marketing", exec_class: "email_campaign.create_and_send", exec_status: "executed",
      executed_at: "2026-09-26T00:00:00Z", title: "Campaign", exec_result: null, ...o,
    });
    db.channel_actions = [
      card({ title: "Spring sale", exec_result: { notice: "ok", receipt: { line: "Sent to 412 people via Mailchimp", url: "https://us1.admin.mailchimp.com/campaigns/1" } } }),
      card({ title: "Refused campaign", exec_status: "failed", exec_result: { error: "Mailchimp says the audience is archived." } }),
      card({ title: "Held for founder", exec_status: "failed", exec_result: { error: "Autopilot left this to you.", held_for_founder: true } }),
      card({ title: "Still queued", exec_status: "queued", executed_at: null }),
      card({ title: "Other channel", channel_slug: "sms" }),
      card({ tenant_id: B, title: "SECRET tenant B campaign" }),
    ];
    const ledger = (o: Record<string, unknown>) => ({
      tenant_id: A, subject: "Bulk", status: "done", total: 3, sent: 3, skipped: 0, failed: 0, unknown: 0, hard_bounces: 0, complaints: 0,
      hold_reason: null, created_at: "2026-09-27T00:00:00Z", finished_at: "2026-09-27T00:05:00Z", ...o,
    });
    db.email_bulk_sends = [
      ledger({ subject: "New 7am class" }),
      ledger({ subject: "Big list", status: "held", total: 200, sent: 50, hold_reason: "bulk_abuse_hold", complaints: 5, finished_at: null, created_at: "2026-09-26T12:00:00Z" }),
      ledger({ tenant_id: B, subject: "SECRET tenant B bulk" }),
    ];
    const e = await load(A);
    const em = ch(e, "email_marketing");
    const byLine = Object.fromEntries(em.items!.map((i) => [i.first_line, i]));
    expect(Object.keys(byLine)).toEqual(expect.arrayContaining(["Big list", "New 7am class", "Refused campaign", "Spring sale"]));
    expect(em.items).toHaveLength(5);
    expect(em.more_items).toBe(1);
    expect(byLine["Spring sale"]).toMatchObject({
      outcome: "Sent to 412 people via Mailchimp, delivery not confirmed",
      url: "https://us1.admin.mailchimp.com/campaigns/1",
      source: "approved campaign in the founder's email tool",
      as_of: "2026-09-26T00:00:00Z",
      metrics: EMAIL_NO_NUMBERS,
    });
    expect(byLine["Refused campaign"].outcome).toBe("not sent: Mailchimp says the audience is archived.");
    expect(byLine["New 7am class"]).toMatchObject({ outcome: "sent to 3 of 3, 0 skipped, delivery not confirmed", source: "Zavi's own bulk send", as_of: "2026-09-27T00:05:00Z" });
    expect(byLine["Big list"].outcome).toBe("stopped after 50 of 200: bulk_abuse_hold, 5 marked as spam");
    expect(em).toMatchObject({ evidence: "insufficient", label: NO_NUMBERS_LABEL });
    expect(JSON.stringify(e)).not.toContain("SECRET");
    expect(JSON.stringify(e)).not.toContain("Held for founder");
  });

  it("a failed or crashed campaign or bulk-send read keeps the single-send evidence; only a failed single-send read loses the channel", async () => {
    seed();
    db.channel_actions = [
      { tenant_id: A, channel_slug: "email_marketing", exec_class: "email_campaign.create_and_send", exec_status: "executed", executed_at: "2026-09-26T00:00:00Z", title: "Spring sale", exec_result: null },
    ];
    db.email_bulk_sends = [
      { tenant_id: A, subject: "New 7am class", status: "done", total: 3, sent: 3, skipped: 0, failed: 0, unknown: 0, hard_bounces: 0, complaints: 0, hold_reason: null, created_at: "2026-09-27T00:00:00Z", finished_at: "2026-09-27T00:05:00Z" },
    ];
    const CAMPAIGN = { table: "channel_actions", cols: "title, exec_status, executed_at, exec_result" };
    const LEDGER = { table: "email_bulk_sends", cols: "subject, status, total, sent, skipped, failed, unknown, hard_bounces, complaints, hold_reason, created_at, finished_at" };
    const lines = async () => {
      const em = ch(await load(A), "email_marketing");
      expect(em.evidence).not.toBe("could not read");
      expect(em.label).not.toBe(NOTHING_PUBLISHED_LABEL);
      return em.items!.map((i) => i.first_line).sort();
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      failingRead.push({ ...CAMPAIGN, mode: "error" });
      expect(await lines()).toEqual(["New 7am class", "Subject bounced", "Subject sent"]);
      failingRead.length = 0;
      failingRead.push({ ...LEDGER, mode: "error" });
      expect(await lines()).toEqual(["Spring sale", "Subject bounced", "Subject sent"]);
      failingRead.length = 0;
      failingRead.push({ ...CAMPAIGN, mode: "throw" }, { ...LEDGER, mode: "throw" });
      expect(await lines()).toEqual(["Subject bounced", "Subject sent"]);
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/campaign read failed[\s\S]*bulk send read failed|bulk send read failed[\s\S]*campaign read failed/);
      failingRead.length = 0;
      failing.add("agent_runs");
      const em = ch(await load(A), "email_marketing");
      expect(em).toMatchObject({ evidence: "could not read" });
      expect(JSON.stringify(em)).not.toContain("Spring sale");
    } finally {
      warn.mockRestore();
    }
  });

  it("a busy operator mailbox never crowds out the channel's own sends", async () => {
    seed();
    for (let i = 0; i < 60; i++) db.decisions.push(send(`op${i}`, A, "rOp", { dispatched_at: `2026-09-27T${String(i % 24).padStart(2, "0")}:00:00Z` }));
    const em = ch(await load(A), "email_marketing");
    expect(em.items!.map((i) => i.first_line).sort()).toEqual(["Subject bounced", "Subject sent"]);
  });

  it("failed sends that never got a dispatch time never crowd out a real send, the way Postgres sorts nulls first", async () => {
    seed();
    db.decisions = [
      send("real", A, "rEm", { dispatched_at: "2026-09-20T00:00:00Z" }),
      ...Array.from({ length: 6 }, (_, i) => send(`nodispatch${i}`, A, "rEm", { status: "dispatch_failed", dispatched_at: null, dispatch_error: "provider down" })),
    ];
    const em = ch(await load(A), "email_marketing");
    expect(em.label).not.toBe(NOTHING_PUBLISHED_LABEL);
    expect(em.items!.map((i) => i.first_line)).toEqual(["Subject real"]);
  });

  it("creator videos never pushed as ads never crowd out the ones running", async () => {
    seed();
    for (let i = 0; i < 20; i++) db.creator_library_assets.push({ tenant_id: A, order_id: "oU", meta_ad_id: null, meta_auto_paused_at: null, metrics: null, metrics_read_at: null, created_at: "2026-09-26T00:00:00Z" });
    const ugc = ch(await load(A), "ugc");
    expect(ugc.evidence).toBe("per_item");
    expect(ugc.items!.filter((i) => i.source === "Meta ads")).toHaveLength(1);
  });

  it("sms has no outcome to read and says why", async () => {
    seed();
    expect(ch(await load(A), "sms")).toMatchObject({ evidence: "insufficient", label: unsupportedLabel("this channel cannot send a text message") });
    expect(ch(await load(A), "sms").items).toBeUndefined();
  });

  it("another tenant's creator posts, ad numbers and sends never appear", async () => {
    seed();
    const text = JSON.stringify(await load(A));
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("99999");
  });

  it("nothing delivered yet reads as nothing published, never as a result", async () => {
    seed();
    db.creator_publications = db.creator_publications.filter((p) => p.status !== "published");
    db.creator_library_assets = [];
    db.decisions = db.decisions.filter((d) => d.status !== "acted" && d.status !== "dispatch_failed");
    const e = await load(A);
    for (const slug of ["ugc", "email_marketing"]) expect(ch(e, slug)).toMatchObject({ evidence: "insufficient", label: NOTHING_PUBLISHED_LABEL });
  });

  it("a failed outcome read says could not read for that channel only", async () => {
    seed();
    failing.add("creator_publications");
    const e = await load(A);
    expect(ch(e, "ugc")).toMatchObject({ evidence: "could not read" });
    expect(ch(e, "email_marketing").items).toHaveLength(2);
    failing.clear();
    failing.add("agent_runs");
    expect(ch(await load(A), "email_marketing")).toMatchObject({ evidence: "could not read" });
  });

  it("pure builders keep the outcome honest", () => {
    expect(emailItems([{ status: "approved", subject: "x", dispatched_at: null, dispatch_error: null }])).toEqual([]);
    expect(emailItems([{ status: "acted", subject: "x", dispatched_at: null, dispatch_error: null }])).toEqual([]);
    expect(creatorItems([], [{ meta_ad_id: "a", meta_auto_paused_at: "2026-09-26T00:00:00Z", metrics: null, metrics_read_at: null, created_at: "2026-09-20T00:00:00Z" }])[0]).toMatchObject({ outcome: "Meta ad paused 2026-09-26", metrics: "not read yet", as_of: null });
  });
});

describe("dedicated channel readers reach Growth Strategy", () => {
  const slugs = ["linkedin_ads", "linkedin_organic", "x_organic", "instagram_organic", "tiktok_organic"];
  const load = (channels = slugs) => loadCgoEvidence({ tenant_id: A, channelSlugs: channels, now: NOW, cardClass: CGO_CARD_CLASS });
  beforeEach(() => {
    for (const k of Object.keys(db)) delete db[k];
    failing.clear();
    linkedinAccounts.mockReset().mockResolvedValue([{ id: "123", name: "Account", currency: "INR" }]);
    linkedinCampaigns.mockReset().mockResolvedValue([{ id: "456", name: "Launch", objective: "WEBSITE_CONVERSIONS", status: "ACTIVE" }]);
    linkedinAnalytics.mockReset().mockResolvedValue([{ pivot: "urn:li:sponsoredCampaign:456", spend: 900, impressions: 1000, clicks: 20, conversions: 0, leads: 0, missing_metrics: ["conversions", "leads"] }]);
    instagramInsights.mockReset().mockResolvedValue({ fetched_at: NOW.toISOString(), items: [{ caption_head: "Owned IG", permalink: "https://instagram.com/p/1", timestamp: "2026-09-25", insights: { views: 50 }, like_count: 2, comments_count: null, insights_error: null }] });
    tiktokVideos.mockReset().mockResolvedValue({ data: { videos: [{ id: "tt1", title: "Owned TikTok", create_time: NOW.getTime() / 1000, view_count: 100, like_count: 0 }], has_more: true } });
    db.social_posts = [{ tenant_id: A, channel: "x", status: "published", external_post_id: "x1", approved_payload_snapshot: { payload: { text: "Owned X" } }, metrics: { views: 12 }, metrics_read_at: "2026-09-27", updated_at: "2026-09-26" }];
  });

  it("wires the five remaining channels through the review loader with bounded evidence", async () => {
    const e = await load();
    expect([...e.paid, ...e.organic].map(c => c.channel_slug).sort()).toEqual([...slugs].sort());
    expect(e.paid.every(c => c.status === "read")).toBe(true);
    expect(e.organic.find(c => c.channel_slug === "instagram_organic")?.items?.[0].metrics).toContain("views 50");
    expect(e.organic.find(c => c.channel_slug === "tiktok_organic")?.items?.[0].metrics).toContain("views 100");
    expect(e.organic.find(c => c.channel_slug === "linkedin_organic")?.limitation).toMatch(/not granted/);
    expect(e.organic.find(c => c.channel_slug === "x_organic")?.items?.[0].as_of).toBe("2026-09-27");
    expect(evidenceSize(e)).toBeLessThanOrEqual(EVIDENCE_CHAR_BUDGET);
    expect(linkedinAccounts).toHaveBeenCalledWith(A);
    expect(instagramInsights.mock.calls[0][0].tenant_id).toBe(A);
    expect(tiktokVideos).toHaveBeenCalledWith(A, 6);
  });

  it("keeps LinkedIn currency and suppressed values; never manufactures USD or tracking", async () => {
    const e = await load(["linkedin_ads"]);
    const campaign = e.paid[0].campaigns![0];
    expect(campaign.reported).toMatchObject({ currency: "INR", metrics: "impressions 1000, clicks 20, spend 900" });
    expect(campaign.ad_sets).toEqual([]);
    expect(linkedinAnalytics).toHaveBeenCalledWith(A, "123", { pivot: "CAMPAIGN", start: { year: 2026, month: 9, day: 21 }, end: { year: 2026, month: 9, day: 27 } });
    expect(cutHeldByEvidence({ target: "linkedin_ads", intent: "pause 456 for zero conversions", evidence: e })?.reasons).toContain("tracking_not_trusted");
  });

  it("ignores cancelled accounts and ranks the busiest campaign before the eight-item cap", async () => {
    linkedinAccounts.mockResolvedValue([{ id: "old", status: "CANCELED" }, { id: "123", status: "ACTIVE", currency: "USD" }]);
    linkedinCampaigns.mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({ id: String(i), name: `Campaign ${i}`, status: "ACTIVE" })));
    linkedinAnalytics.mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({ pivot: `urn:li:sponsoredCampaign:${i}`, spend: i * 10 })));
    const c = (await load(["linkedin_ads"])).paid[0];
    expect(c.campaigns?.map(x => x.id)).toEqual(["9", "8", "7", "6", "5", "4", "3", "2"]);
    expect(c.campaigns?.[0].reported).toMatchObject({ spend: 90, period_confirmed: false });
    expect(c.more_campaigns).toBe(2);
  });

  it("preserves Instagram account totals separately from per-post evidence", async () => {
    instagramInsights.mockResolvedValue({ fetched_at: NOW.toISOString(), account_28d: { views: 120 }, items: [] });
    const c = (await load(["instagram_organic"])).organic[0];
    expect(c.evidence).toBe("insufficient");
    expect(c.account_summary).toMatchObject({ metrics: "views 120", as_of: NOW.toISOString() });
  });

  it("an advertiser with no LinkedIn campaigns is read without asking LinkedIn for analytics it would throw away", async () => {
    linkedinCampaigns.mockResolvedValue([]);
    const c = (await load(["linkedin_ads"])).paid[0];
    expect(c.campaigns ?? []).toEqual([]);
    expect(linkedinCampaigns).toHaveBeenCalledWith(A, "123", 100);
    expect(linkedinAnalytics).not.toHaveBeenCalled();
  });

  it("does not guess an advertiser when the token sees several accounts", async () => {
    linkedinAccounts.mockResolvedValue([{ id: "1" }, { id: "2" }]);
    expect((await load(["linkedin_ads"])).paid[0]).toMatchObject({ status: "could not read", reason: expect.stringMatching(/Multiple/) });
    expect(linkedinAnalytics).not.toHaveBeenCalled();
  });

  it("missing LinkedIn campaign rows are unknown, never zero", async () => {
    linkedinAnalytics.mockResolvedValue([]);
    expect((await load(["linkedin_ads"])).paid[0].campaigns![0].reported!.metrics).toBe("not read yet");
  });

  it("failed providers leave stored publication evidence and do not erase other channels", async () => {
    instagramInsights.mockRejectedValue(Object.assign(new Error("not connected"), { code: "instagram_not_connected" }));
    tiktokVideos.mockRejectedValue(new Error("provider down"));
    const e = await load();
    expect(e.organic.find(c => c.channel_slug === "instagram_organic")).toMatchObject({ evidence: "insufficient", limitation: expect.stringMatching(/not connected/) });
    expect(e.organic.find(c => c.channel_slug === "tiktok_organic")).toMatchObject({ evidence: "insufficient", limitation: expect.stringMatching(/could not read/) });
    expect(e.organic.find(c => c.channel_slug === "x_organic")?.evidence).toBe("per_item");
    expect(e.paid[0].status).toBe("read");
  });

  it("missing TikTok counters remain unknown, while measured zero remains zero", async () => {
    tiktokVideos.mockResolvedValue({ data: { videos: [{ id: "1", title: "unknown" }, { id: "2", title: "measured", view_count: 0 }] } });
    const items = (await load(["tiktok_organic"])).organic[0].items!;
    expect(items.find(i => i.first_line === "unknown")?.metrics).toBe("not read yet");
    expect(items.find(i => i.first_line === "measured")?.metrics).toContain("views 0");
  });

  it("does not claim stored snapshots when the stored read also fails", async () => {
    instagramInsights.mockRejectedValue(new Error("offline"));
    failing.add("social_posts");
    const c = (await load(["instagram_organic"])).organic[0];
    expect(c.evidence).toBe("could not read");
    expect(c.limitation).toContain("stored evidence also unavailable");
    expect(c.limitation).not.toContain("using stored snapshots");
  });

  it("a malformed TikTok response is not reported as no published videos", async () => {
    tiktokVideos.mockResolvedValue({ data: {} });
    expect((await load(["tiktok_organic"])).organic[0].limitation).toMatch(/Live metrics unavailable/);
  });

  it("reads LinkedIn public snapshots without confusing platforms, tenants or dates", async () => {
    db.social_post_metric_snapshots = [
      { tenant_id: A, channel: "linkedin", external_post_id: "same", captured_on: "2026-09-27", posted_at: "2026-09-24", text: "Public LinkedIn", metrics: { reactions: 12, comments: 2 } },
      { tenant_id: A, channel: "linkedin", external_post_id: "same", captured_on: "2026-09-26", posted_at: "2026-09-24", text: "old", metrics: { reactions: 1 } },
      { tenant_id: B, channel: "linkedin", external_post_id: "same", captured_on: "2026-09-28", text: "SECRET", metrics: { reactions: 999 } },
      { tenant_id: A, channel: "x", external_post_id: "same", captured_on: "2026-09-27", text: "X only", metrics: { impressions: 555 } },
    ];
    const e = await load(["linkedin_organic"]);
    expect(e.organic[0].items).toHaveLength(1);
    expect(e.organic[0].items![0]).toMatchObject({ first_line: "Public LinkedIn", as_of: "2026-09-27" });
    expect(JSON.stringify(e)).not.toMatch(/SECRET|555/);
    expect(e.organic[0].items![0].metrics).toContain("reactions 12");
  });

  it("retains existing Instagram and TikTok metric snapshots if live reads fail", async () => {
    db.connector_metadata = [{ tenant_id: A, slug: "composio.instagram", team_id: "ca_current", connected_at: "2026-09-20T00:00:00Z" }];
    db.social_account_snapshots = [{ tenant_id: A, channel: "instagram", captured_on: "2026-09-26", username: "owner", account_id: "ig_current", connection_id: "ca_current", created_at: "2026-09-26T00:00:00Z" }];
    instagramInsights.mockRejectedValue(new Error("offline"));
    tiktokVideos.mockRejectedValue(new Error("offline"));
    db.social_post_metric_snapshots = ["instagram", "tiktok"].map(channel => ({ tenant_id: A, channel, account_id: "ig_current", external_post_id: channel, captured_on: "2026-09-26", posted_at: "2026-09-24", text: channel, metrics: { views: 17 } }));
    const e = await load(["instagram_organic", "tiktok_organic"]);
    for (const c of e.organic) {
      expect(c.items![0]).toMatchObject({ as_of: "2026-09-26", metrics: "views 17 (read 2026-09-26)" });
      expect(c.limitation).toMatch(/Live metrics unavailable/);
      expect(c.limitation).toContain("stored snapshots and publication evidence");
      expect(c.limitation).not.toContain("publication evidence only");
      expect(c.period).toContain("as_of");
    }
  });

  it("filters Instagram fallback snapshots and ledger by the current account after reconnecting", async () => {
    instagramInsights.mockRejectedValue(new Error("offline"));
    db.connector_metadata = [{ tenant_id: A, slug: "composio.instagram", team_id: "ca_current" }];
    db.social_account_snapshots = [
      { tenant_id: A, channel: "instagram", captured_on: "2026-09-25", username: "old", account_id: "ig_old", connection_id: "ca_old" },
      { tenant_id: A, channel: "instagram", captured_on: "2026-09-26", username: "current", account_id: "ig_current", connection_id: "ca_current" },
    ];
    db.social_post_metric_snapshots = [
      { tenant_id: A, channel: "instagram", external_post_id: "old_post", account_id: "ig_old", captured_on: "2026-09-25", text: "WRONG_ACCOUNT", metrics: { views: 999 } },
      { tenant_id: A, channel: "instagram", external_post_id: "ours", account_id: "ig_current", captured_on: "2026-09-26", text: "current", metrics: { views: 17 } },
    ];
    db.social_posts = [
      { tenant_id: A, channel: "instagram_image", status: "published", account_id: "ca_old", transport: "composio", external_post_id: "old_post", updated_at: "2026-09-25", approved_payload_snapshot: { payload: { text: "WRONG_LEDGER" } } },
      { tenant_id: A, channel: "instagram_image", status: "published", account_id: "ca_current", transport: "composio", external_post_id: "new", updated_at: "2026-09-26", approved_payload_snapshot: { payload: { text: "new publication" } } },
    ];
    const e = await load(["instagram_organic"]);
    expect(JSON.stringify(e)).not.toMatch(/WRONG_|999/);
    expect(e.organic[0].items!.map(i => i.first_line).sort()).toEqual(["current", "new publication"]);
    db.connector_metadata[0].team_id = "ca_unread";
    const after = await load(["instagram_organic"]);
    expect(after.organic[0].evidence).toBe("insufficient");
  });

  it("size trimming retains the measured item behind the per_item label", () => {
    const measured = { first_line: "Measured older post", metrics: "views 17", published_on: "2026-09-20", url: null, as_of: "2026-09-27" };
    const receipt = { first_line: "New unmeasured post".repeat(10), metrics: "not read yet", published_on: "2026-09-27", url: null };
    const e = { paid: [], organic: [organicChannel("instagram_organic", [receipt, measured])], own_moves: [] };
    const out = budgetEvidence(e, evidenceSize(e) - 100);
    expect(out.organic[0].items).toEqual([measured]);
    expect(out.organic[0].evidence).toBe("per_item");
    expect(out.organic[0].more_items).toBe(1);
    expect(e.organic[0].items).toHaveLength(2);
  });
});

it("keeps older measured evidence ahead of five newer unmeasured receipts", () => {
  const receipts = Array.from({ length: 5 }, (_, i) => ({ first_line: `receipt${i}`, url: null, published_on: "2026-10-09", metrics: "not read yet" }));
  const result = organicChannel("instagram_organic", [...receipts, { first_line: "measured", url: null, published_on: "2026-10-01", metrics: "views 0" }]);
  expect(result.items?.[0].first_line).toBe("measured");
  expect(result.evidence).toBe("per_item");
  expect(result.items).toHaveLength(5);
});

describe("evidence floor, single budget pass and partial-coverage hold", () => {
  const PAID = ["meta_ads", "google_ads", "youtube_ads", "linkedin_ads", "tiktok_ads", "reddit_ads", "chatgpt_ads"];
  const ORGANIC = ["x_organic", "linkedin_organic", "instagram_organic", "reddit_organic", "tiktok_organic", "pinterest_organic", "youtube_organic", "ugc"];
  const section = { status: "ok" as const, as_of: NOW.toISOString() };
  const window = { from: "2026-09-21", to: "2026-09-27", tz: "UTC" };

  function fullPack(): CgoEvidence {
    const sets = (ch: string, c: number) =>
      [0, 1, 2, 3].map((i) => adSetEvidence(facts({ id: `${ch}-c${c}-as${i}`, spend7dUsd: 1000 - c * 100 - i }), `Ad set ${i} of campaign ${c} on ${ch}`, true));
    const items = (ch: string) =>
      [0, 1, 2, 3, 4].map((i) => ({ first_line: `${ch} post ${i} `.repeat(6).slice(0, 99), url: `https://example.com/${ch}/${i}`, published_on: `2026-09-${10 + i}`, metrics: "impressions 1200, likes 14, replies 3" }));
    const movers = (k: string) => [0, 1, 2].map((i) => ({ key: `${k} number ${i} with a long descriptive key`, now: 1200 + i, before: 1000, change_pct: 20 }));
    const searchMovers = (k: string) => [0, 1, 2].map((i) => ({ key: `${k} number ${i} with a long key`, clicks: [120 + i, 100] as [number, number], position: [8.2, 9.4] as [number, number] }));
    return {
      paid: PAID.map((ch) =>
        paidChannel(ch, [0, 1, 2, 3, 4, 5, 6, 7].map((c) => campaignEvidence({ id: `${ch}-c${c}`, name: `Campaign ${c} on ${ch}`, objective: "OUTCOME_SALES" }, sets(ch, c)))),
      ),
      organic: ORGANIC.map((s) => organicChannel(s, items(s))),
      own_moves: Array.from({ length: 10 }, (_, i) => `Sep ${10 + i}: asked meta_ads to do a fairly long described thing number ${i} -> run success; 2 cards`),
      waiting_on_founder: Array.from({ length: 5 }, (_, i) => `[a${i}] Sep ${20 + i} email_marketing: send the host email -> waiting on the founder`),
      founder_ad_changes: Array.from({ length: 5 }, (_, i) => `Sep ${20 + i}: you paused ad set ${i} outside Zavi`),
      outcome: {
        goals: [0, 1, 2].map((g) => ({
          ...section,
          goal_id: `goal-${g}`,
          source: "tenant_metric_snapshots",
          identity: "net_revenue_30d",
          window,
          points: Array.from({ length: 8 }, (_, i): [string, number] => [`2026-09-2${i}`, 1000 + g * 10 + i]),
          markers: [0, 1, 2].map((i) => ({ date: `2026-09-2${i}`, what: `meta_ads: a move that went live ${i}` })),
          label: "Moved after, not proven caused." as const,
        })),
      },
      traffic: { ...section, source: "google_analytics", identity: "property 1", window, sessions: [6300, 5600], key_events: [84, 80], top_sources: movers("source"), top_pages: movers("/page") },
      search: { ...section, source: "google_search_console", identity: "sc-domain:example.com", window, clicks: [100, 80], impressions: [5000, 4000], ctr: [0.02, 0.02], position: [8.2, 9.4], top_queries: searchMovers("query"), top_pages: searchMovers("/page") },
    };
  }

  function trimmablePack(): CgoEvidence {
    const e = fullPack();
    return { ...e, paid: e.paid.slice(0, 2), organic: e.organic.slice(0, 3) };
  }

  it("must-catch (a): the fullest pack keeps all three traffic sources", () => {
    const e = fullPack();
    expect(evidenceSize(e)).toBeGreaterThan(EVIDENCE_CHAR_BUDGET);
    const out = budgetEvidence(e);
    expect(out.traffic!.top_sources).toEqual(e.traffic!.top_sources);
    expect(out.traffic!.top_sources).toHaveLength(3);
  });

  it("must-catch (d): the fullest pack keeps every pinned row", () => {
    const e = fullPack();
    const out = budgetEvidence(e);
    expect(evidenceSize(out)).toBeGreaterThan(EVIDENCE_CHAR_BUDGET);
    expect(out.cut).toMatchObject({ over_budget: true, note: OVER_BUDGET_NOTE });
    expect(out.paid.map((p) => [p.channel_slug, p.status])).toEqual(PAID.map((s) => [s, "read"]));
    for (const ch of out.paid) {
      expect(ch.campaigns![0].id).toBe(`${ch.channel_slug}-c0`);
      expect(ch.campaigns![0].ad_sets[0].id).toBe(`${ch.channel_slug}-c0-as0`);
      expect(ch.campaigns![0].label).toBe(PAID_LABELS.conversion);
    }
    expect(out.organic.map((o) => [o.channel_slug, o.label, o.clock])).toEqual(e.organic.map((o) => [o.channel_slug, o.label, o.clock]));
    for (const o of out.organic) expect(o.items![0].metrics).toContain("impressions");
    expect(out.waiting_on_founder).toEqual(e.waiting_on_founder);
    expect(out.founder_ad_changes).toEqual(e.founder_ad_changes);
    expect(out.outcome!.goals).toHaveLength(3);
    out.outcome!.goals.forEach((g, i) => {
      expect([g.status, g.label]).toEqual(["ok", "Moved after, not proven caused."]);
      expect(g.points!.at(-1)).toEqual(e.outcome!.goals[i].points!.at(-1));
    });
    for (const k of ["traffic", "search"] as const) {
      expect([out[k]!.status, out[k]!.identity, out[k]!.window]).toEqual([e[k]!.status, e[k]!.identity, e[k]!.window]);
    }
    expect([out.traffic!.sessions, out.traffic!.key_events, out.search!.clicks, out.search!.impressions]).toEqual([[6300, 5600], [84, 80], [100, 80], [5000, 4000]]);
  });

  it("keeps the campaign that spent most before trimming, even after its ad sets were trimmed", () => {
    const set = (id: string, spend: number) => ({ id, name: id, goal: "OFFSITE_CONVERSIONS", learning: false, days_since_edit: 9, spend_7d_usd: spend, conversions_7d: 2, tracking: "ok" as const, label: PAID_LABELS.conversion });
    const e = fullPack();
    e.paid[0].campaigns = [
      { id: "A", name: "A", objective: "OUTCOME_SALES", label: PAID_LABELS.conversion, ad_sets: [set("A1", 60), set("A2", 60)] },
      { id: "B", name: "B", objective: "OUTCOME_SALES", label: PAID_LABELS.conversion, ad_sets: [set("B1", 100)] },
    ];
    const out = budgetEvidence(e);
    expect(out.paid[0].campaigns!.map((c) => c.id)).toEqual(["A"]);
  });

  it("a floor larger than the budget is kept whole and the manifest says so", () => {
    const e = fullPack();
    const out = budgetEvidence(e, 2000);
    expect(out.cut).toMatchObject({ over_budget: true, note: OVER_BUDGET_NOTE });
    expect(evidenceSize(out)).toBeGreaterThan(2000);
    expect(out.traffic!.top_sources).toHaveLength(3);
    expect(out.waiting_on_founder).toEqual(e.waiting_on_founder);
    for (const ch of out.paid) expect(ch.campaigns![0].ad_sets).toHaveLength(1);
  });

  it("the manifest names each list that lost rows and how many", () => {
    const e = trimmablePack();
    const out = budgetEvidence(e);
    expect(evidenceSize(out)).toBeLessThanOrEqual(EVIDENCE_CHAR_BUDGET);
    expect(out.cut!.over_budget).toBeUndefined();
    const left = out.cut!.left_out;
    for (const ch of e.paid) {
      const kept = out.paid.find((p) => p.channel_slug === ch.channel_slug)!;
      const sets = (p: typeof ch) => (p.campaigns ?? []).reduce((n, c) => n + c.ad_sets.length, 0);
      const goneCampaigns = ch.campaigns!.length - kept.campaigns!.length;
      expect(left[`paid.${ch.channel_slug}.campaigns`] ?? 0).toBe(goneCampaigns);
      expect(kept.more_campaigns ?? 0).toBe(goneCampaigns);
      expect(left[`paid.${ch.channel_slug}.ad_sets`] ?? 0).toBeGreaterThanOrEqual(kept.campaigns!.reduce((n, c) => n + (c.more_ad_sets ?? 0), 0));
      expect(sets(kept)).toBeLessThan(sets(ch));
    }
    for (const o of e.organic) {
      const kept = out.organic.find((x) => x.channel_slug === o.channel_slug)!;
      expect(left[`organic.${o.channel_slug}.items`] ?? 0).toBe(o.items!.length - kept.items!.length);
    }
    expect(Object.keys(left).every((k) => /^(paid|organic)\.[a-z_]+\.(ad_sets|campaigns|items)$|^own_moves$|^outcome\.(points|markers)$|^traffic\.top_pages$|^search\.top_(pages|queries)$/.test(k))).toBe(true);
    expect(left["traffic.top_sources"]).toBeUndefined();
  });

  it("budgeting twice keeps the cut note and drops nothing more", () => {
    for (const e of [trimmablePack(), fullPack()]) {
      const once = budgetEvidence(e);
      expect(once.cut).toBeDefined();
      expect(JSON.stringify(budgetEvidence(once))).toBe(JSON.stringify(once));
    }
  });

  it("must-catch (b): the composed goal-owner context carries the cut manifest when anything was trimmed", () => {
    const e = trimmablePack();
    const composed = compose(e).evidence!;
    expect(Object.keys(composed.cut!.left_out).length).toBeGreaterThan(0);
    expect(JSON.stringify(composed)).toBe(JSON.stringify(budgetEvidence(e)));
    expect(compose(budgetEvidence(e)).evidence!.cut).toEqual(composed.cut);
  });

  it("must-not-touch: a pack under the budget is byte-identical and has no manifest", () => {
    const e = fullPack();
    const small: CgoEvidence = {
      ...e,
      paid: e.paid.slice(0, 1).map((p) => ({ ...p, campaigns: p.campaigns!.slice(0, 2).map((c) => ({ ...c, ad_sets: c.ad_sets.slice(0, 2) })) })),
      organic: e.organic.slice(0, 1),
      own_moves: (e.own_moves as string[]).slice(0, 4),
    };
    expect(evidenceSize(small)).toBeLessThanOrEqual(EVIDENCE_CHAR_BUDGET);
    expect(JSON.stringify(budgetEvidence(small))).toBe(JSON.stringify(small));
    expect(JSON.stringify(compose(small).evidence)).toBe(JSON.stringify(small));
    expect(budgetEvidence(small).cut).toBeUndefined();
  });

  describe("cut gate", () => {
    const set = (id: string, name: string, label: PaidLabel) => ({ id, name, goal: null, learning: null, days_since_edit: 20, spend_7d_usd: 140, conversions_7d: 0, tracking: "ok" as const, label });
    const ev = (over: { more_ad_sets?: number; more_campaigns?: number } = {}): CgoEvidence => ({
      paid: [
        {
          channel_slug: "meta_ads",
          status: "read",
          campaigns: [
            { id: "441", name: "Hosts - SF", objective: "OUTCOME_LEADS", label: PAID_LABELS.conversion, ad_sets: [set("442", "SF - Leads", PAID_LABELS.conversion)], ...(over.more_ad_sets ? { more_ad_sets: over.more_ad_sets } : {}) },
            { id: "221", name: "Hosts - Phoenix", objective: "OUTCOME_LEADS", label: PAID_LABELS.learning, ad_sets: [set("222", "Phoenix - Leads", PAID_LABELS.learning)] },
          ],
          ...(over.more_campaigns ? { more_campaigns: over.more_campaigns } : {}),
        },
      ],
      organic: [],
      own_moves: [],
    });
    const held = (intent: string, evidence: CgoEvidence) => cutHeldByEvidence({ target: "meta_ads", intent, evidence })?.reasons ?? null;
    const WHOLE = 'Pause "Hosts - SF": no leads for $140, CPA past target.';
    const ONE_SET = 'Lower "SF - Leads": no leads for $140, CPA past target.';

    it("must-catch (c): a whole-campaign cut is held when some of its ad sets were not shown", () => {
      expect(held(WHOLE, ev({ more_ad_sets: 2 }))).toEqual(["partial_coverage"]);
      expect(cutHeldByEvidence({ target: "meta_ads", intent: WHOLE, evidence: ev({ more_ad_sets: 2 }) })!.object).toBe("Hosts - SF");
    });

    it("must-catch (c): a channel-wide cut is held when some campaigns were not shown", () => {
      expect(held("Pause every campaign that underperforms this week.", ev({ more_campaigns: 3 }))).toContain("partial_coverage");
    });

    it("the budget's own trimming holds a whole-campaign cut on what it trimmed", () => {
      const out = budgetEvidence(trimmablePack());
      const c = out.paid[0].campaigns![0];
      expect(c.more_ad_sets).toBeGreaterThan(0);
      expect(cutHeldByEvidence({ target: out.paid[0].channel_slug, intent: `Pause "${c.name}": CPA past target.`, evidence: out })?.reasons).toEqual(["partial_coverage"]);
      expect(cutHeldByEvidence({ target: out.paid[0].channel_slug, intent: `Pause "${c.ad_sets[0].name}": CPA past target.`, evidence: out })).toBeNull();
    });

    it("must-not-touch: one ad set that is in evidence is judged as before, trimmed siblings or not", () => {
      expect(held(ONE_SET, ev())).toBeNull();
      expect(held(ONE_SET, ev({ more_ad_sets: 2, more_campaigns: 3 }))).toBeNull();
      expect(held('Cut "Phoenix - Leads" in half.', ev({ more_ad_sets: 2, more_campaigns: 3 }))).toEqual(["too_early_learning"]);
      expect(held('Lower ad set "SF - Leads" in "Hosts - SF": CPA past target.', ev({ more_ad_sets: 2 }))).toBeNull();
    });

    it("must-not-touch: a whole-campaign cut with every ad set shown is judged as before", () => {
      expect(held(WHOLE, ev())).toBeNull();
      expect(held(WHOLE, ev({ more_campaigns: 3 }))).toBeNull();
      expect(held('Pause "Hosts - Phoenix": no leads.', ev())).toEqual(["too_early_learning"]);
      expect(held("Pause every campaign that underperforms this week.", ev())).toEqual(["object_not_in_evidence"]);
    });

    it("the new hold reaches the founder in plain words", () => {
      const words = channelCardCutHeld({ channel_slug: "meta_ads", title: 'Pause "Hosts - SF"', step: "Pause it in Ads Manager." }, "", ev({ more_ad_sets: 2 }));
      expect(words).toBe(CUT_HOLD_WORDS.partial_coverage);
      expect(words).toMatch(/only part/);
    });
  });
});
