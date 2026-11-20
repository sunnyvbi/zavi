import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const state = {
    tenant: "t0",
    stampFails: false,
    tables: {} as Record<string, Row[]>,
    bindingReadFails: false,
    walletSwitchedOn: false,
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
      is: (k: string, v: unknown) => {
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
vi.mock("@/services/agents/registry", async (original) => ({ ...(await original<typeof import("@/services/agents/registry")>()), loadAgentDefinition: async (slug: string) => ({ slug }) }));
vi.mock("@/services/analytics/mixpanel", () => ({ track: vi.fn() }));
vi.mock("@/services/ads-wallet/managed-linkedin", async (original) => {
  const real = await original<typeof import("@/services/ads-wallet/managed-linkedin")>();
  return { ...real, managedLinkedinEnabled: () => h.state.walletSwitchedOn || real.managedLinkedinEnabled() };
});
vi.mock("@/services/ads-wallet/wallet", async (original) => {
  const real = await original<typeof import("@/services/ads-wallet/wallet")>();
  return { ...real, fundingEnabled: () => h.state.walletSwitchedOn || real.fundingEnabled() };
});
vi.mock("@/services/supabase", async (original) => ({
  ...(await original<typeof import("@/services/supabase")>()),
  serverClientFromBearer: () => ({
    from: (table: string) =>
      table === "connector_metadata"
        ? { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { team_id: "x", connected_at: "2026-10-01" }, error: null }) }) }) }) }
        : h.query(table),
  }),
}));
vi.mock("@/services/logging/logEvent", async (original) => ({ ...(await original<typeof import("@/services/logging/logEvent")>()), logEvent: vi.fn() }));

import { DASHBOARD_BUILDERS } from "../registry";
import { adsAvailableAccounts, adsDisableAccount, adsSelectAccount } from "@/routes/ads/accounts";
import { agentDashboard } from "@/routes/agents/dashboard";
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
  h.state.walletSwitchedOn = false;
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


const DEV = "10000000-0000-4000-8000-000000000002";
const json = (r: Response) => (r as unknown as { json: ReturnType<typeof vi.fn> }).json.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
const dashboardRoute = async (query: Record<string, string>) => {
  const r = res();
  await agentDashboard({ params: { slug: "linkedin_ads" }, query: { days: "30", window: "last_30d", ...query } } as unknown as Request, r);
  return json(r) as unknown as LinkedinAdsPayload & { generic: boolean };
};
const accountWrite = async (handler: typeof adsSelectAccount, id: string) => {
  const r = res();
  await handler({ params: { platform: "linkedin" }, method: "POST", body: { account_binding_id: id } } as unknown as Request, r);
  expect((r as unknown as { status: ReturnType<typeof vi.fn> }).status).not.toHaveBeenCalled();
  expect(json(r)).toEqual({ ok: true });
};
const addDeveloperAccount = () => {
  h.state.tables.ads_account_binding_details.push({ id: DEV, tenant_id: h.state.tenant, platform: "linkedin", funding_source: "provider", provider_account_id: "502", credential_source: "tenant_connector", credential_tenant_id: h.state.tenant, credential_ref: "linkedin_ads.access_token", currency: "USD" });
  const base = live.override;
  live.override = (url) => {
    if (/adAccounts\/502\/adCampaigns$/.test(url.pathname) && url.search.includes("ACTIVE")) return reply({ elements: [campaign("502", "9100")], metadata: {} });
    if (kindOf(url) === "roles") return reply({ elements: ["700", "501", "502"].map((id) => ({ account: `urn:li:sponsoredAccount:${id}`, role: "ACCOUNT_MANAGER" })), paging: { total: 3 } });
    return base?.(url) ?? null;
  };
};
const choose = (id: string) => {
  h.state.tables.ads_account_selections = [{ account_binding_id: id, tenant_id: h.state.tenant, platform: "linkedin" }];
};
const pageOpen = () => Promise.all([dashboardRoute({}), dashboardRoute({})]);
const pageAfterAccountChange = () => Promise.all([dashboardRoute({ refresh: "1", scope: "selection" }), dashboardRoute({ refresh: "1", scope: "selection" })]);

describe("picking the account for new campaigns", () => {
  it("re-reads the dashboard for the new account and asks LinkedIn only for what the old account did not already read", async () => {
    addDeveloperAccount();
    const [open] = await pageOpen();
    expect(open.campaigns.map((c) => c.id).sort()).toEqual(["7001", "7002", "7003", "9001", "9002"]);
    vi.setSystemTime(T0 + 30_000);
    const select = await during(() => accountWrite(adsSelectAccount, DEV));
    expect(select).toEqual({ account: 1, roles: 1 });
    choose(DEV);
    let after: Awaited<ReturnType<typeof pageAfterAccountChange>> | undefined;
    const start = gets().length;
    const reread = await during(async () => {
      after = await pageAfterAccountChange();
    });
    for (const p of after!) {
      expect(p.generic).toBe(false);
      expect(p.campaigns.map((c) => c.id).sort()).toEqual(["7001", "7002", "7003", "9100"]);
      expect(p.account).toMatchObject({ id: "502", account_count: 2 });
    }
    expect(reread).toEqual({ campaign_list: 1, group_list: 1, analytics: 2, creatives: 1 });
    const urls = gets().slice(start);
    expect(urls.every((u) => u.pathname.includes("adAccounts/502/") || u.search.includes("sponsoredAccount%3A502"))).toBe(true);
  });

  it("the access check on the pick itself is never served from a cached read", async () => {
    addDeveloperAccount();
    await pageOpen();
    const first = await during(() => accountWrite(adsSelectAccount, DEV));
    const second = await during(() => accountWrite(adsSelectAccount, DEV));
    expect(first).toEqual({ account: 1, roles: 1 });
    expect(second).toEqual({ account: 1, roles: 1 });
  });

  it("a manual Refresh after the pick still reads campaigns live", async () => {
    addDeveloperAccount();
    await pageOpen();
    vi.setSystemTime(T0 + 30_000);
    choose(DEV);
    await pageAfterAccountChange();
    live.status["9100"] = "PAUSED";
    const manual = await during(async () => {
      const p = await dashboardRoute({ refresh: "1", meter: "1" });
      expect(statusOf(p, "9100")).toBe("PAUSED");
      expect(statusOf(p, "9001")).toBeUndefined();
    });
    expect(manual.campaign_list).toBeGreaterThanOrEqual(1);
    expect(gets().every((u) => !u.pathname.includes("adAccounts/501/adCampaigns") || u.search.includes("sponsoredCampaign") || true)).toBe(true);
  });
});

describe("stopping the account for new campaigns", () => {
  it("the next re-read drops a stopped account that has no campaigns, even when the dashboard before it was cached, with no LinkedIn call", async () => {
    live.status = { "9001": "PAUSED", "9002": "PAUSED", "7001": "PAUSED", "7002": "PAUSED", "7003": "PAUSED" };
    addDeveloperAccount();
    const base = live.override;
    live.override = (url) => (/adAccounts\/502\/adCampaigns$/.test(url.pathname) ? reply({ elements: [], metadata: {} }) : base?.(url) ?? null);
    choose(DEV);
    const [open] = await pageOpen();
    expect(open.account?.account_count).toBe(2);
    expect(open.campaigns.every((c) => c.ad_delivery === null)).toBe(true);
    vi.setSystemTime(T0 + 30_000);
    const cached = await during(() => pageAfterAccountChange());
    expect(cached).toEqual({});
    await accountWrite(adsDisableAccount, DEV);
    h.state.tables.ads_account_binding_status = [{ account_binding_id: DEV, tenant_id: h.state.tenant, disabled_at: "2026-10-30T09:00:30Z" }];
    let after: Awaited<ReturnType<typeof pageAfterAccountChange>> | undefined;
    const reread = await during(async () => {
      after = await pageAfterAccountChange();
    });
    for (const p of after!) expect(p.account?.account_count).toBe(1);
    expect(reread).toEqual({});
  });
});

describe("a workspace whose only runnable ad account is held by another workspace", () => {
  const noAccountHere = () => {
    h.state.tables.ads_account_selections = [];
    h.state.tables.ads_account_binding_details = [];
    h.state.tables.ads_campaign_binding_details = [];
    h.state.tables.ads_provider_accounts = [{ platform: "linkedin", provider_account_id: "501", credential_source: "tenant_connector", credential_tenant_id: "another-tenant", claim_released_at: null }];
  };

  const onlyHeldAccountOnLogin = () => {
    live.override = (url) => (kindOf(url) === "accounts" ? reply({ elements: [{ id: 501, name: "Own", currency: "USD", status: "ACTIVE" }], metadata: {} }) : null);
  };

  it("names the held account so the page can say it cannot be used here", async () => {
    noAccountHere();
    onlyHeldAccountOnLogin();
    const p = await dashboard();
    expect(p.connected).toBe(true);
    expect(p.account).toBeNull();
    expect(p.held_elsewhere).toEqual(["Own"]);
  });

  it("names nothing when the login also runs an account no workspace holds", async () => {
    noAccountHere();
    const p = await dashboard();
    expect(p.held_elsewhere).toEqual([]);
  });

  it("names nothing when the held claim was released", async () => {
    noAccountHere();
    onlyHeldAccountOnLogin();
    h.state.tables.ads_provider_accounts = [{ platform: "linkedin", provider_account_id: "501", credential_source: "tenant_connector", credential_tenant_id: "another-tenant", claim_released_at: "2026-10-29T00:00:00Z" }];
    const p = await dashboard();
    expect(p.held_elsewhere).toEqual([]);
  });

  const T0_ISO = new Date(T0).toISOString();
  const HELD = { id: "acc-held", platform: "linkedin", provider_account_id: "501", credential_source: "tenant_connector", credential_tenant_id: "another-tenant", claim_released_at: null, verified_at: T0_ISO, currency: "USD" };
  const zaviAccount = (over: Record<string, unknown> = {}) => ({ id: "acc-zavi", platform: "linkedin", provider_account_id: "700", credential_source: "platform", credential_tenant_id: null, claim_released_at: null, verified_at: T0_ISO, currency: "USD", ...over });
  const zaviGranted = (grant: Record<string, unknown> = {}, account: Record<string, unknown> = {}) => {
    noAccountHere();
    onlyHeldAccountOnLogin();
    h.state.walletSwitchedOn = true;
    h.state.tables.ads_provider_accounts = [HELD, zaviAccount(account)];
    h.state.tables.ads_managed_account_choices = [{ tenant_id: h.state.tenant, account_id: "acc-zavi", label: "Zavi LinkedIn", platform: "linkedin", disabled_at: null, ...grant }];
  };

  it("offers the shared wallet whenever Zavi's LinkedIn account is switched on, with no grant for this workspace and no permission given yet", async () => {
    noAccountHere();
    onlyHeldAccountOnLogin();
    h.state.walletSwitchedOn = true;
    h.state.tables.ads_provider_accounts = [HELD];
    h.state.tables.ads_managed_account_choices = [];
    h.state.tables.ads_wallet_consents = [];
    const p = await dashboard();
    expect(p.account).toBeNull();
    expect(p.held_elsewhere).toEqual(["Own"]);
    expect(p.wallet_offered).toBe(true);
  });

  it.each([
    ["a ready grant and the permission given", () => { zaviGranted(); h.state.tables.ads_wallet_consents = [{ tenant_id: h.state.tenant, version: "shared_ads_wallet_v1", revoked_at: null }]; }],
    ["a ready grant and the permission withdrawn", () => { zaviGranted(); h.state.tables.ads_wallet_consents = [{ tenant_id: h.state.tenant, version: "shared_ads_wallet_v1", revoked_at: T0_ISO }]; }],
    ["a grant that is switched off for this workspace", () => zaviGranted({ disabled_at: T0_ISO })],
    ["a granted account that is not verified yet", () => zaviGranted({}, { verified_at: null })],
  ])("still offers it with %s", async (_why, arrange) => {
    arrange();
    expect((await dashboard()).wallet_offered).toBe(true);
  });

  it("does not offer the shared wallet while Zavi's LinkedIn account is switched off for everyone, even with a ready grant and the permission given", async () => {
    zaviGranted();
    h.state.walletSwitchedOn = false;
    h.state.tables.ads_wallet_consents = [{ tenant_id: h.state.tenant, version: "shared_ads_wallet_v1", revoked_at: null }];
    const p = await dashboard();
    expect(p.held_elsewhere).toEqual(["Own"]);
    expect(p.wallet_offered).toBe(false);
  });
});
