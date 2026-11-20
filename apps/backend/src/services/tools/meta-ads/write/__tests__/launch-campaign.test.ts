
import { describe, it, expect, vi, beforeEach } from "vitest";

type Obj = {
  id: string;
  kind: "campaign" | "adset" | "creative" | "ad";
  name: string;
  status: string;
  parent: string | null;
  daily_budget?: string;
  bid_strategy?: string;
  bid_amount?: string;
  end_time?: string;
};

const g = vi.hoisted(() => ({
  objs: new Map<string, Obj>(),
  posts: [] as Array<{ path: string; params: Record<string, string> }>,
  next: 1300000000,
  failEdge: null as string | null,
  bidDrift: false,
  capability: { ok: true, ad_account_id: "act_1", page_id: "5550001" } as Record<string, unknown>,
  cap: null as unknown,
  writeEnabled: true,
  currency: "USD",
  ask: null as null | { plan: Record<string, unknown> | null; line: string },
  dropEnd: false,
}));
vi.mock("@/services/approvals/approval-envelope", () => ({ founderAskFor: async () => g.ask }));

vi.mock("../_ad-set-bid", () => ({ resolveCreateAdSetBid: async (_t: string, d: unknown) => d }));
vi.mock("../../_client", () => ({
  getAdAccountCurrency: async () => "USD",
  metaAdsCreds: async () => ({ ad_account_id: "act_1", access_token: "x" }),
  fbGet: async (_t: string, path: string, params: Record<string, unknown>) => {
    const [id, edge] = path.split("/");
    if (id === "act_1" && edge === "campaigns") {
      const f = JSON.parse(String(params.filtering ?? "[]"))[0]?.value ?? "";
      return { data: [...g.objs.values()].filter((o) => o.kind === "campaign" && o.name.includes(f)).map((o) => ({ id: o.id, name: o.name })) };
    }
    if (edge === "ads" || edge === "adsets") {
      const kind = edge === "ads" ? "ad" : "adset";
      return { data: [...g.objs.values()].filter((o) => o.kind === kind && o.parent === id).map((o) => ({ id: o.id, name: o.name, status: o.status })) };
    }
    const o = g.objs.get(id!);
    return o ? { ...o, effective_status: o.status } : {};
  },
  fbPost: async (_t: string, path: string, params: Record<string, string>) => {
    g.posts.push({ path, params });
    const [id, edge] = path.split("/");
    if (g.failEdge && edge === g.failEdge) {
      g.failEdge = null;
      throw new Error("socket hang up");
    }
    const n = String(g.next++);
    if (id === "act_1" && edge === "campaigns") {
      g.objs.set(n, { id: n, kind: "campaign", name: params.name!, status: params.status!, parent: null, daily_budget: params.daily_budget, bid_strategy: params.bid_strategy });
      return { id: n };
    }
    if (id === "act_1" && edge === "adsets") {
      const bid = params.bid_amount && g.bidDrift ? String(Number(params.bid_amount) + 1) : params.bid_amount;
      g.objs.set(n, { id: n, kind: "adset", name: params.name!, status: params.status!, parent: params.campaign_id!, bid_amount: bid, ...(params.end_time && !g.dropEnd ? { end_time: params.end_time } : {}) });
      return { id: n };
    }
    if (id === "act_1" && edge === "adcreatives") {
      g.objs.set(n, { id: n, kind: "creative", name: params.name!, status: "ACTIVE", parent: null });
      return { id: n };
    }
    if (id === "act_1" && edge === "ads") {
      g.objs.set(n, { id: n, kind: "ad", name: params.name!, status: params.status!, parent: params.adset_id! });
      return { id: n };
    }
    const o = g.objs.get(id!)!;
    if (params.status) o.status = params.status;
    return { success: true };
  },
}));
vi.mock("../_library-ad-capability", () => ({ resolveMetaAdCapability: async () => g.capability }));
vi.mock("../_flag-check", () => ({ isMetaAdsWriteEnabled: async () => g.writeEnabled }));
vi.mock("../cap-reader", () => {
  const m = { readTenantCapAndToday: vi.fn(async () => ({ cap: g.cap, today_total_change_usd: 0, currency: g.currency, units_per_usd: 1 })) };
  return { ...m, readTenantCapRowAndToday: m.readTenantCapAndToday };
});

import { metaLaunchCampaign } from "../launch";
import { checkNewAdSetBid, createAdSetBodySchema, launchCampaignBodySchema, type LaunchCampaignBody } from "../_decision-bodies";
import { shapeCreateAdSetRequest } from "../_request-shapers";
import { shapeLaunchAdSetRequest } from "../_launch-shapers";
import { metaProposeCampaignLaunchTool } from "../propose_campaign_launch";
import { metaProposeNewAdSetTool } from "../propose_new_ad_set";
import { metaChangeRows } from "../_change-rows";
import { adShape } from "@/services/growth/unattended-policy";
import type { ToolContext } from "@/services/tools/types";

const TAG = "zvabcdef0123";
const targeting = { geo_locations: { countries: ["US"] }, age_min: 25 };

function body(over: { campaign?: Record<string, unknown>; ad_set?: Record<string, unknown>; ad?: Record<string, unknown> } = {}): LaunchCampaignBody {
  return launchCampaignBodySchema.parse({
    campaign: { name: "Spring launch", objective: "OUTCOME_TRAFFIC", daily_budget_usd: 20, ...over.campaign },
    ad_set: { optimization_goal: "LINK_CLICKS", billing_event: "IMPRESSIONS", targeting, ...over.ad_set },
    ad: { image_url: "https://x.com/i.png", primary_text: "Try it", headline: "New", link_url: "https://x.com", source: "zavi_generated", ...over.ad },
    rationale: "r",
  });
}

const kinds = (k: Obj["kind"]) => [...g.objs.values()].filter((o) => o.kind === k);

function ctx() {
  const emit = vi.fn(async (_c: string, _b: unknown) => "d-1");
  const c: ToolContext = { tenant_id: "t-1", log: () => {}, emit_decision: emit };
  return { c, emit };
}

beforeEach(() => {
  g.objs.clear();
  g.posts.length = 0;
  g.failEdge = null;
  g.bidDrift = false;
  g.writeEnabled = true;
  g.capability = { ok: true, ad_account_id: "act_1", page_id: "5550001" };
  g.cap = null;
  g.dropEnd = false;
});

describe("checkNewAdSetBid: a bid Meta would refuse never reaches a card", () => {
  it("a bid cap or cost cap needs an amount; lowest cost takes none; MIN_ROAS is not supported yet", () => {
    expect(checkNewAdSetBid(undefined, undefined)).toBeNull();
    expect(checkNewAdSetBid("LOWEST_COST_WITHOUT_CAP", undefined)).toBeNull();
    expect(checkNewAdSetBid("LOWEST_COST_WITH_BID_CAP", 2.5)).toBeNull();
    expect(checkNewAdSetBid("COST_CAP", 12)).toBeNull();
    expect(checkNewAdSetBid("LOWEST_COST_WITH_BID_CAP", undefined)).toMatch(/needs bid_amount_usd/);
    expect(checkNewAdSetBid("COST_CAP", undefined)).toMatch(/needs bid_amount_usd/);
    expect(checkNewAdSetBid("LOWEST_COST_WITHOUT_CAP", 3)).toMatch(/takes no bid amount/);
    expect(checkNewAdSetBid(undefined, 3)).toMatch(/needs bid_strategy/);
    expect(checkNewAdSetBid("LOWEST_COST_WITH_MIN_ROAS", undefined)).toMatch(/not supported/);
  });
});

describe("a new ad set keeps its bid from propose to Meta", () => {
  const adSet = { campaign_id: "1110001", name: "Bid set", daily_budget_usd: 30, optimization_goal: "LINK_CLICKS", billing_event: "IMPRESSIONS", targeting };

  it("the dispatch body keeps bid_strategy and bid_amount_usd (no longer stripped)", () => {
    const b = createAdSetBodySchema.parse({ ...adSet, bid_strategy: "LOWEST_COST_WITH_BID_CAP", bid_amount_usd: 2.5 });
    expect(b).toMatchObject({ bid_strategy: "LOWEST_COST_WITH_BID_CAP", bid_amount_usd: 2.5 });
    expect(createAdSetBodySchema.safeParse({ ...adSet, bid_strategy: "COST_CAP" }).success).toBe(false);
  });

  it("the Graph request carries the strategy as given and the amount in cents", () => {
    const r = shapeCreateAdSetRequest({ ...adSet, bid_strategy: "COST_CAP", bid_amount_usd: 12.34 }, "USD", "act_1");
    expect(r.params).toMatchObject({ bid_strategy: "COST_CAP", bid_amount: "1234", daily_budget: "3000" });
    const none = shapeCreateAdSetRequest(adSet, "USD", "act_1");
    expect(none.params).not.toHaveProperty("bid_strategy");
    expect(none.params).not.toHaveProperty("bid_amount");
    expect(() => shapeCreateAdSetRequest({ ...adSet, bid_amount_usd: 2 }, "USD", "act_1")).toThrow(/bid_strategy/);
  });

  it("the propose tool passes the bid onto the card, and the card shows it", async () => {
    const a = ctx();
    await metaProposeNewAdSetTool.execute(a.c, { ...adSet, bid_strategy: "LOWEST_COST_WITH_BID_CAP", bid_amount_usd: 2.5, rationale: "r" });
    const emitted = a.emit.mock.calls[0]![1];
    expect(emitted).toMatchObject({ bid_strategy: "LOWEST_COST_WITH_BID_CAP", bid_amount_usd: 2.5 });
    expect(metaChangeRows("meta_ads.create_ad_set", emitted)!.rows).toContainEqual({ item: "Bid", before: "None", after: "Bid cap, $2.50" });
  });
});

describe("launchCampaignBodySchema: an impossible launch is refused before a card", () => {
  it("refuses a bid cap with no amount, MIN_ROAS, no place, no media", () => {
    const base = body();
    const bad = (over: Record<string, Record<string, unknown>>) =>
      launchCampaignBodySchema.safeParse({ ...base, ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, { ...(base as Record<string, unknown>)[k] as object, ...v }])) });
    expect(bad({ campaign: { bid_strategy: "LOWEST_COST_WITH_BID_CAP" } }).success).toBe(false);
    expect(bad({ campaign: { bid_strategy: "LOWEST_COST_WITH_MIN_ROAS" } }).success).toBe(false);
    expect(bad({ ad_set: { targeting: { age_min: 25 } } }).success).toBe(false);
    expect(bad({ ad: { image_url: undefined } }).success).toBe(false);
    expect(bad({ ad_set: { optimization_goal: "OFFSITE_CONVERSIONS" } }).success).toBe(false);
    expect(base.campaign.bid_strategy).toBe("LOWEST_COST_WITHOUT_CAP");
  });

  it("the launch ad set carries the bid amount but never a budget or its own strategy", () => {
    const r = shapeLaunchAdSetRequest(
      { ad_account_id: "act_1", campaign_id: "1110001", name: "s", optimization_goal: "LINK_CLICKS", billing_event: "IMPRESSIONS", targeting, bid_strategy: "COST_CAP", bid_amount_usd: 4 },
      "USD",
    );
    expect(r.params).toMatchObject({ campaign_id: "1110001", bid_amount: "400", status: "PAUSED" });
    expect(r.params).not.toHaveProperty("daily_budget");
    expect(r.params).not.toHaveProperty("bid_strategy");
  });
});

describe("metaLaunchCampaign: one call ends live, with a receipt per stage", () => {
  it("builds campaign > ad set > creative > ad paused, then switches on top-level last and reads all three back ACTIVE", async () => {
    const onCampaign = vi.fn(async () => {});
    const r = await metaLaunchCampaign("t-1", {
      body: body({ campaign: { bid_strategy: "LOWEST_COST_WITH_BID_CAP" }, ad_set: { bid_amount_usd: 1.75 } }),
      campaign_name: "Spring launch",
      tag: TAG,
      onCampaign,
    });
    expect(r.receipts.map((x) => `${x.stage}:${x.outcome}`)).toEqual(["campaign:created", "ad_set:created", "creative:created", "ad:created", "live:verified"]);
    expect(onCampaign).toHaveBeenCalledWith(r.campaign_id);
    const [camp] = kinds("campaign");
    expect(camp).toMatchObject({ status: "ACTIVE", daily_budget: "2000", bid_strategy: "LOWEST_COST_WITH_BID_CAP" });
    expect(kinds("adset")[0]).toMatchObject({ status: "ACTIVE", bid_amount: "175", parent: camp!.id });
    expect(kinds("ad")[0]!.status).toBe("ACTIVE");
    expect(g.posts.find((p) => p.path === "act_1/campaigns")!.params.status).toBe("PAUSED");
    expect(g.posts.find((p) => p.path === "act_1/adsets")!.params.status).toBe("PAUSED");
    const switches = g.posts.filter((p) => p.params.status === "ACTIVE" && !p.path.startsWith("act_1/")).map((p) => p.path);
    expect(switches[switches.length - 1]).toBe(camp!.id);
    expect(r.status).toBe("ACTIVE");
  });

  it("a failed step switches the campaign off and says which stage stopped it", async () => {
    g.failEdge = "ads";
    await expect(metaLaunchCampaign("t-1", { body: body(), campaign_name: "Spring launch", tag: TAG })).rejects.toMatchObject({
      code: "meta_ads_launch_switched_off",
      message: expect.stringMatching(/at the ad stage/),
    });
    expect(kinds("campaign")[0]!.status).toBe("PAUSED");
  });

  it("Meta writes switched off mid-launch: nothing goes live and the campaign ends paused", async () => {
    g.writeEnabled = false;
    await expect(metaLaunchCampaign("t-1", { body: body(), campaign_name: "Spring launch", tag: TAG })).rejects.toMatchObject({
      code: "meta_ads_launch_switched_off",
    });
    expect(g.posts.some((p) => p.params.status === "ACTIVE" && !p.path.startsWith("act_1/"))).toBe(false);
    expect(kinds("campaign")[0]!.status).toBe("PAUSED");
  });

  it("a bid Meta stored differently from the approved one is not launched", async () => {
    g.bidDrift = true;
    await expect(
      metaLaunchCampaign("t-1", { body: body({ campaign: { bid_strategy: "COST_CAP" }, ad_set: { bid_amount_usd: 3 } }), campaign_name: "x", tag: TAG }),
    ).rejects.toMatchObject({ code: "meta_ads_launch_switched_off", message: expect.stringMatching(/not 300 as approved/) });
    expect(kinds("campaign")[0]!.status).toBe("PAUSED");
    expect(kinds("ad")).toHaveLength(0);
  });

  it("a retry finishes the first attempt's objects instead of making new ones", async () => {
    g.failEdge = "ads";
    await expect(metaLaunchCampaign("t-1", { body: body(), campaign_name: "Spring launch", tag: TAG })).rejects.toBeTruthy();
    const r = await metaLaunchCampaign("t-1", { body: body(), campaign_name: "Spring launch", tag: TAG });
    expect(kinds("campaign")).toHaveLength(1);
    expect(kinds("adset")).toHaveLength(1);
    expect(r.receipts.slice(0, 2).map((x) => x.outcome)).toEqual(["found", "found"]);
    expect(kinds("campaign")[0]!.status).toBe("ACTIVE");
  });

  it("a retry that finds the launch already live switches nothing and never switches it off", async () => {
    await metaLaunchCampaign("t-1", { body: body(), campaign_name: "Spring launch", tag: TAG });
    const [adSet] = kinds("adset");
    adSet!.status = "PAUSED";
    g.posts.length = 0;
    const r = await metaLaunchCampaign("t-1", { body: body(), campaign_name: "Spring launch", tag: TAG });
    expect(r.reused).toBe(true);
    expect(g.posts).toHaveLength(0);
    expect(adSet!.status).toBe("PAUSED");
  });

  it("a replay of a finished launch keeps it live even after the founder changed its budget", async () => {
    await metaLaunchCampaign("t-1", { body: body(), campaign_name: "Spring launch", tag: TAG });
    const [camp] = kinds("campaign");
    camp!.daily_budget = "5000";
    const r = await metaLaunchCampaign("t-1", { body: body(), campaign_name: "Spring launch", tag: TAG });
    expect(r.reused).toBe(true);
    expect(kinds("campaign")[0]!.status).toBe("ACTIVE");
  });

  it("no Facebook Page: refused before anything is made", async () => {
    g.capability = { ok: false, reason_code: "no_page", reason: "no Page" };
    await expect(metaLaunchCampaign("t-1", { body: body(), campaign_name: "x", tag: TAG })).rejects.toMatchObject({ code: "meta_ads_no_page" });
    expect(g.posts).toHaveLength(0);
  });
});

describe("meta_ads_propose_campaign_launch", () => {
  const input = {
    campaign: { name: "Spring launch", objective: "OUTCOME_TRAFFIC", daily_budget_usd: 20 },
    ad_set: { optimization_goal: "LINK_CLICKS", billing_event: "IMPRESSIONS", targeting },
    ad: { image_url: "https://x.com/i.png", primary_text: "Try it", headline: "New", link_url: "https://x.com", source: "zavi_generated" },
    rationale: "founder asked",
  };

  it("emits one meta_ads.launch_campaign card whose rows show the whole launch going live", async () => {
    const a = ctx();
    const r = await metaProposeCampaignLaunchTool.execute(a.c, input);
    expect(r).toMatchObject({ decision_class: "meta_ads.launch_campaign" });
    const [cls, emitted] = a.emit.mock.calls[0]!;
    expect(cls).toBe("meta_ads.launch_campaign");
    const rows = metaChangeRows("meta_ads.launch_campaign", emitted)!;
    expect(rows.rows).toContainEqual({ item: "Daily budget", before: "None", after: "$20/day on the campaign" });
    expect(rows.rows).toContainEqual({ item: "Status", before: "None", after: "Live" });
  });

  it("excluded_locations become the ad set's excluded_geo_locations", async () => {
    const a = ctx();
    await metaProposeCampaignLaunchTool.execute(a.c, { ...input, ad_set: { ...input.ad_set, excluded_locations: ["city:2418956", "country:ca"] } });
    const emitted = a.emit.mock.calls[0]![1] as { ad_set: { targeting: Record<string, unknown> } };
    expect(emitted.ad_set.targeting.excluded_geo_locations).toEqual({ countries: ["CA"], cities: [{ key: "2418956" }] });
    expect(emitted.ad_set.targeting.geo_locations).toEqual(targeting.geo_locations);
  });

  it("refuses over the tenant ceiling, without a Page, and an impossible bid, emitting nothing", async () => {
    const a = ctx();
    g.cap = { enabled: true, max_daily_budget_usd: 10 };
    await expect(metaProposeCampaignLaunchTool.execute(a.c, input)).rejects.toMatchObject({ code: "meta_ads_proposal_over_absolute_cap" });
    g.cap = null;
    g.capability = { ok: false, reason_code: "no_page", reason: "no Page" };
    await expect(metaProposeCampaignLaunchTool.execute(a.c, input)).rejects.toMatchObject({ code: "meta_ads_no_page" });
    g.capability = { ok: true, ad_account_id: "act_1", page_id: "5550001" };
    await expect(
      metaProposeCampaignLaunchTool.execute(a.c, { ...input, campaign: { ...input.campaign, bid_strategy: "COST_CAP" } }),
    ).rejects.toMatchObject({ code: "meta_ads_invalid_launch_body" });
    expect(a.emit).not.toHaveBeenCalled();
  });

  it("cgo treats it as a create, and asks the founder when no place is named", () => {
    expect(adShape("meta_ads.launch_campaign", body())).toEqual({ cls: "create", platform: "meta", missingLocation: false, asks: [] });
    expect(adShape("meta_ads.launch_campaign", { ad_set: { targeting: {} } })).toMatchObject({ cls: "create", missingLocation: true });
  });
});

describe("a founder's dollar ask on Meta is sized only on a USD account (F5)", () => {
  const input = {
    campaign: { name: "Spring launch", objective: "OUTCOME_TRAFFIC", daily_budget_usd: 800 },
    ad_set: { optimization_goal: "LINK_CLICKS", billing_event: "IMPRESSIONS", targeting },
    ad: { image_url: "https://x.com/i.png", primary_text: "Try it", headline: "New", link_url: "https://x.com", source: "zavi_generated" },
    rationale: "founder asked",
  };
  const plan = { channel_slug: "meta_ads", budget_type: "daily", daily_usd: 9.52, total_usd: 50, end: "2026-12-20", days: 3 };
  it("USD: the plan's daily and end are applied", async () => {
    g.currency = "USD";
    g.ask = { plan, line: "Running $9.52 a day on Meta" };
    const a = ctx();
    const r = (await metaProposeCampaignLaunchTool.execute(a.c, input)) as Record<string, unknown>;
    const emitted = a.emit.mock.calls[0]![1] as { campaign: { daily_budget_usd: number }; ad_set: { end_time?: string } };
    expect(emitted.campaign.daily_budget_usd).toBe(9.52);
    expect(Date.parse(emitted.ad_set.end_time!)).toBe(Date.parse("2026-12-20T00:00:00Z"));
    expect(r.say_to_founder).toMatch(/^Running \$9\.52 a day on Meta It stops [A-Z][a-z]{2} \d{1,2} at \d{2}:\d{2} UTC\.$/);
    g.ask = null;
  });
  it("INR: not shaped (no rupees = dollars); the founder is told the card is waiting", async () => {
    g.currency = "INR";
    g.ask = { plan, line: "Running $9.52 a day on Meta" };
    const a = ctx();
    const r = (await metaProposeCampaignLaunchTool.execute(a.c, input)) as Record<string, unknown>;
    const emitted = a.emit.mock.calls[0]![1] as { campaign: { daily_budget_usd: number }; ad_set: { end_time?: string } };
    expect(emitted.campaign.daily_budget_usd).toBe(800);
    expect(emitted.ad_set.end_time).toBeUndefined();
    expect(r.say_to_founder).toBe("I can only size a direct ask in USD; the card is waiting for you.");
    g.ask = null;
    g.currency = "USD";
  });
});

describe("metaLaunchCampaign: a test's ad set must read back its end before anything goes on", () => {
  const END = "2026-11-03T00:00:00+00:00";
  it("the end reads back: it goes live as usual", async () => {
    const r = await metaLaunchCampaign("t-1", { body: body({ ad_set: { end_time: END } }), campaign_name: "Spring launch", tag: TAG, testEndsOn: "2026-11-03" });
    expect(r.status).toBe("ACTIVE");
    expect(g.posts.find((p) => p.path === "act_1/adsets")!.params.end_time).toMatch(/^2026-11-03T00:00:00/);
  });
  it("Meta does not keep the end: nothing is switched on and the campaign is confirmed off", async () => {
    g.dropEnd = true;
    await expect(metaLaunchCampaign("t-1", { body: body({ ad_set: { end_time: END } }), campaign_name: "Spring launch", tag: TAG, testEndsOn: "2026-11-03" })).rejects.toMatchObject({
      code: "meta_ads_launch_switched_off",
      message: expect.stringMatching(/not switched on/),
    });
    expect(kinds("campaign")[0]!.status).toBe("PAUSED");
    expect(g.posts.some((p) => p.params.status === "ACTIVE" && !p.path.startsWith("act_1/"))).toBe(false);
  });
  it("a retry that finds its own ad set from an earlier attempt keeps that sooner end", async () => {
    g.objs.set("1200000900", { id: "1200000900", kind: "campaign", name: `Spring launch ${TAG}`, status: "PAUSED", parent: null, daily_budget: "2000", bid_strategy: "LOWEST_COST_WITHOUT_CAP" });
    g.objs.set("1200000901", { id: "1200000901", kind: "adset", name: `Spring launch ${TAG}`, status: "PAUSED", parent: "1200000900", end_time: "2099-01-02T00:00:00+0000" });
    const r = await metaLaunchCampaign("t-1", { body: body({ ad_set: { end_time: "2099-01-03T00:00:00+00:00" } }), campaign_name: "Spring launch", tag: TAG, testEndsOn: "2099-01-03" });
    expect(r.status).toBe("ACTIVE");
    expect(r.ad_set_id).toBe("1200000901");
  });
  it("an end later than the test's is never accepted", async () => {
    await expect(metaLaunchCampaign("t-1", { body: body({ ad_set: { end_time: "2026-11-10T00:00:00+00:00" } }), campaign_name: "Spring launch", tag: TAG, testEndsOn: "2026-11-03" })).rejects.toMatchObject({
      code: "meta_ads_launch_switched_off",
    });
  });
});

describe("metaLaunchCampaign built paused (the founder's campaign editor)", () => {
  const pausedBody = () =>
    launchCampaignBodySchema.parse({ ...body(), switch_on: false, origin: "user_initiated_ledger" });

  it("switches the ad set and ad on but leaves the campaign PAUSED, so nothing delivers", async () => {
    const r = await metaLaunchCampaign("t-1", { body: pausedBody(), campaign_name: "Spring launch", tag: TAG });
    const [camp] = kinds("campaign");
    expect(camp!.status).toBe("PAUSED");
    expect(kinds("adset")[0]!.status).toBe("ACTIVE");
    expect(kinds("ad")[0]!.status).toBe("ACTIVE");
    expect(g.posts.some((p) => p.path === camp!.id && p.params.status === "ACTIVE")).toBe(false);
    expect(r.status).toBe("PAUSED");
  });

  it("only the founder's editor may ask for a paused build", () => {
    expect(launchCampaignBodySchema.safeParse({ ...body(), switch_on: false }).success).toBe(false);
    expect(launchCampaignBodySchema.safeParse({ ...body(), switch_on: false, origin: "agent" }).success).toBe(false);
  });
});
