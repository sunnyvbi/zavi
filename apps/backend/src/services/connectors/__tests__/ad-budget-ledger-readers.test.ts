const managedLedger = vi.hoisted(() => ({ read: async (): Promise<unknown[]> => [] }));
vi.mock("@/services/ads-wallet/linkedin-ledger",()=>({readManagedLinkedinLedger:() => managedLedger.read()}));
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { zipSync, strToU8 } from "fflate";

const connected = vi.hoisted(() => ({ slugs: new Set<string>(), tables: {} as Record<string, unknown[]>, failing: new Set<string>() }));
const logged = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>>, fail: false }));
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: async (e: Record<string, unknown>) => {
    logged.events.push(e);
    if (logged.fail) throw new Error("log table down");
  },
}));
vi.mock("@/services/tenant-client", () => {
  const client = () => ({
    from: (table: string) => {
      let slug = "";
      const within: Array<[string, unknown[]]> = [];
      const compares: Array<(r: Record<string, unknown>) => boolean> = [];
      const q = {
        select: () => q,
        order: () => q,
        range: async (from?: number, to?: number) => {
          if (connected.failing.has(table)) return { data: null, error: { message: "boom" } };
          const rows = (connected.tables[table] ?? []) as Array<Record<string, unknown>>;
          const hit = rows.filter((r) => within.every(([c, vs]) => vs.includes(r[c])) && compares.every((f) => f(r)));
          return { data: from === undefined || to === undefined ? hit : hit.slice(from, to + 1), error: null };
        },
        in: (c: string, vs: unknown[]) => (within.push([c, vs]), q),
        eq: (c: string, v: string) => {
          slug = v;
          if (table === "ad_spend_daily" || table === "ads_campaign_operations" || table === "ad_campaigns") compares.push((r) => r[c] === v);
          return q;
        },
        gte: (c: string, v: string) => (compares.push((r) => String(r[c]) >= v), q),
        lt: (c: string, v: string) => (compares.push((r) => String(r[c]) < v), q),
        gt: (c: string, v: number) => (compares.push((r) => Number(r[c]) > v), q),
        maybeSingle: async () => {
          if (connected.failing.has(table)) return { data: null, error: { message: "boom" } };
          if (table === "tenants") return { data: connected.tables.tenants?.[0] ?? null, error: null };
          return { data: connected.slugs.has(slug) ? { slug } : null, error: null };
        },
      };
      return q;
    },
  });
  return { asTenantId: (t: string) => t, tenantClient: client, globalClient: client };
});
vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: async () => "tok" }));
vi.mock("@/services/connectors/tiktok-ads/client", () => ({
  listTikTokAdvertisers: async () => [{ advertiser_id: "adv1", currency: advCurrency.value, timezone: "America/Los_Angeles" }],
}));
const advCurrency = vi.hoisted(() => ({ value: "USD" }));
const composio = vi.hoisted(() => ({
  calls: [] as string[], answers: new Map<string, unknown>(),
  state: { connected: true, accounts: [] as Array<{ advertiser_id: string }> },
  discovered: [] as string[],
  verified: new Map<string, { advertiser_id: string; currency: string; timezone: string }>(),
}));
vi.mock("@/services/connectors/tiktok-ads/composio-read", () => ({
  tiktokAdsAccount: async () => ({ connected_account_id: "ca1" }),
  listAdvertiserIds: async () => composio.discovered,
  verifyAdvertisers: async (_a: unknown, ids: string[]) => ids.flatMap((id) => (composio.verified.has(id) ? [composio.verified.get(id)!] : [])),
  tt: async (_a: unknown, path: string) => {
    composio.calls.push(path);
    for (const [k, v] of composio.answers) if (path.includes(k)) return typeof v === "function" ? v(path) : v;
    throw new Error(`unrouted composio ${path}`);
  },
}));
vi.mock("@/services/connectors/tiktok-ads/ad-accounts", () => ({
  TIKTOK_ADS_ROW_SLUG: "composio.tiktok_ads",
  ensureAdAccounts: async () => composio.state,
}));
vi.mock("@/services/connectors/apple-ads/client", async (orig) => ({
  ...(await orig<typeof import("@/services/connectors/apple-ads/client")>()),
  tenantCreds: async () => ({ clientId: "c", teamId: "t", keyId: "k", privateKeyPem: "p" }),
}));
vi.mock("@/services/connectors/apple-ads/http", async (orig) => ({
  ...(await orig<typeof import("@/services/connectors/apple-ads/http")>()),
  appleAccessToken: async () => "tok",
}));
vi.mock("@/services/connectors/linkedin-ads/client", async (orig) => ({
  ...(await orig<typeof import("@/services/connectors/linkedin-ads/client")>()),
  linkedinAdsToken: async () => "tok",
}));

import { readTiktokAccountsForBudget, tiktokSpendCapacity } from "../tiktok-ads/budget-ledger";
import { readPinterestAccountsForBudget } from "../pinterest-ads/budget-ledger";
import { readSnapchatAccountsForBudget } from "../snapchat-ads/budget-ledger";
import { readMicrosoftAccountsForBudget, parseCsv, isReportDownloadUrl, zipUnpackedBytes } from "../microsoft-ads/budget-ledger";
import { readAppleAccountsForBudget } from "../apple-ads/budget-ledger";
import { readSpotifyAccountsForBudget } from "../spotify-ads/budget-ledger";
import { readLinkedinAccountsForBudget } from "../linkedin-ads/budget-ledger";
import { resetLinkedInAdsReadCache } from "../linkedin-ads/http";
import { AdAccountLostError, classifyAdReadError } from "../core/read-error-kind";
import { ExpectedToolError } from "@/services/tools/types";
import { LINKEDIN_ADS_FORBIDDEN_READ, LINKEDIN_ADS_RECONNECT } from "../linkedin-ads/http";

const T = "tenant-1";
const START = new Date("2026-10-01T00:00:00Z");
const NOW = new Date("2026-10-05T19:00:00Z");

type Route = (url: URL, init?: RequestInit) => unknown;
let routes: Array<[RegExp, Route]> = [];
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  logged.events = [];
  logged.fail = false;
  connected.slugs = new Set();
  connected.tables = {};
  connected.failing = new Set();
  advCurrency.value = "USD";
  routes = [];
  process.env.MICROSOFT_ADS_DEVELOPER_TOKEN = "dev";
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    for (const [re, fn] of routes) if (re.test(url.href)) {
      const out = fn(url, init);
      return out instanceof Response ? out : json(out);
    }
    throw new Error(`unrouted ${url.href}`);
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("not connected: every reader returns nothing and calls no API", () => {
  it.each([
    ["tiktok", readTiktokAccountsForBudget],
    ["pinterest", readPinterestAccountsForBudget],
    ["snapchat", readSnapchatAccountsForBudget],
    ["microsoft", readMicrosoftAccountsForBudget],
    ["apple", readAppleAccountsForBudget],
    ["spotify", readSpotifyAccountsForBudget],
    ["linkedin", readLinkedinAccountsForBudget],
  ] as const)("%s", async (_p, read) => {
    expect(await read(T, START, NOW)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("TikTok", () => {
  beforeEach(() => {
    connected.slugs.add("tiktok_ads");
  });
  it("campaign budgets + spend per campaign per advertiser day; today provisional", async () => {
    routes.push([/campaign\/get/, () => ({ code: 0, message: "OK", data: {
      list: [
        { campaign_id: "c1", campaign_name: "Spring", operation_status: "ENABLE", budget: 50, budget_mode: "BUDGET_MODE_DAY" },
        { campaign_id: "c2", campaign_name: "Open", operation_status: "DISABLE", budget: 0, budget_mode: "BUDGET_MODE_INFINITE" },
      ], page_info: { page: 1, total_page: 1 } } })]);
    routes.push([/adgroup\/get/, () => ({ code: 0, message: "OK", data: {
      list: [
        { adgroup_id: "g1", adgroup_name: "Spring A", campaign_id: "c1", operation_status: "ENABLE", budget: 0, budget_mode: "BUDGET_MODE_INFINITE" },
        { adgroup_id: "g2", adgroup_name: "Open A", campaign_id: "c2", operation_status: "ENABLE", budget: "25", budget_mode: "BUDGET_MODE_DAY" },
      ], page_info: { page: 1, total_page: 1 } } })]);
    routes.push([/report\/integrated\/get/, () => ({ code: 0, message: "OK", data: {
      list: [
        { dimensions: { campaign_id: "c1", stat_time_day: "2026-10-04 00:00:00" }, metrics: { spend: "48.20" } },
        { dimensions: { campaign_id: "c1", stat_time_day: "2026-10-05 00:00:00" }, metrics: { spend: "12.00" } },
      ], page_info: { page: 1, total_page: 1 } } })]);
    const [r] = await readTiktokAccountsForBudget(T, START, NOW);
    expect(r.window).toEqual({ since: "2026-10-01", until: "2026-10-05" });
    expect(r.campaigns).toEqual([
      { object_id: "c1", level: "campaign", campaign_id: "c1", name: "Spring", budget_kind: "daily", budget_usd: 50, status: "ACTIVE", currency: "USD" },
      { object_id: "c2", level: "campaign", campaign_id: "c2", name: "Open", budget_kind: "none", budget_usd: null, status: "PAUSED", currency: "USD" },
      { object_id: "g1", level: "ad_group", campaign_id: "c1", name: "Spring A", budget_kind: "campaign_level", budget_usd: null, status: "ACTIVE", currency: "USD" },
      { object_id: "g2", level: "ad_group", campaign_id: "c2", name: "Open A", budget_kind: "daily", budget_usd: 25, status: "CAMPAIGN_PAUSED", currency: "USD" },
    ]);
    expect(r.spend).toEqual([
      { object_id: "c1", spend_date: "2026-10-04", amount_usd: 48.2, provisional: false },
      { object_id: "c1", spend_date: "2026-10-05", amount_usd: 12, provisional: true },
    ]);
  });
  it("a non-USD advertiser throws", async () => {
    advCurrency.value = "EUR";
    await expect(readTiktokAccountsForBudget(T, START, NOW)).rejects.toThrow("USD TikTok Ads");
  });
  it("an unreadable spend value throws, never counts as zero", async () => {
    routes.push([/campaign\/get/, () => ({ code: 0, message: "OK", data: { list: [], page_info: { total_page: 1 } } })]);
    routes.push([/adgroup\/get/, () => ({ code: 0, message: "OK", data: { list: [], page_info: { total_page: 1 } } })]);
    routes.push([/report\/integrated\/get/, () => ({ code: 0, message: "OK", data: { list: [
      { dimensions: { campaign_id: "c1", stat_time_day: "2026-10-04 00:00:00" }, metrics: { spend: "-" } },
    ], page_info: { total_page: 1 } } })]);
    await expect(readTiktokAccountsForBudget(T, START, NOW)).rejects.toThrow("unreadable spend");
  });
});

describe("TikTok through Composio (the live rail)", () => {
  beforeEach(() => {
    connected.slugs.add("composio.tiktok_ads");
    composio.calls = [];
    composio.answers = new Map();
    composio.state = { connected: true, accounts: [{ advertiser_id: "adv9" }] };
    composio.discovered = [];
    composio.verified = new Map([["adv9", { advertiser_id: "adv9", currency: "USD", timezone: "America/Los_Angeles" }]]);
  });
  it("reads every saved ad account through the proxy, same endpoints and shapes as native", async () => {
    composio.answers.set("/campaign/get/", { list: [{ campaign_id: "c9", campaign_name: "Hosts", operation_status: "ENABLE", budget: "80", budget_mode: "BUDGET_MODE_DAY" }], page_info: { total_page: 1 } });
    composio.answers.set("/adgroup/get/", { list: [{ adgroup_id: "g9", adgroup_name: "Hosts A", campaign_id: "c9", operation_status: "DISABLE", budget: "0", budget_mode: "BUDGET_MODE_INFINITE" }], page_info: { total_page: 1 } });
    composio.answers.set("/report/integrated/get/", { list: [{ dimensions: { campaign_id: "c9", stat_time_day: "2026-10-03 00:00:00" }, metrics: { spend: "71.5" } }], page_info: { total_page: 1 } });
    const [r] = await readTiktokAccountsForBudget(T, START, NOW);
    expect(r.account_id).toBe("adv9");
    expect(r.campaigns[0]).toMatchObject({ object_id: "c9", budget_kind: "daily", budget_usd: 80, status: "ACTIVE" });
    expect(r.campaigns[1]).toMatchObject({ object_id: "g9", level: "ad_group", campaign_id: "c9", budget_kind: "campaign_level", budget_usd: null, status: "PAUSED" });
    expect(r.spend).toEqual([{ object_id: "c9", spend_date: "2026-10-03", amount_usd: 71.5, provisional: false }]);
    expect(composio.calls.find((c) => c.startsWith("/report/integrated/get/?"))).toContain("data_level=AUCTION_CAMPAIGN");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("an ended group and its fully ended campaign no longer contribute capacity", async () => {
    composio.answers.set("/campaign/get/", { list: [{ campaign_id: "c9", operation_status: "ENABLE", budget: 60, budget_mode: "BUDGET_MODE_DAY" }] });
    composio.answers.set("/adgroup/get/", { list: [{ adgroup_id: "g9", campaign_id: "c9", operation_status: "ENABLE", secondary_status: "ADGROUP_STATUS_TIME_DONE", budget: 20.01, budget_mode: "BUDGET_MODE_DAY" }] });
    composio.answers.set("/report/integrated/get/", { list: [] });
    const [r] = await readTiktokAccountsForBudget(T, START, NOW);
    expect(r.campaigns.map((c) => c.status)).toEqual(["ENDED", "ENDED"]);
    expect(await tiktokSpendCapacity(T, NOW)).toEqual({ connected: true, capacity_usd: 0 });
  });
  it("temporary blockers and one ended child do not release a still-enabled campaign", async () => {
    composio.answers.set("/campaign/get/", { list: [{ campaign_id: "c9", operation_status: "ENABLE", budget: 60, budget_mode: "BUDGET_MODE_DAY" }] });
    composio.answers.set("/adgroup/get/", { list: [
      { adgroup_id: "g1", campaign_id: "c9", operation_status: "ENABLE", secondary_status: "ADGROUP_STATUS_TIME_DONE" },
      { adgroup_id: "g2", campaign_id: "c9", operation_status: "ENABLE", secondary_status: "ADGROUP_STATUS_CAMPAIGN_EXCEED" },
    ] });
    composio.answers.set("/report/integrated/get/", { list: [] });
    expect((await readTiktokAccountsForBudget(T, START, NOW))[0].campaigns[0].status).toBe("ACTIVE");
    expect(await tiktokSpendCapacity(T, NOW)).toEqual({ connected: true, capacity_usd: 60 });
  });
  it("a later live group prevents an ended verdict even when page two omits metadata", async () => {
    composio.answers.set("/campaign/get/", { list: [{ campaign_id: "c9", operation_status: "ENABLE", budget: 60, budget_mode: "BUDGET_MODE_DAY" }] });
    composio.answers.set("/adgroup/get/", (path: string) => {
      const page = Number(new URL(path, "https://example.test").searchParams.get("page"));
      return { list: [{ adgroup_id: `g${page}`, campaign_id: "c9", operation_status: "ENABLE", secondary_status: page < 3 ? "ADGROUP_STATUS_TIME_DONE" : "ADGROUP_STATUS_DELIVERY_OK" }], ...(page === 1 ? { page_info: { total_page: 3 } } : {}) };
    });
    composio.answers.set("/report/integrated/get/", { list: [] });
    const [r] = await readTiktokAccountsForBudget(T, START, NOW);
    expect(r.campaigns).toHaveLength(4);
    expect(r.campaigns[0].status).toBe("ACTIVE");
  });
  it("an ad account added after connecting is found and read (the saved list is only a cache)", async () => {
    composio.discovered = ["adv10"];
    composio.verified.set("adv10", { advertiser_id: "adv10", currency: "USD", timezone: "America/Los_Angeles" });
    composio.answers.set("/campaign/get/", { list: [], page_info: { total_page: 1 } });
    composio.answers.set("/adgroup/get/", { list: [], page_info: { total_page: 1 } });
    composio.answers.set("/report/integrated/get/", { list: [], page_info: { total_page: 1 } });
    const reads = await readTiktokAccountsForBudget(T, START, NOW);
    expect(reads.map((r) => r.account_id)).toEqual(["adv9", "adv10"]);
  });
  it("a saved ad account TikTok no longer confirms: throws, never reads the rest as the whole", async () => {
    composio.state = { connected: true, accounts: [{ advertiser_id: "adv9" }, { advertiser_id: "gone" }] };
    await expect(readTiktokAccountsForBudget(T, START, NOW)).rejects.toThrow("no longer answers for ad account gone");
  });
  it("discovery at its 200-account cap throws (a full list may hide a spender)", async () => {
    composio.discovered = Array.from({ length: 200 }, (_, i) => `d${i}`);
    await expect(readTiktokAccountsForBudget(T, START, NOW)).rejects.toThrow("more ad accounts than one read covers");
  });
  it("linked with no ad account TikTok answers for: throws (unknown, never zero)", async () => {
    composio.state = { connected: true, accounts: [] };
    composio.verified = new Map();
    await expect(readTiktokAccountsForBudget(T, START, NOW)).rejects.toThrow("no ad account could be read");
  });
  it("an ad group read that fails fails the whole read (never a campaign-only ledger)", async () => {
    composio.answers.set("/campaign/get/", { list: [], page_info: { total_page: 1 } });
    await expect(readTiktokAccountsForBudget(T, START, NOW)).rejects.toThrow("unrouted composio /adgroup/get/");
  });
  it.each([{}, { list: null }, { list: [], page_info: { total_page: "3" } }, { list: [], page_info: { total_page: 51 } }])("refuses incomplete ledger pages instead of releasing holds: %j", async (data) => {
    composio.answers.set("/campaign/get/", data);
    composio.answers.set("/adgroup/get/", { list: [] });
    composio.answers.set("/report/integrated/get/", { list: [] });
    await expect(readTiktokAccountsForBudget(T, START, NOW)).rejects.toThrow();
  });
  it("capacity: a budget on the campaign counts once; an ad group counts only when it carries the budget and its campaign is on", async () => {
    composio.answers.set("/campaign/get/", { list: [
      { campaign_id: "c1", campaign_name: "Budgeted", operation_status: "ENABLE", budget: "60", budget_mode: "BUDGET_MODE_DAY" },
      { campaign_id: "c2", campaign_name: "Open", operation_status: "ENABLE", budget: "0", budget_mode: "BUDGET_MODE_INFINITE" },
      { campaign_id: "c3", campaign_name: "Off", operation_status: "DISABLE", budget: "0", budget_mode: "BUDGET_MODE_INFINITE" },
    ], page_info: { total_page: 1 } });
    composio.answers.set("/adgroup/get/", { list: [
      { adgroup_id: "g1", campaign_id: "c1", operation_status: "ENABLE", budget: "0", budget_mode: "BUDGET_MODE_INFINITE" },
      { adgroup_id: "g2", campaign_id: "c2", operation_status: "ENABLE", budget: "30", budget_mode: "BUDGET_MODE_DAY" },
      { adgroup_id: "g3", campaign_id: "c3", operation_status: "ENABLE", budget: "40", budget_mode: "BUDGET_MODE_DAY" },
    ], page_info: { total_page: 1 } });
    composio.answers.set("/report/integrated/get/", { list: [], page_info: { total_page: 1 } });
    expect(await tiktokSpendCapacity(T, NOW)).toEqual({ connected: true, capacity_usd: 90 });
    composio.answers.set("/adgroup/get/", { list: [
      { adgroup_id: "g2", campaign_id: "c2", operation_status: "ENABLE", budget: "30", budget_mode: "BUDGET_MODE_DYNAMIC_DAILY_BUDGET" },
    ], page_info: { total_page: 1 } });
    expect(await tiktokSpendCapacity(T, NOW)).toEqual({ connected: true, capacity_usd: 97.5 });
  });
  it("capacity: an ACTIVE lifetime budget is unknown, and so is a failed read", async () => {
    composio.answers.set("/campaign/get/", { list: [{ campaign_id: "c1", operation_status: "ENABLE", budget: "600", budget_mode: "BUDGET_MODE_TOTAL" }], page_info: { total_page: 1 } });
    composio.answers.set("/adgroup/get/", { list: [], page_info: { total_page: 1 } });
    composio.answers.set("/report/integrated/get/", { list: [], page_info: { total_page: 1 } });
    expect(await tiktokSpendCapacity(T, NOW)).toEqual({ connected: true, capacity_usd: null });
    composio.answers.delete("/adgroup/get/");
    expect(await tiktokSpendCapacity(T, NOW)).toEqual({ connected: true, capacity_usd: null });
  });
  it("linked but ad accounts unreadable: throws (unknown, never zero)", async () => {
    composio.state = { connected: false, accounts: [] };
    await expect(readTiktokAccountsForBudget(T, START, NOW)).rejects.toThrow("could not be read");
  });
});

describe("Pinterest", () => {
  beforeEach(() => {
    connected.slugs.add("pinterest_ads");
  });
  const account = (currency = "USD") => routes.push([/\/v5\/ad_accounts\?/, () => ({ items: [{ id: "549", currency, time_zone: "America/New_York" }], bookmark: null })]);
  it("CBO campaign and ad-group budgets (micros); account daily spend; last two days provisional", async () => {
    account();
    routes.push([/ad_accounts\/549\/campaigns/, () => ({ items: [
      { id: "cbo", name: "CBO", status: "ACTIVE", is_campaign_budget_optimization: true, daily_spend_cap: 40_000_000 },
      { id: "std", name: "Std", status: "ACTIVE", is_campaign_budget_optimization: false },
    ], bookmark: null })]);
    routes.push([/ad_accounts\/549\/ad_groups/, () => ({ items: [
      { id: "g1", name: "G1", status: "PAUSED", campaign_id: "std", budget_in_micro_currency: 25_000_000, budget_type: "DAILY" },
      { id: "g2", name: "G2", status: "ACTIVE", campaign_id: "cbo", budget_type: "CBO_ADGROUP" },
    ], bookmark: null })]);
    routes.push([/ad_accounts\/549\/analytics/, (u) => {
      expect(u.searchParams.get("granularity")).toBe("DAY");
      expect(u.searchParams.get("columns")).toBe("SPEND_IN_MICRO_DOLLAR");
      return [{ DATE: "2026-10-03", SPEND_IN_MICRO_DOLLAR: 30_500_000 }, { DATE: "2026-10-04", SPEND_IN_MICRO_DOLLAR: 10_000_000 }, { DATE: "2026-10-05" }];
    }]);
    const [r] = await readPinterestAccountsForBudget(T, START, NOW);
    expect(r.campaigns.map((c) => [c.object_id, c.level, c.budget_kind, c.budget_usd, c.status])).toEqual([
      ["cbo", "campaign", "daily", 40, "ACTIVE"],
      ["g1", "ad_group", "daily", 25, "PAUSED"],
      ["g2", "ad_group", "campaign_level", null, "ACTIVE"],
    ]);
    expect(r.spend).toEqual([
      { object_id: "account_549", spend_date: "2026-10-03", amount_usd: 30.5, provisional: false },
      { object_id: "account_549", spend_date: "2026-10-04", amount_usd: 10, provisional: true },
    ]);
  });
  it("a non-USD account throws", async () => {
    account("GBP");
    await expect(readPinterestAccountsForBudget(T, START, NOW)).rejects.toThrow("USD Pinterest Ads");
  });
});

describe("Snapchat", () => {
  beforeEach(() => {
    connected.slugs.add("snapchat_ads");
  });
  it("ad-squad budgets (micros); DAY stats on the account's own midnights", async () => {
    routes.push([/me\/organizations/, () => ({ request_status: "SUCCESS", organizations: [{ sub_request_status: "SUCCESS", organization: { id: "o1" } }] })]);
    routes.push([/organizations\/o1\/adaccounts/, () => ({ request_status: "SUCCESS", adaccounts: [{ sub_request_status: "SUCCESS", adaccount: { id: "a1", currency: "USD", timezone: "America/Los_Angeles" } }] })]);
    routes.push([/adaccounts\/a1\/adsquads/, () => ({ request_status: "SUCCESS", adsquads: [
      { sub_request_status: "SUCCESS", adsquad: { id: "sq1", name: "Squad", status: "ACTIVE", campaign_id: "c1", daily_budget_micro: 20_000_000 } },
    ] })]);
    routes.push([/adaccounts\/a1\/stats/, (u) => {
      expect(u.searchParams.get("start_time")).toBe("2026-10-01T00:00:00-07:00");
      expect(u.searchParams.get("end_time")).toBe("2026-10-06T00:00:00-07:00");
      return { request_status: "SUCCESS", timeseries_stats: [{ sub_request_status: "SUCCESS", timeseries_stat: { timeseries: [
        { start_time: "2026-10-03T00:00:00.000-07:00", stats: { spend: 15_250_000 } },
        { start_time: "2026-10-04T00:00:00.000-07:00", stats: { spend: 9_000_000 } },
      ] } }] };
    }]);
    const [r] = await readSnapchatAccountsForBudget(T, START, NOW);
    expect(r.campaigns).toEqual([{ object_id: "sq1", level: "ad_set", campaign_id: "c1", name: "Squad", budget_kind: "daily", budget_usd: 20, status: "ACTIVE", currency: "USD" }]);
    expect(r.spend).toEqual([
      { object_id: "account_a1", spend_date: "2026-10-03", amount_usd: 15.25, provisional: false },
      { object_id: "account_a1", spend_date: "2026-10-04", amount_usd: 9, provisional: true },
    ]);
  });
});

describe("Snapchat partial lists", () => {
  beforeEach(() => {
    connected.slugs.add("snapchat_ads");
  });
  it("a failed sub-request among successes throws (never a partial account list)", async () => {
    routes.push([/me\/organizations/, () => ({ request_status: "SUCCESS", organizations: [
      { sub_request_status: "SUCCESS", organization: { id: "o1" } },
      { sub_request_status: "ERROR", sub_request_error_reason: "forbidden" },
    ] })]);
    await expect(readSnapchatAccountsForBudget(T, START, NOW)).rejects.toThrow("incomplete");
  });
});

describe("Microsoft", () => {
  beforeEach(() => {
    connected.slugs.add("microsoft_ads");
  });
  const accounts = (currency = "USD") => {
    routes.push([/User\/Query/, () => ({ User: { Id: 7 } })]);
    routes.push([/Accounts\/Search/, () => ({ Accounts: [{ Id: 111, CurrencyCode: currency, ParentCustomerId: 9, TimeZone: "PacificTimeUSCanadaTijuana" }] })]);
  };
  it("campaign budgets (shared when BudgetId); daily report CSV inside a ZIP, after a pending poll", async () => {
    accounts();
    routes.push([/Campaigns\/QueryByAccountId/, () => ({ Campaigns: [
      { Id: 1, Name: "Brand", Status: "Active", DailyBudget: 30, BudgetType: "DailyBudgetStandard" },
      { Id: 2, Name: "Shared", Status: "Paused", DailyBudget: 100, BudgetId: 55 },
    ] })]);
    let submitted: Record<string, unknown> | null = null;
    routes.push([/GenerateReport\/Submit/, (_u, init) => ((submitted = JSON.parse(String(init?.body))), { ReportRequestId: "r1" })]);
    let polls = 0;
    routes.push([/GenerateReport\/Poll/, () => (++polls === 1
      ? { ReportRequestStatus: { Status: "Pending" } }
      : { ReportRequestStatus: { Status: "Success", ReportDownloadUrl: "https://bingadsappsstorage.blob.core.windows.net/r1.zip" } })]);
    const csv = '﻿"TimePeriod","CampaignId","Spend","CurrencyCode"\r\n"2026-10-02","1","12.34","USD"\r\n"2026-10-05","1","1.00","USD"\r\n';
    routes.push([/blob\.core\.windows\.net/, () => new Response(zipSync({ "r1.csv": strToU8(csv) }), { status: 200 })]);
    const [r] = await readMicrosoftAccountsForBudget(T, START, NOW, { sleep: async () => {}, fetch });
    const time = ((submitted as unknown as { ReportRequest: { Time: Record<string, unknown> } }).ReportRequest.Time);
    expect(time).toEqual({ CustomDateRangeStart: { Year: 2026, Month: 10, Day: 1 }, CustomDateRangeEnd: { Year: 2026, Month: 10, Day: 5 }, ReportTimeZone: "PacificTimeUSCanadaTijuana" });
    expect(r.campaigns.map((c) => [c.object_id, c.budget_kind, c.budget_usd, c.status])).toEqual([["1", "daily", 30, "ACTIVE"], ["2", "shared", 100, "PAUSED"]]);
    expect(r.spend).toEqual([
      { object_id: "1", spend_date: "2026-10-02", amount_usd: 12.34, provisional: false },
      { object_id: "1", spend_date: "2026-10-05", amount_usd: 1, provisional: true },
    ]);
  });
  it("a report still pending after the poll budget throws (unread this hour, never zero)", async () => {
    accounts();
    routes.push([/Campaigns\/QueryByAccountId/, () => ({ Campaigns: [] })]);
    routes.push([/GenerateReport\/Submit/, () => ({ ReportRequestId: "r1" })]);
    routes.push([/GenerateReport\/Poll/, () => ({ ReportRequestStatus: { Status: "Pending" } })]);
    await expect(readMicrosoftAccountsForBudget(T, START, NOW, { sleep: async () => {}, fetch })).rejects.toThrow("still running");
  });
  it("an unmapped account time zone throws instead of guessing the day", async () => {
    routes.push([/User\/Query/, () => ({ User: { Id: 7 } })]);
    routes.push([/Accounts\/Search/, () => ({ Accounts: [{ Id: 111, CurrencyCode: "USD", ParentCustomerId: 9, TimeZone: "BeijingChongqingHongKongUrumqi" }] })]);
    routes.push([/Campaigns\/QueryByAccountId/, () => ({ Campaigns: [] })]);
    await expect(readMicrosoftAccountsForBudget(T, START, NOW)).rejects.toThrow("not mapped");
  });
  it("a non-USD account throws", async () => {
    accounts("CAD");
    await expect(readMicrosoftAccountsForBudget(T, START, NOW)).rejects.toThrow("USD Microsoft Ads");
  });
  it("the report link is fetched only from Microsoft's report hosts: https, default port, no credentials", () => {
    expect(isReportDownloadUrl("https://download.api.bingads.microsoft.com/ReportDownload/Download.aspx?q=x")).toBe(true);
    expect(isReportDownloadUrl("https://bingadsappsstorage.blob.core.windows.net/r1.zip")).toBe(true);
    for (const bad of ["http://download.api.bingads.microsoft.com/r.zip", "https://169.254.169.254/latest/meta-data", "https://internal.service.local/x", "https://evil.com/blob.core.windows.net", "https://user:pw@x.blob.core.windows.net/r.zip", "https://x.blob.core.windows.net:8443/r.zip", "not a url"])
      expect(isReportDownloadUrl(bad)).toBe(false);
  });
  it("a report link on another host is refused before any fetch", async () => {
    accounts();
    routes.push([/Campaigns\/QueryByAccountId/, () => ({ Campaigns: [] })]);
    routes.push([/GenerateReport\/Submit/, () => ({ ReportRequestId: "r1" })]);
    routes.push([/GenerateReport\/Poll/, () => ({ ReportRequestStatus: { Status: "Success", ReportDownloadUrl: "https://169.254.169.254/latest/meta-data" } })]);
    await expect(readMicrosoftAccountsForBudget(T, START, NOW, { sleep: async () => {}, fetch })).rejects.toThrow("outside its download hosts");
  });
  it("a small archive that unpacks past the size bound is refused before it is inflated", async () => {
    accounts();
    routes.push([/Campaigns\/QueryByAccountId/, () => ({ Campaigns: [] })]);
    routes.push([/GenerateReport\/Submit/, () => ({ ReportRequestId: "r1" })]);
    routes.push([/GenerateReport\/Poll/, () => ({ ReportRequestStatus: { Status: "Success", ReportDownloadUrl: "https://x.blob.core.windows.net/r1.zip" } })]);
    routes.push([/blob\.core\.windows\.net/, () => new Response(zipSync({ "r1.csv": new Uint8Array(21 * 1024 * 1024) }), { status: 200 })]);
    await expect(readMicrosoftAccountsForBudget(T, START, NOW, { sleep: async () => {}, fetch })).rejects.toThrow("too large");
  });
  it("reads a ZIP's unpacked size from its directory; not a ZIP is null", () => {
    expect(zipUnpackedBytes(zipSync({ "a.csv": strToU8("hello"), "b.csv": new Uint8Array(1000) }))).toBe(1005);
    expect(zipUnpackedBytes(strToU8("not a zip at all, just some text bytes"))).toBeNull();
  });
  it("parses quoted CSV with commas and doubled quotes", () => {
    expect(parseCsv('a,"b,c","d""e"\n1,2,3')).toEqual([["a", "b,c", 'd"e'], ["1", "2", "3"]]);
  });
});

describe("Apple", () => {
  beforeEach(() => {
    connected.slugs.add("apple_ads");
  });
  it("v1 dailyBudget; spend per campaign per ORTZ day from the apps report", async () => {
    routes.push([/\/v1\/acls$/, () => ({ result: { acls: [{ adAccount: { id: 42, name: "App" }, roles: ["Admin"] }] } })]);
    routes.push([/\/v1\/ad-accounts\/42$/, () => ({ result: { id: 42, currency: "USD", timezone: "America/Los_Angeles" } })]);
    routes.push([/\/v1\/campaigns\/query$/, () => ({ result: [
      { id: 900, name: "Search", status: "ENABLED", promotedObjectType: "APPSTORE_APP", dailyBudget: { value: { amount: "75.00", currency: "USD" } } },
    ] })]);
    routes.push([/reports\/apps\/campaigns\/query$/, (_u, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.timeRange).toEqual({ start: "2026-10-01", end: "2026-10-05", timeZone: "ORTZ", granularity: "DAILY" });
      expect(body.filters).toEqual([{ field: "campaignId", operator: "IN", value: ["900"] }]);
      return { result: { rows: [{ metadata: { id: 900 }, granularMetrics: [
        { date: "2026-10-03", localSpend: { amount: "70.10", currency: "USD" } },
        { date: "2026-10-05", localSpend: { amount: "5", currency: "USD" } },
      ] }] } };
    }]);
    const [r] = await readAppleAccountsForBudget(T, START, NOW);
    expect(r.campaigns).toEqual([{ object_id: "900", level: "campaign", campaign_id: "900", name: "Search", budget_kind: "daily", budget_usd: 75, status: "ACTIVE", currency: "USD" }]);
    expect(r.spend).toEqual([
      { object_id: "900", spend_date: "2026-10-03", amount_usd: 70.1, provisional: false },
      { object_id: "900", spend_date: "2026-10-05", amount_usd: 5, provisional: true },
    ]);
  });
});

describe("Apple Maps", () => {
  beforeEach(() => {
    connected.slugs.add("apple_ads");
    routes.push([/\/v1\/acls$/, () => ({ result: { acls: [{ adAccount: { id: 42, name: "App" }, roles: ["Admin"] }] } })]);
    routes.push([/\/v1\/ad-accounts\/42$/, () => ({ result: { id: 42, currency: "USD", timezone: "America/Los_Angeles" } })]);
  });
  it("Maps campaign spend is read from the business-brands report and reaches the ledger", async () => {
    routes.push([/\/v1\/campaigns\/query$/, (_u, init) => {
      expect(JSON.parse(String(init?.body)).filters).toEqual([{ field: "deleted", operator: "IN", value: [true, false] }]);
      return { result: [
      { id: 900, name: "Search", status: "ENABLED", promotedObjectType: "APPSTORE_APP", dailyBudget: { value: { amount: "75.00", currency: "USD" } } },
      { id: 901, name: "Maps", status: "ENABLED", promotedObjectType: "BUSINESS_BRAND", dailyBudget: { value: { amount: "40.00", currency: "USD" } } },
    ] };
    }]);
    routes.push([/reports\/apps\/campaigns\/query$/, (_u, init) => {
      expect(JSON.parse(String(init?.body)).filters).toEqual([{ field: "campaignId", operator: "IN", value: ["900"] }]);
      return { result: { rows: [{ metadata: { id: 900 }, granularMetrics: [{ date: "2026-10-03", localSpend: { amount: "10", currency: "USD" } }] }] } };
    }]);
    routes.push([/reports\/business-brands\/campaigns\/query$/, (_u, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.timeRange).toEqual({ start: "2026-10-01", end: "2026-10-05", timeZone: "ORTZ", granularity: "DAILY" });
      expect(body.filters).toEqual([{ field: "campaignId", operator: "IN", value: ["901"] }]);
      return { result: { rows: [{ metadata: { id: 901 }, granularMetrics: [
        { date: "2026-10-02", localSpend: { amount: "42.00", currency: "USD" } },
        { date: "2026-10-05", localSpend: { amount: "3", currency: "USD" } },
      ] }] } };
    }]);
    const [r] = await readAppleAccountsForBudget(T, START, NOW);
    expect(r.campaigns.map((c) => [c.object_id, c.budget_usd, c.status])).toEqual([["900", 75, "ACTIVE"], ["901", 40, "ACTIVE"]]);
    expect(r.spend).toEqual([
      { object_id: "900", spend_date: "2026-10-03", amount_usd: 10, provisional: false },
      { object_id: "901", spend_date: "2026-10-02", amount_usd: 42, provisional: false },
      { object_id: "901", spend_date: "2026-10-05", amount_usd: 3, provisional: true },
    ]);
  });
  it("a campaign whose type the reader does not know fails the read closed", async () => {
    routes.push([/\/v1\/campaigns\/query$/, () => ({ result: [
      { id: 902, name: "?", status: "ENABLED", dailyBudget: { value: { amount: "40.00", currency: "USD" } } },
    ] })]);
    routes.push([/reports\//, () => ({ result: { rows: [] } })]);
    await expect(readAppleAccountsForBudget(T, START, NOW)).rejects.toThrow(/spend is unknown/);
  });
});

describe("Spotify", () => {
  beforeEach(() => {
    connected.slugs.add("spotify_ads");
  });
  it("ad-set budgets (micros); SPEND per ad set per UTC day is already in currency units", async () => {
    routes.push([/\/businesses$/, () => ({ businesses: [{ id: "b1" }] })]);
    routes.push([/businesses\/b1\/ad_accounts/, () => ({ ad_accounts: [{ id: "acc-1", currency_code: "USD" }] })]);
    routes.push([/ad_accounts\/acc-1\/ad_sets/, () => ({ ad_sets: [
      { id: "set-1", name: "Set", status: "ACTIVE", delivery: "ON", campaign_id: "camp-1", budget: { micro_amount: 15_000_000, type: "DAILY" } },
    ], paging: { total_results: 1 } })]);
    routes.push([/aggregate_reports/, (u) => {
      expect(u.searchParams.get("report_start")).toBe("2026-10-01T00:00:00Z");
      expect(u.searchParams.get("report_end")).toBe("2026-10-06T00:00:00Z");
      return { rows: [
        { entity_id: "set-1", start_time: "2026-10-02T00:00:00Z", stats: [{ field_type: "SPEND", field_value: 17.48 }] },
        { entity_id: "set-1", start_time: "2026-10-05T00:00:00Z", stats: [{ field_type: "SPEND", field_value: 2 }] },
      ] };
    }]);
    const [r] = await readSpotifyAccountsForBudget(T, START, NOW);
    expect(r.campaigns).toEqual([{ object_id: "set-1", level: "ad_set", campaign_id: "camp-1", name: "Set", budget_kind: "daily", budget_usd: 15, status: "ACTIVE", currency: "USD" }]);
    expect(r.spend).toEqual([
      { object_id: "set-1", spend_date: "2026-10-02", amount_usd: 17.48, provisional: false },
      { object_id: "set-1", spend_date: "2026-10-05", amount_usd: 2, provisional: true },
    ]);
  });
});

describe("LinkedIn", () => {
  const boundAccounts = (ids: number[]) => ids.map((id) => ({ id: `b${id}`, provider_account_id: String(id), funding_source: "provider" }));
  beforeEach(() => {
    connected.slugs.add("linkedin_ads");
    connected.tables = { ads_account_binding_details: boundAccounts([501]) };
  });
  const idleAccount = (id: number) => ({ elements: [{ id, currency: "USD" }] });
  it("must catch (an account with 250 campaigns, mostly archived): every page is read and the live campaign on the last page is counted, not refused as unknown", async () => {
    routes.push([/rest\/adAccounts\?/, () => idleAccount(501)]);
    const pageTokens: Array<string | null> = [];
    routes.push([/adAccounts\/501\/adCampaigns/, (u) => {
      const token = u.searchParams.get("pageToken");
      pageTokens.push(token);
      const page = token === null ? 0 : Number(token);
      const elements = Array.from({ length: page === 2 ? 50 : 100 }, (_, i) => {
        const id = 1000 + page * 100 + i;
        return id === 1249
          ? { id, name: "Live", status: "ACTIVE", dailyBudget: { amount: "40.00", currencyCode: "USD" } }
          : { id, name: `Old ${id}`, status: "ARCHIVED", changeAuditStamps: { lastModified: { time: Date.parse("2026-06-01T00:00:00Z") } } };
      });
      return { elements, metadata: { nextPageToken: page < 2 ? String(page + 1) : null } };
    }]);
    routes.push([/rest\/adAnalytics.*timeGranularity=ALL/, () => ({ elements: [{ pivotValues: ["urn:li:sponsoredAccount:501"], costInLocalCurrency: "30.00", impressions: 1, clicks: 1, externalWebsiteConversions: 0, oneClickLeads: 0 }] })]);
    routes.push([/rest\/adAnalytics/, (u) => ({ elements: u.search.includes("day:1)") && u.search.includes("start:(year:2026,month:10,day:1)") ? [{ dateRange: { start: { year: 2026, month: 10, day: 3 } }, pivotValues: ["urn:li:sponsoredCampaign:1249"], costInLocalCurrency: "30.00" }] : [] })]);
    const [r] = await readLinkedinAccountsForBudget(T, START, NOW);
    expect(pageTokens).toEqual([null, "1", "2"]);
    expect(r.campaigns).toHaveLength(250);
    expect(r.campaigns.find((c) => c.object_id === "1249")).toMatchObject({ status: "ACTIVE", budget_usd: 40 });
    expect(r.spend).toContainEqual({ object_id: "1249", spend_date: "2026-10-03", amount_usd: 30, provisional: false });
  });
  it("must catch (a login that sees 130 ad accounts): every account page is read, so spend is known instead of unknown forever", async () => {
    routes.push([/rest\/adAccounts\?/, (u) => {
      const second = u.searchParams.get("pageToken") === "p2";
      const ids = second ? Array.from({ length: 30 }, (_, i) => 700 + i) : Array.from({ length: 100 }, (_, i) => 600 + i);
      return { elements: ids.map((id) => ({ id, currency: "USD" })), metadata: { nextPageToken: second ? null : "p2" } };
    }]);
    connected.tables = { ads_account_binding_details: boundAccounts([...Array.from({ length: 100 }, (_, i) => 600 + i), ...Array.from({ length: 30 }, (_, i) => 700 + i)]) };
    routes.push([/adAccounts\/\d+\/adCampaigns/, () => ({ elements: [] })]);
    routes.push([/rest\/adAnalytics/, () => ({ elements: [] })]);
    const reads = await readLinkedinAccountsForBudget(T, START, NOW);
    expect(reads.map((r) => r.account_id)).toHaveLength(130);
    expect(reads.map((r) => r.account_id)).toContain("729");
  });
  it("must not catch: campaign pages that never end keep the spend unknown instead of counting a truncated list", async () => {
    routes.push([/rest\/adAccounts\?/, () => idleAccount(501)]);
    let n = 0;
    routes.push([/adAccounts\/501\/adCampaigns/, () => ({ elements: [{ id: ++n, name: "x", status: "ARCHIVED", changeAuditStamps: { lastModified: { time: Date.parse("2026-06-01T00:00:00Z") } } }], metadata: { nextPageToken: `t${n}` } })]);
    routes.push([/rest\/adAnalytics/, () => ({ elements: [] })]);
    await expect(readLinkedinAccountsForBudget(T, START, NOW)).rejects.toThrow("more campaigns than Zavi can read; spend is unknown");
  });
  it("must catch (an agency login): only this workspace's bound accounts count; a stopped account counts only while it still runs a Zavi campaign", async () => {
    connected.tables = {
      ads_account_binding_details: [
        { id: "b501", provider_account_id: "501", funding_source: "provider" },
        { id: "b502", provider_account_id: "502", funding_source: "provider" },
        { id: "b503", provider_account_id: "503", funding_source: "provider" },
      ],
      ads_account_binding_status: [
        { account_binding_id: "b501", disabled_at: null },
        { account_binding_id: "b502", disabled_at: "2026-10-02T00:00:00Z" },
        { account_binding_id: "b503", disabled_at: "2026-10-02T00:00:00Z" },
      ],
      ads_campaign_binding_details: [{ id: "cb-90", provider_campaign_id: "90", account_binding_id: "b503" }],
    };
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [501, 502, 503, 504].map((id) => ({ id, currency: "USD" })) })]);
    const campaignReads: string[] = [];
    routes.push([/adAccounts\/(\d+)\/adCampaigns/, (u) => {
      const acct = u.pathname.match(/adAccounts\/(\d+)/)![1];
      campaignReads.push(acct);
      return { elements: [{ id: Number(acct) * 10, name: "c", status: "ACTIVE" }] };
    }]);
    routes.push([/rest\/adAnalytics.*timeGranularity=ALL/, (u) => {
      const acct = decodeURIComponent(u.search).match(/sponsoredAccount:(\d+)/)![1];
      return { elements: [{ pivotValues: [`urn:li:sponsoredAccount:${acct}`], costInLocalCurrency: "500.00", impressions: 1, clicks: 1, externalWebsiteConversions: 0, oneClickLeads: 0 }] };
    }]);
    routes.push([/rest\/adAnalytics/, () => ({ elements: [] })]);
    const reads = await readLinkedinAccountsForBudget(T, START, NOW);
    expect(reads.map((r) => r.account_id).sort()).toEqual(["501", "503"]);
    expect(campaignReads.sort()).toEqual(["501", "503"]);
    expect(reads.flatMap((r) => r.spend).reduce((a, s) => a + s.amount_usd, 0)).toBe(1000);
  });
  it.each([
    ["a committed launch hold", { object_id: "cb-90", status: "committed", ends_on: "2026-10-20" }],
    ["a launch hold still in flight", { object_id: "cb-90", status: "reserved", ends_on: "2026-10-20" }],
    ["a hold with no end date", { object_id: "cb-90", status: "committed", ends_on: null }],
    ["a hold that ends today", { object_id: "cb-90", status: "committed", ends_on: "2026-10-05" }],
    ["a hold filed under the raw campaign id", { object_id: "90", status: "committed", ends_on: "2026-10-20" }],
  ])("must not catch: a bound account the login can no longer see whose Zavi campaign still has %s keeps the spend unknown", async (_label, hold) => {
    connected.tables = {
      ads_account_binding_details: [
        { id: "b501", provider_account_id: "501", funding_source: "provider" },
        { id: "b503", provider_account_id: "503", funding_source: "provider" },
      ],
      ads_campaign_binding_details: [{ id: "cb-90", provider_campaign_id: "90", account_binding_id: "b503" }],
      ad_budget_reservations: [hold],
    };
    routes.push([/rest\/adAccounts\?/, () => idleAccount(501)]);
    routes.push([/adAccounts\/\d+\/adCampaigns/, () => ({ elements: [] })]);
    routes.push([/rest\/adAnalytics/, () => ({ elements: [] })]);
    await expect(readLinkedinAccountsForBudget(T, START, NOW)).rejects.toThrow("cannot see an ad account that runs Zavi campaigns; spend is unknown");
  });
  describe("an unseen account judged by its Zavi campaigns, not only its holds", () => {
    const AT = NOW.getTime();
    const activate = (o: Record<string, unknown> = {}, campaign = "cb-90") => ({ campaign_binding_id: campaign, kind: "activate", status: "succeeded", updated_at: "2026-10-02T00:00:00Z", end_time: String(AT + 86400000), ...o });
    const unseenWith = (tables: Record<string, unknown[]>) => {
      connected.tables = {
        ads_account_binding_details: boundAccounts([501, 503]),
        ads_campaign_binding_details: [{ id: "cb-90", provider_campaign_id: "90", account_binding_id: "b503" }],
        ad_budget_reservations: [{ object_id: "cb-90", status: "released", ends_on: "2026-10-20" }],
        ...tables,
      };
      routes.push([/rest\/adAccounts\?/, () => idleAccount(501)]);
      routes.push([/adAccounts\/\d+\/adCampaigns/, () => ({ elements: [] })]);
      routes.push([/rest\/adAnalytics/, () => ({ elements: [] })]);
    };
    const refused = () => expect(readLinkedinAccountsForBudget(T, START, NOW)).rejects.toThrow("spend is unknown");
    const leftOut = async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect((await readLinkedinAccountsForBudget(T, START, NOW)).map((r) => r.account_id)).toEqual(["501"]);
      warn.mockRestore();
    };
    it("must catch: the hold was released but the campaign has no confirmed stop and its end date has not passed, so the cap is not blind", async () => {
      unseenWith({ ads_campaign_operations: [activate()] });
      await expect(readLinkedinAccountsForBudget(T, START, NOW)).rejects.toThrow("cannot see an ad account that runs Zavi campaigns; spend is unknown");
    });
    it("must catch: no hold row at all", async () => {
      unseenWith({ ad_budget_reservations: [], ads_campaign_operations: [activate()] });
      await refused();
    });
    it("must catch: a launch whose outcome is uncertain, or a stop requested and never confirmed, is still live", async () => {
      unseenWith({ ads_campaign_operations: [activate({ status: "uncertain" })] });
      await refused();
      unseenWith({ ads_campaign_operations: [activate()], ads_campaign_lifecycle: [{ campaign_binding_id: "cb-90", stop_requested_at: "2026-10-03T00:00:00Z", stop_confirmed_at: null }] });
      await refused();
    });
    it("must catch: a stop confirmed before a later relaunch does not count", async () => {
      unseenWith({
        ads_campaign_operations: [activate({ updated_at: "2026-10-04T00:00:00Z" })],
        ads_campaign_lifecycle: [{ campaign_binding_id: "cb-90", stop_requested_at: "2026-10-03T00:00:00Z", stop_confirmed_at: "2026-10-03T00:01:00Z" }],
      });
      await refused();
    });
    it("must catch: the latest launch decides the end date, and one live campaign among dead ones is enough", async () => {
      unseenWith({
        ads_campaign_binding_details: [
          { id: "cb-90", provider_campaign_id: "90", account_binding_id: "b503" },
          { id: "cb-91", provider_campaign_id: "91", account_binding_id: "b503" },
        ],
        ads_campaign_operations: [
          activate({ end_time: String(AT - 1000) }),
          activate({ updated_at: "2026-10-03T00:00:00Z", end_time: String(AT + 1) }),
          activate({ end_time: String(AT - 1000) }, "cb-91"),
        ],
      });
      await refused();
    });
    it("must catch: an end date it cannot read is not a passed one", async () => {
      unseenWith({ ads_campaign_operations: [activate({ end_time: null })] });
      await refused();
    });
    it.each(["ads_campaign_operations", "ads_campaign_lifecycle"])("must not catch: %s unreadable keeps the spend unknown", async (table) => {
      unseenWith({});
      connected.failing.add(table);
      await expect(readLinkedinAccountsForBudget(T, START, NOW)).rejects.toThrow("whether they still run is unreadable; spend is unknown");
    });
    it("must not catch (the dead historic account): its end date passed at exactly now, or a minute ago, and every launch is free to read", async () => {
      unseenWith({ ads_campaign_operations: [activate({ end_time: String(AT) })] });
      await leftOut();
      unseenWith({ ads_campaign_operations: [activate({ end_time: String(AT - 60000) })] });
      await leftOut();
    });
    it("must not catch: one millisecond before its end it is still live", async () => {
      unseenWith({ ads_campaign_operations: [activate({ end_time: String(AT + 1) })] });
      await refused();
    });
    it("must not catch: a confirmed stop after its last launch ends it", async () => {
      unseenWith({
        ads_campaign_operations: [activate()],
        ads_campaign_lifecycle: [{ campaign_binding_id: "cb-90", stop_requested_at: "2026-10-03T00:00:00Z", stop_confirmed_at: "2026-10-03T00:01:00Z" }],
      });
      await leftOut();
    });
    it("must not catch: a campaign only ever refused, or never launched, never ran; a pause operation is not a launch", async () => {
      unseenWith({ ads_campaign_operations: [activate({ status: "refused" })] });
      await leftOut();
      unseenWith({ ads_campaign_operations: [] });
      await leftOut();
      unseenWith({ ads_campaign_operations: [activate({ kind: "pause" })] });
      await leftOut();
    });
    it("must not catch: a live campaign on an account this login can see is read normally, not refused", async () => {
      unseenWith({
        ads_account_binding_details: boundAccounts([501]),
        ads_campaign_binding_details: [{ id: "cb-10", provider_campaign_id: "10", account_binding_id: "b501" }],
        ads_campaign_operations: [activate({}, "cb-10")],
        ad_budget_reservations: [],
      });
      await leftOut();
    });
  });
  it("DECISION FOR MOHIT, non-regression guard: a connected LinkedIn login with no ad account bound counts no spend, however much the account is spending, and calls LinkedIn for none of it", async () => {
    connected.tables = {};
    const read: string[] = [];
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [{ id: 501, currency: "USD" }] })]);
    routes.push([/adAccounts\/\d+\/adCampaigns/, (u) => (read.push(u.pathname), { elements: [{ id: 10, name: "Running", status: "ACTIVE" }] })]);
    routes.push([/rest\/adAnalytics/, (u) => (read.push(u.pathname), { elements: [{ pivotValues: ["urn:li:sponsoredAccount:501"], costInLocalCurrency: "5000.00" }] })]);
    expect(await readLinkedinAccountsForBudget(T, START, NOW)).toEqual([]);
    expect(read).toEqual([]);
  });
  it("must not catch: an unseen account whose holds cannot be read keeps the spend unknown", async () => {
    connected.tables = {
      ads_account_binding_details: [
        { id: "b501", provider_account_id: "501", funding_source: "provider" },
        { id: "b503", provider_account_id: "503", funding_source: "provider" },
      ],
      ads_campaign_binding_details: [{ id: "cb-90", provider_campaign_id: "90", account_binding_id: "b503" }],
    };
    connected.failing.add("ad_budget_reservations");
    routes.push([/rest\/adAccounts\?/, () => idleAccount(501)]);
    routes.push([/adAccounts\/\d+\/adCampaigns/, () => ({ elements: [] })]);
    routes.push([/rest\/adAnalytics/, () => ({ elements: [] })]);
    await expect(readLinkedinAccountsForBudget(T, START, NOW)).rejects.toThrow("spend is unknown");
  });
  it("must catch: one historic account the login cannot see, among several, no longer blocks the read; the visible accounts' spend counts and the gap is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    connected.tables = {
      ads_account_binding_details: [
        { id: "b501", provider_account_id: "501", funding_source: "provider" },
        { id: "b502", provider_account_id: "502", funding_source: "provider" },
        { id: "b503", provider_account_id: "503", funding_source: "provider" },
      ],
      ads_campaign_binding_details: [
        { id: "cb-10", provider_campaign_id: "10", account_binding_id: "b501" },
        { id: "cb-90", provider_campaign_id: "90", account_binding_id: "b503" },
      ],
      ad_budget_reservations: [
        { object_id: "cb-90", status: "committed", ends_on: "2026-10-04" },
        { object_id: "cb-10", status: "committed", ends_on: "2026-10-30" },
      ],
    };
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [501, 502].map((id) => ({ id, currency: "USD" })) })]);
    routes.push([/adAccounts\/(\d+)\/adCampaigns/, (u) => {
      const acct = u.pathname.match(/adAccounts\/(\d+)/)![1];
      return { elements: [{ id: acct === "501" ? 10 : 20, name: "c", status: "ACTIVE" }] };
    }]);
    routes.push([/rest\/adAnalytics.*timeGranularity=ALL/, (u) => {
      const acct = decodeURIComponent(u.search).match(/sponsoredAccount:(\d+)/)![1];
      return { elements: [{ pivotValues: [`urn:li:sponsoredAccount:${acct}`], costInLocalCurrency: acct === "501" ? "40.00" : "7.00", impressions: 1, clicks: 1, externalWebsiteConversions: 0, oneClickLeads: 0 }] };
    }]);
    routes.push([/rest\/adAnalytics/, () => ({ elements: [] })]);
    const reads = await readLinkedinAccountsForBudget(T, START, NOW);
    expect(reads.map((r) => r.account_id).sort()).toEqual(["501", "502"]);
    expect(reads.find((r) => r.account_id === "501")!.campaigns.map((c) => c.object_id)).toEqual(["cb-10"]);
    expect(reads.flatMap((r) => r.spend).reduce((a, s) => a + s.amount_usd, 0)).toBe(47);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ad account 503 is not visible"));
    warn.mockRestore();
  });
  const liveAccounts = (ids: number[], spend: Record<string, string> = {}) => {
    routes.push([/rest\/adAccounts\?/, () => ({ elements: ids.map((id) => ({ id, currency: "USD" })) })]);
    routes.push([/adAccounts\/(\d+)\/adCampaigns/, (u) => ({ elements: [{ id: Number(u.pathname.match(/adAccounts\/(\d+)/)![1]) * 10, name: "c", status: "ACTIVE" }] })]);
    routes.push([/rest\/adAnalytics.*timeGranularity=ALL/, (u) => {
      const acct = decodeURIComponent(u.search).match(/sponsoredAccount:(\d+)/)![1];
      return { elements: [{ pivotValues: [`urn:li:sponsoredAccount:${acct}`], costInLocalCurrency: spend[acct] ?? "0.00", impressions: 1, clicks: 1, externalWebsiteConversions: 0, oneClickLeads: 0 }] };
    }]);
    routes.push([/rest\/adAnalytics/, () => ({ elements: [] })]);
  };
  const recordedRow = (account_id: string, object_id: string, spend_date: string, amount_usd: string | number, source = "api", platform = "linkedin") => ({ platform, account_id, object_id, spend_date, amount_usd, source, provisional: false });

  it("must catch (wallet-only workspace): a login that sees other people's accounts adds none of their spend and calls LinkedIn for none of them", async () => {
    connected.tables = {};
    const read: string[] = [];
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [{ id: 501, currency: "USD" }, { id: 502, currency: "USD" }] })]);
    routes.push([/adAccounts\/\d+\/adCampaigns/, (u) => (read.push(u.pathname), { elements: [] })]);
    routes.push([/rest\/adAnalytics/, (u) => (read.push(u.pathname), { elements: [{ pivotValues: ["urn:li:sponsoredAccount:501"], costInLocalCurrency: "9000.00" }] })]);
    expect(await readLinkedinAccountsForBudget(T, START, NOW)).toEqual([]);
    expect(read).toEqual([]);
  });
  it("must catch: an account claimed by another workspace counts for neither its spend nor its calls, even when this workspace also bound it", async () => {
    connected.tables = {
      ads_account_binding_details: boundAccounts([501, 502, 503]),
      ads_provider_accounts: [
        { provider_account_id: "502", credential_source: "tenant_connector", credential_tenant_id: "other-tenant" },
        { provider_account_id: "503", credential_source: "platform", credential_tenant_id: null },
        { provider_account_id: "501", credential_source: "tenant_connector", credential_tenant_id: T },
      ],
    };
    liveAccounts([501, 502, 503], { "501": "40.00", "502": "700.00", "503": "900.00" });
    const reads = await readLinkedinAccountsForBudget(T, START, NOW);
    expect(reads.map((r) => r.account_id)).toEqual(["501"]);
    expect(reads.flatMap((r) => r.spend).reduce((a, s) => a + s.amount_usd, 0)).toBe(40);
  });
  it("must not catch: account owners that cannot be read keep the spend unknown instead of counting every bound account", async () => {
    connected.failing.add("ads_provider_accounts");
    liveAccounts([501]);
    await expect(readLinkedinAccountsForBudget(T, START, NOW)).rejects.toThrow("account owners are unreadable; spend is unknown");
  });
  it("must catch (a historic account the login lost, spend already recorded): the account stays in the read with its recorded rows, so the reconcile keeps it counted and does not call it gone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    connected.tables = {
      ads_account_binding_details: boundAccounts([501, 503]),
      ads_campaign_binding_details: [{ id: "cb-90", provider_campaign_id: "90", account_binding_id: "b503" }],
      ad_budget_reservations: [{ object_id: "cb-90", status: "committed", ends_on: "2026-10-04" }],
      ad_campaigns: [{ platform: "linkedin", account_id: "503", object_id: "cb-90", status: "PAUSED" }],
      ad_spend_daily: [
        recordedRow("503", "cb-90", "2026-10-02", "70.25"),
        recordedRow("503", "cb-90", "2026-10-03", "9.75"),
        recordedRow("503", "cb-90", "2026-09-30", "500.00"),
        recordedRow("503", "cb-90", "2026-11-01", "500.00"),
        recordedRow("503", "cb-90", "2026-10-04", "0"),
        recordedRow("503", "cb-90", "2026-10-02", "500.00", "manual"),
        recordedRow("503", "x", "2026-10-02", "500.00", "api", "meta"),
        recordedRow("501", "cb-10", "2026-10-01", "111.00"),
      ],
    };
    liveAccounts([501], { "501": "40.00" });
    const reads = await readLinkedinAccountsForBudget(T, START, NOW);
    expect(reads.map((r) => r.account_id)).toEqual(["501", "503"]);
    const recorded = reads.find((r) => r.account_id === "503")!;
    expect(recorded).toMatchObject({ recorded_only: true, campaigns: [], window: { since: "2026-10-01", until: "2026-10-05" } });
    expect(recorded.spend).toEqual([
      { object_id: "cb-90", spend_date: "2026-10-02", amount_usd: 70.25, provisional: false },
      { object_id: "cb-90", spend_date: "2026-10-03", amount_usd: 9.75, provisional: false },
    ]);
    expect(reads.find((r) => r.account_id === "501")!.recorded_only).toBeUndefined();
    warn.mockRestore();
  });
  it("must catch (the login sees none of the bound accounts): the recorded read still answers, so the platform is not called disconnected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    connected.tables = {
      ads_account_binding_details: boundAccounts([503]),
      ad_campaigns: [{ platform: "linkedin", account_id: "503", object_id: "cb-90", status: "PAUSED" }],
      ad_spend_daily: [recordedRow("503", "cb-90", "2026-10-02", "70.00")],
    };
    liveAccounts([]);
    const reads = await readLinkedinAccountsForBudget(T, START, NOW);
    expect(reads.map((r) => [r.account_id, r.recorded_only])).toEqual([["503", true]]);
    warn.mockRestore();
  });
  it("must catch (rollout, wallet-only): an account no longer counted still carries this month's recorded spend, so the month does not shrink and nothing is refused", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    connected.tables = { ad_spend_daily: [recordedRow("777", "cc", "2026-10-02", "12.00")] };
    liveAccounts([777]);
    const reads = await readLinkedinAccountsForBudget(T, START, NOW);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ account_id: "777", recorded_only: true, spend: [{ amount_usd: 12 }] });
    warn.mockRestore();
  });
  it("must not catch: recorded spend that cannot be read keeps the spend unknown", async () => {
    connected.failing.add("ad_spend_daily");
    liveAccounts([501]);
    await expect(readLinkedinAccountsForBudget(T, START, NOW)).rejects.toThrow("recorded spend is unreadable; spend is unknown");
  });
  it("must not catch: a live hold on an object with recorded spend outside the read keeps the spend unknown, even with no campaign binding left", async () => {
    connected.tables = {
      ads_account_binding_details: boundAccounts([501]),
      ad_spend_daily: [recordedRow("777", "raw-1", "2026-10-02", "12.00")],
      ad_budget_reservations: [{ object_id: "raw-1", status: "committed", ends_on: "2026-10-30" }],
    };
    liveAccounts([501, 777]);
    await expect(readLinkedinAccountsForBudget(T, START, NOW)).rejects.toThrow("spend is unknown");
  });
  it("reads every page of the recorded rows, so a row past the first 1,000 is still counted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    connected.tables = {
      ads_account_binding_details: boundAccounts([501]),
      ad_spend_daily: [...Array.from({ length: 1000 }, (_, i) => recordedRow("777", `o${i % 3}`, "2026-10-02", "1.00")), recordedRow("888", "late", "2026-10-03", "5.00")],
    };
    liveAccounts([501]);
    const reads = await readLinkedinAccountsForBudget(T, START, NOW);
    expect(reads.map((r) => r.account_id)).toEqual(["501", "777", "888"]);
    expect(reads.find((r) => r.account_id === "888")!.spend).toEqual([{ object_id: "late", spend_date: "2026-10-03", amount_usd: 5, provisional: false }]);
    warn.mockRestore();
  });
  describe("a hold on an unseen account is judged on the budget's day", () => {
    const unseenWith = (timezone: string, ends_on: string) => {
      connected.tables = {
        tenants: [{ timezone }],
        ads_account_binding_details: boundAccounts([501, 503]),
        ads_campaign_binding_details: [{ id: "cb-90", provider_campaign_id: "90", account_binding_id: "b503" }],
        ad_budget_reservations: [{ object_id: "cb-90", status: "committed", ends_on }],
      };
      liveAccounts([501]);
    };
    it("must not catch (Los Angeles, already tomorrow in UTC): a hold ending on the tenant's own today is still live", async () => {
      unseenWith("America/Los_Angeles", "2026-10-05");
      await expect(readLinkedinAccountsForBudget(T, START, new Date("2026-10-06T01:00:00Z"))).rejects.toThrow("cannot see an ad account that runs Zavi campaigns; spend is unknown");
    });
    it("must not catch (Tokyo, already tomorrow locally): a hold ending on the UTC budget day is still live, because the reserve's clock counts it", async () => {
      unseenWith("Asia/Tokyo", "2026-10-05");
      await expect(readLinkedinAccountsForBudget(T, START, new Date("2026-10-05T19:00:00Z"))).rejects.toThrow("cannot see an ad account that runs Zavi campaigns; spend is unknown");
    });
    it("must catch: a hold that ended before both clocks' today no longer blocks", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      unseenWith("America/Los_Angeles", "2026-10-04");
      const reads = await readLinkedinAccountsForBudget(T, START, new Date("2026-10-06T01:00:00Z"));
      expect(reads.map((r) => r.account_id)).toEqual(["501"]);
      warn.mockRestore();
    });
    it("must not catch: a zone that cannot be read keeps the spend unknown", async () => {
      unseenWith("America/Los_Angeles", "2026-10-01");
      connected.failing.add("tenants");
      await expect(readLinkedinAccountsForBudget(T, START, NOW)).rejects.toThrow("budget day is unknown");
    });
    it("must not catch: an unusable stored zone keeps the spend unknown", async () => {
      unseenWith("Not/AZone", "2026-10-01");
      await expect(readLinkedinAccountsForBudget(T, START, NOW)).rejects.toThrow("spend is unknown");
    });
  });
  it("must not catch: an account that could not have served logs nothing, so the log stays a real signal", async () => {
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [{ id: 501, currency: "USD" }] })]);
    routes.push([/adAccounts\/501\/adCampaigns/, () => ({ elements: [] })]);
    routes.push([/rest\/adAnalytics/, () => ({ elements: [] })]);
    await readLinkedinAccountsForBudget(T, START, NOW);
    expect(logged.events).toEqual([]);
  });
  const refusesAsUnknown = async () => {
    await expect(readLinkedinAccountsForBudget(T, START, NOW)).rejects.toThrow("period spend is missing; spend is unknown");
    expect(logged.events).toEqual([]);
  };
  const emptyAnalyticsOn = (campaign: Record<string, unknown>) => {
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [{ id: 501, currency: "USD" }] })]);
    routes.push([/adAccounts\/501\/adCampaigns/, () => ({ elements: [campaign] })]);
    routes.push([/rest\/adAnalytics/, () => ({ elements: [] })]);
  };
  const ledgerRow = (o: Record<string, unknown> = {}) => ({ platform: "linkedin", account_id: "501", object_id: "cb-1", spend_date: "2026-10-02", amount_usd: "40.00", source: "api", provisional: false, ...o });
  it.each([
    ["a running campaign", { id: 77, name: "Leads", status: "ACTIVE" }],
    ["a campaign paused inside the window", { id: 78, name: "p", status: "PAUSED", changeAuditStamps: { lastModified: { time: NOW.getTime() - 86_400_000 } } }],
    ["a campaign idle since before the window", { id: 79, name: "p", status: "PAUSED", changeAuditStamps: { lastModified: { time: Date.parse("2026-08-15T00:00:00Z") } } }],
  ])("must not catch: LinkedIn reported spend on this account earlier this month and now answers empty beside %s: the spend stays unknown, never $0", async (_label, campaign) => {
    connected.tables.ad_spend_daily = [ledgerRow()];
    emptyAnalyticsOn(campaign);
    await expect(readLinkedinAccountsForBudget(T, START, NOW)).rejects.toThrow("period spend is missing");
  });
  it.each([
    ["another account", { account_id: "502" }],
    ["another platform", { platform: "meta" }],
    ["last month", { spend_date: "2026-09-30" }],
    ["a manual row", { source: "manual" }],
    ["a zero row", { amount_usd: "0" }],
  ])("must catch: recorded spend on %s is no reason to call this account's empty answer unknown", async (_label, row) => {
    connected.tables.ad_spend_daily = [ledgerRow(row)];
    emptyAnalyticsOn({ id: 79, name: "p", status: "PAUSED", changeAuditStamps: { lastModified: { time: Date.parse("2026-08-15T00:00:00Z") } } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reads = await readLinkedinAccountsForBudget(T, START, NOW);
    expect(reads.find((r) => r.account_id === "501")!.spend).toEqual([{ object_id: "account_501", spend_date: "2026-10-01", amount_usd: 0, provisional: false }]);
    warn.mockRestore();
  });
  it("must catch (#4246): an empty answer on a running campaign writes nothing, and the first real period total counts all of it", async () => {
    let answer: unknown = { elements: [] };
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [{ id: 501, currency: "USD" }] })]);
    routes.push([/adAccounts\/501\/adCampaigns/, () => ({ elements: [{ id: 77, name: "Leads", status: "ACTIVE" }] })]);
    routes.push([/rest\/adAnalytics.*timeGranularity=ALL/, () => answer]);
    routes.push([/rest\/adAnalytics/, () => ({ elements: [] })]);
    await refusesAsUnknown();
    answer = { elements: [{ pivotValues: ["urn:li:sponsoredAccount:501"], costInLocalCurrency: "12.50", impressions: 1, clicks: 1, externalWebsiteConversions: 0, oneClickLeads: 0 }] };
    expect((await readLinkedinAccountsForBudget(T, START, NOW))[0].spend).toEqual([{ object_id: "account_501", spend_date: "2026-10-01", amount_usd: 12.5, provisional: false }]);
  });
  it("must catch (#4246): an ACTIVE campaign whose only ad is still in review stays unknown: LinkedIn's current review state does not prove nothing served, so no $0 and no ad read", async () => {
    const creativeReads: string[] = [];
    routes.push([/adAccounts\/501\/creatives/, (u) => { creativeReads.push(u.search); return { elements: [{ campaign: "urn:li:sponsoredCampaign:77", intendedStatus: "ACTIVE", isServing: false, review: { status: "PENDING" } }] }; }]);
    emptyAnalyticsOn({ id: 77, name: "Awaiting review", status: "ACTIVE", changeAuditStamps: { created: { time: NOW.getTime() - 3_600_000 }, lastModified: { time: NOW.getTime() - 3_600_000 } } });
    await refusesAsUnknown();
    expect(creativeReads).toEqual([]);
  });
  it("must catch (#4555 stays narrow): a never-changed PAUSED campaign is no cover for an ACTIVE one beside it", async () => {
    const created = NOW.getTime() - 3_600_000;
    emptyAnalyticsOn({ id: 77, name: "Leads", status: "ACTIVE" });
    routes.splice(1, 1, [/adAccounts\/501\/adCampaigns/, () => ({ elements: [
      { id: 90, name: "Zavi test", status: "PAUSED", changeAuditStamps: { created: { time: created }, lastModified: { time: created } } },
      { id: 77, name: "Leads", status: "ACTIVE" },
    ] })]);
    await refusesAsUnknown();
  });
  describe("#4246: a schedule that ended before the window proves nothing served in it", () => {
    const windowStart = START.getTime();
    const ended = (status: string | undefined, end: unknown) => ({ id: 79, name: "Ended", status, runSchedule: { start: windowStart - 90 * 86_400_000, end }, changeAuditStamps: { lastModified: { time: NOW.getTime() - 3_600_000 } } });
    const zero = [{ object_id: "account_501", spend_date: "2026-10-01", amount_usd: 0, provisional: false }];
    it.each([
      ["COMPLETED, a month earlier", "COMPLETED", windowStart - 30 * 86_400_000],
      ["COMPLETED, exactly at the window's first instant", "COMPLETED", windowStart],
      ["still reading ACTIVE at LinkedIn", "ACTIVE", windowStart - 86_400_000],
    ])("must not catch: %s reads $0", async (_label, status, end) => {
      emptyAnalyticsOn(ended(status, end));
      expect((await readLinkedinAccountsForBudget(T, START, NOW))[0].spend).toEqual(zero);
    });
    it.each([
      ["one millisecond into the window", "COMPLETED", windowStart + 1],
      ["no end date", "COMPLETED", undefined],
      ["an unreadable end date", "COMPLETED", "soon"],
      ["ending in the future", "ACTIVE", NOW.getTime() + 86_400_000],
    ])("must catch: %s stays unknown", async (_label, status, end) => {
      emptyAnalyticsOn(ended(status, end));
      await refusesAsUnknown();
    });
    it("must catch: recorded spend this month outranks an old end date", async () => {
      connected.tables.ad_spend_daily = [ledgerRow()];
      emptyAnalyticsOn(ended("COMPLETED", windowStart - 86_400_000));
      await refusesAsUnknown();
    });
  });
  it("must not catch: day rows with no period total stay unknown, and an answer without an elements array is never an empty one", async () => {
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [{ id: 501, currency: "USD" }] })]);
    routes.push([/adAccounts\/501\/adCampaigns/, () => ({ elements: [{ id: 77, name: "Leads", status: "ACTIVE" }] })]);
    routes.push([/rest\/adAnalytics.*timeGranularity=ALL/, () => ({ elements: [] })]);
    routes.push([/rest\/adAnalytics/, () => ({ elements: [{ dateRange: { start: { year: 2026, month: 10, day: 2 } }, pivotValues: ["urn:li:sponsoredCampaign:77"], costInLocalCurrency: "3.00" }] })]);
    await expect(readLinkedinAccountsForBudget(T, START, NOW)).rejects.toThrow("period spend is missing");
    routes = [];
    emptyAnalyticsOn({ id: 77, name: "Leads", status: "ACTIVE" });
    routes.unshift([/rest\/adAnalytics/, () => ({})]);
    await expect(readLinkedinAccountsForBudget(T, START, NOW)).rejects.toThrow("spend is unknown");
  });
  describe("a lost account that may still be spending is not frozen as recorded spend", () => {
    const lost = (rows: Array<Record<string, unknown>>, tables: Record<string, unknown[]> = {}) => {
      connected.tables = { ads_account_binding_details: boundAccounts([501, 503]), ad_spend_daily: rows, ...tables };
      liveAccounts([501], { "501": "40.00" });
    };
    const spentOn = (spend_date: string) => recordedRow("503", "cb-90", spend_date, "5.00");
    const ledgerCampaign = (status: string | null, object_id = "cb-90") => ({ platform: "linkedin", account_id: "503", object_id, status });
    it.each(["2026-10-05", "2026-10-04"])("must catch: an account this login lost that spent on %s (today or yesterday) keeps LinkedIn unread, with a reconnect kind of error", async (day) => {
      lost([spentOn("2026-10-01"), spentOn(day)]);
      const e = await readLinkedinAccountsForBudget(T, START, NOW).catch((x) => x);
      expect(e).toBeInstanceOf(AdAccountLostError);
      expect(e.message).toContain("spend is unknown");
    });
    it("must not catch (the dead historic account): last spend two days ago is recorded only, so launches stay free", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      lost([spentOn("2026-10-01"), spentOn("2026-10-03")], { ad_campaigns: [ledgerCampaign("PAUSED")] });
      const reads = await readLinkedinAccountsForBudget(T, START, NOW);
      expect(reads.map((r) => [r.account_id, r.recorded_only])).toEqual([["501", undefined], ["503", true]]);
      warn.mockRestore();
    });
    const NOV_START = new Date("2026-11-01T00:00:00Z");
    const refused = async (start = START, now = NOW) => {
      const e = await readLinkedinAccountsForBudget(T, start, now).catch((x) => x);
      expect(e).toBeInstanceOf(AdAccountLostError);
      expect(e.message).toContain("spend is unknown");
    };
    const keptRecorded = async (start = START, now = NOW) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const reads = await readLinkedinAccountsForBudget(T, start, now);
      warn.mockRestore();
      return reads;
    };
    it.each(["2026-10-03", "2026-10-02", "2026-10-01"])("must catch (Review 10): a lost account last seen running, last spend %s, stays blocked: the block does not expire with the day rows", async (day) => {
      lost([spentOn(day)], { ad_campaigns: [ledgerCampaign("ACTIVE")] });
      await refused();
    });
    it("must catch (Review 10): a lost account last seen running stays blocked three weeks later in the next month, with no row this month", async () => {
      lost([spentOn("2026-10-31")], { ad_campaigns: [ledgerCampaign("ACTIVE")] });
      await refused(NOV_START, new Date("2026-11-21T12:00:00Z"));
    });
    it("must catch (Review 10): a lost account that never spent but was last seen running is blocked, and so is a status the ledger could not name", async () => {
      lost([], { ad_campaigns: [ledgerCampaign("ACTIVE")] });
      await refused();
      routes = [];
      lost([], { ad_campaigns: [ledgerCampaign(null)] });
      await refused();
    });
    it("must catch (Review 10): one running campaign among stopped ones is enough", async () => {
      lost([spentOn("2026-10-01")], { ad_campaigns: [ledgerCampaign("PAUSED", "a"), ledgerCampaign("ACTIVE", "b"), ledgerCampaign("ARCHIVED", "c")] });
      await refused();
    });
    it("must catch (Review 10, month boundary): a stopped account that spent on the last day of last month is still settling on the first of this one", async () => {
      lost([spentOn("2026-10-31")], { ad_campaigns: [ledgerCampaign("PAUSED")] });
      await refused(NOV_START, new Date("2026-11-01T01:00:00Z"));
    });
    it("must catch (Review 10): last month's spend is only a clue: it never enters this month's recorded rows", async () => {
      lost([spentOn("2026-10-30"), spentOn("2026-11-01")], { ad_campaigns: [ledgerCampaign("PAUSED")] });
      const reads = await keptRecorded(NOV_START, new Date("2026-11-04T12:00:00Z"));
      expect(reads.find((r) => r.account_id === "503")!.spend.map((s) => s.spend_date)).toEqual(["2026-11-01"]);
    });
    it.each([
      ["six days ago", "2026-09-29", true],
      ["seven days ago, the far edge", "2026-09-28", true],
      ["eight days ago, past the lookback", "2026-09-27", false],
    ])("must catch (Review 10): with no campaign row to judge by, spend %s across the month start is decided by the lookback", async (_label, day, blocked) => {
      lost([spentOn(day)]);
      if (blocked) await refused();
      else expect((await keptRecorded()).map((r) => r.account_id)).toEqual(["501"]);
    });
    it.each(["PAUSED", "ARCHIVED", "CANCELED", "COMPLETED", "PENDING_DELETION", "DRAFT", "REMOVED", "removed"])("must not catch (Review 10, harmless): an account lost after every campaign was %s, last spend two days ago, is recorded only and nobody is told to reconnect", async (status) => {
      lost([spentOn("2026-10-03")], { ad_campaigns: [ledgerCampaign(status)] });
      const reads = await keptRecorded();
      expect(reads.map((r) => [r.account_id, r.recorded_only])).toEqual([["501", undefined], ["503", true]]);
      expect(reads.find((r) => r.account_id === "503")!.spend).toEqual([{ object_id: "cb-90", spend_date: "2026-10-03", amount_usd: 5, provisional: false }]);
    });
    it("must not catch (Review 10): a stopped account that spent yesterday blocks today and clears itself tomorrow, with no reconnect", async () => {
      lost([spentOn("2026-10-04")], { ad_campaigns: [ledgerCampaign("PAUSED")] });
      await refused();
      expect((await keptRecorded(START, new Date("2026-10-06T00:00:00Z"))).find((r) => r.account_id === "503")!.recorded_only).toBe(true);
    });
    it("must not catch (Review 10): the block lifts the hour the account is visible again, running campaigns and all", async () => {
      lost([spentOn("2026-10-03")], { ad_campaigns: [ledgerCampaign("ACTIVE")] });
      await refused();
      routes = [];
      resetLinkedInAdsReadCache();
      liveAccounts([501, 503], { "501": "40.00", "503": "5.00" });
      const reads = await readLinkedinAccountsForBudget(T, START, NOW);
      expect(reads.map((r) => [r.account_id, r.recorded_only])).toEqual([["501", undefined], ["503", undefined]]);
    });
    it("must not catch (Review 10): a Zavi campaign already proven over, whose stale row still says running, is no reason to block", async () => {
      lost([spentOn("2026-10-03")], {
        ad_campaigns: [ledgerCampaign("ACTIVE")],
        ads_campaign_binding_details: [{ id: "cb-90", provider_campaign_id: "90", account_binding_id: "b503" }],
        ads_campaign_operations: [{ campaign_binding_id: "cb-90", kind: "activate", status: "succeeded", updated_at: "2026-10-02T00:00:00Z", end_time: String(NOW.getTime() - 1) }],
      });
      expect((await keptRecorded()).find((r) => r.account_id === "503")!.recorded_only).toBe(true);
    });
    it("must not catch (Review 10): the ledger of another platform or another account says nothing about this one", async () => {
      lost([spentOn("2026-10-03")], { ad_campaigns: [ledgerCampaign("PAUSED"), { platform: "meta", account_id: "503", object_id: "m", status: "ACTIVE" }, { platform: "linkedin", account_id: "888", object_id: "o", status: "ACTIVE" }] });
      expect((await keptRecorded()).find((r) => r.account_id === "503")!.recorded_only).toBe(true);
    });
    it("must not catch (Review 10): a ledger it cannot read keeps spend unknown without asking the founder to reconnect, and a full page is not a whole answer", async () => {
      lost([spentOn("2026-10-03")], { ad_campaigns: [ledgerCampaign("PAUSED")] });
      connected.failing.add("ad_campaigns");
      const e = await readLinkedinAccountsForBudget(T, START, NOW).catch((x) => x);
      expect(e).not.toBeInstanceOf(AdAccountLostError);
      expect(e.message).toContain("spend is unknown");
      connected.failing.delete("ad_campaigns");
      routes = [];
      lost([spentOn("2026-10-03")], { ad_campaigns: Array.from({ length: 5000 }, (_, i) => ledgerCampaign("PAUSED", `o${i}`)) });
      const full = await readLinkedinAccountsForBudget(T, START, NOW).catch((x) => x);
      expect(full).not.toBeInstanceOf(AdAccountLostError);
      expect(full.message).toContain("spend is unknown");
    });
    it("must not catch: an account the founder turned off, with no campaigns, never asks for a reconnect however recent its spend", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      lost([spentOn("2026-10-05")], { ads_account_binding_status: [{ account_binding_id: "b503", disabled_at: "2026-10-05T00:00:00Z" }] });
      const reads = await readLinkedinAccountsForBudget(T, START, NOW);
      expect(reads.find((r) => r.account_id === "503")!.recorded_only).toBe(true);
      warn.mockRestore();
    });
    it("must not catch: an account never bound here, or now claimed by another workspace, is not this workspace's to reconnect", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      lost([recordedRow("777", "cc", "2026-10-05", "5.00")]);
      expect((await readLinkedinAccountsForBudget(T, START, NOW)).find((r) => r.account_id === "777")!.recorded_only).toBe(true);
      routes = [];
      lost([spentOn("2026-10-05")], { ads_provider_accounts: [{ provider_account_id: "503", credential_source: "tenant_connector", credential_tenant_id: "someone-else" }] });
      expect((await readLinkedinAccountsForBudget(T, START, NOW)).find((r) => r.account_id === "503")!.recorded_only).toBe(true);
      warn.mockRestore();
    });
    it("must catch: a live hold or a live campaign on a lost account is the reconnect kind of error too", async () => {
      connected.tables = {
        ads_account_binding_details: boundAccounts([501, 503]),
        ads_campaign_binding_details: [{ id: "cb-90", provider_campaign_id: "90", account_binding_id: "b503" }],
        ad_budget_reservations: [{ object_id: "cb-90", status: "committed", ends_on: "2026-10-30" }],
      };
      liveAccounts([501]);
      await expect(readLinkedinAccountsForBudget(T, START, NOW)).rejects.toBeInstanceOf(AdAccountLostError);
      connected.tables.ad_budget_reservations = [];
      connected.tables.ads_campaign_operations = [{ campaign_binding_id: "cb-90", kind: "activate", status: "succeeded", updated_at: "2026-10-02T00:00:00Z", end_time: String(NOW.getTime() + 86_400_000) }];
      await expect(readLinkedinAccountsForBudget(T, START, NOW)).rejects.toBeInstanceOf(AdAccountLostError);
    });
    it("must not catch: holds it cannot read are unknown, not a lost account, so nobody is told to reconnect for a database blip", async () => {
      connected.tables = {
        ads_account_binding_details: boundAccounts([501, 503]),
        ads_campaign_binding_details: [{ id: "cb-90", provider_campaign_id: "90", account_binding_id: "b503" }],
      };
      connected.failing.add("ad_budget_reservations");
      liveAccounts([501]);
      const e = await readLinkedinAccountsForBudget(T, START, NOW).catch((x) => x);
      expect(e).not.toBeInstanceOf(AdAccountLostError);
      expect(e.message).toContain("spend is unknown");
    });
  });
  it("campaign daily budgets; DAILY adAnalytics per campaign per UTC day", async () => {
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [{ id: 501, currency: "USD" }] })]);
    routes.push([/adAccounts\/501\/adCampaigns/, () => ({ elements: [{ id: 77, name: "Leads", status: "ACTIVE", dailyBudget: { amount: "60.00", currencyCode: "USD" } }] })]);
    routes.push([/rest\/adAnalytics.*timeGranularity=ALL/, () => ({ elements: [
      { pivotValues: ["urn:li:sponsoredAccount:501"], costInLocalCurrency: "65.00", impressions: 1, clicks: 1, externalWebsiteConversions: 0, oneClickLeads: 0 },
    ] })]);
    routes.push([/rest\/adAnalytics/, (u) => {
      expect(u.search).toContain("timeGranularity=DAILY");
      expect(u.search).toContain("fields=dateRange,pivotValues,costInLocalCurrency");
      return { elements: [
        { dateRange: { start: { year: 2026, month: 10, day: 2 } }, pivotValues: ["urn:li:sponsoredCampaign:77"], costInLocalCurrency: "58.9" },
        { dateRange: { start: { year: 2026, month: 10, day: 5 } }, pivotValues: ["urn:li:sponsoredCampaign:77"], costInLocalCurrency: "3.1" },
      ] };
    }]);
    const [r] = await readLinkedinAccountsForBudget(T, START, NOW);
    expect(r.campaigns).toEqual([{ object_id: "77", level: "campaign", campaign_id: "77", name: "Leads", budget_kind: "daily", budget_usd: 60, status: "ACTIVE", currency: "USD" }]);
    expect(r.spend).toEqual([
      { object_id: "77", spend_date: "2026-10-02", amount_usd: 58.9, provisional: false },
      { object_id: "77", spend_date: "2026-10-05", amount_usd: 3.1, provisional: true },
      { object_id: "account_501", spend_date: "2026-10-01", amount_usd: 3, provisional: false },
    ]);
  });
  it("a period row without spend throws, even when the day rows were empty too", async () => {
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [{ id: 501, currency: "USD" }] })]);
    routes.push([/adAccounts\/501\/adCampaigns/, () => ({ elements: [] })]);
    routes.push([/rest\/adAnalytics.*timeGranularity=ALL/, () => ({ elements: [{ pivotValues: ["urn:li:sponsoredAccount:501"], impressions: 5, clicks: 1 }] })]);
    routes.push([/rest\/adAnalytics/, () => ({ elements: [{ dateRange: { start: { year: 2026, month: 10, day: 2 } }, pivotValues: ["urn:li:sponsoredCampaign:77"] }] })]);
    await expect(readLinkedinAccountsForBudget(T, START, NOW)).rejects.toThrow("period spend is missing");
  });
  it("must catch (#4246): no analytics at all for an account WITH a running campaign stays unknown, never $0", async () => {
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [{ id: 501, currency: "USD" }] })]);
    routes.push([/adAccounts\/501\/adCampaigns/, () => ({ elements: [{ id: 77, name: "Leads", status: "ACTIVE" }] })]);
    routes.push([/rest\/adAnalytics/, () => ({ elements: [] })]);
    await refusesAsUnknown();
  });
  it("must catch (a newly connected florist account): a draft and a campaign paused before the window, no analytics: $0, not unknown", async () => {
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [{ id: 501, currency: "USD" }] })]);
    routes.push([/adAccounts\/501\/adCampaigns/, () => ({ elements: [
      { id: 77, name: "Spring bouquets", status: "DRAFT" },
      { id: 78, name: "Old promo", status: "PAUSED", changeAuditStamps: { lastModified: { time: Date.parse("2026-08-15T00:00:00Z") } } },
    ] })]);
    routes.push([/rest\/adAnalytics/, () => ({ elements: [] })]);
    const [r] = await readLinkedinAccountsForBudget(T, START, NOW);
    expect(r.spend).toEqual([{ object_id: "account_501", spend_date: "2026-10-01", amount_usd: 0, provisional: false }]);
    expect(r.campaigns.map((c) => c.object_id)).toEqual(["77", "78"]);
  });
  it("an account whose campaigns could not have served this month costs one period read an hour, not one per week of the month", async () => {
    const late = new Date("2026-10-29T19:00:00Z");
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [{ id: 501, currency: "USD" }] })]);
    routes.push([/adAccounts\/501\/adCampaigns/, () => ({ elements: [
      { id: 77, name: "Spring bouquets", status: "DRAFT" },
      { id: 78, name: "Old promo", status: "PAUSED", changeAuditStamps: { lastModified: { time: Date.parse("2026-08-15T00:00:00Z") } } },
    ] })]);
    const analytics: string[] = [];
    routes.push([/rest\/adAnalytics/, (u) => { analytics.push(u.search); return { elements: [] }; }]);
    const [r] = await readLinkedinAccountsForBudget(T, START, late);
    expect(r.spend).toEqual([{ object_id: "account_501", spend_date: "2026-10-01", amount_usd: 0, provisional: false }]);
    expect(analytics).toHaveLength(1);
    expect(analytics[0]).toContain("timeGranularity=ALL");
    expect(analytics[0]).toContain("pivot=ACCOUNT");
  });
  it("an idle account whose period total still shows spend reads its day rows, so the spend is never dropped", async () => {
    const late = new Date("2026-10-29T19:00:00Z");
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [{ id: 501, currency: "USD" }] })]);
    routes.push([/adAccounts\/501\/adCampaigns/, () => ({ elements: [
      { id: 78, name: "Old promo", status: "PAUSED", changeAuditStamps: { lastModified: { time: Date.parse("2026-08-15T00:00:00Z") } } },
    ] })]);
    routes.push([/rest\/adAnalytics.*timeGranularity=ALL/, () => ({ elements: [{ pivotValues: ["urn:li:sponsoredAccount:501"], costInLocalCurrency: "12.00", impressions: 1, clicks: 1, externalWebsiteConversions: 0, oneClickLeads: 0 }] })]);
    let dayReads = 0;
    routes.push([/rest\/adAnalytics/, () => { dayReads++; return dayReads === 1 ? { elements: [{ dateRange: { start: { year: 2026, month: 10, day: 2 } }, pivotValues: ["urn:li:sponsoredCampaign:78"], costInLocalCurrency: "10.00" }] } : { elements: [] }; }]);
    const [r] = await readLinkedinAccountsForBudget(T, START, late);
    expect(dayReads).toBe(5);
    expect(r.spend).toContainEqual({ object_id: "78", spend_date: "2026-10-02", amount_usd: 10, provisional: false });
    expect(r.spend).toContainEqual({ object_id: "account_501", spend_date: "2026-10-01", amount_usd: 2, provisional: false });
  });
  it("must catch (cap path): two reads in a row both ask LinkedIn for spend, so a cap never acts on a cached total", async () => {
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [{ id: 501, currency: "USD" }] })]);
    routes.push([/adAccounts\/501\/adCampaigns/, () => ({ elements: [{ id: 79, name: "Live", status: "ACTIVE", dailyBudget: { amount: "40.00", currencyCode: "USD" } }] })]);
    const totals = ["12.00", "20.00"];
    let totalReads = 0;
    let dayReads = 0;
    routes.push([/rest\/adAnalytics.*timeGranularity=ALL/, () => ({ elements: [{ pivotValues: ["urn:li:sponsoredAccount:501"], costInLocalCurrency: totals[totalReads++], impressions: 1, clicks: 1, externalWebsiteConversions: 0, oneClickLeads: 0 }] })]);
    routes.push([/rest\/adAnalytics/, () => { dayReads++; return { elements: [] }; }]);
    const [first] = await readLinkedinAccountsForBudget(T, START, NOW);
    const firstDayReads = dayReads;
    const [second] = await readLinkedinAccountsForBudget(T, START, NOW);
    expect(totalReads).toBe(2);
    expect(dayReads).toBe(firstDayReads * 2);
    expect(first.spend).toContainEqual(expect.objectContaining({ object_id: "account_501", amount_usd: 12 }));
    expect(second.spend).toContainEqual(expect.objectContaining({ object_id: "account_501", amount_usd: 20 }));
  });
  it("must catch (own billing, first launch): Zavi's new PAUSED campaign, never changed since LinkedIn created it, with no analytics reads $0 so the launch can hold the budget", async () => {
    const created = NOW.getTime() - 3_600_000;
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [{ id: 501, currency: "USD" }] })]);
    routes.push([/adAccounts\/501\/adCampaigns/, () => ({ elements: [
      { id: 90, name: "Zavi test", status: "PAUSED", dailyBudget: { amount: "20.00", currencyCode: "USD" }, runSchedule: { start: created }, changeAuditStamps: { created: { time: created }, lastModified: { time: created } } },
    ] })]);
    routes.push([/rest\/adAnalytics/, () => ({ paging: { start: 0, count: 10, links: [] }, elements: [] })]);
    const [r] = await readLinkedinAccountsForBudget(T, START, NOW);
    expect(r.spend).toEqual([{ object_id: "account_501", spend_date: "2026-10-01", amount_usd: 0, provisional: false }]);
    expect(r.campaigns).toEqual([{ object_id: "90", level: "campaign", campaign_id: "90", name: "Zavi test", budget_kind: "daily", budget_usd: 20, status: "PAUSED", currency: "USD" }]);
  });
  it("must not catch: a new PAUSED campaign whose analytics read fails (HTTP 500) stays unknown", async () => {
    const created = NOW.getTime() - 3_600_000;
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [{ id: 501, currency: "USD" }] })]);
    routes.push([/adAccounts\/501\/adCampaigns/, () => ({ elements: [
      { id: 90, name: "Zavi test", status: "PAUSED", changeAuditStamps: { created: { time: created }, lastModified: { time: created } } },
    ] })]);
    routes.push([/rest\/adAnalytics.*timeGranularity=ALL/, () => new Response("upstream", { status: 500 })]);
    routes.push([/rest\/adAnalytics/, () => ({ elements: [] })]);
    await expect(readLinkedinAccountsForBudget(T, START, NOW)).rejects.toThrow("LinkedIn Ads is not responding right now");
  });
  it("must not catch: a new PAUSED campaign whose day analytics come back without an elements array stays unknown", async () => {
    const created = NOW.getTime() - 3_600_000;
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [{ id: 501, currency: "USD" }] })]);
    routes.push([/adAccounts\/501\/adCampaigns/, () => ({ elements: [
      { id: 90, name: "Zavi test", status: "PAUSED", changeAuditStamps: { created: { time: created }, lastModified: { time: created } } },
    ] })]);
    routes.push([/rest\/adAnalytics/, () => ({})]);
    await expect(readLinkedinAccountsForBudget(T, START, NOW)).rejects.toThrow("spend is unknown");
  });
  it.each([
    ["switched on and paused again this month", "PAUSED", 3_600_000],
    ["paused one second after creation", "PAUSED", 1_000],
    ["live since creation", "ACTIVE", 0],
  ])("must catch (#4246, #4555): a campaign created this month and %s, with no analytics, stays unknown", async (_label, status, changedAfter) => {
    const created = NOW.getTime() - 2 * 86_400_000;
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [{ id: 501, currency: "USD" }] })]);
    routes.push([/adAccounts\/501\/adCampaigns/, () => ({ elements: [
      { id: 91, name: "Served", status, changeAuditStamps: { created: { time: created }, lastModified: { time: created + changedAfter } } },
    ] })]);
    routes.push([/rest\/adAnalytics/, () => ({ elements: [] })]);
    await refusesAsUnknown();
  });
  it("must catch (#4555): a never-changed PAUSED campaign beside one changed this month, with no analytics, stays unknown", async () => {
    const created = NOW.getTime() - 3_600_000;
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [{ id: 501, currency: "USD" }] })]);
    routes.push([/adAccounts\/501\/adCampaigns/, () => ({ elements: [
      { id: 90, name: "Zavi test", status: "PAUSED", changeAuditStamps: { created: { time: created }, lastModified: { time: created } } },
      { id: 92, name: "Old live", status: "PAUSED", changeAuditStamps: { created: { time: Date.parse("2026-08-01T00:00:00Z") }, lastModified: { time: NOW.getTime() - 86_400_000 } } },
    ] })]);
    routes.push([/rest\/adAnalytics/, () => ({ elements: [] })]);
    await refusesAsUnknown();
  });
  it("must catch (#4555): a PAUSED campaign without a creation time, with no analytics, stays unknown", async () => {
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [{ id: 501, currency: "USD" }] })]);
    routes.push([/adAccounts\/501\/adCampaigns/, () => ({ elements: [
      { id: 90, name: "Zavi test", status: "PAUSED", changeAuditStamps: { lastModified: { time: NOW.getTime() - 3_600_000 } } },
    ] })]);
    routes.push([/rest\/adAnalytics/, () => ({ elements: [] })]);
    await refusesAsUnknown();
  });
  it("must catch (#4246): a COMPLETED campaign with no end date and no analytics stays unknown", async () => {
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [{ id: 501, currency: "USD" }] })]);
    routes.push([/adAccounts\/501\/adCampaigns/, () => ({ elements: [{ id: 79, name: "Ended", status: "COMPLETED", changeAuditStamps: { lastModified: { time: Date.parse("2026-08-15T00:00:00Z") } } }] })]);
    routes.push([/rest\/adAnalytics/, () => ({ elements: [] })]);
    await refusesAsUnknown();
  });
  it("must catch (#4246): a campaign paused INSIDE the window with no analytics stays unknown", async () => {
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [{ id: 501, currency: "USD" }] })]);
    routes.push([/adAccounts\/501\/adCampaigns/, () => ({ elements: [{ id: 78, name: "Old promo", status: "PAUSED", changeAuditStamps: { lastModified: { time: NOW.getTime() - 86_400_000 } } }] })]);
    routes.push([/rest\/adAnalytics/, () => ({ elements: [] })]);
    await refusesAsUnknown();
  });
  it("must catch (#4246): a campaign with a status it cannot read, with no analytics, stays unknown", async () => {
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [{ id: 501, currency: "USD" }] })]);
    routes.push([/adAccounts\/501\/adCampaigns/, () => ({ elements: [{ id: 77, name: "Leads" }] })]);
    routes.push([/rest\/adAnalytics/, () => ({ elements: [] })]);
    await refusesAsUnknown();
  });
  it("an idle account (no campaigns, no day rows, no period row) reads as zero, rewriting the shortfall row to 0", async () => {
    routes.push([/rest\/adAccounts\?/, () => ({ elements: [{ id: 501, currency: "USD" }] })]);
    routes.push([/adAccounts\/501\/adCampaigns/, () => ({ elements: [] })]);
    routes.push([/rest\/adAnalytics/, () => ({ elements: [] })]);
    const [r] = await readLinkedinAccountsForBudget(T, START, NOW);
    expect(r.spend).toEqual([{ object_id: "account_501", spend_date: "2026-10-01", amount_usd: 0, provisional: false }]);
  });
  it("account pages that never end keep the spend unknown: more accounts may be hidden", async () => {
    let n = 0;
    routes.push([/rest\/adAccounts\?/, () => ({ elements: Array.from({ length: 100 }, () => ({ id: ++n, currency: "USD" })), metadata: { nextPageToken: `t${n}` } })]);
    await expect(readLinkedinAccountsForBudget(T, START, NOW)).rejects.toThrow("more ad accounts than Zavi can read; spend is unknown");
  });
});

describe("LinkedIn: Zavi's own managed login stops working", () => {
  afterEach(() => { managedLedger.read = async () => []; });
  it.each([
    ["a revoked managed token", () => new ExpectedToolError("linkedin_ads_token_revoked", LINKEDIN_ADS_RECONNECT, { status: 401, http_status: 401 })],
    ["a refused managed role", () => new ExpectedToolError("linkedin_ads_forbidden", LINKEDIN_ADS_FORBIDDEN_READ, { status: 403, http_status: 403 })],
  ])("%s is a Zavi-side outage: never a founder login problem, never a Reconnect", async (_label, fault) => {
    managedLedger.read = async () => { throw fault(); };
    const err = await readLinkedinAccountsForBudget(T, START, NOW).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect(classifyAdReadError(err)).not.toBe("auth");
    expect((err as Error).message).not.toMatch(/reconnect/i);
  });
  it("a managed rate limit keeps its own kind, so the one quick retry still happens", async () => {
    managedLedger.read = async () => { throw new ExpectedToolError("linkedin_ads_rate_limited", "LinkedIn is busy.", { status: 429, http_status: 429 }); };
    const err = await readLinkedinAccountsForBudget(T, START, NOW).then(() => null, (e: unknown) => e);
    expect(classifyAdReadError(err)).toBe("rate_limited");
  });
});
