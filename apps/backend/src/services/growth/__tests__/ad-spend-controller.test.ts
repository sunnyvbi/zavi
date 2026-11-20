
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/growth/spend-pace", async (orig) => ({
  forecastDailySpend: (await orig<typeof import("@/services/growth/spend-pace")>()).forecastDailySpend,
  loadSpendPace: vi.fn(),
}));
const fbGetAllPages = vi.fn();
const fbGet = vi.fn();
vi.mock("@/services/tools/meta-ads/_client", async (orig) => ({
  ...(await orig<typeof import("@/services/tools/meta-ads/_client")>()),
  metaAdsCreds: async () => ({ ad_account_id: "act_1" }),
  fbGetAllPages: (...a: unknown[]) => fbGetAllPages(...a),
  fbGet: (...a: unknown[]) => fbGet(...a),
}));
const fetchMetaDailySeries = vi.fn();
vi.mock("@/services/tools/meta-ads/daily_series", async (orig) => ({
  ...(await orig<typeof import("@/services/tools/meta-ads/daily_series")>()),
  fetchMetaDailySeries: (...a: unknown[]) => fetchMetaDailySeries(...a),
}));
const gadsSearch = vi.fn();
vi.mock("@/services/tools/google-ads/_client", async (orig) => ({
  ...(await orig<typeof import("@/services/tools/google-ads/_client")>()),
  gadsCustomerId: async () => "1234567890",
  gadsSearch: (...a: unknown[]) => gadsSearch(...a),
}));
let orderRows: Array<Record<string, unknown>> = [];
let ledgerRows: Record<string, Array<Record<string, unknown>>> = {};
const ledgerFilters: string[] = [];
vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<typeof import("@/services/tenant-client")>()),
  tenantClient: () => ({
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (ledgerFilters.push(`${table}.${c}=${String(v)}`), q),
        gte: (c: string, v: unknown) => (ledgerFilters.push(`${table}.${c}>=${String(v)}`), q),
        in: (c: string, v: unknown) => (ledgerFilters.push(`${table}.${c} in ${String(v)}`), q),
        or: (f: string) => (ledgerFilters.push(`${table}.or(${f})`), q),
        limit: async () => ({ data: table === "channel_actions" ? orderRows : (ledgerRows[table] ?? []), error: null }),
      };
      return q;
    },
  }),
}));
const loadPausedByFounder = vi.fn();
vi.mock("../unattended-policy", () => ({ loadPausedByFounder: (...a: unknown[]) => loadPausedByFounder(...a) }));

import type { SpendPace } from "@/services/growth/spend-pace";
import { refsFromPayload } from "../open-advice";
import { blockerChange } from "../cgo-blockers";
import { _resetMetaUsage, parseMetaUsageHeaders } from "@/services/tools/meta-ads/_client";
import { createAdBodySchema, createCustomAudienceBodySchema, normalizeLaunchCta, websiteAudienceName } from "@/services/tools/meta-ads/write/_decision-bodies";
import type { CgoAdOrderInput, CgoAdOrderResult } from "../cgo-ad-orders";
import type { CopyRegion } from "../copy-regions";
import {
  _resetSpendControllerCaches,
  applyGoalBasis,
  LEDGER_FRESH_HOURS,
  MAX_CREATIVES_PER_RUN,
  OVERBOOK,
  isMetaRateLimitError,
  defaultControllerDeps,
  dwellKeyOf,
  liveCapacityUsd,
  metaAdReady,
  metaCannotDeliver,
  cannotDeliverAdSets,
  cannotDeliverBlocker,
  objectCapacityUsd,
  orderDefinitelyFailed,
  planGapOrders,
  resultBasis,
  readFatiguedAdSets,
  readGoogleInventory,
  googleStartToIso,
  readLedgerCapacity,
  readMetaInventory,
  readRecentOrderKeys,
  readCopyIds,
  readOrderBackoffs,
  deterministicBackoffs,
  rejectedOrderHolds,
  withoutRejected,
  rejectHoldKey,
  normalizeAdLinkUrl,
  normalizeCreativeCopy,
  readCreativeCopy,
  requiredDailyUsd,
  runSpendControllerForTenant,
  type AdObject,
  type ControllerDeps,
  type Inventory,
} from "../ad-spend-controller";

const T = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-10-02T15:41:00Z");
const OLD = "2026-09-01T00:00:00Z";

function adSet(id: string, over: Partial<AdObject> = {}): AdObject {
  return {
    platform: "meta",
    level: "ad_set",
    id,
    campaign_id: "c1",
    name: `Ad set ${id}`,
    active: true,
    paused_self: false,
    parent_active: true,
    daily_budget_usd: 100,
    budget_on_campaign: false,
    spend7d_usd: 700,
    spend3d_usd: 300,
    spend_days7d: 7,
    results7d: 70,
    result_kind: "conversions",
    has_live_ads: true,
    has_any_ads: true,
    has_ready_ads: true,
    audience_ids: [],
    created_at: OLD,
    goal: "event:PURCHASE",
    ...over,
  };
}

const OPEN_REGION: CopyRegion = { label: "Northfield", share: 0.4, place: { kind: "state", country: "US", name: "Northfield" }, meta: { type: "region", key: "9001", name: "Northfield, United States" }, covered_goals: [] };

function campaign(id: string, over: Partial<AdObject> = {}): AdObject {
  return adSet(id, { level: "campaign", campaign_id: id, audience_ids: [], ...over });
}

function inv(metaObjects: AdObject[], googleObjects: AdObject[] = [], over: Partial<Inventory> = {}): Inventory {
  return {
    meta: { connected: true, objects: metaObjects, ads: [] },
    google: { connected: googleObjects.length > 0, objects: googleObjects, conversions30d: googleObjects.length ? 10 : null },
    ...over,
  };
}

const OCT1: SpendPace = {
  daily_target_usd: round2((25_000 - 518) / 30),
  required_cumulative_usd: 806.45,
  actual_month_usd: 518,
  delivery_debt_usd: 288.45,
  days_left: 30,
  data_fresh: true,
};
function round2(n: number) {
  return Math.round(n * 100) / 100;
}

type Fake = {
  deps: ControllerDeps;
  submitted: CgoAdOrderInput[];
  logs: Array<{ code: string; message: string }>;
  order: string[];
  woke: number;
  reads: { meta: number; google: number };
};

function fake(opts: {
  inventory: Inventory;
  pace?: SpendPace | null;
  running?: boolean;
  dwell?: string[];
  enableSafe?: string[];
  submit?: (i: CgoAdOrderInput) => CgoAdOrderResult;
  audience?: { id: string; count: number | null } | null;
  fatigued?: string[];
  maintainHolds?: () => Promise<unknown>;
  ledger?: Partial<Record<"meta" | "google", number | null>>;
  readMeta?: () => Promise<Inventory["meta"]>;
  readGoogle?: () => Promise<Inventory["google"]>;
}): Fake {
  const f: Fake = { deps: {} as ControllerDeps, submitted: [], logs: [], order: [], woke: 0, reads: { meta: 0, google: 0 } };
  const dwell = new Set(opts.dwell ?? []);
  f.deps = {
    cgoAdBudget: async () => (opts.running === false ? null : { id: "b1" }),
    loadSpendPace: async () => (opts.pace === undefined ? OCT1 : opts.pace),
    readMeta: async () => {
      f.reads.meta += 1;
      return opts.readMeta ? opts.readMeta() : opts.inventory.meta;
    },
    readGoogle: async () => {
      f.reads.google += 1;
      return opts.readGoogle ? opts.readGoogle() : opts.inventory.google;
    },
    ledgerCapacity: async (_t, p) => opts.ledger?.[p] ?? null,
    metaThrottled: defaultControllerDeps.metaThrottled,
    noteMetaRateLimit: defaultControllerDeps.noteMetaRateLimit,
    recentOrderKeys: async () => new Set(dwell),
    enableSafe: async () => new Set(opts.enableSafe ?? []),
    copyRegions: async () => ({ regions: [OPEN_REGION], goals: new Map() }),
    businessShape: async () => "marketplace",
    submit: async (i) => {
      f.submitted.push(i);
      return opts.submit ? opts.submit(i) : { ok: true, action_id: `a${f.submitted.length}` };
    },
    wakeCgo: async () => {
      f.woke += 1;
      return { woke: true };
    },
    retarget: () => ({
      readWebsiteAudience: async () => (opts.audience === undefined ? { id: "aud1", count: 500 } : opts.audience),
      readAdSetSetup: async () => ({ campaign_id: "c1", optimization_goal: "OFFSITE_CONVERSIONS", billing_event: "IMPRESSIONS", promoted_object: { pixel_id: "px", custom_event_type: "PURCHASE" }, geo_locations: { countries: ["US"] } }),
      readCreativeCopy: async (id) => ({ source_ad_id: `ad-${id}`, primary_text: "Words", headline: "Head", link_url: "https://example.com" }),
    }),
    creative: () => ({
      fatiguedAdSets: async () => new Set(opts.fatigued ?? []),
      readCreativeCopy: async (id) => ({ source_ad_id: `ad-${id}`, primary_text: "Words", headline: "Head", link_url: "https://example.com" }),
      generateImage: async () => "https://signed.example/img.jpg",
    }),
    maintainHolds: async () => {
      f.order.push("maintain");
      return opts.maintainHolds ? opts.maintainHolds() : { status: "done" };
    },
    log: (_t, code, message) => f.logs.push({ code, message }),
  };
  const submit = f.deps.submit;
  f.deps.submit = async (i) => {
    f.order.push("submit");
    return submit(i);
  };
  return f;
}

const isGapOrder = (o: CgoAdOrderInput) =>
  ["meta_ads.update_ad_set_budget", "google_ads.update_campaign_budget", "meta_ads.set_status", "google_ads.set_status", "meta_ads.duplicate_ad_set", "meta_ads.duplicate_campaign"].includes(o.exec_class);

function addedBy(o: CgoAdOrderInput, objects: AdObject[]): number {
  const b = o.body as Record<string, unknown>;
  if (o.exec_class.endsWith("update_ad_set_budget") || o.exec_class.endsWith("update_campaign_budget")) {
    return (b.daily_budget_usd as number) - (b.expected_current_daily_budget_usd as number);
  }
  if (o.exec_class.startsWith("meta_ads.duplicate_")) return b.daily_budget_usd as number;
  if (o.exec_class.endsWith("set_status")) {
    const id = (b.object_id ?? b.campaign_id) as string;
    return objects.find((x) => x.id === id)?.daily_budget_usd ?? 0;
  }
  return 0;
}

beforeEach(() => {
  loadPausedByFounder.mockReset();
  _resetSpendControllerCaches();
  _resetMetaUsage();
});

describe("X Ads share the controller's spending capacity", () => {
  it("includes X capacity when computing room for other channels", () => {
    expect(liveCapacityUsd(inv([adSet("s1")], [], { x: { connected: true, capacity_usd: 20 } }), NOW, new Set())).toBe(120);
  });
  it("unreadable X capacity prevents automatic spend increases on another platform", async () => {
    const f = fake({ inventory: inv([adSet("s1")]) });
    f.deps.readXCapacity = async () => ({ connected: true, capacity_usd: null });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.filter(isGapOrder)).toEqual([]);
  });
});

describe("acceptance 1: the 1 Oct shape grows what it can in one run", () => {
  it("raises, and copies at most each source's own budget", async () => {
    const objects = [
      adSet("s1", { results7d: 70 }),
      adSet("s2", { results7d: 58 }),
      adSet("s3", { results7d: 50 }),
      adSet("s4", { daily_budget_usd: 50, spend7d_usd: 0, spend_days7d: 0, results7d: 0, has_live_ads: false, has_any_ads: false, created_at: "2026-10-02T14:30:00Z" }),
    ];
    const f = fake({ inventory: inv(objects) });
    const out = await runSpendControllerForTenant(T, NOW, f.deps);
    expect(out.outcome).toBe("ran");
    const before = liveCapacityUsd(inv(objects), NOW, new Set());
    expect(before).toBe(350);
    const added = f.submitted.filter(isGapOrder).reduce((s, o) => s + addedBy(o, objects), 0);
    expect(added).toBeGreaterThan(0);
    expect(before + added).toBeLessThan(OCT1.daily_target_usd * OVERBOOK);
    const raises = f.submitted.filter((o) => o.exec_class === "meta_ads.update_ad_set_budget");
    expect(raises.length).toBeGreaterThan(0);
    for (const r of raises) {
      const b = r.body as { daily_budget_usd: number; expected_current_daily_budget_usd: number };
      expect(b.daily_budget_usd).toBeLessThanOrEqual(2 * b.expected_current_daily_budget_usd);
      expect(b.daily_budget_usd).toBeGreaterThan(b.expected_current_daily_budget_usd);
    }
    const copies = f.submitted.filter((o) => o.exec_class === "meta_ads.duplicate_ad_set");
    expect(copies.length).toBeGreaterThan(0);
    for (const c of copies) {
      const b = c.body as { source_ad_set_id: string; daily_budget_usd: number };
      expect(b.daily_budget_usd).toBeLessThanOrEqual(objects.find((o) => o.id === b.source_ad_set_id)!.daily_budget_usd as number);
    }
    for (const o of f.submitted) {
      expect((o.body as { status?: string }).status).not.toBe("PAUSED");
    }
    expect(copies).toHaveLength(1);
    expect(copies[0]!.body).toMatchObject({ places: [{ type: "region", key: "9001" }] });
    expect(f.woke).toBe(1);
  });

  it("the required line is daily target x 1.2 plus the debt spread over the days left", () => {
    expect(requiredDailyUsd({ daily_target_usd: 100, delivery_debt_usd: 300, days_left: 30 })).toBe(130);
    expect(requiredDailyUsd({ daily_target_usd: 100, delivery_debt_usd: 0, days_left: 0 })).toBe(120);
  });

  it("an object outside 1.5x the median cost per result is not raised", () => {
    const objects = [adSet("good", { results7d: 70 }), adSet("ok", { results7d: 60 }), adSet("bad", { results7d: 10 })];
    const plan = planGapOrders({ pace: OCT1, inv: inv(objects), now: NOW, dwell: new Set(), recentlyOrdered: new Set(), enableSafe: new Set() });
    const raised = plan.orders.filter((o) => o.exec_class === "meta_ads.update_ad_set_budget").map((o) => o.body.ad_set_id);
    expect(raised).toContain("good");
    expect(raised).not.toContain("bad");
  });

  it("a campaign that holds the budget is raised on the campaign first, then copied as its campaign", () => {
    const objects = [adSet("s1", { budget_on_campaign: true, daily_budget_usd: null }), campaign("c1", { daily_budget_usd: 200, spend7d_usd: 1400 })];
    const plan = planGapOrders({ pace: OCT1, inv: inv(objects), now: NOW, dwell: new Set(), recentlyOrdered: new Set(), enableSafe: new Set(), copyRegions: [OPEN_REGION] });
    expect(plan.orders.map((o) => o.exec_class)).toEqual(["meta_ads.update_campaign_budget", "meta_ads.duplicate_campaign"]);
    expect(plan.orders[0]!.body).toMatchObject({ campaign_id: "c1", expected_current_daily_budget_usd: 200, daily_budget_usd: 400 });
    expect(plan.orders[0]!.body.ad_set_id).toBeUndefined();
    expect(plan.orders[1]!.body.source_campaign_id).toBe("c1");
  });

  it("an ad set under a campaign budget is never raised as an ad set", () => {
    const objects = [adSet("s1", { budget_on_campaign: true, daily_budget_usd: null }), campaign("c1", { daily_budget_usd: 200, spend7d_usd: 1400 })];
    const plan = planGapOrders({ pace: OCT1, inv: inv(objects), now: NOW, dwell: new Set(), recentlyOrdered: new Set(), enableSafe: new Set() });
    expect(plan.orders.some((o) => o.exec_class === "meta_ads.update_ad_set_budget")).toBe(false);
  });
});

describe("acceptance 9: stale spend data never cuts or pauses", () => {
  it("logs and continues with increases only", async () => {
    const objects = [adSet("s1"), adSet("s2", { results7d: 5, spend7d_usd: 700 })];
    const f = fake({ inventory: inv(objects), pace: { ...OCT1, data_fresh: false } });
    const out = await runSpendControllerForTenant(T, NOW, f.deps);
    expect(out).toMatchObject({ outcome: "ran", data_fresh: false });
    expect(f.logs.some((l) => l.code === "cgo.spend_controller_stale")).toBe(true);
    for (const o of f.submitted) {
      const b = o.body as { status?: string; daily_budget_usd?: number; expected_current_daily_budget_usd?: number };
      expect(b.status).not.toBe("PAUSED");
      if (b.expected_current_daily_budget_usd !== undefined) expect(b.daily_budget_usd).toBeGreaterThan(b.expected_current_daily_budget_usd);
    }
  });
});

describe("stale spend tells Zavi's ops and the founder (#3979 option 1)", () => {
  it("calls the stale note once per stale hour, and a failed note never stops the hour", async () => {
    const noteStale = vi.fn(async () => {
      throw new Error("insert failed");
    });
    const f = fake({ inventory: inv([adSet("s1")]), pace: { ...OCT1, data_fresh: false } });
    const out = await runSpendControllerForTenant(T, NOW, { ...f.deps, noteStale });
    expect(noteStale).toHaveBeenCalledWith(T, NOW);
    expect(out).toMatchObject({ outcome: "ran" });
    const fresh = fake({ inventory: inv([adSet("s1")]) });
    const quiet = vi.fn(async () => undefined);
    await runSpendControllerForTenant(T, NOW, { ...fresh.deps, noteStale: quiet });
    expect(quiet).not.toHaveBeenCalled();
  });
});

describe("must not touch", () => {
  it("a tenant not on Autopilot with a budget: nothing read, nothing written", async () => {
    const f = fake({ inventory: inv([adSet("s1")]), running: false });
    const out = await runSpendControllerForTenant(T, NOW, f.deps);
    expect(out).toEqual({ tenant_id: T, outcome: "skipped", why: "not_running_ads" });
    expect(f.submitted).toHaveLength(0);
    expect(f.reads).toEqual({ meta: 0, google: 0 });
    expect(f.woke).toBe(0);
  });

  it("D4: a budget test that ends with Autopilot off still gets its revert card checked", async () => {
    const f = fake({ inventory: inv([adSet("s1")]), running: false });
    const monitor = vi.fn(async () => ({ filed: [] }));
    await runSpendControllerForTenant(T, NOW, { ...f.deps, monitorBudgetTests: monitor });
    expect(monitor).toHaveBeenCalledWith(T, NOW);
    expect(f.submitted).toHaveLength(0);
  });

  it("an object the founder paused is never switched on", async () => {
    const paused = adSet("fp", { active: false, paused_self: true, spend7d_usd: 0, spend_days7d: 0, results7d: 0 });
    const f = fake({ inventory: inv([paused]), enableSafe: [] });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.filter((o) => o.exec_class.endsWith("set_status"))).toHaveLength(0);
    const g = fake({ inventory: inv([paused]), enableSafe: [dwellKeyOf("meta", "fp")] });
    await runSpendControllerForTenant(T, NOW, g.deps);
    expect(g.submitted.filter((o) => o.exec_class === "meta_ads.set_status").map((o) => o.body)).toEqual([expect.objectContaining({ object_id: "fp", status: "ACTIVE" })]);
  });

  it("the default owner check passes only Zavi's own pauses (pausedByFounder false)", async () => {
    const objs = [adSet("mine", { paused_self: true }), adSet("founder", { paused_self: true }), adSet("outside", { paused_self: true })];
    loadPausedByFounder.mockImplementation(async (_t: string, _p: string, id: string) => ({ pausedByFounder: id === "mine" ? false : id === "founder" ? true : null, firstOwnEnable: false }));
    const safe = await defaultControllerDeps.enableSafe(T, objs);
    expect([...safe]).toEqual([dwellKeyOf("meta", "mine")]);
  });

  it("re-running in the same hour orders the same keys, and after they land nothing new", async () => {
    const objects = [adSet("s1"), adSet("s2")];
    const a = fake({ inventory: inv(objects) });
    await runSpendControllerForTenant(T, NOW, a.deps);
    const b = fake({ inventory: inv(objects) });
    await runSpendControllerForTenant(T, new Date(NOW.getTime() + 10 * 60_000), b.deps);
    expect(b.submitted.map((o) => o.idempotency_key)).toEqual(a.submitted.map((o) => o.idempotency_key));
    for (const o of a.submitted) expect(o.idempotency_key).toBe(`${T}:${o.dwell_key}:2026-10-02T15`);
    const c = fake({ inventory: inv(objects), dwell: a.submitted.map((o) => o.dwell_key!) });
    await runSpendControllerForTenant(T, NOW, c.deps);
    expect(c.submitted.filter((o) => a.submitted.some((p) => p.dwell_key === o.dwell_key))).toHaveLength(0);
  });

  it("a just-changed object counts at its full budget (no churn the hour after a raise)", () => {
    const o = adSet("s1", { daily_budget_usd: 200, spend7d_usd: 700 });
    expect(liveCapacityUsd(inv([o]), NOW, new Set())).toBe(100);
    expect(liveCapacityUsd(inv([o]), NOW, new Set([dwellKeyOf("meta", "s1")]))).toBe(200);
  });
});

describe("where the money goes", () => {
  it("Google with no conversions in 30 days is not raised while Meta can take it", () => {
    const g = adSet("g1", { platform: "google", level: "campaign", campaign_id: "g1", results7d: 0, result_kind: "clicks", has_live_ads: null, has_any_ads: null });
    const i = inv([adSet("m1")], [g]);
    i.google.conversions30d = 0;
    const plan = planGapOrders({ pace: OCT1, inv: i, now: NOW, dwell: new Set(), recentlyOrdered: new Set(), enableSafe: new Set() });
    expect(plan.orders.some((o) => o.channel_slug === "google_ads")).toBe(false);
    expect(plan.orders.some((o) => o.channel_slug === "meta_ads")).toBe(true);
  });

  it("no inventory left to grow: the CGO is woken with the debt", async () => {
    const f = fake({ inventory: inv([]), audience: { id: "aud1", count: 100 } });
    const out = await runSpendControllerForTenant(T, NOW, f.deps);
    expect(out).toMatchObject({ outcome: "ran", woke_cgo: true });
    expect(f.woke).toBe(1);
  });

  it("every order held by the gate also wakes the CGO", async () => {
    const f = fake({ inventory: inv([adSet("s1")]), submit: () => ({ ok: false, why: "held:learning_lock" }) });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.woke).toBe(1);
    expect(f.logs.some((l) => l.code === "cgo.spend_controller_order_held")).toBe(true);
  });

  it("at pace: no gap orders and no wake", async () => {
    const objects = Array.from({ length: 12 }, (_, k) => adSet(`s${k}`));
    const f = fake({ inventory: inv(objects), audience: { id: "aud1", count: 100 } });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.filter(isGapOrder)).toHaveLength(0);
    expect(f.woke).toBe(0);
  });
});

describe("C5: retargeting and creative supply", () => {
  const live = () => Array.from({ length: 12 }, (_, k) => adSet(`s${k}`));

  it("no website audience: it is created from the pixel", async () => {
    const f = fake({ inventory: inv(live()), audience: null });
    await runSpendControllerForTenant(T, NOW, f.deps);
    const body = f.submitted.find((o) => o.exec_class === "meta_ads.create_custom_audience")?.body;
    expect(body).toEqual({ kind: "website_visitors", retention_days: 30, name: websiteAudienceName(30) });
    expect(refsFromPayload(body).names).toEqual([websiteAudienceName(30)]);
    expect(createCustomAudienceBodySchema.parse(body).name).toBe("Website visitors, 30 days");
  });

  it("an audience under ~1K people: no retargeting ad set, the money stays in prospecting", async () => {
    const f = fake({ inventory: inv(live()), audience: { id: "aud1", count: 400 } });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.some((o) => o.exec_class === "meta_ads.create_ad_set")).toBe(false);
  });

  it("a big enough audience and no retargeting ad set: one is built at ~12.5% of the daily target", async () => {
    const f = fake({ inventory: inv(live()), audience: { id: "aud1", count: 5000 } });
    await runSpendControllerForTenant(T, NOW, f.deps);
    const c = f.submitted.find((o) => o.exec_class === "meta_ads.create_ad_set");
    expect(c?.body).toMatchObject({ campaign_id: "c1", targeting: { custom_audiences: [{ id: "aud1" }] } });
    expect((c!.body as { daily_budget_usd: number }).daily_budget_usd).toBeCloseTo(OCT1.daily_target_usd * 0.125, 1);
  });

  it("a live campaign with few new ads this week gets a Zavi-generated variant; a fatigued ad set first", async () => {
    const objects = [...live(), adSet("tired", { campaign_id: "c2", results7d: 60 })];
    const f = fake({ inventory: inv(objects), fatigued: ["tired"], audience: { id: "aud1", count: 100 } });
    await runSpendControllerForTenant(T, NOW, f.deps);
    const ads = f.submitted.filter((o) => o.exec_class === "meta_ads.create_ad");
    expect(ads.length).toBeGreaterThan(0);
    expect(ads.every((o) => (o.body as { source: string }).source === "zavi_generated" && !!(o.body as { image_url?: string }).image_url)).toBe(true);
    expect(ads.find((o) => o.dwell_key === "creative:c2")?.body).toMatchObject({ ad_set_id: "tired" });
  });

  it("a Meta account that cannot take an ad holds the gap planner's duplicates too; budget raises still go out", async () => {
    const objects = [
      adSet("s1", { results7d: 70 }),
      adSet("s2", { results7d: 58 }),
      adSet("s3", { results7d: 50 }),
    ];
    const f = fake({ inventory: inv(objects) });
    f.deps.creative = () => ({
      fatiguedAdSets: async () => new Set(),
      readCreativeCopy: async () => null,
      generateImage: async () => null,
      adReadiness: async () => ({ ok: false as const, code: "meta_ads_account_not_writable" }),
    });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.some((o) => o.exec_class === "meta_ads.duplicate_ad_set" || o.exec_class === "meta_ads.duplicate_campaign")).toBe(false);
    expect(f.submitted.some((o) => o.exec_class === "meta_ads.update_ad_set_budget")).toBe(true);
    expect(f.logs.find((l) => l.code === "cgo.spend_controller_ran")?.message).toMatch(/ad-creating Meta order(s)? held: Meta cannot take a new ad yet \(meta_ads_account_not_writable\)/);
  });

  it("a Meta account that cannot take an ad holds the retargeting ad too, with ONE readiness check for the whole run", async () => {
    const rt1 = adSet("rt1", { audience_ids: ["aud1"], active: false, paused_self: true, has_live_ads: false, has_any_ads: true, has_ready_ads: false, spend7d_usd: 0, spend3d_usd: 0, spend_days7d: 0, results7d: 0 });
    let checks = 0;
    const f = fake({ inventory: inv([...live(), rt1]), audience: { id: "aud1", count: 5000 } });
    f.deps.creative = () => ({
      fatiguedAdSets: async () => new Set(),
      readCreativeCopy: async (id) => ({ source_ad_id: `ad-${id}`, primary_text: "Words", headline: "Head", link_url: "https://example.com" }),
      generateImage: async () => "https://signed.example/img.jpg",
      adReadiness: async () => (checks++, { ok: false as const, code: "meta_ads_no_page" }),
    });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.some((o) => o.exec_class === "meta_ads.create_ad")).toBe(false);
    expect(checks).toBe(1);
    expect(f.logs.find((l) => l.code === "cgo.spend_controller_ran")?.message).toContain("retargeting ad held: Meta cannot take a new ad yet (meta_ads_no_page)");

    const g = fake({ inventory: inv([...live(), rt1]), audience: { id: "aud1", count: 5000 } });
    g.deps.creative = () => ({
      fatiguedAdSets: async () => new Set(),
      readCreativeCopy: async (id) => ({ source_ad_id: `ad-${id}`, primary_text: "Words", headline: "Head", link_url: "https://example.com" }),
      generateImage: async () => "https://signed.example/img.jpg",
      adReadiness: async () => ({ ok: true as const }),
    });
    await runSpendControllerForTenant(T, NOW, g.deps);
    expect(g.submitted.find((o) => o.exec_class === "meta_ads.create_ad" && (o.body as { ad_set_id?: string }).ad_set_id === "rt1")).toBeTruthy();
  });

  it("a campaign that already got 3 new ads this week and no fatigue gets none", async () => {
    const i = inv([adSet("s1")]);
    i.meta.ads = [1, 2, 3].map((k) => ({ id: `ad${k}`, ad_set_id: "s1", campaign_id: "c1", live: true, created_at: "2026-10-01T00:00:00Z" }));
    const f = fake({ inventory: i, audience: { id: "aud1", count: 100 } });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.some((o) => o.exec_class === "meta_ads.create_ad")).toBe(false);
  });
});

describe("hold upkeep runs once per tenant before any order", () => {
  it("maintainCgoAdHolds runs once, before the first order is placed", async () => {
    const f = fake({ inventory: inv([adSet("s1", { results7d: 70 })]) });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.order.filter((x) => x === "maintain")).toHaveLength(1);
    expect(f.order[0]).toBe("maintain");
    expect(f.order.indexOf("submit")).toBeGreaterThan(0);
  });

  it("a failed upkeep is logged and the run still places its orders", async () => {
    const f = fake({ inventory: inv([adSet("s1", { results7d: 70 })]), maintainHolds: async () => { throw new Error("rpc down"); } });
    const out = await runSpendControllerForTenant(T, NOW, f.deps);
    expect(out.outcome).toBe("ran");
    expect(f.submitted.length).toBeGreaterThan(0);
    expect(f.logs.some((l) => l.code === "cgo.spend_controller_holds_failed")).toBe(true);
  });

  it("not on Autopilot with a budget: no upkeep and nothing else", async () => {
    const f = fake({ inventory: inv([adSet("s1")]), running: false });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.order).toEqual([]);
  });

  it("the default deps wire upkeep to spend-pace's maintainCgoAdHolds", () => {
    expect(typeof defaultControllerDeps.maintainHolds).toBe("function");
  });
});

describe("readFatiguedAdSets uses the real ad-fatigue helper", () => {
  const days = (n: number, impressions: number, clicks: number) =>
    Array.from({ length: n }, (_, k) => ({ impressions: String(impressions), clicks: String(clicks), spend: "10", k }));
  function rows(ad_id: string, adset_id: string, baselineCtrClicks: number, recentCtrClicks: number) {
    const base = days(14, 1000, baselineCtrClicks).map((d, k) => ({ ...d, date_start: `2026-09-${String(11 + k).padStart(2, "0")}` }));
    const recent = days(7, 1000, recentCtrClicks).map((d, k) => ({ ...d, date_start: `2026-09-${String(25 + k).padStart(2, "0")}` }));
    return [...base, ...recent].map(({ k: _k, ...d }) => ({ ...d, ad_id, adset_id }));
  }

  beforeEach(() => fbGetAllPages.mockReset());

  it("an ad whose CTR fell against its own baseline marks its ad set fatigued; a steady one does not", async () => {
    fbGetAllPages.mockResolvedValue([...rows("adA", "tired", 20, 10), ...rows("adB", "steady", 20, 19)]);
    const out = await readFatiguedAdSets(T, ["tired", "steady"], NOW);
    expect([...out]).toEqual(["tired"]);
    const [, path, params] = fbGetAllPages.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(path).toBe("act_1/insights");
    expect(params).toMatchObject({ level: "ad", time_increment: 1 });
    expect(JSON.parse(params.filtering as string)).toEqual([{ field: "adset.id", operator: "IN", value: ["tired", "steady"] }]);
  });

  it("too little data is not fatigue", async () => {
    fbGetAllPages.mockResolvedValue(rows("adA", "quiet", 20, 10).map((r) => ({ ...r, impressions: "10" })));
    expect((await readFatiguedAdSets(T, ["quiet"], NOW)).size).toBe(0);
  });

  it("no ad sets: no read", async () => {
    expect((await readFatiguedAdSets(T, [], NOW)).size).toBe(0);
    expect(fbGetAllPages).not.toHaveBeenCalled();
  });
});

describe("a failed order does not block the object for a day (A F5)", () => {
  const row = (key: string, over: Record<string, unknown>) => ({ body: { cgo_dwell_key: key }, status: "pending", exec_status: "queued", exec_result: null, ...over });

  it("only a failure sorted as definite (blocked on us, needs the founder) is left out of the dwell", () => {
    expect(orderDefinitelyFailed(row("k", { exec_status: "failed", exec_result: { error: "Meta said 400 (#100)", bucket: "blocked_on_us" } }))).toBe(true);
    expect(orderDefinitelyFailed(row("k", { exec_status: "failed", exec_result: { error: "token expired", bucket: "needs_founder", fix: "reconnect" } }))).toBe(true);
    for (const kept of [
      { exec_status: "failed", exec_result: { error: "Meta Graph API timed out", bucket: "temporary" } },
      { exec_status: "failed", exec_result: { error: "Meta said 400" } },
      { exec_status: "queued" },
      { exec_status: "dispatching" },
      { exec_status: "executed", status: "acted" },
      { exec_status: "failed", exec_result: { code: "exec_partial" } },
      { exec_status: "failed", exec_result: { code: "exec_outcome_unknown" } },
      { exec_status: "failed", exec_result: { interrupted: true, lease_expired: true } },
      { exec_status: "failed", exec_result: { held_for_founder: true } },
      { exec_status: "failed", exec_result: { error: "cap_refuse: ad_budget_over_month", bucket: "needs_founder", fix: "ad_budget" } },
      { exec_status: null, status: "rejected" },
    ]) {
      expect(orderDefinitelyFailed(row("k", kept)), JSON.stringify(kept)).toBe(false);
    }
  });

  it("readRecentOrderKeys: the object whose raise was definitely refused is planned again next hour; in-flight, timed-out and maybe-landed ones are not", async () => {
    orderRows = [
      row(dwellKeyOf("google", "g-failed"), { exec_status: "failed", exec_result: { error: "RESOURCE_NOT_FOUND", bucket: "blocked_on_us" } }),
      row("dup:120200000001", { exec_status: "failed", exec_result: { error: "timed out", bucket: "temporary" } }),
      row(dwellKeyOf("google", "g-queued"), { exec_status: "queued" }),
      row(dwellKeyOf("meta", "m-unknown"), { exec_status: "failed", exec_result: { code: "exec_outcome_unknown" } }),
      row(dwellKeyOf("meta", "m-done"), { exec_status: "executed", status: "acted" }),
    ];
    const keys = await readRecentOrderKeys(T, NOW, 24);
    expect([...keys].sort()).toEqual(["dup:120200000001", dwellKeyOf("google", "g-queued"), dwellKeyOf("meta", "m-done"), dwellKeyOf("meta", "m-unknown")].sort());

    const g = adSet("g-failed", { platform: "google", level: "campaign", campaign_id: "g-failed", has_live_ads: null, has_any_ads: null, has_ready_ads: null });
    const plan = planGapOrders({ pace: OCT1, inv: inv([], [g], { meta: { connected: false, objects: [], ads: [] } }), now: NOW, dwell: keys, recentlyOrdered: keys, enableSafe: new Set() });
    expect(plan.orders.map((o) => o.body.campaign_id)).toContain("g-failed");
  });

  it("readRecentOrderKeys: a raise queued for hours holds its object for 24h from when it RAN, the gate's own spacing clock (upcar-ai 2026-10-28)", async () => {
    const tick = new Date("2026-10-29T01:41:00Z");
    const queuedLong = dwellKeyOf("meta", "120258729006520059");
    const old = dwellKeyOf("meta", "old-done");
    orderRows = [
      row(queuedLong, { exec_status: "executed", status: "acted", proposed_at: "2026-10-28T00:41:58Z", exec_claimed_at: "2026-10-28T14:54:27Z", executed_at: "2026-10-28T14:54:32Z" }),
      row(old, { exec_status: "executed", status: "acted", proposed_at: "2026-10-27T00:00:00Z", exec_claimed_at: "2026-10-27T00:00:10Z", executed_at: "2026-10-27T00:00:20Z" }),
    ];
    ledgerFilters.length = 0;
    const keys = await readRecentOrderKeys(T, tick, 24);
    expect([...keys]).toEqual([queuedLong]);
    const since = new Date(tick.getTime() - 24 * 3_600_000).toISOString();
    expect(ledgerFilters).toContain(`channel_actions.or(proposed_at.gte.${since},exec_claimed_at.gte.${since},executed_at.gte.${since})`);

    const best = adSet("120258729006520059", { daily_budget_usd: 178.8, spend7d_usd: 1251.6, spend3d_usd: 536.4 });
    const plan = planGapOrders({ pace: OCT1, inv: inv([best]), now: tick, dwell: keys, recentlyOrdered: keys, enableSafe: new Set() });
    expect(plan.orders.filter((o) => o.body.ad_set_id === "120258729006520059")).toHaveLength(0);
    const open = planGapOrders({ pace: OCT1, inv: inv([best]), now: tick, dwell: new Set(), recentlyOrdered: new Set(), enableSafe: new Set() });
    expect(open.orders.filter((o) => o.body.ad_set_id === "120258729006520059")).toHaveLength(1);
  });
});

describe("a paused object is ready only with an ad that can deliver (A F6)", () => {
  it("metaAdReady: rejected or switched-off ads are not ready; one held back only by its paused ad set is", () => {
    expect(metaAdReady({ effective_status: "DISAPPROVED", configured_status: "ACTIVE" })).toBe(false);
    expect(metaAdReady({ effective_status: "WITH_ISSUES", configured_status: "ACTIVE" })).toBe(false);
    expect(metaAdReady({ effective_status: "PAUSED", configured_status: "PAUSED" })).toBe(false);
    expect(metaAdReady({ effective_status: "ADSET_PAUSED", configured_status: "PAUSED" })).toBe(false);
    expect(metaAdReady({ effective_status: "ADSET_PAUSED", configured_status: "ACTIVE" })).toBe(true);
    expect(metaAdReady({ effective_status: "PENDING_REVIEW", configured_status: "ACTIVE" })).toBe(true);
    expect(metaAdReady({ effective_status: "ACTIVE", configured_status: "ACTIVE" })).toBe(true);
  });

  it("Zavi's paused ad set whose only ad was rejected is not switched on: it gets a fresh ad first", async () => {
    const rejected = adSet("zp", { active: false, paused_self: true, spend7d_usd: 0, spend3d_usd: 0, spend_days7d: 0, results7d: 0, has_live_ads: false, has_any_ads: true, has_ready_ads: false });
    const f = fake({ inventory: inv([adSet("s1"), rejected]), enableSafe: [dwellKeyOf("meta", "zp")], audience: { id: "aud1", count: 100 } });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.filter((o) => o.exec_class === "meta_ads.set_status" && o.body.object_id === "zp")).toHaveLength(0);
    const ad = f.submitted.find((o) => o.exec_class === "meta_ads.create_ad" && o.body.ad_set_id === "zp");
    expect(ad).toMatchObject({ dwell_key: "creative:zp", body: { source: "zavi_generated", image_url: "https://signed.example/img.jpg" } });
    const ready = { ...rejected, has_ready_ads: true };
    const g = fake({ inventory: inv([adSet("s1"), ready]), enableSafe: [dwellKeyOf("meta", "zp")], audience: { id: "aud1", count: 100 } });
    await runSpendControllerForTenant(T, NOW, g.deps);
    expect(g.submitted.filter((o) => o.exec_class === "meta_ads.set_status").map((o) => o.body.object_id)).toEqual(["zp"]);
  });

  it("the founder's paused ad set with no ready ad gets no new ad either", async () => {
    const rejected = adSet("fp", { active: false, paused_self: true, spend7d_usd: 0, spend3d_usd: 0, spend_days7d: 0, results7d: 0, has_live_ads: false, has_any_ads: true, has_ready_ads: false });
    const f = fake({ inventory: inv([adSet("s1"), rejected]), enableSafe: [], audience: { id: "aud1", count: 100 } });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.filter((o) => o.body.ad_set_id === "fp" || o.body.object_id === "fp")).toHaveLength(0);
  });

  it("readMetaInventory reads each ad's configured status and the last 3 days of spend, in one structural call", async () => {
    fbGetAllPages.mockReset();
    fbGetAllPages.mockImplementation(async (_t: string, path: string, q: Record<string, unknown>) => {
      expect(path).toBe("act_1/adsets");
      expect(String(q.fields)).toContain("ads.limit(100){id,campaign_id,effective_status,configured_status,created_time}");
      expect(String(q.fields)).toContain("campaign{id,name,effective_status,status,daily_budget,created_time}");
      const c1 = { id: "c1", effective_status: "ACTIVE", status: "ACTIVE", daily_budget: null };
      return [
        { id: "rej", campaign_id: "c1", campaign: c1, daily_budget: "5000", effective_status: "PAUSED", configured_status: "PAUSED", ads: { data: [{ id: "a1", campaign_id: "c1", effective_status: "DISAPPROVED", configured_status: "ACTIVE" }] } },
        { id: "ok", campaign_id: "c1", campaign: c1, daily_budget: "5000", effective_status: "PAUSED", configured_status: "PAUSED", ads: { data: [{ id: "a2", campaign_id: "c1", effective_status: "ADSET_PAUSED", configured_status: "ACTIVE" }] } },
      ];
    });
    fetchMetaDailySeries.mockReset().mockResolvedValue({
      rows: [
        { ad_set_id: "ok", date: "2026-09-25", spend_usd: 70, conversions: 0, clicks: 0, judged_on: "conversions" },
        { ad_set_id: "ok", date: "2026-09-30", spend_usd: 30, conversions: 0, clicks: 0, judged_on: "conversions" },
        { ad_set_id: "ok", date: "2026-10-01", spend_usd: 30, conversions: 0, clicks: 0, judged_on: "conversions" },
      ],
    });
    fbGet.mockReset().mockResolvedValue({ timezone_name: "America/Los_Angeles" });
    const m = await readMetaInventory(T, NOW);
    const by = new Map(m.objects.map((o) => [o.id, o]));
    expect(by.get("rej")).toMatchObject({ has_any_ads: true, has_ready_ads: false });
    expect(by.get("ok")).toMatchObject({ has_ready_ads: true, spend7d_usd: 130, spend3d_usd: 60 });
    expect(m.ads.map((x) => [x.id, x.ad_set_id])).toEqual([["a1", "rej"], ["a2", "ok"]]);
    expect(fbGetAllPages).toHaveBeenCalledTimes(1);
  });
});

describe("live capacity: 24h grace, then observed delivery (D6)", () => {
  it("an object copied 30 hours ago that has spent nothing counts 0, so the gap stays open", () => {
    const copy = adSet("copy", { daily_budget_usd: 200, spend7d_usd: 0, spend3d_usd: 0, spend_days7d: 0, results7d: 0, created_at: "2026-10-01T09:41:00Z" });
    expect(objectCapacityUsd(copy, NOW, new Set())).toBe(0);
    expect(objectCapacityUsd({ ...copy, created_at: "2026-10-02T09:41:00Z" }, NOW, new Set())).toBe(200);
    expect(objectCapacityUsd(copy, NOW, new Set([dwellKeyOf("meta", "copy")]))).toBe(200);
  });

  it("after the grace an object counts what it spends, never above its budget", () => {
    expect(objectCapacityUsd(adSet("s", { daily_budget_usd: 200, spend3d_usd: 240 }), NOW, new Set())).toBe(80);
    expect(objectCapacityUsd(adSet("s", { daily_budget_usd: 50, spend3d_usd: 240 }), NOW, new Set())).toBe(50);
  });
});

describe("Meta delivery is read on the ad account's own clock", () => {
  const structure = async () => [
    { id: "s1", campaign_id: "c1", campaign: { id: "c1", effective_status: "ACTIVE", status: "ACTIVE", daily_budget: null }, daily_budget: "10000", effective_status: "ACTIVE", configured_status: "ACTIVE", ads: { data: [] } },
  ];
  const series = async (_t: string, q: { time_range?: { since: string; until: string } }) => ({
    rows: ["2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"]
      .filter((d) => !q.time_range || (d >= q.time_range.since && d <= q.time_range.until))
      .map((date) => ({ ad_set_id: "s1", date, spend_usd: Number(date.slice(8)), conversions: 0, clicks: 0, judged_on: "conversions" })),
  });

  it("a Los Angeles account at 02:00 UTC is still on yesterday: its partial day is not read as a whole one", async () => {
    fbGetAllPages.mockReset().mockImplementation(structure);
    fbGet.mockReset().mockResolvedValue({ timezone_name: "America/Los_Angeles" });
    fetchMetaDailySeries.mockReset().mockImplementation(series);
    const m = await readMetaInventory(T, new Date("2026-10-03T02:00:00Z"));
    expect(fetchMetaDailySeries.mock.calls[0]![1]).toMatchObject({ time_range: { since: "2026-09-22", until: "2026-10-01" } });
    expect(m.objects.find((o) => o.id === "s1")).toMatchObject({ spend3d_usd: 60 });
  });

  it("a Sydney account at 20:00 UTC is already on tomorrow: three whole days, never four", async () => {
    fbGetAllPages.mockReset().mockImplementation(structure);
    fbGet.mockReset().mockResolvedValue({ timezone_name: "Australia/Sydney" });
    fetchMetaDailySeries.mockReset().mockImplementation(series);
    const m = await readMetaInventory(T, new Date("2026-10-02T20:00:00Z"));
    expect(fetchMetaDailySeries.mock.calls[0]![1]).toMatchObject({ time_range: { since: "2026-09-23", until: "2026-10-02" } });
    expect(m.objects.find((o) => o.id === "s1")).toMatchObject({ spend3d_usd: 33 });
  });

  it("an account whose zone Meta does not report is not read (never guessed as UTC)", async () => {
    fbGetAllPages.mockReset().mockImplementation(structure);
    fbGet.mockReset().mockResolvedValue({});
    await expect(readMetaInventory(T, NOW)).rejects.toThrow(/time zone/);
  });

  it("readLedgerCapacity counts the ledger on a zone already read, and never calls Meta for it", async () => {
    fbGetAllPages.mockReset().mockImplementation(structure);
    fbGet.mockReset().mockResolvedValue({ timezone_name: "America/Los_Angeles" });
    fetchMetaDailySeries.mockReset().mockImplementation(series);
    const at = new Date("2026-10-03T02:00:00Z");
    await readMetaInventory(T, at);
    fbGet.mockClear();
    ledgerRows = {
      ad_campaigns: [{ platform: "meta", object_id: "s1", status: "ACTIVE", budget_kind: "daily", budget_usd: 100 }],
      ad_spend_daily: [
        ...["2026-09-29", "2026-09-30", "2026-10-01"].map((d) => ({ platform: "meta", object_id: "s1", spend_date: d, amount_usd: 60 })),
        { platform: "meta", object_id: "s1", spend_date: "2026-10-02", amount_usd: 6 },
      ],
    };
    expect(await readLedgerCapacity(T, "meta", at)).toBe(60);
    expect(fbGet).not.toHaveBeenCalled();
    ledgerRows = {};
  });
});

describe("Google delivery is read on the account's own clock (review F3)", () => {
  it("a UTC+10 account at 16:41 UTC: three whole local days, the same bounds in the query and the sum", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T16:41:00Z"));
    try {
      gadsSearch.mockReset();
      const queries: string[] = [];
      gadsSearch.mockImplementation(async (_t: string, q: string) => {
        queries.push(q);
        if (q.includes("customer.time_zone")) return [{ customer: { timeZone: "Australia/Brisbane" } }];
        if (q.includes("campaign_budget.amount_micros")) {
          return [{ campaign: { id: "777", name: "Search", status: "ENABLED", startDate: "2026-08-01" }, campaignBudget: { amountMicros: "100000000", period: "DAILY", explicitlyShared: false } }];
        }
        if (q.includes("segments.date BETWEEN") || q.includes("LAST_7_DAYS")) {
          return ["2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"].map((date) => ({
            campaign: { id: "777" },
            segments: { date },
            metrics: { costMicros: "30000000", conversions: 1, clicks: 10 },
          }));
        }
        return [{ metrics: { conversions: 7 } }];
      });
      const g = await readGoogleInventory(T);
      const perf = queries.find((q) => q.includes("metrics.cost_micros"))!;
      expect(perf).toContain("segments.date BETWEEN '2026-09-23' AND '2026-10-02'");
      const o = g.objects[0]!;
      expect(o.spend3d_usd).toBe(90);
      expect(objectCapacityUsd(o, new Date("2026-10-02T16:41:00Z"), new Set())).toBe(30);
    } finally {
      vi.useRealTimers();
    }
  });
});

const META_RATE_LIMIT = new Error(
  'Meta Ads request failed: 400 {"error":{"message":"User request limit reached","type":"OAuthException","is_transient":false,"code":17,"error_subcode":2446079,"error_user_title":"Ad Account Has Too Many API Calls"}}',
);
const google = (id: string, over: Partial<AdObject> = {}) => campaign(id, { platform: "google", campaign_id: id, has_live_ads: null, has_any_ads: null, has_ready_ads: null, ...over });
const codes = (f: Fake) => f.logs.map((l) => l.code);

describe("Google: the v25 field rename (campaign.start_date -> campaign.start_date_time)", () => {
  const V25_FIELDS = new Set([
    "campaign.id",
    "campaign.name",
    "campaign.status",
    "campaign.start_date_time",
    "campaign.end_date_time",
    "campaign.advertising_channel_type",
    "campaign.primary_status",
    "campaign.primary_status_reasons",
    "segments.conversion_action_category",
    "campaign_budget.amount_micros",
    "campaign_budget.period",
    "campaign_budget.explicitly_shared",
    "segments.date",
    "metrics.cost_micros",
    "metrics.conversions",
    "metrics.conversions_value",
    "metrics.clicks",
    "customer.time_zone",
  ]);
  const selected = (q: string) => q.slice(q.indexOf("SELECT") + 6, q.indexOf("FROM")).split(",").map((f) => f.trim()).filter(Boolean);

  it("every field it selects exists in v25 (a removed field fails the whole read), and the start time maps to created_at", async () => {
    gadsSearch.mockReset();
    const queries: string[] = [];
    gadsSearch.mockImplementation(async (_t: string, q: string) => {
      queries.push(q);
      const bad = selected(q).find((f) => !V25_FIELDS.has(f));
      if (bad) throw new Error(`Google Ads search failed: 400 UNRECOGNIZED_FIELD Unrecognized field in the query: '${bad}'`);
      if (q.includes("customer.time_zone")) return [{ customer: { timeZone: "America/Los_Angeles" } }];
      if (q.includes("campaign_budget.amount_micros")) {
        return [{ campaign: { id: "777", name: "Search", status: "ENABLED", startDateTime: "2026-10-01 09:30:00" }, campaignBudget: { amountMicros: "100000000", period: "DAILY", explicitlyShared: false } }];
      }
      return [];
    });
    const g = await readGoogleInventory(T);
    expect(queries.length).toBeGreaterThanOrEqual(3);
    for (const q of queries) for (const f of selected(q)) expect(V25_FIELDS.has(f), f).toBe(true);
    expect(queries.join(" ")).not.toMatch(/campaign\.(start|end)_date\b/);
    expect(g.objects[0]).toMatchObject({ id: "777", created_at: "2026-10-01T16:30:00Z" });
  });
});

describe("Google: a failed brand read holds only what could be brand search", () => {
  it("must catch: the Search campaign is marked brand (held); must not catch: Performance Max is not", async () => {
    gadsSearch.mockReset();
    gadsSearch.mockImplementation(async (_t: string, q: string) => {
      if (q.includes("customer.time_zone")) return [{ customer: { timeZone: "America/Los_Angeles" } }];
      if (q.includes("advertising_channel_type = 'SEARCH'")) throw new Error("Google Ads search failed: 400 QUERY_ERROR");
      if (q.includes("campaign_budget.amount_micros")) {
        return [
          { campaign: { id: "301", name: "Search", status: "ENABLED", advertisingChannelType: "SEARCH" }, campaignBudget: { amountMicros: "50000000", period: "DAILY", explicitlyShared: false } },
          { campaign: { id: "302", name: "PMax", status: "ENABLED", advertisingChannelType: "PERFORMANCE_MAX" }, campaignBudget: { amountMicros: "50000000", period: "DAILY", explicitlyShared: false } },
        ];
      }
      return [];
    });
    const goalMatch = await import("../ad-goal-match");
    const spy = vi.spyOn(goalMatch, "readGoogleBrandCampaignIds").mockResolvedValue({ error: "Google Ads search failed: 400 QUERY_ERROR" });
    const g = await readGoogleInventory(T);
    spy.mockRestore();
    expect(g.brand_unread).toBe(true);
    expect(g.objects.find((o) => o.id === "301")).toMatchObject({ brand: true, channel_type: "SEARCH" });
    expect(g.objects.find((o) => o.id === "302")?.brand).toBeUndefined();
  });
});

describe("Meta rate limit (code 17 / 2446079): Meta is left alone for the hour", () => {
  it("no Meta orders, Google still runs on the stored Meta capacity, the ran line is logged, the CGO is not woken", async () => {
    const f = fake({
      inventory: inv([], [google("g1", { daily_budget_usd: 100, spend3d_usd: 300 })]),
      readMeta: async () => {
        throw META_RATE_LIMIT;
      },
      ledger: { meta: 300 },
    });
    const r = await runSpendControllerForTenant(T, NOW, f.deps);
    expect(r.outcome).toBe("ran");
    expect(f.submitted.filter((o) => o.channel_slug === "meta_ads")).toEqual([]);
    expect(r.outcome === "ran" && r.capacity_usd).toBe(400);
    expect(f.submitted.some((o) => o.exec_class === "google_ads.update_campaign_budget")).toBe(true);
    expect(f.woke).toBe(0);
    expect(codes(f)).toContain("cgo.spend_controller_ran");
    expect(f.logs.find((l) => l.code === "cgo.spend_controller_read_failed")?.message).toMatch(/^meta \(rate limited/);
    expect(f.logs.filter((l) => l.code === "cgo.spend_controller_read_failed")).toHaveLength(1);
    expect(f.logs.find((l) => l.code === "cgo.spend_controller_ran")?.message).not.toMatch(/no inventory left/);
  });

  it("backs off for the shared cooldown: one probe per window, then Meta is read again after it", async () => {
    const cd = await import("@/services/tools/meta-ads/_cooldown");
    cd._setMetaCooldownStoreForTest(cd._memoryCooldownStore());
    try {
      const f = fake({
        inventory: inv([adSet("s1")]),
        readMeta: async () => {
          throw META_RATE_LIMIT;
        },
      });
      await runSpendControllerForTenant(T, NOW, f.deps);
      expect(f.reads.meta).toBe(1);
      await expect(cd.gateMetaCall("act_1", "reconcile", NOW.getTime() + 60_000)).resolves.toEqual({ probe: true });
      await runSpendControllerForTenant(T, new Date(NOW.getTime() + 2 * 60_000), f.deps);
      expect(f.reads.meta).toBe(1);
      expect(f.submitted).toEqual([]);
      expect(f.woke).toBe(0);
      expect(codes(f).filter((c) => c === "cgo.spend_controller_ran")).toHaveLength(2);
      await runSpendControllerForTenant(T, new Date(NOW.getTime() + 6 * 60_000), f.deps);
      expect(f.reads.meta).toBe(2);
    } finally {
      cd._setMetaCooldownStoreForTest(null);
    }
  });

  it("usage headers at 90%+ after the read: no Meta writes this hour, no wake", async () => {
    const { recordAdAccountUsage } = await import("@/services/tools/meta-ads/_client");
    const f = fake({
      inventory: inv([adSet("s1", { daily_budget_usd: 50, spend7d_usd: 350, spend3d_usd: 150 })]),
      readMeta: async () => {
        recordAdAccountUsage({ headers: { get: (n) => (n === "x-ad-account-usage" ? '{"acc_id_util_pct":95}' : null) } }, "act_1/adsets", T);
        return inv([adSet("s1", { daily_budget_usd: 50, spend7d_usd: 350, spend3d_usd: 150 })]).meta;
      },
    });
    const r = await runSpendControllerForTenant(T, NOW, f.deps);
    expect(r.outcome).toBe("ran");
    expect(f.submitted).toEqual([]);
    expect(f.woke).toBe(0);
    expect(f.logs.find((l) => l.code === "cgo.spend_controller_ran")?.message).toMatch(/meta not changed this hour \(rate limit\)/);
  });

  it("Meta at its limit after the read: the gap Meta would have taken goes to Google instead of being dropped (review F2)", async () => {
    const { recordAdAccountUsage } = await import("@/services/tools/meta-ads/_client");
    const metaSet = adSet("s1", { daily_budget_usd: 300, spend7d_usd: 2100, spend3d_usd: 900, results7d: 700 });
    const g = google("g1", { daily_budget_usd: 300, spend7d_usd: 2100, spend3d_usd: 900, results7d: 700 });
    const f = fake({
      inventory: inv([metaSet], [g]),
      readMeta: async () => {
        recordAdAccountUsage({ headers: { get: (n) => (n === "x-ad-account-usage" ? '{"acc_id_util_pct":95}' : null) } }, "act_1/adsets", T);
        return inv([metaSet]).meta;
      },
    });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.filter((o) => o.channel_slug === "meta_ads")).toEqual([]);
    expect(f.submitted.find((o) => o.exec_class === "google_ads.update_campaign_budget")?.body.daily_budget_usd).toBe(360);
    expect(f.woke).toBe(0);
  });

  it("Meta hits its limit during planning (a retargeting read): the gap is planned again without Meta", async () => {
    const metaSet = adSet("s1", { daily_budget_usd: 300, spend7d_usd: 2100, spend3d_usd: 900, results7d: 700 });
    const g = google("g1", { daily_budget_usd: 300, spend7d_usd: 2100, spend3d_usd: 900, results7d: 700 });
    const f = fake({ inventory: inv([metaSet], [g]) });
    const base = f.deps.retarget;
    f.deps.retarget = (t, now) => ({
      ...base(t, now),
      readWebsiteAudience: async () => {
        await defaultControllerDeps.noteMetaRateLimit(t, now);
        throw META_RATE_LIMIT;
      },
    });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.filter((o) => o.channel_slug === "meta_ads")).toEqual([]);
    expect(f.submitted.find((o) => o.exec_class === "google_ads.update_campaign_budget")?.body.daily_budget_usd).toBe(360);
    expect(f.woke).toBe(0);
  });

  it("isMetaRateLimitError knows the throttling codes and nothing else", () => {
    expect(isMetaRateLimitError(META_RATE_LIMIT)).toBe(true);
    for (const code of [4, 17, 32, 613, 80004]) expect(isMetaRateLimitError(new Error(`x {"error":{"code":${code}}}`))).toBe(true);
    expect(isMetaRateLimitError(new Error('x {"error":{"code":100,"error_subcode":33}}'))).toBe(false);
    expect(isMetaRateLimitError(new Error("Meta Ads needs to be reconnected"))).toBe(false);
  });

  it("parseMetaUsageHeaders takes the worst figure across both headers", () => {
    const h: Record<string, string> = {
      "x-ad-account-usage": '{"acc_id_util_pct":12}',
      "x-business-use-case-usage": '{"123":[{"type":"ads_management","call_count":40,"total_cputime":91,"total_time":10,"estimated_time_to_regain_access":0}]}',
    };
    expect(parseMetaUsageHeaders((n) => h[n] ?? null)).toEqual({ pct: 91, regain_minutes: 0 });
    expect(parseMetaUsageHeaders(() => "not json")).toBeNull();
  });
});

describe("a failed read is never zero inventory", () => {
  it("Google unreadable with no fresh stored read: no gap orders on Meta, no CGO wake, the ran line says why (couple-app)", async () => {
    const f = fake({
      inventory: inv([adSet("s1", { active: false, paused_self: true, spend7d_usd: 0, spend3d_usd: 0, spend_days7d: 0 })]),
      readGoogle: async () => {
        throw new Error('Google Ads authorization has expired or been revoked: 400 {"error":"invalid_grant"}');
      },
      ledger: { google: null },
    });
    const r = await runSpendControllerForTenant(T, NOW, f.deps);
    expect(r.outcome).toBe("ran");
    expect(f.submitted.filter(isGapOrder)).toEqual([]);
    expect(f.woke).toBe(0);
    const ran = f.logs.find((l) => l.code === "cgo.spend_controller_ran")?.message ?? "";
    expect(ran).toMatch(/unread google/);
    expect(ran).toMatch(/gap unknown/);
    expect(ran).not.toMatch(/no inventory left/);
  });

  it("both platforms unreadable (Upcar): the run still logs its ran line, orders nothing and wakes nobody", async () => {
    const f = fake({
      inventory: inv([]),
      readMeta: async () => {
        throw META_RATE_LIMIT;
      },
      readGoogle: async () => {
        throw new Error("Google Ads search failed: 400 UNRECOGNIZED_FIELD");
      },
      ledger: { meta: 250, google: 60 },
    });
    const r = await runSpendControllerForTenant(T, NOW, f.deps);
    expect(r.outcome).toBe("ran");
    expect(f.submitted).toEqual([]);
    expect(f.woke).toBe(0);
    expect(codes(f).filter((c) => c === "cgo.spend_controller_read_failed")).toHaveLength(2);
    expect(f.logs.find((l) => l.code === "cgo.spend_controller_ran")?.message).toMatch(/live 310 .*unread meta\+google/);
  });

  it("planGapOrders: an unread platform counts its stored capacity and is never 'nothing left to grow'", () => {
    const i = inv([], [], { google: { connected: true, objects: [], conversions30d: null, unread: { reason: "x", rate_limited: false, ledger_capacity_usd: 120 } } });
    const p = planGapOrders({ pace: OCT1, inv: i, now: NOW, dwell: new Set(), recentlyOrdered: new Set(), enableSafe: new Set() });
    expect(p.capacity_usd).toBe(120);
    expect(p.blind).toBe(true);
    expect(p.wake_cgo).toBe(false);
  });

  it("googleStartToIso reads the account's own clock, across DST and an unknown zone", () => {
    expect(googleStartToIso("2026-01-15 09:00:00", "America/Los_Angeles")).toBe("2026-01-15T17:00:00Z");
    expect(googleStartToIso("2026-10-03 09:00:00", "Australia/Brisbane")).toBe("2026-10-02T23:00:00Z");
    expect(googleStartToIso("2026-10-01 09:00:00", "Not/AZone")).toBe("2026-10-01T09:00:00Z");
    expect(googleStartToIso("", "UTC")).toBeNull();
  });

  it("readLedgerCapacity: the stored read counts the forecast way; none stored in 6 hours is null", async () => {
    ledgerFilters.length = 0;
    ledgerRows = {
      ad_campaigns: [
        { platform: "meta", object_id: "s1", status: "ACTIVE", budget_kind: "daily", budget_usd: 100 },
        { platform: "meta", object_id: "s2", status: "ACTIVE", budget_kind: "campaign_level", budget_usd: null },
        { platform: "meta", object_id: "s3", status: "PAUSED", budget_kind: "daily", budget_usd: 500 },
      ],
      ad_spend_daily: ["2026-09-29", "2026-09-30", "2026-10-01"].flatMap((d) => [
        { platform: "meta", object_id: "s1", spend_date: d, amount_usd: 60 },
        { platform: "meta", object_id: "s2", spend_date: d, amount_usd: 30 },
        { platform: "meta", object_id: "s3", spend_date: d, amount_usd: 99 },
      ]),
    };
    expect(await readLedgerCapacity(T, "meta", NOW)).toBe(90);
    expect(ledgerFilters).toContain("ad_campaigns.platform=meta");
    expect(ledgerFilters).toContain("ad_campaigns.account_id=act_1");
    expect(ledgerFilters).toContain("ad_spend_daily.account_id=act_1");
    ledgerRows.ad_budget_reservations = [{ platform: "meta", object_id: "s3", created_at: "2026-10-02T10:00:00Z" }];
    ledgerRows.ad_campaigns = [...ledgerRows.ad_campaigns!, { platform: "meta", object_id: "s4", status: "ACTIVE", budget_kind: "daily", budget_usd: 100 }];
    ledgerRows.ad_budget_reservations = [{ platform: "meta", object_id: "s4", created_at: "2026-10-02T10:00:00Z" }];
    expect(await readLedgerCapacity(T, "meta", NOW)).toBe(190);
    expect(ledgerFilters).toContain(`ad_campaigns.as_of>=${new Date(NOW.getTime() - LEDGER_FRESH_HOURS * 3_600_000).toISOString()}`);
    ledgerRows = {};
    expect(await readLedgerCapacity(T, "meta", NOW)).toBeNull();
  });

  it("an error that escapes the run is logged, never silent", async () => {
    const f = fake({ inventory: inv([adSet("s1")]) });
    f.deps.recentOrderKeys = async () => {
      throw new Error("db down");
    };
    const r = await runSpendControllerForTenant(T, NOW, f.deps);
    expect(r.outcome).toBe("error");
    expect(f.logs.find((l) => l.code === "cgo.spend_controller_failed")?.message).toBe("db down");
  });
});

describe("Meta call economy: Graph calls per tenant per run are bounded", () => {
  function account() {
    const sets = Array.from({ length: 24 }, (_, k) => {
      const c = { id: `c${k % 6}`, name: `C${k % 6}`, effective_status: "ACTIVE", status: "ACTIVE", daily_budget: null, created_time: OLD };
      return {
        id: `s${k}`,
        name: `S${k}`,
        campaign_id: c.id,
        campaign: c,
        daily_budget: "5000",
        effective_status: "ACTIVE",
        configured_status: "ACTIVE",
        created_time: OLD,
        ads: { data: [0, 1, 2].map((j) => ({ id: `a${k}-${j}`, campaign_id: c.id, effective_status: "ACTIVE", configured_status: "ACTIVE", created_time: OLD })) },
      };
    });
    return sets;
  }
  let graphCalls: string[] = [];

  beforeEach(() => {
    graphCalls = [];
    fbGetAllPages.mockReset().mockImplementation(async (_t: string, path: string) => {
      graphCalls.push(path);
      if (path.endsWith("/adsets")) return account();
      if (path.endsWith("/customaudiences")) return [{ id: "aud1", subtype: "WEBSITE", approximate_count_lower_bound: 500 }];
      if (path.endsWith("/insights")) return [];
      throw new Error(`unexpected ${path}`);
    });
    fbGet.mockReset().mockImplementation(async (_t: string, path: string, q?: Record<string, unknown>) => {
      graphCalls.push(path);
      if (q?.fields === "timezone_name") return { timezone_name: "America/Los_Angeles" };
      return { data: [{ id: "ad1", effective_status: "ACTIVE", creative: { object_story_spec: { link_data: { message: "Words", name: "Head", link: "https://example.com" } } } }] };
    });
    fetchMetaDailySeries.mockReset().mockImplementation(async () => {
      graphCalls.push("act_1/insights(adset,last_7d)");
      return {
        rows: Array.from({ length: 24 }, (_, k) =>
          ["2026-09-29", "2026-09-30", "2026-10-01"].map((date) => ({ ad_set_id: `s${k}`, date, spend_usd: 50, conversions: 2, clicks: 20, judged_on: "conversions" })),
        ).flat(),
      };
    });
  });

  function economyDeps(): ControllerDeps {
    const f = fake({ inventory: inv([]) });
    return {
      ...f.deps,
      readMeta: defaultControllerDeps.readMeta,
      retarget: defaultControllerDeps.retarget,
      creative: (t, now) => ({ ...defaultControllerDeps.creative(t, now), generateImage: async () => "https://signed.example/img.jpg", adReadiness: async () => ({ ok: true as const }) }),
    };
  }

  it("cold: one structural call, one account zone, one delivery, one audience, one fatigue, and copy for at most MAX_CREATIVES_PER_RUN due campaigns", async () => {
    const r = await runSpendControllerForTenant(T, NOW, economyDeps());
    expect(r.outcome).toBe("ran");
    expect(graphCalls.filter((p) => p.endsWith("/adsets"))).toHaveLength(1);
    expect(graphCalls.length).toBeLessThanOrEqual(5 + MAX_CREATIVES_PER_RUN);
  });

  it("warm (the next hour, creatives already ordered): only the structural call", async () => {
    const deps = economyDeps();
    await runSpendControllerForTenant(T, NOW, deps);
    graphCalls = [];
    const dwell = new Set([...Array.from({ length: 6 }, (_, k) => `creative:c${k}`), "aud:website"]);
    await runSpendControllerForTenant(T, new Date(NOW.getTime() + 3_600_000), { ...deps, recentOrderKeys: async () => new Set(dwell) });
    expect(graphCalls).toEqual(["act_1/adsets"]);
  });
});

describe("creative orders the executor takes, and a fallback when there is no picture", () => {
  const liveCopy = { source_ad_id: "1200000777", primary_text: "Rent a car from $35/day", headline: "Upcar", link_url: "http://www.upcar.ai/", cta: "SEE_DETAILS" };

  it("normalises a source ad's link and button; a platform placeholder link is no website", () => {
    expect(normalizeAdLinkUrl("http://www.upcar.ai/")).toBe("https://www.upcar.ai/");
    expect(normalizeAdLinkUrl("https://www.upcar.ai/?deeplink=rental_landing")).toBe("https://www.upcar.ai/?deeplink=rental_landing");
    expect(normalizeAdLinkUrl("http://fb.me/")).toBeNull();
    expect(normalizeAdLinkUrl("https://www.facebook.com/upcar")).toBeNull();
    expect(normalizeAdLinkUrl("ftp://x.com")).toBeNull();
    expect(normalizeLaunchCta("SEE_DETAILS")).toBe("LEARN_MORE");
    expect(normalizeLaunchCta("BOOK_NOW")).toBe("BOOK_TRAVEL");
    expect(normalizeLaunchCta("SIGN_UP")).toBe("SIGN_UP");
    expect(normalizeLaunchCta("SOMETHING_NEW")).toBe("LEARN_MORE");
    expect(normalizeLaunchCta("NO_BUTTON")).toBeNull();
    expect(normalizeCreativeCopy({ ...liveCopy, headline: "x".repeat(256) })).toBeNull();
  });

  it("an open card on the ad set stops the billed picture before it is made (GS11 preflight)", async () => {
    const objects = [adSet("120000000001", { campaign_id: "120000000100" })];
    const f = fake({ inventory: inv(objects), audience: { id: "aud1", count: 100 } });
    let images = 0;
    f.deps.creative = () => ({
      fatiguedAdSets: async () => new Set(),
      readCreativeCopy: async () => ({ ...liveCopy }),
      generateImage: async () => (images++, "https://signed.example/img.jpg"),
      openConflict: async () => true,
    });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(images).toBe(0);
    expect(f.submitted.find((o) => o.exec_class === "meta_ads.create_ad")).toBeUndefined();
  });

  it("an unreadable conflict check also makes no picture (fail closed)", async () => {
    const objects = [adSet("120000000001", { campaign_id: "120000000100" })];
    const f = fake({ inventory: inv(objects), audience: { id: "aud1", count: 100 } });
    let images = 0;
    f.deps.creative = () => ({
      fatiguedAdSets: async () => new Set(),
      readCreativeCopy: async () => ({ ...liveCopy }),
      generateImage: async () => (images++, "https://signed.example/img.jpg"),
      openConflict: async () => { throw new Error("db down"); },
    });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(images).toBe(0);
  });

  it("the live orders now pass the executor's own body schema (https link, a button it takes)", async () => {
    const objects = [adSet("120000000001", { campaign_id: "120000000100" })];
    const f = fake({ inventory: inv(objects), audience: { id: "aud1", count: 100 } });
    f.deps.creative = () => ({ fatiguedAdSets: async () => new Set(), readCreativeCopy: async () => ({ ...liveCopy }), generateImage: async () => "https://signed.example/img.jpg" });
    await runSpendControllerForTenant(T, NOW, f.deps);
    const ad = f.submitted.find((o) => o.exec_class === "meta_ads.create_ad")!;
    expect(ad.body).toMatchObject({ link_url: "https://www.upcar.ai/", cta: "LEARN_MORE", source: "zavi_generated" });
    expect(createAdBodySchema.safeParse(ad.body).success).toBe(true);
  });

  it("a set whose ads link only to fb.me takes its words from the campaign's next live ad set", async () => {
    const objects = [adSet("120000000001", { campaign_id: "120000000100" }), adSet("120000000002", { campaign_id: "120000000100", results7d: 10 })];
    const f = fake({ inventory: inv(objects), audience: { id: "aud1", count: 100 } });
    f.deps.creative = () => ({
      fatiguedAdSets: async () => new Set(),
      readCreativeCopy: async (id) => (id === "120000000001" ? { ...liveCopy, link_url: "http://fb.me/" } : { ...liveCopy, source_ad_id: "1200000888", link_url: "https://gig.upcar.ai/" }),
      generateImage: async () => "https://signed.example/img.jpg",
    });
    await runSpendControllerForTenant(T, NOW, f.deps);
    const ad = f.submitted.find((o) => o.exec_class === "meta_ads.create_ad")!;
    expect(ad.body).toMatchObject({ ad_set_id: "120000000001", link_url: "https://gig.upcar.ai/" });
  });

  it("no picture made: Zavi's paused ad set gets the source ad's picture; a variant is not filed, and no image is made for an order that would be refused", async () => {
    const rejected = adSet("120000000009", { active: false, paused_self: true, spend7d_usd: 0, spend3d_usd: 0, spend_days7d: 0, results7d: 0, has_live_ads: false, has_any_ads: true, has_ready_ads: false });
    const f = fake({ inventory: inv([adSet("120000000001"), rejected]), enableSafe: [dwellKeyOf("meta", "120000000009")], audience: { id: "aud1", count: 100 } });
    let images = 0;
    f.deps.creative = () => ({ fatiguedAdSets: async () => new Set(), readCreativeCopy: async () => ({ ...liveCopy }), generateImage: async () => (images++, null) });
    await runSpendControllerForTenant(T, NOW, f.deps);
    const ads = f.submitted.filter((o) => o.exec_class === "meta_ads.create_ad");
    expect(ads).toHaveLength(1);
    expect(ads[0]!.body).toMatchObject({ ad_set_id: "120000000009", source: "copy", source_ad_id: "1200000777", link_url: "https://www.upcar.ai/" });
    expect(createAdBodySchema.safeParse(ads[0]!.body).success).toBe(true);
    expect(f.logs.find((l) => l.code === "cgo.spend_controller_ran")?.message).toContain("no image made for 120000000001: no new variant this hour");

    const g = fake({ inventory: inv([adSet("120000000001")]), audience: { id: "aud1", count: 100 } });
    images = 0;
    g.deps.creative = () => ({ fatiguedAdSets: async () => new Set(), readCreativeCopy: async () => ({ ...liveCopy, link_url: "http://fb.me/" }), generateImage: async () => (images++, "https://x") });
    await runSpendControllerForTenant(T, NOW, g.deps);
    expect(g.submitted.some((o) => o.exec_class === "meta_ads.create_ad")).toBe(false);
    expect(images).toBe(0);
  });

  it("a Meta account that cannot take an ad holds every creative: no image, no order, one note", async () => {
    const rejected = adSet("120000000009", { active: false, paused_self: true, spend7d_usd: 0, spend3d_usd: 0, spend_days7d: 0, results7d: 0, has_live_ads: false, has_any_ads: true, has_ready_ads: false });
    const f = fake({ inventory: inv([adSet("120000000001"), rejected]), enableSafe: [dwellKeyOf("meta", "120000000009")], audience: { id: "aud1", count: 100 } });
    let images = 0;
    let checks = 0;
    f.deps.creative = () => ({
      fatiguedAdSets: async () => new Set(),
      readCreativeCopy: async () => ({ ...liveCopy }),
      generateImage: async () => (images++, "https://x"),
      adReadiness: async () => (checks++, { ok: false, code: "meta_ads_no_page" }),
    });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.some((o) => o.exec_class === "meta_ads.create_ad")).toBe(false);
    expect(images).toBe(0);
    expect(checks).toBe(1);
    expect(f.logs.find((l) => l.code === "cgo.spend_controller_ran")?.message).toContain("creatives held: Meta cannot take a new ad yet (meta_ads_no_page)");

    const g = fake({ inventory: inv([adSet("120000000001")]), audience: { id: "aud1", count: 100 } });
    g.deps.creative = () => ({
      fatiguedAdSets: async () => new Set(),
      readCreativeCopy: async () => ({ ...liveCopy }),
      generateImage: async () => "https://signed.example/img.jpg",
      adReadiness: async () => ({ ok: true }),
    });
    await runSpendControllerForTenant(T, NOW, g.deps);
    expect(g.submitted.some((o) => o.exec_class === "meta_ads.create_ad")).toBe(true);
  });

  it("readCreativeCopy passes over an ad with no website link and maps the next one's button", async () => {
    fbGet.mockReset().mockResolvedValueOnce({
      data: [
        { id: "1200000001", effective_status: "ACTIVE", creative: { object_story_spec: { link_data: { message: "M", name: "N", link: "http://fb.me/", call_to_action: { type: "SIGN_UP" } } } } },
        { id: "1200000002", effective_status: "ACTIVE", creative: { object_story_spec: { link_data: { message: "M2", name: "N2", link: "http://www.upcar.ai/", call_to_action: { type: "SEE_DETAILS" } } } } },
      ],
    });
    expect(await readCreativeCopy(T, "120000000001")).toEqual({ source_ad_id: "1200000002", primary_text: "M2", headline: "N2", link_url: "https://www.upcar.ai/", cta: "LEARN_MORE" });
  });
});

describe("a deterministic order failure backs off for DWELL_HOURS, logged once", () => {
  const H = 3_600_000;
  const row = (key: string, hoursAgo: number, exec_result: Record<string, unknown>) => ({
    body: { cgo_dwell_key: key },
    exec_status: "failed",
    status: "pending",
    exec_result,
    proposed_at: new Date(NOW.getTime() - hoursAgo * H).toISOString(),
    executed_at: null,
    exec_claimed_at: new Date(NOW.getTime() - hoursAgo * H + 2000).toISOString(),
  });
  const invalid = { error: "meta_ads.create_ad body invalid: must be an https URL", bucket: "blocked_on_us", platform_code: null };
  const se = { code: "meta_ads_write_failed", error: "Meta Ads write failed: 400 {...}", bucket: "blocked_on_us", platform_code: "meta_100_3858504" };

  it("an invalid body backs off at once; the same platform code twice does; once, a different code, or a temporary failure does not", () => {
    const b = deterministicBackoffs(
      [
        row("creative:c1", 0.5, invalid),
        row("dup:s1", 3, se),
        row("dup:s1", 2, se),
        row("dup:s2", 1, se),
        row("dup:s3", 2, se),
        row("dup:s3", 1, { ...se, platform_code: "meta_100_1487" }),
        row("dup:s4", 2, { ...se, bucket: "temporary" }),
        row("dup:s4", 1, { ...se, bucket: "temporary" }),
      ],
      NOW,
    );
    expect(b.map((x) => x.dwell_key).sort()).toEqual(["creative:c1", "dup:s1"]);
    expect(b.find((x) => x.dwell_key === "dup:s1")).toMatchObject({ fresh: false, why: "refused twice with meta_100_3858504" });
    expect(b.find((x) => x.dwell_key === "creative:c1")?.fresh).toBe(true);
  });

  it("Meta's Custom Audience terms (needs_founder, #2663) backs off like a refusal; other founder fixes do not", () => {
    const terms = { code: "meta_ads_write_failed", error: "(#2663) Terms of service has not been accepted", bucket: "needs_founder", fix: "audience_terms", platform_code: "meta_2663" };
    const reconnect = { ...terms, fix: "reconnect", platform_code: "meta_190" };
    const b = deterministicBackoffs([row("aud:website", 3, terms), row("aud:website", 2, terms), row("dup:s1", 3, reconnect), row("dup:s1", 2, reconnect)], NOW);
    expect(b.map((x) => x.dwell_key)).toEqual(["aud:website"]);
  });

  it("an executed order in between resets the count: two refusals around a success are not a backoff", () => {
    const ok = { ...row("dup:s1", 10, {}), exec_status: "executed", exec_result: {} };
    expect(deterministicBackoffs([row("dup:s1", 30, se), ok, row("dup:s1", 2, se)], NOW)).toEqual([]);
    expect(deterministicBackoffs([row("dup:s1", 30, se), row("dup:s1", 20, se), ok], NOW)).toEqual([]);
  });

  it("ordered by when each ran, not when it was proposed; the run about an hour after is the one that logs", () => {
    const late = { ...row("dup:s1", 3, se), exec_claimed_at: new Date(NOW.getTime() - 1.1 * H).toISOString() };
    const ok = { ...row("dup:s1", 2, {}), exec_status: "executed", exec_claimed_at: new Date(NOW.getTime() - 2 * H).toISOString() };
    const b = deterministicBackoffs([row("dup:s1", 5, se), ok, late, row("dup:s1", 1.6, se)], NOW);
    expect(b.map((x) => x.dwell_key)).toEqual(["dup:s1"]);
    expect(deterministicBackoffs([row("dup:s1", 1.0, se), row("dup:s1", 2, se)], NOW)[0]?.fresh).toBe(true);
    expect(deterministicBackoffs([row("dup:s1", 2.0, se), row("dup:s1", 3, se)], NOW)[0]?.fresh).toBe(false);
  });

  it("the backoff ends DWELL_HOURS after the failure that made it deterministic", () => {
    expect(deterministicBackoffs([row("dup:s1", 30, se), row("dup:s1", 23.5, se)], NOW).map((x) => x.dwell_key)).toEqual(["dup:s1"]);
    expect(deterministicBackoffs([row("dup:s1", 30, se), row("dup:s1", 24.5, se)], NOW)).toEqual([]);
  });

  it("the run re-files nothing for a backed-off object, logs it once, and still counts nothing for it as live", async () => {
    const src = adSet("120000000001", { daily_budget_usd: 100, spend7d_usd: 700, spend3d_usd: 300 });
    const f = fake({ inventory: inv([src]), audience: { id: "aud1", count: 100 } });
    f.deps.orderBackoffs = async () => [{ dwell_key: "dup:120000000001", why: "refused twice with meta_100_3858504", failed_at: NOW.toISOString(), fresh: true }];
    f.deps.creative = () => ({ fatiguedAdSets: async () => new Set(), readCreativeCopy: async () => null, generateImage: async () => null });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.some((o) => o.dwell_key === "dup:120000000001")).toBe(false);
    expect(f.logs.filter((l) => l.code === "cgo.spend_controller_backoff")).toHaveLength(1);
    f.deps.orderBackoffs = async () => [{ dwell_key: "dup:120000000001", why: "x", failed_at: NOW.toISOString(), fresh: false }];
    await runSpendControllerForTenant(T, new Date(NOW.getTime() + H), f.deps);
    expect(f.logs.filter((l) => l.code === "cgo.spend_controller_backoff")).toHaveLength(1);
    expect(f.submitted.some((o) => o.dwell_key === "dup:120000000001")).toBe(false);
  });

  it("readOrderBackoffs reads the controller's failed orders over two dwell windows", async () => {
    orderRows = [row("dup:s1", 3, se), row("dup:s1", 2, se)];
    ledgerFilters.length = 0;
    expect((await readOrderBackoffs(T, NOW)).map((x) => x.dwell_key)).toEqual(["dup:s1"]);
    expect(ledgerFilters).toContain("channel_actions.exec_status in failed,executed");
    expect(ledgerFilters.some((f) => f.startsWith("channel_actions.proposed_at>=") && f.endsWith(new Date(NOW.getTime() - 48 * H).toISOString()))).toBe(true);
    orderRows = [];
  });
});

describe("Google: an enabled campaign that never served says why", () => {
  it("the new $5/day campaign with no spend in 7 days gets Google's reason; a serving one does not; a failed status read changes nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    gadsSearch.mockReset();
    let statusFails = false;
    gadsSearch.mockImplementation(async (_t: string, q: string) => {
      if (q.includes("customer.time_zone")) return [{ customer: { timeZone: "America/Los_Angeles" } }];
      if (q.includes("campaign.primary_status")) {
        if (statusFails) throw new Error("Google Ads search failed: 500");
        return [
          { campaign: { id: "555", name: "Hosts $5", primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["HAS_ADS_DISAPPROVED", "SEARCH_VOLUME_LIMITED"] } },
          { campaign: { id: "777", name: "Search", primaryStatus: "ELIGIBLE", primaryStatusReasons: [] } },
        ];
      }
      if (q.includes("campaign_budget.amount_micros")) {
        return [
          { campaign: { id: "555", name: "Hosts $5", status: "ENABLED", startDateTime: "2026-09-20 09:00:00" }, campaignBudget: { amountMicros: "5000000", period: "DAILY", explicitlyShared: false } },
          { campaign: { id: "777", name: "Search", status: "ENABLED", startDateTime: "2026-08-01 09:00:00" }, campaignBudget: { amountMicros: "80000000", period: "DAILY", explicitlyShared: false } },
        ];
      }
      if (q.includes("segments.date BETWEEN")) return [{ campaign: { id: "777" }, segments: { date: "2026-10-01" }, metrics: { costMicros: "80000000", conversions: 1, clicks: 9 } }];
      return [{ metrics: { conversions: 3 } }];
    });
    const g = await readGoogleInventory(T);
    expect(g.objects.find((o) => o.id === "555")?.not_serving).toBe("its ads were disapproved; too few people search for its keywords");
    expect(g.objects.find((o) => o.id === "777")?.not_serving).toBeUndefined();

    statusFails = true;
    const again = await readGoogleInventory(T);
    expect(again.objects.map((o) => o.id)).toEqual(["555", "777"]);
    expect(again.objects.find((o) => o.id === "555")?.not_serving).toBeUndefined();
    vi.useRealTimers();
  });

  it("the hourly run logs it", async () => {
    const f = fake({ inventory: inv([], [google("555", { name: "Hosts $5", spend7d_usd: 0, spend3d_usd: 0, not_serving: "its ads were disapproved" })]) });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.logs).toContainEqual({ code: "cgo.spend_controller_not_serving", message: 'Google campaign "Hosts $5" (555) is on but spent nothing in 7 days: its ads were disapproved' });
  });
});

describe("spend is judged on the founder's goal: bookings, booked value, or the platform's own results", () => {
  const metaSets = () => {
    fbGetAllPages.mockReset();
    fbGetAllPages.mockImplementation(async () => {
      const c1 = { id: "c1", effective_status: "ACTIVE", status: "ACTIVE", daily_budget: null };
      const live = { data: [{ id: "a", campaign_id: "c1", effective_status: "ACTIVE", configured_status: "ACTIVE" }] };
      return [
        { id: "signups", campaign_id: "c1", campaign: c1, daily_budget: "5000", effective_status: "ACTIVE", configured_status: "ACTIVE", ads: live },
        { id: "books", campaign_id: "c1", campaign: c1, daily_budget: "5000", effective_status: "ACTIVE", configured_status: "ACTIVE", ads: live },
      ];
    });
    fbGet.mockReset().mockResolvedValue({ timezone_name: "America/Los_Angeles" });
  };
  const row = (ad_set_id: string, conversions: number, purchases: number, purchase_value_usd = 0) => ({ ad_set_id, date: "2026-09-30", spend_usd: 100, conversions, purchases, purchase_value_usd, clicks: 50, judged_on: "conversions" });
  const raisesOf = (plan: ReturnType<typeof planGapOrders>) =>
    plan.orders.filter((o) => /update_(ad_set|campaign)_budget/.test(o.exec_class)).map((o) => (o.body.ad_set_id ?? o.body.campaign_id) as string);

  it("Meta: the reader keeps the platform's results and records purchases; a purchase goal judges on bookings; any other goal, or no purchase yet, changes nothing", async () => {
    metaSets();
    fetchMetaDailySeries.mockReset().mockResolvedValue({ rows: [row("signups", 40, 0), row("books", 4, 3, 450)] });
    const m = await readMetaInventory(T, NOW);
    const read = new Map(m.objects.map((o) => [o.id, o]));
    expect(read.get("signups")).toMatchObject({ results7d: 40, purchases7d: 0 });
    expect(read.get("books")).toMatchObject({ results7d: 4, purchases7d: 3, purchase_value7d_usd: 450 });
    expect(read.get("signups")?.results_are_bookings).toBeUndefined();

    const counted = new Map(applyGoalBasis(inv(m.objects), "count").meta.objects.map((o) => [o.id, o]));
    expect(counted.get("signups")).toMatchObject({ results7d: 0, results_are_bookings: true });
    expect(counted.get("books")).toMatchObject({ results7d: 3, results_are_bookings: true });
    const valued = new Map(applyGoalBasis(inv(m.objects), "value").meta.objects.map((o) => [o.id, o]));
    expect(valued.get("books")).toMatchObject({ results7d: 450, results_are_bookings: true, results_are_value: true });
    expect(resultBasis(valued.get("books")!)).toBe("value");
    expect(applyGoalBasis(inv(m.objects), "native").meta.objects.find((o) => o.id === "signups")).toMatchObject({ results7d: 40 });

    _resetSpendControllerCaches();
    metaSets();
    fetchMetaDailySeries.mockReset().mockResolvedValue({ rows: [row("signups", 40, 0), row("books", 4, 0)] });
    const none = await readMetaInventory(T, NOW);
    const noPurchase = applyGoalBasis(inv(none.objects), "count").meta.objects.find((o) => o.id === "signups")!;
    expect(noPurchase).toMatchObject({ results7d: 40 });
    expect(noPurchase.results_are_bookings).toBeUndefined();
  });

  it("Google: PURCHASE-category conversions and value are recorded (none = 0); a failed booking read is reported, not erased", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    let bookingsFail = false;
    gadsSearch.mockReset();
    gadsSearch.mockImplementation(async (_t: string, q: string) => {
      if (q.includes("customer.time_zone")) return [{ customer: { timeZone: "America/Los_Angeles" } }];
      if (q.includes("conversion_action_category")) {
        if (bookingsFail) throw new Error("Google Ads search failed: 400");
        return [{ campaign: { id: "777" }, segments: { date: "2026-09-30" }, metrics: { conversions: 2, conversionsValue: 300 } }];
      }
      if (q.includes("campaign_budget.amount_micros")) {
        return ["777", "888"].map((id) => ({ campaign: { id, name: id, status: "ENABLED", startDateTime: "2026-08-01 09:00:00" }, campaignBudget: { amountMicros: "50000000", period: "DAILY", explicitlyShared: false } }));
      }
      if (q.includes("segments.date BETWEEN")) return ["777", "888"].map((id) => ({ campaign: { id }, segments: { date: "2026-09-30" }, metrics: { costMicros: "70000000", conversions: 9, clicks: 30 } }));
      return [{ metrics: { conversions: 18 } }];
    });
    const g = await readGoogleInventory(T);
    expect(g.purchases_unread).toBeUndefined();
    expect(g.objects.find((o) => o.id === "777")).toMatchObject({ results7d: 9, purchases7d: 2, purchase_value7d_usd: 300 });
    const counted = applyGoalBasis(inv([], g.objects), "count").google.objects;
    expect(counted.find((o) => o.id === "777")).toMatchObject({ result_kind: "conversions", results7d: 2, results_are_bookings: true });
    expect(counted.find((o) => o.id === "888")).toMatchObject({ result_kind: "conversions", results7d: 0, results_are_bookings: true });

    bookingsFail = true;
    const failed = await readGoogleInventory(T);
    expect(failed.purchases_unread).toBe(true);
    expect(failed.objects.find((o) => o.id === "888")).toMatchObject({ results7d: 9, purchases7d: 0 });
    vi.useRealTimers();
  });

  it("Google: conversions only in the settled week keep the campaign judged on conversions, not clicks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    gadsSearch.mockReset();
    gadsSearch.mockImplementation(async (_t: string, q: string) => {
      if (q.includes("customer.time_zone")) return [{ customer: { timeZone: "America/Los_Angeles" } }];
      if (q.includes("conversion_action_category")) return [];
      if (q.includes("campaign_budget.amount_micros")) return [{ campaign: { id: "901", name: "Trials", status: "ENABLED", startDateTime: "2026-08-01 09:00:00" }, campaignBudget: { amountMicros: "50000000", period: "DAILY", explicitlyShared: false } }];
      if (q.includes("segments.date BETWEEN"))
        return [
          { campaign: { id: "901" }, segments: { date: "2026-09-23" }, metrics: { costMicros: "50000000", conversions: 25, clicks: 40 } },
          { campaign: { id: "901" }, segments: { date: "2026-09-30" }, metrics: { costMicros: "50000000", conversions: 0, clicks: 300 } },
        ];
      return [{ metrics: { conversions: 25 } }];
    });
    const g = await readGoogleInventory(T);
    expect(g.objects[0]).toMatchObject({ result_kind: "conversions", results7d: 0, settled: { results: 25, spend_usd: 50 } });
    vi.useRealTimers();
  });

  it("the next dollar goes to the ad with bookings, not the one with cheap sign-ups or clicks", () => {
    const books = adSet("books", { results7d: 3, spend7d_usd: 700, results_are_bookings: true });
    const cheapClicks = google("clicks", { result_kind: "clicks", results7d: 1400, spend7d_usd: 700 });
    const plan = planGapOrders({ pace: OCT1, inv: inv([books], [cheapClicks]), now: NOW, dwell: new Set(), recentlyOrdered: new Set(), enableSafe: new Set() });
    expect(raisesOf(plan)[0]).toBe("books");
    expect(resultBasis(books)).toBe("bookings");
    expect(resultBasis(cheapClicks)).toBe("clicks");
  });

  it("an ad set with 0 bookings is not raised ahead of a campaign with real conversions", () => {
    const books = adSet("books", { results7d: 3, spend7d_usd: 2100, daily_budget_usd: 300, results_are_bookings: true });
    const noBookings = adSet("none", { results7d: 0, spend7d_usd: 700, results_are_bookings: true });
    const convs = google("convs", { result_kind: "conversions", results7d: 70, spend7d_usd: 700 });
    const plan = planGapOrders({ pace: OCT1, inv: inv([books, noBookings], [convs]), now: NOW, dwell: new Set(), recentlyOrdered: new Set(), enableSafe: new Set() });
    expect(raisesOf(plan).slice(0, 2)).toEqual(["books", "convs"]);
  });

  it("M2 (money goal): a sign-up-optimised ad set with one purchase is not raised ahead of one with booked value, on either platform", () => {
    const leads = adSet("leads", { results7d: 120, spend7d_usd: 900, daily_budget_usd: 130, purchases7d: 1, purchase_value7d_usd: 60 });
    const orders = adSet("orders", { results7d: 6, spend7d_usd: 600, daily_budget_usd: 90, purchases7d: 4, purchase_value7d_usd: 1600 });
    const gSignups = google("g-signups", { result_kind: "conversions", results7d: 50, spend7d_usd: 400, daily_budget_usd: 60, purchases7d: 0 });
    const judged = applyGoalBasis(inv([leads, orders], [gSignups]), "value");
    const plan = planGapOrders({ pace: OCT1, inv: judged, now: NOW, dwell: new Set(), recentlyOrdered: new Set(), enableSafe: new Set() });
    const raises = raisesOf(plan);
    expect(raises[0]).toBe("orders");
    expect(raises.indexOf("g-signups")).toBeGreaterThan(raises.indexOf("orders"));
    const native = planGapOrders({ pace: OCT1, inv: applyGoalBasis(inv([leads, orders], [gSignups]), "native"), now: NOW, dwell: new Set(), recentlyOrdered: new Set(), enableSafe: new Set() });
    expect(raisesOf(native)[0]).not.toBe("orders");
  });

  it("brand search is never raised, switched on or used as a yardstick, even when its cost per booking is the cheapest", () => {
    const brand = google("brand", { results7d: 40, spend7d_usd: 160, daily_budget_usd: 25, brand: true, results_are_bookings: true });
    const pausedBrand = google("brand-off", { active: false, paused_self: true, brand: true, daily_budget_usd: 30 });
    const generic = google("generic", { results7d: 4, spend7d_usd: 500, daily_budget_usd: 75, results_are_bookings: true });
    const plan = planGapOrders({
      pace: OCT1,
      inv: inv([], [brand, pausedBrand, generic]),
      now: NOW,
      dwell: new Set(),
      recentlyOrdered: new Set(),
      enableSafe: new Set([dwellKeyOf("google", "brand-off")]),
    });
    const touched = plan.orders.map((o) => (o.body.campaign_id ?? o.body.object_id) as string);
    expect(touched).not.toContain("brand");
    expect(touched).not.toContain("brand-off");
    expect(raisesOf(plan)).toContain("generic");
  });

  it("Meta CBO: a campaign's bookings are its purchases, never a click-goal child's clicks", async () => {
    for (const order of [["conv", "clk"], ["clk", "conv"]]) {
      _resetSpendControllerCaches();
      fbGetAllPages.mockReset();
      fbGetAllPages.mockImplementation(async () => {
        const c1 = { id: "c1", effective_status: "ACTIVE", status: "ACTIVE", daily_budget: "10000" };
        const live = { data: [{ id: "a", campaign_id: "c1", effective_status: "ACTIVE", configured_status: "ACTIVE" }] };
        return order.map((id) => ({ id, campaign_id: "c1", campaign: c1, daily_budget: null, effective_status: "ACTIVE", configured_status: "ACTIVE", ads: live }));
      });
      fbGet.mockReset().mockResolvedValue({ timezone_name: "America/Los_Angeles" });
      fetchMetaDailySeries.mockReset().mockResolvedValue({
        rows: [
          { ad_set_id: "conv", date: "2026-09-30", spend_usd: 100, conversions: 5, purchases: 1, clicks: 20, judged_on: "conversions" },
          { ad_set_id: "clk", date: "2026-09-30", spend_usd: 100, conversions: 0, purchases: 0, clicks: 100, judged_on: "reach_and_clicks" },
        ],
      });
      const m = await readMetaInventory(T, NOW);
      const judged = applyGoalBasis(inv(m.objects), "count").meta.objects;
      expect(judged.find((o) => o.level === "campaign" && o.id === "c1")).toMatchObject({ results7d: 1, result_kind: "conversions", results_are_bookings: true });
    }
  });

  it("a goal that cannot be read stops the hour: no orders, one log line", async () => {
    const f = fake({ inventory: inv([adSet("a", { daily_budget_usd: 50, spend7d_usd: 350, spend3d_usd: 150 })]) });
    f.deps.goalMode = async () => ({ ok: false, error: "db down" });
    const out = await runSpendControllerForTenant(T, NOW, f.deps);
    expect(out).toMatchObject({ outcome: "skipped", why: "goal_unreadable" });
    expect(f.submitted).toHaveLength(0);
    expect(f.logs.map((l) => l.code)).toContain("cgo.spend_controller_skipped");
  });

  it("under a purchase goal, a failed Google booking read freezes Google for the hour; Meta still closes the gap", async () => {
    const g = google("g1", { daily_budget_usd: 50, spend7d_usd: 350, spend3d_usd: 150 });
    const m = adSet("m1", { daily_budget_usd: 50, spend7d_usd: 350, spend3d_usd: 150, purchases7d: 2 });
    const base = inv([m], [g]);
    const f = fake({ inventory: { ...base, google: { ...base.google, purchases_unread: true } } });
    f.deps.goalMode = async () => ({ ok: true, mode: "count", metric: "orders" });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.some((s) => s.channel_slug === "google_ads")).toBe(false);
    expect(f.submitted.some((s) => s.channel_slug === "meta_ads")).toBe(true);

    const search = google("g-search", { daily_budget_usd: 50, spend7d_usd: 350, spend3d_usd: 150, channel_type: "SEARCH", brand: true });
    const pmax = google("g-pmax", { daily_budget_usd: 50, spend7d_usd: 350, spend3d_usd: 150, channel_type: "PERFORMANCE_MAX" });
    const both = inv([m], [search, pmax]);
    const f3 = fake({ inventory: { ...both, google: { ...both.google, brand_unread: true, brand_unread_why: "google_ads_query_truncated: more than 10 pages" } } });
    f3.deps.goalMode = async () => ({ ok: true, mode: "native", metric: "signups" });
    await runSpendControllerForTenant(T, NOW, f3.deps);
    expect(f3.submitted.some((s) => s.channel_slug === "google_ads" && s.body.campaign_id === "g-pmax")).toBe(true);
    expect(f3.submitted.some((s) => s.channel_slug === "google_ads" && s.body.campaign_id === "g-search")).toBe(false);
    expect(f3.logs.some((l) => l.message.includes("brand campaigns could not be read (google_ads_query_truncated: more than 10 pages); its Search campaigns are left alone this hour"))).toBe(true);

    const f2 = fake({ inventory: { ...base, google: { ...base.google, purchases_unread: true } } });
    f2.deps.goalMode = async () => ({ ok: true, mode: "native", metric: "signups" });
    await runSpendControllerForTenant(T, NOW, f2.deps);
    expect(f2.submitted.some((s) => s.channel_slug === "google_ads")).toBe(true);
  });
});

describe("B3: a pending new-channel test keeps its room from the pace step (pending-tests.ts)", () => {
  const objects = () => [adSet("s1", { results7d: 70 }), adSet("s2", { results7d: 58 }), adSet("s3", { results7d: 50 })];

  it("the same 1 Oct gap: no raise, switch-on or copy is placed into the room a $525 TikTok test waits for, and cgo is not woken for it", async () => {
    const f = fake({ inventory: inv(objects()) });
    f.deps.pendingTestRoom = async () => ({ reserve_usd: 525, daily_usd: 25, left_usd: 525, days_left: 21, margin: 1, channels: ["tiktok_ads"] });
    const out = await runSpendControllerForTenant(T, NOW, f.deps);
    expect(out.outcome).toBe("ran");
    expect(f.submitted.filter(isGapOrder)).toEqual([]);
    expect(f.woke).toBe(0);
    expect(f.logs.find((l) => l.code === "cgo.spend_controller_ran")?.message).toContain("kept free for the pending TikTok test");
  });

  it("no pending test: the controller closes the gap exactly as before", async () => {
    const a = fake({ inventory: inv(objects()) });
    const b = fake({ inventory: inv(objects()) });
    b.deps.pendingTestRoom = async () => null;
    await runSpendControllerForTenant(T, NOW, a.deps);
    await runSpendControllerForTenant(T, NOW, b.deps);
    expect(b.submitted.map((o) => o.exec_class)).toEqual(a.submitted.map((o) => o.exec_class));
    expect(b.submitted.filter(isGapOrder).length).toBeGreaterThan(0);
  });

  it("pending tests unreadable: nothing that adds daily spend this hour (fail closed)", async () => {
    const f = fake({ inventory: inv(objects()) });
    f.deps.pendingTestRoom = async () => {
      throw new Error("db down");
    };
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.filter(isGapOrder)).toEqual([]);
    expect(f.woke).toBe(0);
  });
});

describe("copy cap, no copy of a copy, wake on the leftover gap", () => {
  const BEHIND: SpendPace = { ...OCT1, daily_target_usd: 800, delivery_debt_usd: 2100, days_left: 30 };

  it("must catch (home-cleaning): a $40/day source is copied at $40, not at the whole gap", () => {
    const objects = [adSet("deep-clean", { daily_budget_usd: 40, spend7d_usd: 280, spend3d_usd: 120, results7d: 20 })];
    const plan = planGapOrders({ pace: BEHIND, inv: inv(objects), now: NOW, dwell: new Set(["obj:meta:deep-clean"]), recentlyOrdered: new Set(), enableSafe: new Set(), copyRegions: [OPEN_REGION] });
    const copy = plan.orders.find((o) => o.exec_class === "meta_ads.duplicate_ad_set")!;
    expect(copy.body).toMatchObject({ source_ad_set_id: "deep-clean", daily_budget_usd: 40 });
    expect(plan.remaining_usd).toBeGreaterThan(900);
    expect(plan.wake_cgo).toBe(true);
  });

  it("must catch (SaaS): a campaign-budget copy is capped at the campaign's daily budget", () => {
    const objects = [
      campaign("trial-cbo", { daily_budget_usd: 60, spend7d_usd: 420, spend3d_usd: 180, results7d: 30 }),
      adSet("trial-lookalike", { campaign_id: "trial-cbo", budget_on_campaign: true, daily_budget_usd: null, spend7d_usd: 420, spend3d_usd: 180, results7d: 30 }),
    ];
    const plan = planGapOrders({ pace: BEHIND, inv: inv(objects), now: NOW, dwell: new Set(["obj:meta:trial-cbo"]), recentlyOrdered: new Set(), enableSafe: new Set(), copyRegions: [OPEN_REGION] });
    const copy = plan.orders.find((o) => o.exec_class === "meta_ads.duplicate_campaign")!;
    expect(copy.body).toMatchObject({ source_campaign_id: "trial-cbo", daily_budget_usd: 60 });
  });

  it("must catch: an earlier copy is never copied again; its source still can be", () => {
    const objects = [
      adSet("move-out", { daily_budget_usd: 50, spend7d_usd: 350, spend3d_usd: 150, results7d: 30 }),
      adSet("move-out-copy", { daily_budget_usd: 50, spend7d_usd: 350, spend3d_usd: 150, results7d: 35 }),
    ];
    const plan = planGapOrders({
      pace: BEHIND,
      inv: inv(objects),
      now: NOW,
      dwell: new Set(["obj:meta:move-out", "obj:meta:move-out-copy"]),
      recentlyOrdered: new Set(),
      enableSafe: new Set(),
      copies: new Set(["move-out-copy"]),
      copyRegions: [OPEN_REGION],
    });
    const sources = plan.orders.filter((o) => o.exec_class === "meta_ads.duplicate_ad_set").map((o) => o.body.source_ad_set_id);
    expect(sources).toEqual(["move-out"]);
  });

  it("must catch: a small raise lands, a large gap is left, cgo is woken", async () => {
    const f = fake({ inventory: inv([adSet("weekday", { daily_budget_usd: 10, spend7d_usd: 70, spend3d_usd: 30, results7d: 12 })]), pace: BEHIND, audience: { id: "aud1", count: 100 } });
    f.deps.copyIds = async () => new Set(["weekday"]);
    const out = await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.some((o) => o.exec_class === "meta_ads.update_ad_set_budget")).toBe(true);
    expect(out).toMatchObject({ outcome: "ran", woke_cgo: true });
    expect(f.woke).toBe(1);
  });

  it("must not catch: the gap is closed to under 5% of the need, cgo sleeps", async () => {
    const objects = Array.from({ length: 6 }, (_, k) => adSet(`s${k}`));
    const f = fake({ inventory: inv(objects), audience: { id: "aud1", count: 100 } });
    f.deps.businessRulesOff = async () => true;
    f.deps.copyIds = async () => new Set();
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.woke).toBe(0);
  });

  it("must not catch: every order region already has a same-goal ad, so nothing is copied and cgo gets the gap", async () => {
    const f = fake({ inventory: inv([adSet("s1", { daily_budget_usd: 40 })]), pace: BEHIND, audience: { id: "aud1", count: 100 } });
    f.deps.copyIds = async () => new Set();
    f.deps.copyRegions = async () => ({ regions: [{ ...OPEN_REGION, covered_goals: ["event:PURCHASE"] }], goals: new Map() });
    const out = await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.some((o) => o.exec_class.startsWith("meta_ads.duplicate_"))).toBe(false);
    expect(out).toMatchObject({ woke_cgo: true });
  });

  it("unreadable copy targets (a Graph or Google error): nothing is copied, the raises still go", async () => {
    const f = fake({ inventory: inv([adSet("s1", { daily_budget_usd: 40 })]), pace: BEHIND, audience: { id: "aud1", count: 100 } });
    f.deps.copyIds = async () => new Set();
    f.deps.copyRegions = async () => {
      throw new Error("Meta Graph: unknown field promoted_object");
    };
    const out = await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.some((o) => o.exec_class.startsWith("meta_ads.duplicate_"))).toBe(false);
    expect(out.outcome).toBe("ran");
    expect(f.submitted.some((o) => o.exec_class === "meta_ads.update_ad_set_budget")).toBe(true);
    expect(f.logs.some((l) => l.code === "cgo.spend_controller_copy_regions_unread")).toBe(true);
  });

  it("unreadable copy history: nothing is copied this hour", async () => {
    const f = fake({ inventory: inv([adSet("s1", { daily_budget_usd: 40 })]), pace: BEHIND, audience: { id: "aud1", count: 100 } });
    f.deps.copyIds = async () => {
      throw new Error("db down");
    };
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.some((o) => o.exec_class.startsWith("meta_ads.duplicate_"))).toBe(false);
    expect(f.logs.some((l) => l.code === "cgo.spend_controller_copies_unread")).toBe(true);
  });

  it("must not catch (SaaS): a campaign-budget campaign with ad sets after different goals is not copied", () => {
    const objects = [
      campaign("trial-cbo", { daily_budget_usd: 60, spend7d_usd: 420, spend3d_usd: 180, results7d: 30 }),
      adSet("trial-signups", { campaign_id: "trial-cbo", budget_on_campaign: true, daily_budget_usd: null, goal: "event:COMPLETE_REGISTRATION", spend7d_usd: 210, spend3d_usd: 90, results7d: 15 }),
      adSet("trial-paid", { campaign_id: "trial-cbo", budget_on_campaign: true, daily_budget_usd: null, goal: "event:PURCHASE", spend7d_usd: 210, spend3d_usd: 90, results7d: 15 }),
    ];
    const plan = planGapOrders({ pace: BEHIND, inv: inv(objects), now: NOW, dwell: new Set(["obj:meta:trial-cbo"]), recentlyOrdered: new Set(), enableSafe: new Set(), copyRegions: [OPEN_REGION] });
    expect(plan.orders.some((o) => o.exec_class === "meta_ads.duplicate_campaign")).toBe(false);
  });

  it("an ad set this pass switches on counts as reaching its places when the copy regions are read", async () => {
    const ready = adSet("120000000555", { active: false, paused_self: true, has_live_ads: false, has_ready_ads: true, spend7d_usd: 0, spend3d_usd: 0, spend_days7d: 0, results7d: 0, daily_budget_usd: 20 });
    const f = fake({ inventory: inv([adSet("s1", { daily_budget_usd: 40 }), ready]), pace: BEHIND, enableSafe: [dwellKeyOf("meta", "120000000555")], audience: { id: "aud1", count: 100 } });
    f.deps.copyIds = async () => new Set();
    let seen: Inventory | null = null;
    f.deps.copyRegions = async (_t, i) => {
      seen = i;
      return { regions: [OPEN_REGION], goals: new Map() };
    };
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.some((o) => o.exec_class === "meta_ads.set_status" && (o.body as { object_id?: string }).object_id === "120000000555")).toBe(true);
    expect(seen!.meta.objects.find((o) => o.id === "120000000555")).toMatchObject({ active: true, has_live_ads: true });
  });

  it("readCopyIds: a copy made with no hold is still known by its launch tag in its name", async () => {
    orderRows = [{ id: "a1b2c3d4-e5f6-0000-0000-0000000000c1" }];
    ledgerRows = { ad_budget_reservations: [] };
    const ids = await readCopyIds(T, [adSet("120000000888", { name: "Zavi · Weekly clean (copy) · zva1b2c3d4e5" }), adSet("120000000889", { name: "Weekly clean" })]);
    expect([...ids]).toEqual(["120000000888"]);
    orderRows = [];
    ledgerRows = {};
  });

  it("fail closed: a source whose daily budget is unknown is never copied", () => {
    const objects = [adSet("deep-clean", { daily_budget_usd: null, budget_on_campaign: false })];
    const plan = planGapOrders({ pace: BEHIND, inv: inv(objects), now: NOW, dwell: new Set(), recentlyOrdered: new Set(), enableSafe: new Set(), copyRegions: [OPEN_REGION] });
    expect(plan.orders.some((o) => o.exec_class.startsWith("meta_ads.duplicate_"))).toBe(false);
  });

  it("readCopyIds: many copy cards are looked up in chunks, not one oversized request", async () => {
    orderRows = Array.from({ length: 120 }, (_, k) => ({ id: `a0000000-0000-0000-0000-${String(k).padStart(12, "0")}` }));
    ledgerRows = { ad_budget_reservations: [{ object_id: "120000000999" }] };
    ledgerFilters.length = 0;
    const ids = await readCopyIds(T);
    expect(ids.has("120000000999")).toBe(true);
    expect(ledgerFilters.filter((x) => x.startsWith("ad_budget_reservations.idem_key in")).length).toBe(3);
    orderRows = [];
    ledgerRows = {};
  });

  it("readCopyIds: a copy history at its read cap is incomplete, so it throws", async () => {
    orderRows = Array.from({ length: 1000 }, (_, k) => ({ id: `a0000000-0000-0000-0000-${String(k).padStart(12, "0")}` }));
    await expect(readCopyIds(T)).rejects.toThrow("read cap");
    orderRows = [];
  });

  it("readCopyIds: a copy's id comes from its executed copy card's create hold", async () => {
    orderRows = [{ id: "a0000000-0000-0000-0000-0000000000c1" }];
    ledgerRows = { ad_budget_reservations: [{ object_id: "120000000777" }] };
    ledgerFilters.length = 0;
    const ids = await readCopyIds(T);
    expect([...ids]).toEqual(["120000000777"]);
    expect(ledgerFilters).toContain("ad_budget_reservations.op=create");
    expect(ledgerFilters.some((x) => x.startsWith("channel_actions.exec_status"))).toBe(false);
    expect(ledgerFilters.some((x) => x.startsWith("ad_budget_reservations.idem_key in a0000000-0000-0000-0000-0000000000c1:create"))).toBe(true);
    orderRows = [];
    ledgerRows = {};
  });
});

describe("a Meta rate limit on the copy read is honoured", () => {
  it("notes the rate limit, copies nothing, and the pass still runs", async () => {
    const BEHIND3: SpendPace = { ...OCT1, daily_target_usd: 800, delivery_debt_usd: 2100, days_left: 30 };
    const f = fake({ inventory: inv([adSet("s1", { daily_budget_usd: 40 })]), pace: BEHIND3, audience: { id: "aud1", count: 100 } });
    f.deps.copyIds = async () => new Set();
    let noted = 0;
    f.deps.noteMetaRateLimit = async () => {
      noted += 1;
    };
    f.deps.copyRegions = async () => {
      throw new Error('Meta Ads request failed: 400 {"error":{"message":"User request limit reached","code":17,"error_subcode":2446079}}');
    };
    const out = await runSpendControllerForTenant(T, NOW, f.deps);
    expect(out.outcome).toBe("ran");
    expect(noted).toBe(1);
    expect(f.submitted.some((o) => o.exec_class.startsWith("meta_ads.duplicate_"))).toBe(false);
  });
});

describe("copy goals come from the copy read, not the hourly inventory", () => {
  it("an ad set's goal from the copy read decides its copy region", async () => {
    const BEHIND2: SpendPace = { ...OCT1, daily_target_usd: 800, delivery_debt_usd: 2100, days_left: 30 };
    const f = fake({ inventory: inv([adSet("s1", { daily_budget_usd: 40, goal: undefined })]), pace: BEHIND2, audience: { id: "aud1", count: 100 } });
    f.deps.copyIds = async () => new Set();
    f.deps.copyRegions = async () => ({ regions: [{ ...OPEN_REGION, covered_goals: ["event:PURCHASE"] }], goals: new Map([["s1", "event:COMPLETE_REGISTRATION"]]) });
    await runSpendControllerForTenant(T, NOW, f.deps);
    const copy = f.submitted.find((o) => o.exec_class === "meta_ads.duplicate_ad_set");
    expect(copy?.body).toMatchObject({ source_ad_set_id: "s1", places: [{ key: "9001" }] });
  });
});

describe("region copies only for a marketplace", () => {
  const BEHIND5: SpendPace = { ...OCT1, daily_target_usd: 800, delivery_debt_usd: 2100, days_left: 30 };
  for (const [shape, copies] of [["marketplace", true], ["saas", false], ["ecommerce", false], [null, false]] as const) {
    it(`${shape ?? "unknown"}: ${copies ? "copies into an open order region" : "no region copy, the gap wakes cgo"}`, async () => {
      const f = fake({ inventory: inv([adSet("s1", { daily_budget_usd: 40 })]), pace: BEHIND5, audience: { id: "aud1", count: 100 } });
      f.deps.copyIds = async () => new Set();
      let regionReads = 0;
      f.deps.copyRegions = async () => {
        regionReads += 1;
        return { regions: [OPEN_REGION], goals: new Map() };
      };
      f.deps.businessShape = async () => shape;
      const out = await runSpendControllerForTenant(T, NOW, f.deps);
      expect(f.submitted.some((o) => o.exec_class.startsWith("meta_ads.duplicate_"))).toBe(copies);
      expect(regionReads).toBe(copies ? 1 : 0);
      expect(f.submitted.some((o) => o.exec_class === "meta_ads.update_ad_set_budget")).toBe(true);
      expect(out).toMatchObject({ outcome: "ran", woke_cgo: true });
    });
  }

  it("a shape read that fails counts as unknown: no region copy", async () => {
    const f = fake({ inventory: inv([adSet("s1", { daily_budget_usd: 40 })]), pace: BEHIND5, audience: { id: "aud1", count: 100 } });
    f.deps.copyIds = async () => new Set();
    f.deps.businessShape = async () => {
      throw new Error("db down");
    };
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.some((o) => o.exec_class.startsWith("meta_ads.duplicate_"))).toBe(false);
  });
});

describe("a funded Meta ad set none of whose ads can run (Upcar 2026-10-11: the only ad went to Update Required for 21h)", () => {
  const stuck = (over: Partial<AdObject> = {}) => adSet("host-areas", { name: "Host Recommended Areas", daily_budget_usd: 140, spend7d_usd: 700, spend3d_usd: 300, has_any_ads: true, has_live_ads: false, has_ready_ads: false, ...over });

  it("keeps counting what it spent (no room is freed: queued raises would stack when the ad is fixed)", () => {
    expect(metaCannotDeliver(stuck())).toBe(true);
    expect(objectCapacityUsd(stuck(), NOW, new Set())).toBe(100);
  });

  it("is never raised; healthy ad sets still are, and the founder is told this hour", async () => {
    const noteCannotDeliver = vi.fn(async () => undefined);
    const objects = [stuck({ results7d: 90 }), adSet("s1", { results7d: 70 }), adSet("s2", { results7d: 58 })];
    const f = fake({ inventory: inv(objects) });
    await runSpendControllerForTenant(T, NOW, { ...f.deps, noteCannotDeliver });
    const budgetIds = f.submitted.filter((o) => o.exec_class === "meta_ads.update_ad_set_budget").map((o) => (o.body as { ad_set_id: string }).ad_set_id);
    expect(budgetIds).not.toContain("host-areas");
    expect(budgetIds.length).toBeGreaterThan(0);
    expect(noteCannotDeliver).toHaveBeenCalledTimes(1);
    expect(noteCannotDeliver).toHaveBeenCalledWith(T, [expect.objectContaining({ id: "host-areas" })], NOW);
  });

  it("a failed founder alert never stops the hour", async () => {
    const f = fake({ inventory: inv([stuck(), adSet("s1")]) });
    const out = await runSpendControllerForTenant(T, NOW, { ...f.deps, noteCannotDeliver: async () => { throw new Error("note insert failed"); } });
    expect(out.outcome).toBe("ran");
    expect(f.logs.some((l) => l.code === "cgo.spend_controller_alert_failed")).toBe(true);
  });

  it("a stuck retargeting ad set is not raised", async () => {
    const rt = stuck({ id: "rt", name: "Retargeting", daily_budget_usd: 5, audience_ids: ["aud1"] });
    const f = fake({ inventory: inv([...Array.from({ length: 12 }, (_, k) => adSet(`s${k}`)), rt]), audience: { id: "aud1", count: 5000 } });
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.some((o) => (o.body as { ad_set_id?: string }).ad_set_id === "rt")).toBe(false);
  });

  it("must not touch: ads in review, a fresh ad set with no ads yet, a paused ad set, Google, a $0 budget", () => {
    expect(metaCannotDeliver(stuck({ has_live_ads: true }))).toBe(false);
    const fresh = adSet("copy", { daily_budget_usd: 50, has_any_ads: false, has_live_ads: false, spend7d_usd: 0, spend3d_usd: 0, spend_days7d: 0, created_at: "2026-10-02T14:30:00Z" });
    expect(metaCannotDeliver(fresh)).toBe(false);
    expect(objectCapacityUsd(fresh, NOW, new Set())).toBe(50);
    expect(cannotDeliverAdSets([fresh, stuck({ has_live_ads: true })])).toEqual([]);
    expect(cannotDeliverAdSets([stuck({ active: false, paused_self: true }), stuck({ parent_active: false })])).toEqual([]);
    expect(cannotDeliverAdSets([stuck({ daily_budget_usd: 0 })])).toEqual([]);
    expect(metaCannotDeliver({ platform: "google", level: "campaign", has_any_ads: null, has_live_ads: null })).toBe(false);
  });

  it("a campaign budget is left as before: its has_any_ads also counts paused ad sets", () => {
    const cbo = campaign("cbo", { daily_budget_usd: 200, has_any_ads: true, has_live_ads: false, created_at: "2026-10-02T14:30:00Z" });
    expect(metaCannotDeliver(cbo)).toBe(false);
    expect(objectCapacityUsd(cbo, NOW, new Set())).toBe(200);
  });

  it("an ad set under a campaign budget is reported too (the campaign carries the money)", () => {
    expect(cannotDeliverAdSets([stuck({ daily_budget_usd: null, budget_on_campaign: true })]).map((o) => o.id)).toEqual(["host-areas"]);
  });

  it("the founder's blocker has one stable id per ad set and is told now without a money claim", () => {
    const b = cannotDeliverBlocker(stuck(), NOW);
    expect(b).toMatchObject({ id: "meta-no-live-ad:host-areas", kind: "ad_delivery", who: "you", notify_now: true, at_risk_now: false, usd_at_stake: null, channel_slug: "meta_ads" });
    expect(b.what).toContain('"Host Recommended Areas"');
    expect(cannotDeliverBlocker(stuck(), new Date(NOW.getTime() + 3_600_000)).id).toBe(b.id);
  });

  it("the next hour's read of the same stuck ad set is not news (told once, not every hour)", () => {
    const told = { severity: "urgent" as const, usd: null, at: NOW.toISOString() };
    const nextHour = cannotDeliverBlocker(stuck(), new Date(NOW.getTime() + 3_600_000));
    expect(blockerChange(nextHour.id, { severity: "urgent", usd: null, since: nextHour.since }, told)).toBe("unchanged");
    expect(blockerChange("stuck:x", { severity: "urgent", usd: null, since: nextHour.since }, told)).toBe("reopened");
  });
});

describe("a rejected order holds the same change on the same object for 14 days", () => {
  const H = 3_600_000;
  const objects = () => [adSet("s1", { results7d: 70 }), adSet("s2", { results7d: 58 }), adSet("s3", { results7d: 50 })];
  const raisesOf = (f: Fake, id: string) => f.submitted.filter((o) => o.exec_class === "meta_ads.update_ad_set_budget" && (o.body as { ad_set_id?: string }).ad_set_id === id);

  it("hour 1 files a raise, it is rejected with a note; hour 25 files no raise on that ad set, and the hold lifts after 14 days", async () => {
    const hour1 = fake({ inventory: inv(objects()) });
    await runSpendControllerForTenant(T, NOW, hour1.deps);
    const raise = raisesOf(hour1, "s1")[0]!;
    expect(raise).toBeDefined();
    const rows = [{
      body: { cgo_dwell_key: raise.dwell_key, cgo_order_origin: "ad_spend_controller" },
      exec_class: raise.exec_class,
      exec_payload: raise.body,
      status: "rejected",
      status_at: new Date(NOW.getTime() + 0.5 * H).toISOString(),
      note: "Not this month, the cost per booking is too high",
    }];
    const withHolds = (f: Fake) => {
      f.deps.rejectedHolds = async (_t, now) => rejectedOrderHolds(rows, now);
      return f;
    };

    const hour2 = withHolds(fake({ inventory: inv(objects()), dwell: [raise.dwell_key!] }));
    await runSpendControllerForTenant(T, new Date(NOW.getTime() + 1.5 * H), hour2.deps);
    const logged = hour2.logs.filter((l) => l.code === "cgo.spend_controller_reject_hold");
    expect(logged).toHaveLength(1);
    expect(logged[0]!.message).toContain("Not this month, the cost per booking is too high");

    const hour25 = withHolds(fake({ inventory: inv(objects()) }));
    await runSpendControllerForTenant(T, new Date(NOW.getTime() + 25 * H), hour25.deps);
    expect(raisesOf(hour25, "s1")).toEqual([]);
    expect(raisesOf(hour25, "s2").length).toBe(1);
    expect(hour25.logs.filter((l) => l.code === "cgo.spend_controller_reject_hold")).toEqual([]);

    const later = withHolds(fake({ inventory: inv(objects()) }));
    await runSpendControllerForTenant(T, new Date(NOW.getTime() + (14 * 24 + 1.5) * H), later.deps);
    expect(raisesOf(later, "s1").length).toBe(1);
  });

  it("a cut or pause on the rejected object still goes; a rejected cut holds nothing", () => {
    const raiseBody = { ad_set_id: "s1", daily_budget_usd: 120, expected_current_daily_budget_usd: 100 };
    const holds = rejectedOrderHolds(
      [
        { body: { cgo_dwell_key: "obj:meta:s1" }, exec_class: "meta_ads.update_ad_set_budget", exec_payload: raiseBody, status: "rejected", status_at: NOW.toISOString(), note: "no" },
        { body: { cgo_dwell_key: "cut:meta:s2" }, exec_class: "meta_ads.update_ad_set_budget", exec_payload: { ad_set_id: "s2", daily_budget_usd: 80, expected_current_daily_budget_usd: 100 }, status: "rejected", status_at: NOW.toISOString(), note: null },
        { body: { cgo_dwell_key: "obj:meta:s3" }, exec_class: "meta_ads.set_status", exec_payload: { object_id: "s3", status: "PAUSED" }, status: "rejected", status_at: NOW.toISOString(), note: null },
        { body: { cgo_dwell_key: "obj:meta:s4" }, exec_class: "meta_ads.update_ad_set_budget", exec_payload: raiseBody, status: "displaced", status_at: NOW.toISOString(), note: null },
      ],
      new Date(NOW.getTime() + 25 * H),
    );
    expect(holds.map((h) => h.key)).toEqual([rejectHoldKey("obj:meta:s1", "meta_ads.update_ad_set_budget", raiseBody)]);
    const keys = new Set(holds.map((h) => h.key));
    const order = (exec_class: string, dwell_key: string, body: Record<string, unknown>) => ({ channel_slug: "meta_ads" as const, exec_class, body, reason: "r", dwell_key, adds_usd: 0 });
    const raiseAgain = order("meta_ads.update_ad_set_budget", "obj:meta:s1", { ...raiseBody, daily_budget_usd: 125 });
    const cut = order("meta_ads.update_ad_set_budget", "cut:meta:s1", { ad_set_id: "s1", daily_budget_usd: 80, expected_current_daily_budget_usd: 100 });
    const pause = order("meta_ads.set_status", "obj:meta:s1", { object_id: "s1", status: "PAUSED" });
    const switchOn = order("meta_ads.set_status", "obj:meta:s1", { object_id: "s1", status: "ACTIVE" });
    const r = withoutRejected([raiseAgain, cut, pause, switchOn], keys);
    expect(r.held).toEqual([raiseAgain]);
    expect(r.orders).toEqual([cut, pause, switchOn]);
    expect(withoutRejected([raiseAgain, cut, pause, switchOn], null).orders).toEqual([cut, pause]);
  });

  it("unreadable rejections: no raise this hour, and cgo is not woken for it", async () => {
    const f = fake({ inventory: inv(objects()) });
    f.deps.rejectedHolds = async () => {
      throw new Error("db down");
    };
    await runSpendControllerForTenant(T, NOW, f.deps);
    expect(f.submitted.filter(isGapOrder)).toEqual([]);
    expect(f.woke).toBe(0);
    expect(f.logs.some((l) => l.code === "cgo.spend_controller_reject_holds_unread")).toBe(true);
  });
});
