import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const state = {
    tenant: "t0",
    stampFails: false,
    tables: {} as Record<string, Row[]>,
    bindingReadFails: false,
  };
  const query = (table: string) => {
    let rows: Row[] = [...(state.tables[table] ?? [])];
    let failed = false;
    if (table === "ads_campaign_operations" && state.stampFails) failed = true;
    if (table === "ads_account_binding_details" && state.bindingReadFails) failed = true;
    const q = {
      select: () => q,
      order: () => q,
      range: () => q,
      limit: () => q,
      eq: (k: string, v: unknown) => {
        rows = rows.filter((r) => !(k in r) || r[k] === v);
        return q;
      },
      in: (k: string, v: unknown[]) => {
        rows = rows.filter((r) => !(k in r) || v.includes(r[k]));
        return q;
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: failed ? { message: "boom" } : null }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(failed ? { data: null, error: { message: "boom" } } : { data: rows, error: null }).then(resolve, reject),
    };
    return q;
  };
  return { state, query };
});

vi.mock("@/services/tenant-client", async (original) => ({
  ...(await original<typeof import("@/services/tenant-client")>()),
  asTenantId: (t: string) => t,
  tenantClient: () => ({ from: h.query }),
  globalClient: () => ({ from: h.query }),
  tenantRpc: async () => ({ data: null, error: null }),
  platformSecretRpc: async () => ({ data: "tok-wallet", error: null }),
}));
vi.mock("@/services/auth/middleware", async (original) => ({ ...(await original<typeof import("@/services/auth/middleware")>()), requireAuth: async () => ({ tenant_id: h.state.tenant, user_id: "owner" }) }));
vi.mock("@/services/auth/tenant-role", async (original) => ({ ...(await original<typeof import("@/services/auth/tenant-role")>()), requireTenantRole: async () => true }));
vi.mock("@/services/ads-wallet/providers", async (original) => ({ ...(await original<typeof import("@/services/ads-wallet/providers")>()), refillEligibility: async () => "blocked" }));
vi.mock("@/services/agents/entitlement", async (original) => ({ ...(await original<typeof import("@/services/agents/entitlement")>()), checkAgentTier: async () => ({ allowed: true, enforced: true }) }));
vi.mock("@/services/channels/lock", async (original) => ({ ...(await original<typeof import("@/services/channels/lock")>()), isChannelLockedStrict: async () => false }));
vi.mock("@/services/connectors/core/token", async (original) => ({ ...(await original<typeof import("@/services/connectors/core/token")>()), getConnectorToken: async () => "tok-own", forceRefreshConnector: vi.fn(), markConnectorTokenRevoked: vi.fn() }));
vi.mock("@/services/logging/logEvent", async (original) => ({ ...(await original<typeof import("@/services/logging/logEvent")>()), logEvent: vi.fn() }));

import { DASHBOARD_BUILDERS } from "../registry";
import { adsAvailableAccounts } from "@/routes/ads/accounts";
import { agentCampaignThumbnails } from "@/routes/agents/campaign-thumbnails";
import { linkedinCampaignMedia } from "@/services/campaign-media/linkedin";
import { linkedinCampaign, linkedinLifetimeSpend } from "@/services/ads-wallet/adapters/linkedin";
import { listEveryLinkedInCampaign, listLinkedInCampaigns } from "@/services/connectors/linkedin-ads/client";
import { linkedinAdsGet, linkedinAdsPost, resetLinkedInAdsReadCache, withLinkedInDisplayReads } from "@/services/connectors/linkedin-ads/http";
import type { DashboardContext } from "../_contract";
import type { LinkedinAdsPayload } from "../linkedin-ads";

type Reply = { ok: boolean; status: number; headers: Headers; json: () => Promise<unknown>; text: () => Promise<string> };
const reply = (body: unknown, status = 200): Reply => ({
  ok: status < 400,
  status,
  headers: new Headers({ "x-restli-id": "1" }),
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const T0 = new Date("2026-10-30T09:00:00.000Z").getTime();
const live = {
  status: {} as Record<string, string>,
  creativesFor: {} as Record<string, string[]>,
  override: null as null | ((url: URL) => Reply | Promise<Reply> | null),
};
const fetchMock = vi.fn();
const gets = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== "POST").map(([u]) => new URL(String(u)));

function kindOf(url: URL): string {
  const p = url.pathname.replace(/^.*\/rest\//, "");
  if (p === "adAccounts") return "accounts";
  if (/^adAccounts\/\d+$/.test(p)) return "account";
  if (/^adAccounts\/\d+\/adCampaigns$/.test(p)) return "campaign_list";
  if (/^adAccounts\/\d+\/adCampaigns\/\d+$/.test(p)) return "campaign_single";
  if (/^adAccounts\/\d+\/adCampaignGroups$/.test(p)) return "group_list";
  if (/^adAccounts\/\d+\/adCampaignGroups\/\d+$/.test(p)) return "group_single";
  if (/^adAccounts\/\d+\/creatives$/.test(p)) return "creatives";
  if (p === "adAnalytics") return "analytics";
  if (p === "adAccountUsers") return "roles";
  return p;
}
const tally = (urls: URL[]) => urls.reduce<Record<string, number>>((t, u) => ({ ...t, [kindOf(u)]: (t[kindOf(u)] ?? 0) + 1 }), {});

const campaign = (account: string, id: string) => ({
  id: Number(id),
  account: `urn:li:sponsoredAccount:${account}`,
  name: `Campaign ${id}`,
  status: live.status[id] ?? "ACTIVE",
  campaignGroup: "urn:li:sponsoredCampaignGroup:1",
  runSchedule: { start: 1 },
  changeAuditStamps: { created: { time: T0 - 86_400_000 }, lastModified: { time: T0 - 86_400_000 } },
});

function route(url: URL): Reply {
  const p = url.pathname.replace(/^.*\/rest\//, "");
  if (p === "adAccounts") return reply({ elements: [{ id: 501, name: "Own", currency: "USD", status: "ACTIVE" }, { id: 502, name: "Other", currency: "USD", status: "ACTIVE" }], metadata: {} });
  const account = /^adAccounts\/(\d+)$/.exec(p);
  if (account) return reply({ id: Number(account[1]), name: "A", currency: "USD", status: "ACTIVE", servingStatuses: [] });
  const list = /^adAccounts\/(\d+)\/adCampaigns$/.exec(p);
  if (list) return reply({ elements: list[1] === "501" ? ["9001", "9002"].map((id) => campaign("501", id)) : [], metadata: {} });
  const single = /^adAccounts\/(\d+)\/adCampaigns\/(\d+)$/.exec(p);
  if (single) return reply(campaign(single[1], single[2]));
  if (/^adAccounts\/\d+\/adCampaignGroups$/.test(p)) return reply({ elements: [{ id: 1, name: "Group 1", status: "ACTIVE", runSchedule: { start: 1 } }], metadata: {} });
  const creatives = /^adAccounts\/(\d+)\/creatives$/.exec(p);
  if (creatives) {
    const wanted = [...url.search.matchAll(/sponsoredCampaign%3A(\d+)/g)].map((m) => m[1]);
    const held = live.creativesFor[creatives[1]] ?? [];
    return reply({ elements: wanted.filter((id) => held.includes(id)).map((id) => ({ id: Number(id) + 1, campaign: `urn:li:sponsoredCampaign:${id}`, intendedStatus: "ACTIVE", thumbnail: `https://media.licdn.com/${id}.png` })), metadata: {} });
  }
  if (p === "adAnalytics") return reply({ elements: [] });
  if (p === "adAccountUsers") return reply({ elements: [{ account: "urn:li:sponsoredAccount:700", role: "ACCOUNT_MANAGER" }, { account: "urn:li:sponsoredAccount:501", role: "ACCOUNT_MANAGER" }], paging: { total: 2 } });
  return reply({ results: {} });
}

let counter = 0;
const ctx = (over: Partial<DashboardContext> = {}) =>
  ({
    tenantId: h.state.tenant,
    accessToken: "a",
    ctx: {},
    sb: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { team_id: "x", connected_at: "2026-10-01" }, error: null }) }) }) }) }) },
    refresh: false,
    meteredRefresh: false,
    rangeDays: 30,
    ...over,
  }) as unknown as DashboardContext;
const dashboard = (over: Partial<DashboardContext> = {}) => DASHBOARD_BUILDERS.linkedin_ads(ctx(over)) as Promise<LinkedinAdsPayload>;
const res = () => {
  const r = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  r.status.mockReturnValue(r);
  return r as unknown as Response;
};
const available = () => adsAvailableAccounts({ params: { platform: "linkedin" }, method: "GET", query: {} } as unknown as Request, res());
const thumbnails = (ids: string[]) =>
  agentCampaignThumbnails({ params: { slug: "performance-marketer" }, query: { channel: "linkedin_ads", campaign_ids: ids.join(",") } } as unknown as Request, res());
const slowAccountList = () => {
  live.override = (url) => (kindOf(url) === "accounts" ? new Promise<Reply>((resolve) => setTimeout(() => resolve(route(url)), 400)) : null);
};
const channelPageLoad = async () => {
  const [payload] = await Promise.all([dashboard(), available()]);
  await thumbnails((payload as LinkedinAdsPayload).campaigns.map((c) => c.id));
  return payload as LinkedinAdsPayload;
};
const during = async (run: () => Promise<unknown>) => {
  const before = gets().length;
  await run();
  return tally(gets().slice(before));
};
const statusOf = (p: LinkedinAdsPayload, id: string) => p.campaigns.find((c) => c.id === id)?.status;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  resetLinkedInAdsReadCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  live.status = {};
  live.creativesFor = { "501": ["9001", "9002"], "700": ["7001", "7002", "7003"] };
  live.override = null;
  const tenant = `t${++counter}`;
  h.state.tenant = tenant;
  h.state.stampFails = false;
  h.state.bindingReadFails = false;
  const own = { id: "b-own", tenant_id: tenant, platform: "linkedin", funding_source: "provider", provider_account_id: "501", credential_source: "tenant_connector", credential_tenant_id: tenant, credential_ref: "linkedin_ads.access_token", currency: "USD" };
  const wallet = { id: "b-wallet", tenant_id: tenant, platform: "linkedin", funding_source: "wallet", provider_account_id: "700", credential_source: "platform", credential_tenant_id: null, credential_ref: "linkedin_ads_managed_1", currency: "USD" };
  const walletCampaign = (id: string, n: string) => ({ id, tenant_id: tenant, platform: "linkedin", funding_source: "wallet", account_binding_id: "b-wallet", provider_campaign_id: n });
  h.state.tables = {
    ads_account_selections: [{ account_binding_id: "b-own", tenant_id: tenant, platform: "linkedin" }],
    ads_account_binding_details: [own, wallet],
    ads_campaign_binding_details: [
      { id: "c-own", tenant_id: tenant, platform: "linkedin", funding_source: "provider", account_binding_id: "b-own", provider_campaign_id: "9001" },
      walletCampaign("w1", "7001"),
      walletCampaign("w2", "7002"),
      walletCampaign("w3", "7003"),
    ],
    ads_account_binding_status: [],
    ads_provider_accounts: [],
    ads_campaign_lifecycle: [],
    ads_campaign_operations: [],
    channel_actions: [],
  };
  fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
    const url = new URL(String(u));
    if (init?.method === "POST") return reply({}, 204);
    return (await live.override?.(url)) ?? route(url);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("what one reload of the LinkedIn channel page asks LinkedIn", () => {
  it("a reload 30 seconds after a cold load makes no LinkedIn calls, even when the campaign table is not cacheable as a page", async () => {
    slowAccountList();
    const cold = await during(channelPageLoad);
    expect(cold).toEqual({ accounts: 1, account: 1, campaign_list: 1, group_list: 1, group_single: 1, campaign_single: 3, creatives: 3, analytics: 4 });
    vi.setSystemTime(T0 + 30_000);
    const reload = await during(channelPageLoad);
    expect(reload).toEqual({});
  });

  it("the shape of a cold load: the account list is asked once though the picker and the dashboard both want it", async () => {
    slowAccountList();
    const cold = await during(() => Promise.all([dashboard(), available()]));
    expect(cold.accounts).toBe(1);
  });

  it("the picker asking first and the dashboard joining it also costs one account list", async () => {
    slowAccountList();
    const cold = await during(async () => {
      const picker = available();
      await vi.waitFor(() => expect(gets().some((u) => kindOf(u) === "accounts")).toBe(true));
      await Promise.all([picker, dashboard()]);
    });
    expect(cold.accounts).toBe(1);
  });

  it("a page mounted twice at once asks LinkedIn for each read once", async () => {
    const cold = await during(() => Promise.all([dashboard(), dashboard()]));
    expect(cold.campaign_list).toBe(1);
    expect(cold.campaign_single).toBe(3);
    expect(cold.accounts).toBe(1);
  });

  it("N wallet campaigns cost N reads on the first load and none on the next", async () => {
    const first = await during(dashboard);
    expect(first.campaign_single).toBe(3);
    vi.setSystemTime(T0 + 60_000);
    const second = await during(dashboard);
    expect(second.campaign_single).toBeUndefined();
  });
});

describe("a display read may be cached", () => {
  it("expires after two minutes and then asks LinkedIn again", async () => {
    await dashboard();
    vi.setSystemTime(T0 + 2 * 60_000 + 1);
    live.status["9001"] = "PAUSED";
    const after = await during(async () => {
      expect(statusOf(await dashboard(), "9001")).toBe("PAUSED");
    });
    expect(after.campaign_list).toBe(1);
    expect(after.campaign_single).toBe(3);
  });

  it("Refresh and realtime rebuilds read campaigns live, and the reload after them sees the new value without another call", async () => {
    await dashboard();
    vi.setSystemTime(T0 + 10_000);
    live.status["9001"] = "PAUSED";
    const manual = await during(async () => {
      expect(statusOf(await dashboard({ refresh: true, meteredRefresh: true }), "9001")).toBe("PAUSED");
    });
    expect(manual.campaign_list).toBe(1);
    expect(manual.campaign_single).toBe(3);
    live.status["9001"] = "ACTIVE";
    const realtime = await during(async () => {
      expect(statusOf(await dashboard({ refresh: true }), "9001")).toBe("ACTIVE");
    });
    expect(realtime.campaign_list).toBe(1);
    live.status["9001"] = "CANCELED";
    const next = await during(async () => {
      expect(statusOf(await dashboard(), "9001")).toBe("ACTIVE");
    });
    expect(next.campaign_list).toBeUndefined();
  });

  it.each([
    ["ads_campaign_operations", { updated_at: "2026-10-30T09:00:09Z" }],
    ["ads_campaign_lifecycle", { campaign_binding_id: "w1", stop_confirmed_at: "2026-10-30T09:00:09Z" }],
    ["channel_actions", { executed_at: "2026-10-30T09:00:09Z" }],
  ])("a Zavi change made on another host moves %s and the next load reads campaigns live", async (table, row) => {
    await dashboard();
    vi.setSystemTime(T0 + 10_000);
    live.status["9001"] = "PAUSED";
    h.state.tables[table] = [{ ...row, tenant_id: h.state.tenant }];
    const after = await during(async () => {
      expect(statusOf(await dashboard(), "9001")).toBe("PAUSED");
    });
    expect(after.campaign_list).toBe(1);
    expect(after.campaign_single).toBe(3);
  });

  it("when the change stamp cannot be read nothing is served from or written to the display cache", async () => {
    h.state.stampFails = true;
    await dashboard();
    live.status["9001"] = "PAUSED";
    vi.setSystemTime(T0 + 10_000);
    const after = await during(async () => {
      expect(statusOf(await dashboard(), "9001")).toBe("PAUSED");
    });
    expect(after.campaign_list).toBe(1);
    expect(after.campaign_single).toBe(3);
  });
});

describe("money, launch and pause reads stay fresh after a cached display read", () => {
  it("inside a dashboard build a fresh or pause-critical campaign read still goes to LinkedIn and does not refill the display entry", async () => {
    const path = "adAccounts/700/adCampaigns/7001";
    const scope = { refresh: false, stamp: "s1" };
    const read = (options: { fresh?: boolean; pauseCritical?: boolean } = {}) =>
      withLinkedInDisplayReads(scope, () => linkedinAdsGet<{ status: string }>("tok", path, {}, {}, options));
    expect((await read()).status).toBe("ACTIVE");
    live.status["7001"] = "PAUSED";
    expect((await read()).status).toBe("ACTIVE");
    expect((await read({ fresh: true })).status).toBe("PAUSED");
    expect((await read({ pauseCritical: true })).status).toBe("PAUSED");
    expect(gets()).toHaveLength(3);
    expect((await read()).status).toBe("ACTIVE");
    expect(gets()).toHaveLength(3);
  });

  it("the write read of a campaign goes to LinkedIn and returns the live status", async () => {
    await dashboard();
    live.status["7001"] = "PAUSED";
    const calls = await during(async () => {
      const read = await linkedinCampaign(h.state.tenant, "w1", true);
      expect(read.campaign.status).toBe("PAUSED");
    });
    expect(calls.campaign_single).toBe(1);
    expect(calls.account).toBe(1);
    expect(calls.roles).toBe(1);
  });

  it("the pause-critical read goes to LinkedIn and returns the live status", async () => {
    await dashboard();
    live.status["7001"] = "PAUSED";
    const calls = await during(async () => {
      const read = await linkedinCampaign(h.state.tenant, "w1", true, false, true);
      expect(read.campaign.status).toBe("PAUSED");
    });
    expect(calls.campaign_single).toBe(1);
  });

  it("the plain campaign read used by spend settlement goes to LinkedIn outside a dashboard build", async () => {
    await dashboard();
    live.status["7001"] = "PAUSED";
    const calls = await during(async () => {
      const read = await linkedinCampaign(h.state.tenant, "w1");
      expect(read.campaign.status).toBe("PAUSED");
    });
    expect(calls.campaign_single).toBe(1);
    const spend = await during(() => linkedinLifetimeSpend(h.state.tenant, "w1"));
    expect(spend.campaign_single).toBe(1);
    expect(spend.analytics).toBeGreaterThanOrEqual(1);
  });

  it("campaign lists used by the budget ledger and agent tools go to LinkedIn outside a dashboard build", async () => {
    await dashboard();
    const a = await during(() => listLinkedInCampaigns(h.state.tenant, "501", 200));
    expect(a.campaign_list).toBe(1);
    const b = await during(() => listEveryLinkedInCampaign(h.state.tenant, "501"));
    expect(b.campaign_list).toBe(1);
  });
});

describe("a write invalidates what it changed", () => {
  const seed = async () => {
    await channelPageLoad();
    vi.setSystemTime(T0 + 10_000);
    live.status["9001"] = "PAUSED";
    live.status["7001"] = "PAUSED";
  };

  it("a pause that LinkedIn accepted drops that account's campaigns and creatives for every token", async () => {
    await seed();
    await linkedinAdsPost("tok-other-user", "adAccounts/501/adCampaigns/9001", "PARTIAL_UPDATE", { patch: { $set: { status: "PAUSED" } } });
    const after = await during(async () => {
      expect(statusOf(await dashboard(), "9001")).toBe("PAUSED");
    });
    expect(after.campaign_list).toBe(1);
    expect(after.creatives).toBeGreaterThanOrEqual(1);
    expect(after.campaign_single).toBeUndefined();
  });

  it("a wallet campaign write drops the single campaign read", async () => {
    await seed();
    await linkedinAdsPost("tok-wallet", "adAccounts/700/adCampaigns/7001", "PARTIAL_UPDATE", { patch: { $set: { status: "PAUSED" } } });
    const after = await during(async () => {
      expect(statusOf(await dashboard(), "7001")).toBe("PAUSED");
    });
    expect(after.campaign_single).toBe(3);
    expect(after.campaign_list).toBeUndefined();
  });

  it("a write that failed with a 500 may still have landed, so it invalidates too", async () => {
    await seed();
    fetchMock.mockImplementationOnce(async () => reply({ message: "oops" }, 500));
    await expect(linkedinAdsPost("tok-own", "adAccounts/501/adCampaigns/9001", "PARTIAL_UPDATE", {})).rejects.toThrow();
    const after = await during(async () => {
      expect(statusOf(await dashboard(), "9001")).toBe("PAUSED");
    });
    expect(after.campaign_list).toBe(1);
  });

  it("a write whose request never returned invalidates too", async () => {
    await seed();
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("socket hang up");
    });
    await expect(linkedinAdsPost("tok-own", "adAccounts/501/adCampaigns/9001", "PARTIAL_UPDATE", {})).rejects.toThrow("socket hang up");
    const after = await during(() => dashboard());
    expect(after.campaign_list).toBe(1);
  });

  it("a campaign read still in flight when the write lands is not kept, so the old status cannot return", async () => {
    let release: (r: Reply) => void = () => {};
    let held = true;
    live.override = (url) => {
      if (held && kindOf(url) === "campaign_list") {
        held = false;
        return new Promise<Reply>((resolve) => {
          release = resolve;
        });
      }
      return null;
    };
    const loading = dashboard();
    await vi.waitFor(() => expect(gets().some((u) => kindOf(u) === "campaign_list")).toBe(true));
    await linkedinAdsPost("tok-own", "adAccounts/501/adCampaigns/9001", "PARTIAL_UPDATE", {});
    release(route(new URL("https://api.linkedin.com/rest/adAccounts/501/adCampaigns")));
    await loading;
    live.status["9001"] = "PAUSED";
    const after = await during(async () => {
      expect(statusOf(await dashboard(), "9001")).toBe("PAUSED");
    });
    expect(after.campaign_list).toBe(1);
  });

  it("a write on another account keeps this account's cached reads", async () => {
    await seed();
    await linkedinAdsPost("tok-own", "adAccounts/999/adCampaigns/1", "PARTIAL_UPDATE", {});
    const after = await during(() => dashboard());
    expect(after).toEqual({});
  });
});

describe("a failed read is not cached", () => {
  it("a 503 on the campaign list is asked again on the next load", async () => {
    let failing = true;
    live.override = (url) => (failing && kindOf(url) === "campaign_list" ? reply({}, 503) : null);
    await dashboard();
    failing = false;
    const after = await during(() => dashboard());
    expect(after.campaign_list).toBe(1);
  });

  it("a 200 with no elements on the campaign list is asked again on the next load", async () => {
    let failing = true;
    live.override = (url) => (failing && kindOf(url) === "campaign_list" ? reply({ message: "nope" }) : null);
    await dashboard();
    failing = false;
    const after = await during(() => dashboard());
    expect(after.campaign_list).toBe(1);
  });

  it("a 200 with no id on a wallet campaign read is asked again on the next load", async () => {
    let failing = true;
    live.override = (url) => (failing && kindOf(url) === "campaign_single" ? reply({ message: "nope" }) : null);
    await dashboard();
    failing = false;
    const after = await during(() => dashboard());
    expect(after.campaign_single).toBe(3);
  });

  const dayLimit = (url: URL) => (kindOf(url) === "analytics" ? reply({ message: "Resource level throttle APPLICATION DAY limit for calls to this resource is reached." }, 429) : null);

  it("a used-up daily limit on analytics names itself instead of a generic read failure", async () => {
    live.override = dayLimit;
    expect((await dashboard()).error_code).toBe("linkedin_ads_daily_limit");
  });

  it("a used-up daily limit on the shared-balance campaigns alone names the shared wallet, not the founder's own connection", async () => {
    let n = 0;
    live.override = (url) => (url.search.includes("sponsoredCampaign") && kindOf(url) === "analytics" && ++n > 0 ? dayLimit(url) : null);
    const p = await dashboard();
    expect(p.wallet_error_code).toBe("linkedin_ads_wallet_daily_limit");
    expect(p.own_error_code).toBeNull();
    expect(p.error_code).toBeNull();
  });

  it("a 200 with no elements on analytics, creatives or the account list is asked again", async () => {
    let failing = true;
    const bad = new Set(["analytics", "creatives", "accounts"]);
    live.override = (url) => (failing && bad.has(kindOf(url)) ? reply({ message: "nope" }) : null);
    await dashboard();
    failing = false;
    const after = await during(() => dashboard());
    expect(after.accounts).toBe(1);
    expect(after.creatives).toBeGreaterThanOrEqual(1);
    expect(after.analytics).toBeGreaterThanOrEqual(1);
  });
});

describe("the account picker's fresh read", () => {
  it("still asks LinkedIn when no identical read is in flight", async () => {
    await dashboard();
    const after = await during(available);
    expect(after.accounts).toBe(1);
  });
});

describe("campaign thumbnails", () => {
  it("reads the tenant's bound accounts and skips the other accounts in the token when every campaign was found", async () => {
    const calls = await during(() => linkedinCampaignMedia(h.state.tenant, ["9001", "9002"]));
    expect(gets().filter((u) => kindOf(u) === "creatives").map((u) => u.pathname.match(/adAccounts\/(\d+)/)?.[1])).toEqual(["501"]);
    expect(calls.creatives).toBe(1);
  });

  it("falls through to the other accounts for a campaign the bound accounts do not hold, asking only for that campaign", async () => {
    live.creativesFor["502"] = ["5555"];
    const result = await linkedinCampaignMedia(h.state.tenant, ["9001", "5555"]);
    const reads = gets().filter((u) => kindOf(u) === "creatives");
    expect(reads.map((u) => u.pathname.match(/adAccounts\/(\d+)/)?.[1])).toEqual(["501", "502"]);
    expect(reads[1].search).toContain("5555");
    expect(reads[1].search).not.toContain("9001");
    expect(result["5555"]?.length).toBe(1);
    expect(result["9001"]?.length).toBe(1);
  });

  it("reads every account when the binding lookup fails, and still finds the media", async () => {
    h.state.bindingReadFails = true;
    live.creativesFor["502"] = ["5555"];
    const result = await linkedinCampaignMedia(h.state.tenant, ["5555"]);
    expect(gets().filter((u) => kindOf(u) === "creatives").length).toBe(2);
    expect(result["5555"]?.length).toBe(1);
  });
});
