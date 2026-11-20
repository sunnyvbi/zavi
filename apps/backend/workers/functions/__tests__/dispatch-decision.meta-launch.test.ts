
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: async () => false }));
const armStop = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => (_a[2] ? { ok: true as boolean, line: "Runs $48/day until Nov 3, planned about $480. Zavi pauses it if spend gets there." as string | null, why: "" } : { ok: true as boolean, line: null as string | null, why: "" })));
vi.mock("@/services/growth/test-stops", async (orig) => ({ ...(await orig<typeof import("@/services/growth/test-stops")>()), armCreatedTestStop: async (...a: unknown[]) => (await armStop(...a)) ?? (a[2] ? { ok: true, line: "Runs $48/day until Nov 3, planned about $480. Zavi pauses it if spend gets there." } : { ok: true, line: null }) }));
const testEndMock = vi.hoisted(() => ({ end: null as null | { decision_id: string; channel: string | null; ends_on: string } }));
const noFriction = vi.hoisted(() => ({ on: false }));
vi.mock("@/services/growth/ads-no-friction-flag", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/ads-no-friction-flag")>()),
  adsNoFrictionEnabled: async () => noFriction.on,
}));
vi.mock("@/services/growth/cgo-test-end", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/cgo-test-end")>()),
  cgoTestEndForRun: vi.fn(async () => testEndMock.end),
}));
import { overProjectionGate } from "@/services/decisions/ad-budget";
import { makeAdBudgetFake } from "./_ad-budget-fake";

const mocks = vi.hoisted(() => ({
  capReaderMock: vi.fn(),
  serviceClientMock: vi.fn(),
  capabilityMock: vi.fn(),
  googleCreateMock: vi.fn(),
  googleSetCampaignStatusMock: vi.fn(),
  gadsGetCampaignMock: vi.fn(),
  gadsSearchMock: vi.fn(),
  googleCapMock: vi.fn(),
}));

let fake = makeAdBudgetFake(null);
let autopilotOn = true;
vi.mock("@/services/settings", () => ({
  getBoolSettingStrictResolved: async (k: string) => (k === "cgo_autopilot_enabled" ? autopilotOn : false),
  getBoolSetting: async (k: string) => k === "meta_bid_by_strategy_enabled",
}));
vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/decisions/auto-fire-rate-cap", () => ({ checkAutoFireRateCap: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(), LOG_META_KEYS: [] }));
vi.mock("@/services/decisions/atomic-claim", () => ({ claimDecision: vi.fn(), markDispatched: vi.fn(), releaseClaim: vi.fn() }));
vi.mock("@/services/decisions/waiver-resolve", () => ({ resolveWaiverState: vi.fn(async () => ({ state: "none" })) }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: vi.fn(async () => {}) }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecisionId: vi.fn(async () => {}) }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn() }));
const recheck = vi.hoisted(() => ({ result: { ok: true } as { ok: true } | { ok: false; why: string }, calls: 0 }));
vi.mock("@/services/growth/copy-regions", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/copy-regions")>()),
  recheckRegionCopy: async () => {
    recheck.calls += 1;
    return recheck.result;
  },
}));
vi.mock("@/agents/engineer/output-schema", () => ({ prProposalSchema: { safeParse: () => ({ success: false, error: { issues: [] } }) } }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/mcp/internal/jira", () => ({ jiraCreateIssue: vi.fn(), jiraAddComment: vi.fn() }));
vi.mock("@/services/mcp/internal/linear", () => ({ linearCreateIssue: vi.fn(), linearAddComment: vi.fn() }));
vi.mock("../digest-post-handler", () => ({ digestPostHandler: vi.fn() }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: vi.fn(async () => false) }));
vi.mock("../dispatch-notice", () => ({ buildDispatchNotice: vi.fn(), buildOpenPrNotice: vi.fn(), extractChatThreadId: vi.fn(), HANDLER_LABELS: {} }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("@/services/tools/meta-ads/write/cap-reader", () => ({ readTenantCapAndToday: mocks.capReaderMock }));
vi.mock("@/services/tools/meta-ads/write/_library-ad-capability", () => ({ resolveMetaAdCapability: mocks.capabilityMock }));
vi.mock("@/services/growth/unattended-policy", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/unattended-policy")>()),
  authorizeUnattended: vi.fn(async () => ({ verdict: "allow", reasons: [] })),
}));
vi.mock("@/services/tools/google-ads/write/create_campaign", () => ({ googleCreateCampaign: mocks.googleCreateMock }));
vi.mock("@/services/tools/google-ads/write/set_status", () => ({
  googleSetCampaignStatus: mocks.googleSetCampaignStatusMock,
  googleSetAdGroupStatus: vi.fn(),
  googleSetAdStatus: vi.fn(),
}));
vi.mock("@/services/tools/google-ads/write/cap-reader", () => ({ readTenantGoogleCapAndToday: mocks.googleCapMock }));
vi.mock("@/services/tools/google-ads/write/_currency-guard", () => ({ googleCurrencyRefusal: vi.fn(async () => null), assertUsdGoogleAccount: vi.fn() }));
vi.mock("@/services/tools/google-ads/_client", async (orig) => ({
  ...(await orig<typeof import("@/services/tools/google-ads/_client")>()),
  gadsGetCampaign: mocks.gadsGetCampaignMock,
  gadsSearch: mocks.gadsSearchMock,
  gadsGetBudgetGuardFacts: vi.fn(async () => ({ currency_code: "USD", budget_period: "DAILY" })),
}));

type Obj = { id: string; type: "campaign" | "adset" | "ad"; name: string; status: string; parent: string | null; daily_budget?: string | null; lifetime_budget?: string | null; account?: string; targeting?: Record<string, unknown>; end_time?: string | null };
const ACCOUNT = "act_123";
let currency = "USD";
let objects = new Map<string, Obj>();
let nextId = 900000;
let posts: Array<{ path: string; params: Record<string, string> }> = [];
let pixels: string[] = ["5550001"];
let audiences: Array<{ id: string; name: string; rule?: string }> = [];
let failPost: (path: string, params: Record<string, string>) => Error | null = () => null;
let failGet: (path: string) => Error | null = () => null;
let ignoreBudget = false;
let childrenCopiedLive = false;
let ignoreStatus = false;
let ignoreEnd = false;

function put(o: Obj) {
  objects.set(o.id, o);
}
const kids = (parent: string, type: Obj["type"]) => [...objects.values()].filter((o) => o.parent === parent && o.type === type);

function seed(o: { campaignStatus?: string; setStatus?: string; adStatuses?: string[]; cbo?: boolean } = {}) {
  objects = new Map();
  put({ id: "1110001", type: "campaign", name: "Prospecting", status: o.campaignStatus ?? "ACTIVE", parent: null, daily_budget: o.cbo ? "20000" : null });
  put({ id: "2220001", type: "adset", name: "Winners", status: o.setStatus ?? "ACTIVE", parent: "1110001", daily_budget: o.cbo ? null : "5000" });
  (o.adStatuses ?? ["ACTIVE"]).forEach((s, i) => put({ id: `333000${i + 1}`, type: "ad", name: `Ad ${i + 1}`, status: s, parent: "2220001" }));
}

async function fbGet(_t: string, path: string, q: Record<string, unknown> = {}) {
  const getFail = failGet(path);
  if (getFail) throw getFail;
  const fields = String(q.fields ?? "");
  if (path === ACCOUNT && fields === "tos_accepted") return { tos_accepted: { custom_audience_tos: 1 } };
  if (path === ACCOUNT) return { currency };
  if (path === `${ACCOUNT}/adspixels`) return { data: pixels.map((id) => ({ id })) };
  if (path === `${ACCOUNT}/customaudiences`) return { data: audiences };
  if (path === `${ACCOUNT}/campaigns`) {
    const tag = JSON.parse(String(q.filtering))[0].value as string;
    return { data: [...objects.values()].filter((o) => o.type === "campaign" && o.name.includes(tag)) };
  }
  const [id, edge] = path.split("/");
  if (edge === "ads" || edge === "adsets") return { data: kids(id, edge === "ads" ? "ad" : "adset").map((o) => ({ id: o.id, name: o.name, status: o.status, ...(o.end_time ? { end_time: o.end_time } : {}) })) };
  if (edge === "thumbnails") return { data: [{ uri: "https://cdn.example/t.jpg", is_preferred: true }] };
  if (audiences.some((a) => a.id === id)) return { approximate_count_lower_bound: 2500 };
  const o = objects.get(id);
  if (!o) throw new Error(`no object ${id}`);
  const c = o.type === "adset" ? objects.get(o.parent!) : undefined;
  if (fields === "name,targeting") return { name: o.name, targeting: o.targeting ?? { geo_locations: { countries: ["US"] }, age_min: 21 } };
  if (fields.includes("creative")) return { id: o.id, account_id: o.account ?? "123", status: o.status, creative: { id: `44${o.id}`, image_hash: "abc123" } };
  return {
    id: o.id,
    account_id: o.account ?? "123",
    name: o.name,
    status: o.status,
    effective_status: o.status,
    campaign_id: o.type === "adset" ? o.parent : undefined,
    daily_budget: o.daily_budget ?? null,
    lifetime_budget: o.lifetime_budget ?? null,
    ...(o.end_time ? { end_time: o.end_time } : {}),
    campaign: c ? { id: c.id, status: c.status, daily_budget: c.daily_budget ?? null, lifetime_budget: null } : undefined,
  };
}

function copyTree(src: Obj, parent: string | null, suffix: string | null, map: Array<Record<string, string>>, status: string, deep: boolean): Obj {
  const id = String(nextId++);
  const copy: Obj = { ...src, id, parent, status, name: suffix ? `${src.name}${suffix}` : src.name };
  put(copy);
  map.push({ ad_object_type: src.type === "adset" ? "ad_set" : src.type, source_id: src.id, copied_id: id });
  if (deep) for (const k of kids(src.id, src.type === "campaign" ? "adset" : "ad")) copyTree(k, id, null, map, childrenCopiedLive ? "ACTIVE" : status, true);
  return copy;
}

async function fbPost(_t: string, path: string, params: Record<string, string>) {
  posts.push({ path, params });
  const fail = failPost(path, params);
  if (fail) throw fail;
  if (path.endsWith("/copies")) {
    const src = objects.get(path.split("/")[0])!;
    const rename = JSON.parse(params.rename_options);
    const suffix = rename.rename_strategy === "NO_RENAME" ? null : (rename.rename_suffix as string);
    const map: Array<Record<string, string>> = [];
    const parent = params.campaign_id ?? params.adset_id ?? src.parent;
    const copy = copyTree(src, parent, suffix, map, params.status_option, params.deep_copy === "true");
    if (src.type === "ad") return { copied_ad_id: copy.id };
    return src.type === "adset"
      ? { copied_adset_id: copy.id, ad_object_ids: map.slice(1) }
      : { copied_campaign_id: copy.id, ad_object_ids: map.slice(1) };
  }
  if (path === `${ACCOUNT}/customaudiences`) {
    const a = { id: String(nextId++), name: params.name, rule: params.rule };
    audiences.push(a);
    return { id: a.id };
  }
  if (path === `${ACCOUNT}/adcreatives`) return { id: String(nextId++) };
  if (path === `${ACCOUNT}/adsets`) {
    const id = String(nextId++);
    put({ id, type: "adset", name: params.name, status: params.status, parent: params.campaign_id, daily_budget: params.daily_budget, ...(params.end_time ? { end_time: params.end_time.replace(/([+-]\d{2}):(\d{2})$/, "$1$2") } : {}) });
    return { id };
  }
  if (path === `${ACCOUNT}/ads`) {
    const id = String(nextId++);
    put({ id, type: "ad", name: params.name, status: params.status, parent: params.adset_id });
    return { id };
  }
  const o = objects.get(path);
  if (!o) throw new Error(`post to unknown ${path}`);
  if (params.targeting) o.targeting = JSON.parse(params.targeting);
  if (params.daily_budget && !ignoreBudget) o.daily_budget = params.daily_budget;
  if (params.name) o.name = params.name;
  if (params.end_time && !ignoreEnd) o.end_time = params.end_time.replace(/Z$/, "+0000").replace(/([+-]\d{2}):(\d{2})$/, "$1$2");
  if (params.status && !ignoreStatus) o.status = params.status;
  if (params.status) ignoreStatus = false;
  return { success: true };
}

vi.mock("@/services/tools/meta-ads/_client", () => ({
  fbGet: (t: string, p: string, q: Record<string, unknown>) => fbGet(t, p, q),
  fbPost: (t: string, p: string, q: Record<string, string>) => fbPost(t, p, q),
  getAdAccountCurrency: async () => currency,
  metaAdsCreds: async () => ({ ad_account_id: ACCOUNT, access_token: "tok" }),
}));

import { __testOnly_handlers as HANDLERS } from "../dispatch-decision";
import { ExpectedToolError } from "@/services/tools/types";
import { ruleReadsPixel } from "@/services/tools/meta-ads/write/launch";
import { launchTag } from "@/services/tools/meta-ads/write/_launch-shapers";

const OWNER = "owner-1";
const RUN = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const GENEROUS = { enabled: true, max_daily_budget_usd: 100_000, max_pct_change_per_run: 1000, max_daily_total_change_usd: null };

function row(id: string, decision_class: string, body: Record<string, unknown>, by: "cgo" | "founder" = "cgo") {
  return {
    id,
    tenant_id: "tenant-1",
    agent_run_id: RUN,
    decision_class,
    status: "approved",
    handler: null,
    body,
    approved_by: OWNER,
    approved_by_source: by === "cgo" ? "cgo" : null,
  };
}
const ID = (n: number) => `${String(n).padStart(8, "a")}-1111-4222-8333-444455556666`;

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  fake = makeAdBudgetFake({ cap: 25_000, spent: 518, days: 30, margin: 1 });
  autopilotOn = true;
  currency = "USD";
  posts = [];
  nextId = 900000;
  pixels = ["5550001"];
  audiences = [];
  failPost = () => null;
  failGet = () => null;
  ignoreBudget = false;
  childrenCopiedLive = false;
  ignoreStatus = false;
  ignoreEnd = false;
  testEndMock.end = null;
  noFriction.on = false;
  seed();
  mocks.capReaderMock.mockResolvedValue({ cap: GENEROUS, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 });
  mocks.googleCapMock.mockResolvedValue({ cap: GENEROUS, today_total_change_usd: 0 });
  mocks.serviceClientMock.mockReturnValue({
    from: () => ({ insert: vi.fn(async () => ({ error: null })) }),
    rpc: (n: string, a: Record<string, unknown>) => fake.rpc(n, a),
  });
  mocks.capabilityMock.mockResolvedValue({ ok: true, ad_account_id: ACCOUNT, page_id: "7770001", page_name: "Biz", ad_sets: [] });
});

const statusPosts = () => posts.filter((p) => p.params.status && !p.path.endsWith("/ads"));

describe("acceptance 2: a Meta spend order ends with a live copy, never a paused shell", () => {
  it("cgo duplicate_ad_set copies the running ad set ACTIVE at its own budget, holds it as live, and records the ids", async () => {
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(1), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 300 }));
    expect(r.ok).toBe(true);
    const copy = posts.find((p) => p.path === "2220001/copies")!;
    expect(copy.params).toMatchObject({ deep_copy: "false", status_option: "PAUSED" });
    const copies = kids("1110001", "adset").filter((o) => o.id !== "2220001");
    expect(copies).toHaveLength(1);
    const c = copies[0];
    expect(c.status).toBe("ACTIVE");
    expect(c.daily_budget).toBe("30000");
    expect(c.name).toMatch(/^Zavi · Winners copy · zv/);
    expect(kids(c.id, "ad").map((a) => a.status)).toEqual(["ACTIVE"]);
    expect(fake.res.get(`${ID(1)}:create`)).toMatchObject({ status: "committed", object_id: c.id });
    expect(fake.res.get(`${ID(1)}:resume`)).toMatchObject({ status: "committed", object_id: c.id });
    expect(fake.heldDaily("meta", c.id)).toBe(300);
    expect(fake.budget!.held).toBe(300 * 30);
    expect(statusPosts().filter((p) => p.params.status === "PAUSED")).toEqual([]);
    const order = posts.map((p) => (p.path.endsWith("/copies") ? "copy" : p.params.daily_budget ? `budget:${p.path}` : `${p.params.status}:${p.path}`));
    expect(order[0]).toBe("copy");
    expect(order[1]).toBe(`budget:${c.id}`);
    expect(order[order.length - 1]).toBe(`ACTIVE:${c.id}`);
    expect(r.notice).toContain(c.id);
    expect(JSON.parse(r.agent_outcome!)).toMatchObject({ object_id: c.id, status: "ACTIVE" });
  });

  it("a region copy (the spend controller's) shows only in its places, set before it goes live", async () => {
    const places = [{ type: "region", key: "4401", name: "Northfield, United States" }];
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(40), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 40, places }));
    expect(r.ok).toBe(true);
    const c = kids("1110001", "adset").find((o) => o.id !== "2220001")!;
    expect(c.targeting).toEqual({ geo_locations: { regions: [{ key: "4401" }] }, age_min: 21 });
    const placesAt = posts.findIndex((p) => p.path === c.id && p.params.targeting);
    const onAt = posts.findIndex((p) => p.path === c.id && p.params.status === "ACTIVE");
    expect(placesAt).toBeGreaterThan(-1);
    expect(placesAt).toBeLessThan(onAt);
    expect(r.notice).toContain("Shown in Northfield, United States");
  });

  it("a region copy above its source's live daily budget is refused before anything is copied", async () => {
    const places = [{ type: "region", key: "4401", name: "Northfield, United States" }];
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(41), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 80, places }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/may not exceed its source's daily budget/);
    expect(posts.some((p) => p.path.endsWith("/copies"))).toBe(false);
  });

  it("fail closed: a region copy of a source whose own daily budget is unknown is refused, nothing copied", async () => {
    seed({ cbo: true });
    const places = [{ type: "region", key: "4401", name: "Northfield, United States" }];
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(42), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 10, places }));
    expect(r.ok).toBe(false);
    expect(posts.some((p) => p.path.endsWith("/copies"))).toBe(false);
  });

  it("must catch: a same-goal ad went live in the region since the plan, so the region copy is refused, nothing held or copied", async () => {
    recheck.result = { ok: false, why: "Northfield, United States now has a live ad after the same result" };
    const places = [{ type: "region", key: "4401", name: "Northfield, United States" }];
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(43), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 40, places }));
    recheck.result = { ok: true };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/region copy refused: .*same result/);
    expect(posts.some((p) => p.path.endsWith("/copies"))).toBe(false);
    expect(fake.res.get(`${ID(43)}:create`)).toBeUndefined();
  });

  it("a copy without places (not a region copy) is not re-checked", async () => {
    recheck.calls = 0;
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(44), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 40 }));
    expect(r.ok).toBe(true);
    expect(recheck.calls).toBe(0);
  });

  it("a retry of the same action finds its copy by the tag and never copies twice", async () => {
    const d = row(ID(2), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 120 });
    await HANDLERS["meta_ads.duplicate_ad_set"](d);
    const again = await HANDLERS["meta_ads.duplicate_ad_set"]({ ...d });
    expect(again.ok).toBe(true);
    expect(posts.filter((p) => p.path.endsWith("/copies"))).toHaveLength(1);
    expect(kids("1110001", "adset")).toHaveLength(2);
    expect(fake.budget!.held).toBe(120 * 30);
  });

  it("an ad that is off in the source is not copied at all (a founder's pause is never undone)", async () => {
    seed({ adStatuses: ["ACTIVE", "PAUSED"] });
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(3), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 50 }));
    expect(r.ok).toBe(true);
    const c = kids("1110001", "adset").find((o) => o.id !== "2220001")!;
    const ads = kids(c.id, "ad");
    expect(ads.find((a) => a.name === "Ad 1")!.status).toBe("ACTIVE");
    expect(ads.find((a) => a.name === "Ad 2")).toBeUndefined();
  });

  it("a source the founder switched off is never copied live: refused before any hold", async () => {
    seed({ setStatus: "PAUSED" });
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(4), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 50 }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("meta_ads_duplicate_source_paused");
    expect(posts).toEqual([]);
    expect(fake.namesCalled().filter((n) => n === "reserve_ad_spend")).toEqual([]);
  });

  it("a campaign the founder switched off is not copied either", async () => {
    seed({ campaignStatus: "PAUSED" });
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(5), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 50 }));
    expect(r.code).toBe("meta_ads_duplicate_source_paused");
    expect(posts).toEqual([]);
  });

  it("USD only: a non-USD account is refused before any hold or copy", async () => {
    currency = "EUR";
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(6), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 50 }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/USD and INR ad accounts only; got EUR/);
    expect(posts).toEqual([]);
    expect(fake.budget!.held).toBe(0);
  });

  it("a copy past the month's budget is refused and nothing is copied", async () => {
    fake = makeAdBudgetFake({ cap: 1000, spent: 900, days: 30, margin: 1 });
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(7), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 50 }));
    expect(r.error).toBe("cap_refuse: ad_budget_over_month");
    expect(posts).toEqual([]);
  });

  it("the cgo re-check still runs: Autopilot switched off means nothing is copied", async () => {
    autopilotOn = false;
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(8), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 50 }));
    expect(r.error).toMatch(/^cgo_not_authorized/);
    expect(posts).toEqual([]);
  });

  it("an ad set in a CBO campaign is copied as the campaign instead", async () => {
    seed({ cbo: true });
    const refused = await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(9), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 80 }));
    expect(refused.code).toBe("meta_ads_duplicate_cbo_use_campaign");
    const r = await HANDLERS["meta_ads.duplicate_campaign"](row(ID(10), "meta_ads.duplicate_campaign", { source_campaign_id: "1110001", daily_budget_usd: 80 }));
    expect(r.ok).toBe(true);
    const camp = [...objects.values()].find((o) => o.type === "campaign" && o.id !== "1110001")!;
    expect(camp.status).toBe("ACTIVE");
    expect(camp.daily_budget).toBe("8000");
    expect(kids(camp.id, "adset")).toHaveLength(1);
    expect(fake.heldDaily("meta", camp.id)).toBe(80);
    expect(fake.calls.filter((c) => c.name === "reserve_ad_spend").every((c) => c.args.p_paused === undefined)).toBe(true);
    expect(fake.res.get(`${ID(10)}:create`)).toMatchObject({ status: "committed", object_id: camp.id });
    expect(fake.res.get(`${ID(10)}:create`)!.paused).toBeUndefined();
    expect(fake.budget!.held).toBe(80 * 30);
  });
});

describe("CBO under a budget: Autopilot raises the campaign instead of refusing", () => {
  const createBody = {
    campaign_id: "1110001",
    name: "More reach",
    daily_budget_usd: 100,
    optimization_goal: "LINK_CLICKS",
    billing_event: "IMPRESSIONS",
    targeting: { geo_locations: { countries: ["US"] } },
    rationale: "",
  };
  it("cgo create_ad_set on a CBO campaign raises the campaign's daily budget by the amount, held as a raise", async () => {
    seed({ cbo: true });
    const r = await HANDLERS["meta_ads.create_ad_set"](row(ID(11), "meta_ads.create_ad_set", createBody));
    expect(r.ok).toBe(true);
    expect(objects.get("1110001")!.daily_budget).toBe("30000");
    expect(fake.res.get(`${ID(11)}:raise`)).toMatchObject({ status: "committed", object_id: "1110001", delta: 100 });
    expect(fake.res.get(`${ID(11)}:create`)!.status).toBe("released");
    expect(kids("1110001", "adset")).toHaveLength(1);
  });
  it("a retry of the same raise never adds the amount twice", async () => {
    seed({ cbo: true });
    const d = row(ID(22), "meta_ads.create_ad_set", createBody);
    await HANDLERS["meta_ads.create_ad_set"](d);
    const again = await HANDLERS["meta_ads.create_ad_set"]({ ...d });
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/^meta_ads_cbo_raise_in_flight/);
    expect(objects.get("1110001")!.daily_budget).toBe("30000");
  });
  it("a founder's create on a CBO campaign is still refused, unchanged", async () => {
    seed({ cbo: true });
    const r = await HANDLERS["meta_ads.create_ad_set"](row(ID(12), "meta_ads.create_ad_set", createBody, "founder"));
    expect(r.error).toBe("cap_refuse: ad_budget_cbo_campaign_in_budget");
    expect(objects.get("1110001")!.daily_budget).toBe("20000");
  });
});

describe("acceptance 5, platform half: a paused create reserves as a create, stamped with its id", () => {
  it("create_ad_set takes op=create (no object yet) and commits the new ad set's id onto it", async () => {
    const r = await HANDLERS["meta_ads.create_ad_set"](
      row(ID(13), "meta_ads.create_ad_set", {
        campaign_id: "1110001",
        name: "Test set",
        daily_budget_usd: 300,
        optimization_goal: "LINK_CLICKS",
        billing_event: "IMPRESSIONS",
        targeting: { geo_locations: { countries: ["US"] } },
      }),
    );
    expect(r.ok).toBe(true);
    const reserve = fake.calls.find((c) => c.name === "reserve_ad_spend")!;
    expect(reserve.args).toMatchObject({ p_op: "create", p_object_id: null, p_daily_delta_usd: 300 });
    const created = posts.find((p) => p.path === `${ACCOUNT}/adsets`)!;
    expect(created.params.status).toBe("PAUSED");
    expect(fake.res.get(`${ID(13)}:create`)!.status).toBe("committed");
    expect(fake.res.get(`${ID(13)}:resume`)).toBeUndefined();
  });
  it("an ACTIVE ad added to a live copy keeps the copy fully held (an ad adds no budget of its own)", async () => {
    await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(23), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 200 }));
    const c = kids("1110001", "adset").find((o) => o.id !== "2220001")!;
    const r = await HANDLERS["meta_ads.create_ad"](
      row(ID(24), "meta_ads.create_ad", { ad_set_id: c.id, image_url: "https://cdn.example/b.png", primary_text: "New", headline: "Fresh", link_url: "https://example.com", source: "zavi_generated" }),
    );
    expect(r.ok).toBe(true);
    expect(fake.heldDaily("meta", c.id)).toBe(200);
    expect(fake.budget!.held).toBe(200 * 30);
  });
});

describe("meta_ads.create_ad and meta_ads.create_custom_audience", () => {
  const adBody = {
    ad_set_id: "2220001",
    image_url: "https://cdn.example/a.png",
    primary_text: "Book today",
    headline: "Spring deal",
    link_url: "https://example.com/spring",
    source: "zavi_generated",
  };
  it("creates one ACTIVE ad in the ad set, adds no budget, and a retry finds it", async () => {
    const d = row(ID(14), "meta_ads.create_ad", adBody);
    const r = await HANDLERS["meta_ads.create_ad"](d);
    expect(r.ok).toBe(true);
    const ad = posts.find((p) => p.path === `${ACCOUNT}/ads`)!;
    expect(ad.params).toMatchObject({ adset_id: "2220001", status: "ACTIVE" });
    const creative = JSON.parse(posts.find((p) => p.path === `${ACCOUNT}/adcreatives`)!.params.object_story_spec);
    expect(creative).toMatchObject({ page_id: "7770001", link_data: { picture: "https://cdn.example/a.png", link: "https://example.com/spring" } });
    expect(fake.namesCalled().filter((n) => n === "reserve_ad_spend")).toEqual([]);
    const again = await HANDLERS["meta_ads.create_ad"]({ ...d });
    expect(again.ok).toBe(true);
    expect(posts.filter((p) => p.path === `${ACCOUNT}/ads`)).toHaveLength(1);
  });
  it("copy: reuses a source ad's image with new words", async () => {
    const r = await HANDLERS["meta_ads.create_ad"](
      row(ID(15), "meta_ads.create_ad", { ...adBody, image_url: undefined, source: "copy", source_ad_id: "3330001" }),
    );
    expect(r.ok).toBe(true);
    const spec = JSON.parse(posts.find((p) => p.path === `${ACCOUNT}/adcreatives`)!.params.object_story_spec);
    expect(spec.link_data).toMatchObject({ image_hash: "abc123", message: "Book today" });
  });
  it("builds a website-visitor audience on the account's only pixel, then reuses it", async () => {
    const d = row(ID(16), "meta_ads.create_custom_audience", { kind: "website_visitors", retention_days: 30, name: "Website visitors, 30 days" });
    const r = await HANDLERS["meta_ads.create_custom_audience"](d);
    expect(r.ok).toBe(true);
    const rule = JSON.parse(posts[0].params.rule);
    expect(rule.inclusions.rules[0]).toMatchObject({ event_sources: [{ id: "5550001", type: "pixel" }], retention_seconds: 30 * 86400 });
    await HANDLERS["meta_ads.create_custom_audience"](row(ID(17), "meta_ads.create_custom_audience", { kind: "website_visitors", retention_days: 30 }));
    expect(posts.filter((p) => p.path === `${ACCOUNT}/customaudiences`)).toHaveLength(1);
  });
  it("several pixels and none named: refused, nothing built", async () => {
    pixels = ["5550001", "5550002"];
    const r = await HANDLERS["meta_ads.create_custom_audience"](row(ID(18), "meta_ads.create_custom_audience", { kind: "website_visitors", retention_days: 90 }));
    expect(r.code).toBe("meta_ads_pixel_ambiguous");
    expect(posts).toEqual([]);
  });
});

describe("Google: an Autopilot create goes live in the same step (acceptance 8 executor half) and bids for clicks when blind (S2)", () => {
  const body = {
    name: "Search launch",
    channel_type: "SEARCH",
    daily_budget_usd: 60,
    bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
    location_ids: [1014221],
    rationale: "launch",
  };
  beforeEach(() => {
    mocks.googleCreateMock.mockResolvedValue({ campaign_id: "4440001", campaign_resource: "customers/1/campaigns/4440001", budget_resource: "b", ad_group_id: null, ad_group_resource: null, created_resources: 2 });
    mocks.gadsGetCampaignMock.mockResolvedValueOnce({ status: "PAUSED" }).mockResolvedValue({ status: "ENABLED" });
    mocks.googleSetCampaignStatusMock.mockResolvedValue({ resource_name: "x", status: "ENABLED" });
    mocks.gadsSearchMock.mockResolvedValue([{ metrics: { conversions: 0 } }]);
  });
  it("cgo create with a location: created, then switched on with a live hold; no conversions -> TARGET_SPEND", async () => {
    const r = await HANDLERS["google_ads.create_campaign"](row(ID(19), "google_ads.create_campaign", body));
    expect(r.ok).toBe(true);
    expect(mocks.googleCreateMock.mock.calls[0][1].bidding).toEqual({ strategy: "TARGET_SPEND" });
    expect(mocks.googleSetCampaignStatusMock).toHaveBeenCalledWith("tenant-1", { campaign_resource: "customers/1/campaigns/4440001", status: "ENABLED" });
    expect(fake.res.get(`${ID(19)}:resume`)).toMatchObject({ status: "committed", object_id: "4440001" });
    expect(r.notice).toMatch(/Autopilot switched it on/);
    expect(r.created).toMatchObject({ platform: "google", object_type: "campaign", id: "4440001", status: "ENABLED", activated_at: expect.any(String) });
  });
  it("cgo create switched on but Google's read-back does not confirm ENABLED: recorded UNVERIFIED, no activation time", async () => {
    mocks.gadsGetCampaignMock.mockReset();
    mocks.gadsGetCampaignMock.mockResolvedValueOnce({ status: "PAUSED" }).mockResolvedValue({ status: "PAUSED" });
    const r = await HANDLERS["google_ads.create_campaign"](row(ID(23), "google_ads.create_campaign", body));
    expect(r.ok).toBe(true);
    expect(r.created).toEqual({ platform: "google", object_type: "campaign", id: "4440001", status: "UNVERIFIED" });
  });
  it("cgo create switched on in the same step ends FULLY held: the whole month, not the paused create's one day", async () => {
    const r = await HANDLERS["google_ads.create_campaign"](row(ID(22), "google_ads.create_campaign", body));
    expect(r.ok).toBe(true);
    const b = fake.budget!;
    const create = fake.res.get(`${ID(22)}:create`)!;
    expect(fake.calls.find((c) => c.name === "reserve_ad_spend" && c.args.p_op === "create")?.args.p_paused).toBe(true);
    expect(create).toMatchObject({ status: "committed", object_id: "4440001", paused: false });
    expect(fake.heldDaily("google", "4440001")).toBe(60);
    expect(b.held).toBeCloseTo(60 * b.days * b.margin, 2);
    expect(b.held).toBeGreaterThan(60 * b.margin);
  });
  it("an account with conversions keeps its conversion bidding", async () => {
    mocks.gadsSearchMock.mockResolvedValue([{ metrics: { conversions: 12 } }]);
    await HANDLERS["google_ads.create_campaign"](row(ID(20), "google_ads.create_campaign", body));
    expect(mocks.googleCreateMock.mock.calls[0][1].bidding).toEqual({ strategy: "MAXIMIZE_CONVERSIONS" });
  });
  it("a founder-approved create is unchanged: stays paused, keeps its bidding", async () => {
    const r = await HANDLERS["google_ads.create_campaign"](row(ID(21), "google_ads.create_campaign", body, "founder"));
    expect(r.ok).toBe(true);
    expect(mocks.googleSetCampaignStatusMock).not.toHaveBeenCalled();
    expect(mocks.googleCreateMock.mock.calls[0][1].bidding).toEqual({ strategy: "MAXIMIZE_CONVERSIONS" });
    expect(r.notice).toMatch(/PAUSED/);
  });
});

const metaError = (status: number) => new ExpectedToolError("meta_ads_write_failed", `Meta Graph POST failed: ${status} (test)`);
const theCopy = () => kids("1110001", "adset").find((o) => o.id !== "2220001")!;

describe("A F2: a duplicate source must be in this tenant's ad account", () => {
  it("an ad set from another business's account is refused before its ads are read, any hold or any copy", async () => {
    objects.get("2220001")!.account = "999";
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(31), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 50 }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("meta_ads_invalid_target");
    expect(posts).toEqual([]);
    expect(fake.namesCalled().filter((n) => n === "reserve_ad_spend")).toEqual([]);
  });

  it("a campaign from another account is refused the same way", async () => {
    seed({ cbo: true });
    objects.get("1110001")!.account = "act_999";
    const r = await HANDLERS["meta_ads.duplicate_campaign"](row(ID(32), "meta_ads.duplicate_campaign", { source_campaign_id: "1110001", daily_budget_usd: 50 }));
    expect(r.code).toBe("meta_ads_invalid_target");
    expect(posts).toEqual([]);
    expect(fake.namesCalled().filter((n) => n === "reserve_ad_spend")).toEqual([]);
  });

  it("this account's own id, with or without the act_ prefix, is copied", async () => {
    objects.get("2220001")!.account = "act_123";
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(33), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 50 }));
    expect(r.ok).toBe(true);
  });
});

describe("A F1 + D2: the copy is made paused and any failure after it exists switches it off", () => {
  const dup = (n: number, budget = 80) => row(ID(n), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: budget });

  it("one live ad Meta refuses to copy (400) is left out, and the result says so", async () => {
    seed({ adStatuses: ["ACTIVE", "ACTIVE"] });
    failPost = (path, params) => (path === `${ACCOUNT}/ads` && params.name === "Ad 2" ? metaError(400) : null);
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](dup(46));
    expect(r.ok).toBe(true);
    expect(r.notice).toContain("Meta refused to copy 1 live ad(s) (3330002)");
    expect(JSON.parse(r.agent_outcome!).skipped_ads).toEqual(["3330002"]);
  });

  it("the copy's id is on its hold the moment Meta returns it, before its budget is set", async () => {
    let atBudget: unknown = undefined;
    failPost = (path, params) => {
      if (params.daily_budget) atBudget = fake.res.get(`${ID(34)}:create`)?.object_id;
      return null;
    };
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](dup(34));
    expect(r.ok).toBe(true);
    expect(atBudget).toBe(theCopy().id);
  });

  it("a copied child Meta refuses to change (400): the whole copy is switched off and its hold given back", async () => {
    seed({ adStatuses: ["ACTIVE", "PAUSED"] });
    failPost = (path, params) => (params.status === "ACTIVE" && objects.get(path)?.type === "ad" ? metaError(400) : null);
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](dup(36));
    expect(r.ok).toBe(false);
    const c = theCopy();
    expect(c.status).toBe("PAUSED");
    expect(posts.some((p) => p.path === c.id && p.params.status === "PAUSED")).toBe(true);
    expect(kids(c.id, "ad").find((a) => a.name === "Ad 2")).toBeUndefined();
    expect(fake.res.get(`${ID(36)}:create`)!.status).toBe("released");
    expect(fake.heldDaily("meta", c.id)).toBe(0);
  });

  it("the codex F1 case: a founder-paused ad is never copied, so Meta copying children live cannot bring it back", async () => {
    seed({ adStatuses: ["ACTIVE", "PAUSED"] });
    childrenCopiedLive = true;
    failPost = (path, params) => (params.status === "PAUSED" && objects.get(path)?.type === "ad" ? metaError(400) : null);
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](dup(45));
    expect(r.ok).toBe(true);
    const c = theCopy();
    expect(kids(c.id, "ad").map((a) => a.name)).toEqual(["Ad 1"]);
    expect(posts.some((p) => p.path === "3330002/copies")).toBe(false);
  });

  it("a 500 after the copy exists, and the copy is confirmed off: definite, hold given back", async () => {
    failPost = (path, params) => (params.status === "ACTIVE" && objects.get(path)?.type === "adset" ? metaError(500) : null);
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](dup(37));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("meta_ads_launch_switched_off");
    expect(theCopy().status).toBe("PAUSED");
    expect(fake.res.get(`${ID(37)}:create`)!.status).toBe("released");
  });

  it("the copy cannot be confirmed off: outcome unknown, the hold is NOT released and names the copy", async () => {
    failPost = (path, params) => (params.daily_budget ? metaError(400) : params.status === "PAUSED" ? metaError(500) : null);
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](dup(38));
    expect(r).toMatchObject({ ok: false, outcome_unknown: true, code: "exec_outcome_unknown" });
    const hold = fake.res.get(`${ID(38)}:create`)!;
    expect(hold.status).toBe("reserved");
    expect(hold.object_id).toBe(theCopy().id);
    expect(fake.heldDaily("meta", theCopy().id)).toBe(80);
  });

  it("Meta keeps the source's budget on the copy: it is never switched on", async () => {
    ignoreBudget = true;
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](dup(39, 30));
    expect(r.ok).toBe(false);
    const c = theCopy();
    expect(c.daily_budget).toBe("5000");
    expect(c.status).toBe("PAUSED");
    expect(posts.some((p) => p.path === c.id && p.params.status === "ACTIVE")).toBe(false);
    expect(fake.res.get(`${ID(39)}:create`)!.status).toBe("released");
  });

  it("a live copy ends fully held: the create hold for the month plus a zero-delta live hold", async () => {
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](dup(40, 90));
    expect(r.ok).toBe(true);
    expect(fake.calls.filter((c) => c.name === "reserve_ad_spend").map((c) => [c.args.p_op, c.args.p_paused])).toEqual([
      ["create", undefined],
      ["resume", undefined],
    ]);
    expect(fake.heldDaily("meta", theCopy().id)).toBe(90);
    expect(fake.budget!.held).toBe(90 * 30);
  });
});

describe("C P1: a retry never guesses a copied child's source by an ambiguous name", () => {
  function priorCopy(n: number, adNames: Array<[string, string]>) {
    objects = new Map();
    put({ id: "1110001", type: "campaign", name: "Prospecting", status: "ACTIVE", parent: null, daily_budget: null });
    put({ id: "2220001", type: "adset", name: "Winners", status: "ACTIVE", parent: "1110001", daily_budget: "5000" });
    adNames.forEach(([name, status], i) => put({ id: `333000${i + 1}`, type: "ad", name, status, parent: "2220001" }));
    const tag = `zv${ID(n).replace(/[^0-9a-f]/g, "").slice(0, 10)}`;
    put({ id: "8880001", type: "adset", name: `Winners · ${tag}`, status: "PAUSED", parent: "1110001", daily_budget: "5000" });
    adNames.forEach(([name], i) => put({ id: `888100${i + 1}`, type: "ad", name, status: "PAUSED", parent: "8880001" }));
  }

  it("two source ads share a name, one live and one the founder paused: both copies stay off", async () => {
    priorCopy(41, [["Spring", "ACTIVE"], ["Spring", "PAUSED"], ["Summer", "ACTIVE"]]);
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(41), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 40 }));
    expect(r.ok).toBe(true);
    expect(posts.filter((p) => p.path.endsWith("/copies"))).toHaveLength(0);
    const ads = kids("8880001", "ad");
    expect(ads.filter((a) => a.name === "Spring").map((a) => a.status)).toEqual(["PAUSED", "PAUSED"]);
    expect(ads.find((a) => a.name === "Summer")!.status).toBe("ACTIVE");
    expect(objects.get("8880001")!.status).toBe("ACTIVE");
  });
});

describe("C P2: an audience is reused only on the same pixel and window", () => {
  it("ruleReadsPixel reads Meta's JSON rule", () => {
    const rule = (pixel: string, days: number) =>
      JSON.stringify({ inclusions: { operator: "or", rules: [{ event_sources: [{ id: pixel, type: "pixel" }], retention_seconds: days * 86400 }] } });
    expect(ruleReadsPixel(rule("5550001", 30), "5550001", 30)).toBe(true);
    expect(ruleReadsPixel(rule("5550002", 30), "5550001", 30)).toBe(false);
    expect(ruleReadsPixel(rule("5550001", 90), "5550001", 30)).toBe(false);
    expect(ruleReadsPixel("not json", "5550001", 30)).toBe(false);
    expect(ruleReadsPixel(undefined, "5550001", 30)).toBe(false);
  });

  it("an earlier Zavi audience on pixel A is not handed back for pixel B: a new one is built on B", async () => {
    pixels = ["5550001", "5550002"];
    await HANDLERS["meta_ads.create_custom_audience"](row(ID(42), "meta_ads.create_custom_audience", { kind: "website_visitors", retention_days: 30, pixel_id: "5550001" }));
    const r = await HANDLERS["meta_ads.create_custom_audience"](row(ID(43), "meta_ads.create_custom_audience", { kind: "website_visitors", retention_days: 30, pixel_id: "5550002" }));
    expect(r.ok).toBe(true);
    const built = posts.filter((p) => p.path === `${ACCOUNT}/customaudiences`);
    expect(built).toHaveLength(2);
    expect(JSON.parse(built[1].params.rule).inclusions.rules[0].event_sources).toEqual([{ id: "5550002", type: "pixel" }]);
    expect(JSON.parse(r.agent_outcome!)).toMatchObject({ pixel_id: "5550002", reused: false });
    const again = await HANDLERS["meta_ads.create_custom_audience"](row(ID(44), "meta_ads.create_custom_audience", { kind: "website_visitors", retention_days: 30, pixel_id: "5550002" }));
    expect(JSON.parse(again.agent_outcome!)).toMatchObject({ reused: true });
    expect(posts.filter((p) => p.path === `${ACCOUNT}/customaudiences`)).toHaveLength(2);
  });
});

describe("review Q1: the live hold's fallback gives the hold back only once the copy reads off", () => {
  const stopWhenSwitchedOn = (pauseFails: boolean) => {
    failPost = (path, params) => {
      const o = objects.get(path);
      if (o?.type === "adset" && o.id !== "2220001" && params.status === "ACTIVE") fake.stop();
      if (pauseFails && o?.type === "adset" && o.id !== "2220001" && params.status === "PAUSED") return metaError(500);
      return null;
    };
  };

  it("switch-off confirmed by read-back: the hold is released", async () => {
    stopWhenSwitchedOn(false);
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(46), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 70 }));
    expect(r.ok).toBe(false);
    expect(r.outcome_unknown).toBeUndefined();
    expect(theCopy().status).toBe("PAUSED");
    expect(fake.namesCalled()).toContain("release_ad_spend_for_object");
  });

  it("switch-off not confirmed: outcome unknown, the hold is kept", async () => {
    stopWhenSwitchedOn(true);
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(47), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 70 }));
    expect(r).toMatchObject({ ok: false, outcome_unknown: true, code: "exec_outcome_unknown" });
    expect(theCopy().status).toBe("ACTIVE");
    expect(fake.namesCalled()).not.toContain("release_ad_spend_for_object");
    expect(fake.res.get(`${ID(47)}:create`)).toMatchObject({ object_id: theCopy().id });
    expect(fake.res.get(`${ID(47)}:create`)!.status).not.toBe("released");
  });

  it("Meta accepts the pause but the copy still reads ACTIVE: outcome unknown, the hold is kept", async () => {
    failPost = (path, params) => {
      const o = objects.get(path);
      if (o?.type === "adset" && o.id !== "2220001" && params.status === "ACTIVE") fake.stop();
      if (o?.type === "adset" && o.id !== "2220001" && params.status === "PAUSED") ignoreStatus = true;
      return null;
    };
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(48), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 70 }));
    expect(r).toMatchObject({ ok: false, outcome_unknown: true });
    expect(theCopy().status).toBe("ACTIVE");
    expect(fake.namesCalled()).not.toContain("release_ad_spend_for_object");
  });
});

describe("GS01: a create hold whose outcome is unknown", () => {
  const readDown = () => new ExpectedToolError("meta_ads_query_failed", "Meta Ads request failed: 500 x");
  const dup = (n: number, budget = 200) => row(ID(n), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: budget });

  it("a read before the copy fails: nothing was sent, so the hold is given back", async () => {
    failGet = (path) => (path === "1110001/adsets" ? readDown() : null);
    expect(await HANDLERS["meta_ads.duplicate_ad_set"](dup(40))).toMatchObject({ ok: false });
    expect(posts.filter((p) => p.path.endsWith("/copies"))).toEqual([]);
    expect(fake.res.get(`${ID(40)}:create`)).toMatchObject({ status: "released", object_id: null });
    expect(fake.budget!.held).toBe(0);
  });

  it("the copy itself times out: the hold is kept, labelled with the launch tag for the resolver", async () => {
    failPost = (path) => (path.endsWith("/copies") ? new ExpectedToolError("meta_ads_timeout", "Meta Graph API did not respond") : null);
    expect(await HANDLERS["meta_ads.duplicate_ad_set"](dup(41))).toMatchObject({ ok: false });
    const h = fake.res.get(`${ID(41)}:create`)!;
    expect(h).toMatchObject({ status: "reserved", object_id: null });
    expect(h.ref).toEqual({ kind: "meta_tag", level: "adset", campaign_id: "1110001", tag: launchTag(ID(41)) });
    failPost = () => null;
    failGet = (path) => (path === "1110001/adsets" ? readDown() : null);
    expect(await HANDLERS["meta_ads.duplicate_ad_set"](dup(41))).toMatchObject({ ok: false });
    expect(fake.res.get(`${ID(41)}:create`)).toMatchObject({ status: "reserved", object_id: null });
    expect(fake.budget!.held).toBe(200 * 30);
  });

  it("a hold that cannot be labelled sends nothing and is given back", async () => {
    mocks.serviceClientMock.mockReturnValue({
      from: () => ({ insert: vi.fn(async () => ({ error: null })) }),
      rpc: (n: string, a: Record<string, unknown>) =>
        n === "note_ad_spend_ref" ? Promise.resolve({ data: null, error: { message: "db down" } }) : fake.rpc(n, a),
    });
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](dup(42));
    expect(r).toMatchObject({ ok: false });
    expect(String((r as { error?: string }).error)).toContain("ad_budget_unavailable");
    expect(posts.filter((p) => p.path.endsWith("/copies"))).toEqual([]);
    expect(fake.res.get(`${ID(42)}:create`)).toMatchObject({ status: "released" });
  });
});

beforeEach(() => {
  vi.spyOn(overProjectionGate, "read").mockResolvedValue(null);
});

describe("a cgo test's Meta copy carries the test's end", () => {
  beforeEach(() => {
    testEndMock.end = { decision_id: "order-1", channel: "meta_ads", ends_on: "2026-11-03" };
  });

  it("duplicate_ad_set: the copied ad set gets the test's end before anything is switched on", async () => {
    noFriction.on = true;
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(70), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 300 }));
    expect(r.ok, String(r.error)).toBe(true);
    const c = kids("1110001", "adset").find((o) => o.id !== "2220001")!;
    expect(c.status).toBe("ACTIVE");
    expect(c.end_time).toBe("2026-11-03T00:00:00+0000");
    expect(fake.calls.find((c) => c.name === "reserve_ad_spend" && c.args.p_idem_key === `${ID(70)}:create`)?.args.p_ends_on).toBe("2026-11-04");
    const endAt = posts.findIndex((p) => p.path === c.id && p.params.end_time);
    const onAt = posts.findIndex((p) => p.path === c.id && p.params.status === "ACTIVE");
    expect(endAt).toBeGreaterThan(-1);
    expect(endAt).toBeLessThan(onAt);
    expect(objects.get("2220001")!.end_time).toBeUndefined();
  });

  it("a source's own sooner end is kept on the copy", async () => {
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    testEndMock.end = { decision_id: "order-1", channel: "meta_ads", ends_on: "2099-06-01" };
    objects.get("2220001")!.end_time = `${soon}T00:00:00+0000`;
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(71), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 300 }));
    expect(r.ok, String(r.error)).toBe(true);
    const c = kids("1110001", "adset").find((o) => o.id !== "2220001")!;
    expect(c.end_time).toBe(`${soon}T00:00:00+0000`);
  });

  it("Meta does not keep the end: the copy is never switched on and is confirmed off", async () => {
    ignoreEnd = true;
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(72), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 300 }));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/not switched on/);
    const c = kids("1110001", "adset").find((o) => o.id !== "2220001")!;
    expect(c.status).toBe("PAUSED");
    expect(posts.some((p) => p.path === c.id && p.params.status === "ACTIVE")).toBe(false);
  });

  it("the test's end cannot be read: nothing is copied", async () => {
    const { cgoTestEndForRun } = await import("@/services/growth/cgo-test-end");
    vi.mocked(cgoTestEndForRun).mockRejectedValueOnce(new Error("db down"));
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(73), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 300 }));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/could not read this test's end date, so nothing new was copied/);
    expect(posts.some((p) => p.path.endsWith("/copies"))).toBe(false);
  });

  it("not a test's run: no end is written", async () => {
    testEndMock.end = null;
    const r = await HANDLERS["meta_ads.duplicate_ad_set"](row(ID(74), "meta_ads.duplicate_ad_set", { source_ad_set_id: "2220001", daily_budget_usd: 300 }));
    expect(r.ok, String(r.error)).toBe(true);
    expect(posts.some((p) => p.params.end_time)).toBe(false);
  });
});
