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
vi.mock("@/services/agents/registry", async (original) => ({ ...(await original<typeof import("@/services/agents/registry")>()), loadAgentDefinition: async (slug: string) => ({ slug }) }));
vi.mock("@/services/analytics/mixpanel", () => ({ track: vi.fn() }));
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

import { adsBoundCampaigns } from "@/routes/ads/campaigns";
import { agentDashboard } from "@/routes/agents/dashboard";
import { linkedinAdsListAccountsTool } from "@/services/tools/linkedin-ads/list_accounts";
import { linkedinAdsListCampaignsTool } from "@/services/tools/linkedin-ads/list_campaigns";
import { linkedinAdsBoundCampaigns } from "@/services/tools/linkedin-ads/propose_launch_campaign";
import { resetLinkedInAdsReadCache } from "@/services/connectors/linkedin-ads/http";
import type { LinkedinAdsPayload } from "../linkedin-ads";

type Reply = { ok: boolean; status: number; headers: Headers; json: () => Promise<unknown>; text: () => Promise<string> };
const reply = (body: unknown, status = 200): Reply => ({
  ok: status < 400,
  status,
  headers: new Headers({ "x-restli-id": "1" }),
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const T0 = new Date("2026-11-05T09:00:00.000Z").getTime();
const OLD = "10000000-0000-4000-8000-00000000000a";
const NEW = "10000000-0000-4000-8000-00000000000b";
const WALLET = "10000000-0000-4000-8000-00000000000c";
const OLD_ACCOUNT = "501";
const NEW_ACCOUNT = "502";
const WALLET_ACCOUNT = "700";
const OLD_CAMPAIGNS = ["9001", "9002"];
const NEW_CAMPAIGNS = ["9100"];
const WALLET_CAMPAIGNS = ["7001", "7002", "7003"];

const fetchMock = vi.fn();
const gets = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== "POST").map(([u]) => new URL(String(u)));
const readsOfAccount = (account: string) => gets().filter((u) => u.pathname.includes(`adAccounts/${account}/`) || u.search.includes(`sponsoredAccount%3A${account}`));

const campaign = (account: string, id: string) => ({
  id: Number(id),
  account: `urn:li:sponsoredAccount:${account}`,
  name: `Campaign ${id}`,
  status: "PAUSED",
  campaignGroup: "urn:li:sponsoredCampaignGroup:1",
  runSchedule: { start: 1 },
  changeAuditStamps: { created: { time: T0 - 86_400_000 }, lastModified: { time: T0 - 86_400_000 } },
});
const heldBy: Record<string, string[]> = { [OLD_ACCOUNT]: OLD_CAMPAIGNS, [NEW_ACCOUNT]: NEW_CAMPAIGNS, [WALLET_ACCOUNT]: WALLET_CAMPAIGNS };

function route(url: URL): Reply {
  const p = url.pathname.replace(/^.*\/rest\//, "");
  if (p === "adAccounts") return reply({ elements: [{ id: 501, name: "Old own", currency: "USD", status: "ACTIVE" }, { id: 502, name: "New own", currency: "USD", status: "ACTIVE" }], metadata: {} });
  const account = /^adAccounts\/(\d+)$/.exec(p);
  if (account) return reply({ id: Number(account[1]), name: "A", currency: "USD", status: "ACTIVE", servingStatuses: [] });
  const list = /^adAccounts\/(\d+)\/adCampaigns$/.exec(p);
  if (list) return reply({ elements: (heldBy[list[1]] ?? []).map((id) => campaign(list[1], id)), metadata: {} });
  const single = /^adAccounts\/(\d+)\/adCampaigns\/(\d+)$/.exec(p);
  if (single) return reply(campaign(single[1], single[2]));
  if (/^adAccounts\/\d+\/adCampaignGroups$/.test(p)) return reply({ elements: [{ id: 1, name: "Group 1", status: "ACTIVE", runSchedule: { start: 1 } }], metadata: {} });
  if (/^adAccounts\/\d+\/creatives$/.test(p)) return reply({ elements: [], metadata: {} });
  if (p === "adAnalytics") return reply({ elements: [] });
  if (p === "adAccountUsers") return reply({ elements: [WALLET_ACCOUNT, OLD_ACCOUNT, NEW_ACCOUNT].map((id) => ({ account: `urn:li:sponsoredAccount:${id}`, role: "ACCOUNT_MANAGER" })), paging: { total: 3 } });
  return reply({ results: {} });
}

let counter = 0;
const res = () => {
  const r = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  r.status.mockReturnValue(r);
  return r as unknown as Response;
};
const json = (r: Response) => (r as unknown as { json: ReturnType<typeof vi.fn> }).json.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
const dashboardRoute = async (query: Record<string, string> = {}) => {
  const r = res();
  await agentDashboard({ params: { slug: "linkedin_ads" }, query: { days: "30", window: "last_30d", ...query } } as unknown as Request, r);
  return json(r) as unknown as LinkedinAdsPayload & { generic: boolean };
};
const boundRoute = async () => {
  const r = res();
  await adsBoundCampaigns({ query: { platform: "linkedin" }, method: "GET" } as unknown as Request, r);
  expect((r as unknown as { status: ReturnType<typeof vi.fn> }).status).not.toHaveBeenCalled();
  return (json(r) as { campaigns: Array<{ id: string; provider_campaign_id: string; provider_account_id?: string | null }> }).campaigns;
};
const toolCtx = () => ({ tenant_id: h.state.tenant, log: () => undefined }) as never;
const listAccounts = async () => ((await linkedinAdsListAccountsTool.execute(toolCtx(), {})) as { accounts: Array<{ id: string; funding: string }> }).accounts;
const boundTool = async () => ((await linkedinAdsBoundCampaigns.execute(toolCtx(), {})) as { campaigns: Array<{ id: string; provider_campaign_id: string }> }).campaigns;
const listCampaigns = (account: string) => linkedinAdsListCampaignsTool.execute(toolCtx(), { account_id: account });
const select = (id: string) => {
  h.state.tables.ads_account_selections = [{ account_binding_id: id, tenant_id: h.state.tenant, platform: "linkedin" }];
};
const disabled = (...ids: string[]) => {
  h.state.tables.ads_account_binding_status = ids.map((id) => ({ account_binding_id: id, tenant_id: h.state.tenant, disabled_at: "2026-11-01T00:00:00Z" }));
};
const afterSwitch = () => dashboardRoute({ refresh: "1", scope: "selection" });
const sorted = (ids: string[]) => [...ids].sort();
const campaignIds = (p: LinkedinAdsPayload) => sorted(p.campaigns.map((c) => c.id));
const WALLET_AND_NEW = sorted([...WALLET_CAMPAIGNS, ...NEW_CAMPAIGNS]);
const WALLET_AND_OLD = sorted([...WALLET_CAMPAIGNS, ...OLD_CAMPAIGNS]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  resetLinkedInAdsReadCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  const tenant = `scope-${++counter}`;
  h.state.tenant = tenant;
  h.state.stampFails = false;
  h.state.bindingReadFails = false;
  const own = (id: string, account: string) => ({ id, tenant_id: tenant, platform: "linkedin", funding_source: "provider", provider_account_id: account, credential_source: "tenant_connector", credential_tenant_id: tenant, credential_ref: "linkedin_ads.access_token", currency: "USD" });
  const bound = (id: string, binding: string, funding_source: string, n: string) => ({ id, tenant_id: tenant, platform: "linkedin", funding_source, account_binding_id: binding, provider_campaign_id: n });
  h.state.tables = {
    ads_account_selections: [{ account_binding_id: NEW, tenant_id: tenant, platform: "linkedin" }],
    ads_account_binding_details: [
      own(OLD, OLD_ACCOUNT),
      own(NEW, NEW_ACCOUNT),
      { id: WALLET, tenant_id: tenant, platform: "linkedin", funding_source: "wallet", provider_account_id: WALLET_ACCOUNT, credential_source: "platform", credential_tenant_id: null, credential_ref: "linkedin_ads_managed_1", currency: "USD" },
    ],
    ads_campaign_binding_details: [
      bound("c-old-1", OLD, "provider", "9001"),
      bound("c-old-2", OLD, "provider", "9002"),
      bound("c-new", NEW, "provider", "9100"),
      bound("w1", WALLET, "wallet", "7001"),
      bound("w2", WALLET, "wallet", "7002"),
      bound("w3", WALLET, "wallet", "7003"),
    ],
    ads_account_binding_status: [{ account_binding_id: OLD, tenant_id: tenant, disabled_at: "2026-11-01T00:00:00Z" }],
    ads_provider_accounts: [],
    ads_campaign_lifecycle: [],
    ads_campaign_operations: [],
    channel_actions: [],
  };
  fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
    const url = new URL(String(u));
    if (init?.method === "POST") return reply({}, 204);
    return route(url);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("one connected own account per workspace, plus the Zavi wallet account", () => {
  it("must catch: the dashboard shows the selected own account and the wallet only; the replaced account's campaigns are nowhere in the payload and LinkedIn is never asked about it", async () => {
    const p = await dashboardRoute();
    expect(p.generic).toBe(false);
    expect(p.connected).toBe(true);
    expect(campaignIds(p)).toEqual(WALLET_AND_NEW);
    expect(p.account).toMatchObject({ id: NEW_ACCOUNT, account_count: 2 });
    const text = JSON.stringify(p);
    for (const id of OLD_CAMPAIGNS) expect(text).not.toContain(id);
    expect(text).not.toContain("Old own");
    expect(readsOfAccount(OLD_ACCOUNT)).toEqual([]);
    expect(readsOfAccount(NEW_ACCOUNT).length).toBeGreaterThan(0);
  });

  it("must catch: the campaign list behind the cards holds only the selected account's and the wallet's bindings", async () => {
    const rows = await boundRoute();
    expect(sorted(rows.map((c) => c.id))).toEqual(["c-new", "w1", "w2", "w3"]);
    expect(sorted(rows.map((c) => c.provider_campaign_id))).toEqual(WALLET_AND_NEW);
    expect(rows.every((c) => c.provider_account_id !== OLD_ACCOUNT)).toBe(true);
  });

  it("must catch: the agent's account list, campaign list and bound-campaign read follow the same scope, and the replaced account is refused by id", async () => {
    expect((await listAccounts()).map((a) => [a.id, a.funding])).toEqual([[NEW_ACCOUNT, "own"], [WALLET_ACCOUNT, "zavi_wallet"]]);
    await expect(listCampaigns(OLD_ACCOUNT)).rejects.toMatchObject({ code: "linkedin_ads_account_not_in_use" });
    const fresh = await listCampaigns(NEW_ACCOUNT);
    expect((fresh as { campaigns: Array<{ id: string }> }).campaigns.map((c) => c.id)).toEqual(NEW_CAMPAIGNS);
    expect(sorted((await boundTool()).map((c) => c.id))).toEqual(["c-new", "w1", "w2", "w3"]);
    expect(readsOfAccount(OLD_ACCOUNT)).toEqual([]);
  });

  it("must catch: switching the selected account flips every read to the other account at once, with no reload of the page", async () => {
    const before = await dashboardRoute();
    expect(campaignIds(before)).toEqual(WALLET_AND_NEW);
    expect(sorted((await boundRoute()).map((c) => c.id))).toEqual(["c-new", "w1", "w2", "w3"]);
    disabled();
    select(OLD);
    const after = await afterSwitch();
    expect(campaignIds(after)).toEqual(WALLET_AND_OLD);
    expect(after.account).toMatchObject({ id: OLD_ACCOUNT, account_count: 2 });
    expect(JSON.stringify(after)).not.toContain("9100");
    expect(sorted((await boundRoute()).map((c) => c.id))).toEqual(["c-old-1", "c-old-2", "w1", "w2", "w3"]);
    expect((await listAccounts()).map((a) => a.id)).toEqual([OLD_ACCOUNT, WALLET_ACCOUNT]);
    await expect(listCampaigns(NEW_ACCOUNT)).rejects.toMatchObject({ code: "linkedin_ads_account_not_in_use" });
    expect(sorted((await boundTool()).map((c) => c.id))).toEqual(["c-old-1", "c-old-2", "w1", "w2", "w3"]);
    select(NEW);
    const back = await afterSwitch();
    expect(campaignIds(back)).toEqual(WALLET_AND_NEW);
    expect(sorted((await boundRoute()).map((c) => c.id))).toEqual(["c-new", "w1", "w2", "w3"]);
  });

  it("must catch: an enabled but unselected own account holding this workspace's campaigns stays out of every read", async () => {
    disabled();
    const p = await dashboardRoute();
    expect(campaignIds(p)).toEqual(WALLET_AND_NEW);
    expect(p.account).toMatchObject({ id: NEW_ACCOUNT, account_count: 2 });
    expect(readsOfAccount(OLD_ACCOUNT)).toEqual([]);
    expect(sorted((await boundRoute()).map((c) => c.id))).toEqual(["c-new", "w1", "w2", "w3"]);
    expect((await listAccounts()).map((a) => a.id)).toEqual([NEW_ACCOUNT, WALLET_ACCOUNT]);
    await expect(listCampaigns(OLD_ACCOUNT)).rejects.toMatchObject({ code: "linkedin_ads_account_not_in_use" });
    expect(sorted((await boundTool()).map((c) => c.id))).toEqual(["c-new", "w1", "w2", "w3"]);
  });

  it("must catch: when the selected own account is stopped, only the wallet campaigns remain and no own account takes its place", async () => {
    disabled(OLD, NEW);
    const p = await afterSwitch();
    expect(campaignIds(p)).toEqual(sorted(WALLET_CAMPAIGNS));
    expect(p.account).toMatchObject({ id: null, account_count: 1 });
    expect(readsOfAccount(OLD_ACCOUNT)).toEqual([]);
    expect(readsOfAccount(NEW_ACCOUNT).filter((u) => !/adAccounts\/\d+$/.test(u.pathname))).toEqual([]);
    expect(sorted((await boundRoute()).map((c) => c.id))).toEqual(["w1", "w2", "w3"]);
    expect((await listAccounts()).map((a) => a.id)).toEqual([WALLET_ACCOUNT]);
    await expect(listCampaigns(NEW_ACCOUNT)).rejects.toMatchObject({ code: "linkedin_ads_account_not_in_use" });
    expect(sorted((await boundTool()).map((c) => c.id))).toEqual(["w1", "w2", "w3"]);
  });

  it("must catch: when the wallet itself is selected, no own account is in use and the own campaigns drop out", async () => {
    disabled();
    select(WALLET);
    const p = await afterSwitch();
    expect(campaignIds(p)).toEqual(sorted(WALLET_CAMPAIGNS));
    expect(p.account).toMatchObject({ id: null, account_count: 1 });
    expect(sorted((await boundRoute()).map((c) => c.id))).toEqual(["w1", "w2", "w3"]);
    expect((await listAccounts()).map((a) => a.id)).toEqual([WALLET_ACCOUNT]);
  });

  it("must catch: a selection row left by another workspace, or one pointing at a binding owned elsewhere, puts no own account in use", async () => {
    h.state.tables.ads_account_selections = [{ account_binding_id: NEW, tenant_id: "someone-else", platform: "linkedin" }];
    const p = await afterSwitch();
    expect(campaignIds(p)).toEqual(sorted(WALLET_CAMPAIGNS));
    expect(sorted((await boundRoute()).map((c) => c.id))).toEqual(["w1", "w2", "w3"]);
    h.state.tables.ads_account_selections = [{ account_binding_id: NEW, tenant_id: h.state.tenant, platform: "linkedin" }];
    h.state.tables.ads_account_binding_details[1] = { ...h.state.tables.ads_account_binding_details[1], credential_tenant_id: "someone-else" };
    const q = await afterSwitch();
    expect(campaignIds(q)).toEqual(sorted(WALLET_CAMPAIGNS));
    expect(sorted((await boundRoute()).map((c) => c.id))).toEqual(["w1", "w2", "w3"]);
  });
});
