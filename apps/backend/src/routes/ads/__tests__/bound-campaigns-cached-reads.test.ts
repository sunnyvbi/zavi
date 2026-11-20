import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const m = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
}));
vi.mock("../wallet-auth", () => ({ walletAuth: async () => ({ tenant_id: "tenant-a", user_id: "u" }), walletError: (_r: unknown, e: unknown) => { throw e; } }));
vi.mock("@/services/ads-wallet/bindings", () => ({
  getCampaignBinding: async (_t: string, id: string) => ({ id, platform: "linkedin", account_binding_id: "acct", provider_campaign_id: id.slice(1) }),
  getAccountBinding: async () => ({ id: "acct" }),
}));
vi.mock("@/services/ads-wallet/adapters/linkedin-account", () => ({
  resolveLinkedinAccount: async () => ({ token: "tok", account: { id: "501", currency: "USD" } }),
}));
vi.mock("@/services/ads-wallet/linkedin-launch", () => ({}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantClient: () => ({
    from: (table: string) => {
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      const chain: Record<string, unknown> = {};
      for (const k of ["select", "order", "range"]) chain[k] = () => chain;
      chain.eq = (k: string, v: unknown) => (filters.push((r) => r[k] === undefined || r[k] === v), chain);
      chain.in = (k: string, v: unknown[]) => (filters.push((r) => v.includes(r[k] as never)), chain);
      chain.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: (m.tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null }).then(ok);
      chain.maybeSingle = () => Promise.resolve({ data: (m.tables[table] ?? []).filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null });
      return chain;
    },
  }),
}));
import { adsBoundCampaigns } from "../campaigns";
import { resetLinkedInAdsReadCache } from "@/services/connectors/linkedin-ads/http";

const fetchMock = vi.fn();
const ids = ["b9001", "b9002", "b9003"];
const campaignReply = (id: string, status: string) => ({
  ok: true, status: 200, headers: new Headers(),
  json: async () => ({ id: Number(id), account: "urn:li:sponsoredAccount:501", name: "C", status, campaignGroup: "g", runSchedule: { start: 1 }, changeAuditStamps: { created: { time: 1 }, lastModified: { time: 1 } } }),
});
const load = async () => {
  const r = { status: vi.fn(), json: vi.fn() };
  r.status.mockReturnValue(r);
  await adsBoundCampaigns({ query: { platform: "linkedin" } } as unknown as Request, r as unknown as Response);
  return Object.fromEntries((r.json.mock.calls[0]![0] as { campaigns: Array<{ id: string; status?: string }> }).campaigns.map((c) => [c.id, c.status]));
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-10-30T09:00:00Z"));
  resetLinkedInAdsReadCache();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => campaignReply(/adCampaigns\/(\d+)/.exec(String(url))![1], "PAUSED"));
  vi.stubGlobal("fetch", fetchMock);
  m.tables = {
    ads_campaign_binding_details: ids.map((id) => ({ id, platform: "linkedin", provider_campaign_id: id.slice(1), account_binding_id: "acct", funding_source: "wallet" })),
    ads_account_binding_details: [{ id: "acct", tenant_id: "tenant-a", platform: "linkedin", provider_account_id: null, funding_source: "wallet" }],
    ads_account_selections: [],
    ads_account_binding_status: [],
    channel_actions: [],
    ads_campaign_lifecycle: ids.map((id) => ({ campaign_binding_id: id, created_paused: true, activation_attempted_at: "2026-10-01T00:00:00Z", stop_requested_at: null, stop_confirmed_at: null, provider_creative_ids: ["1"] })),
    ads_campaign_operations: ids.map((id) => ({ campaign_binding_id: id, kind: "activate", status: "succeeded", updated_at: "2026-10-01T00:00:10Z", end_time: String(Date.parse("2099-01-01T00:00:00Z")) })),
  };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("the second list load inside two minutes asks LinkedIn nothing, through the real read path", async () => {
  expect(Object.values(await load())).toEqual(["PAUSED", "PAUSED", "PAUSED"]);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  vi.setSystemTime(Date.parse("2026-10-30T09:01:00Z"));
  expect(Object.values(await load())).toEqual(["PAUSED", "PAUSED", "PAUSED"]);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("after two minutes a pause made in Campaign Manager is read again, and a Zavi change misses the cache at once", async () => {
  await load();
  vi.setSystemTime(Date.parse("2026-10-30T09:02:01Z"));
  await load();
  expect(fetchMock).toHaveBeenCalledTimes(6);
  m.tables.ads_campaign_lifecycle[0] = { ...m.tables.ads_campaign_lifecycle[0], activation_attempted_at: "2026-10-02T00:00:00Z" };
  await load();
  expect(fetchMock).toHaveBeenCalledTimes(9);
});
