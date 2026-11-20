import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  get: vi.fn(),
  owned: vi.fn(),
  binding: vi.fn(),
  legacy: vi.fn(),
  rows: [{ id: "internal" }],
  error: null as unknown,
}));
vi.mock("../bindings", () => ({ getCampaignBinding: m.binding }));
vi.mock("@/services/connectors/chatgpt-ads/workspace", () => ({
  ownedCampaign: m.owned,
}));
vi.mock("@/services/connectors/chatgpt-ads/http", () => ({
  chatgptAdsGet: m.get,
}));
vi.mock(
  "@/services/connectors/chatgpt-ads/growth-ledger",
  async (original) => ({
    ...(await original<
      typeof import("@/services/connectors/chatgpt-ads/growth-ledger")
    >()),
    readChatgptAccount: m.legacy,
  }),
);
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: () => ({
    from: () => {
      const q: any = {
        select: () => q,
        eq: () => q,
        range: async () => ({ data: m.rows, error: m.error }),
      };
      return q;
    },
  }),
}));
import { readChatgptAccountsForBudget } from "../chatgpt-ledger";
import { currentBoundCampaign } from "../campaign-context";
const start = new Date("2026-10-01T00:00:00Z"),
  now = new Date("2026-10-01T12:00:00Z");
beforeEach(() => {
  vi.resetAllMocks();
  m.rows = [{ id: "internal" }];
  m.error = null;
  m.legacy.mockResolvedValue(null);
  m.binding.mockResolvedValue({
    id: "internal",
    platform: "chatgpt",
    tenant_id: "t",
    provider_campaign_id: "12345",
    account_binding_id: "original",
    funding_source: "provider",
  });
  m.owned.mockImplementation(async () => {
    expect(currentBoundCampaign()?.account_binding_id).toBe("original");
    return {
      key: "original-key",
      providerAccountId: "own",
      campaign: {
        id: "12345",
        name: "Customer ad",
        status: "paused",
        budget: { lifetime_spend_limit_micros: 60000000 },
      },
    };
  });
  m.get.mockImplementation(async (_key, path) =>
    path === "/ad_account"
      ? { id: "own", currency_code: "USD", timezone: "UTC" }
      : {
          data: [
            {
              campaign_id: "12345",
              start_time: start.getTime() / 1000,
              end_time: start.getTime() / 1000 + 86399,
              spend: 1.25,
            },
          ],
        },
  );
});
it("reports customer campaigns through original credentials and stores their internal identity", async () => {
  const [account] = await readChatgptAccountsForBudget("t", start, now);
  expect(account.account_id).toBe("own");
  expect(account.spend).toEqual([
    {
      object_id: "internal",
      spend_date: "2026-10-01",
      amount_usd: 1.25,
      provisional: true,
    },
  ]);
  expect(account.campaigns[0]).toMatchObject({
    object_id: "internal",
    campaign_id: "internal",
    budget_usd: 60,
  });
  expect(m.get).toHaveBeenCalledWith(
    "original-key",
    "/campaigns/12345/insights",
    expect.anything(),
  );
  expect(currentBoundCampaign()).toBeUndefined();
});
it("rejects an account that changes during reporting", async () => {
  m.get.mockResolvedValue({
    id: "foreign",
    currency_code: "USD",
    timezone: "UTC",
  });
  await expect(readChatgptAccountsForBudget("t", start, now)).rejects.toThrow(
    "unavailable",
  );
  expect(m.get).toHaveBeenCalledTimes(1);
});
it("rejects missing daily evidence rather than replacing spend with zero", async () => {
  m.get.mockImplementation(async (_key, path) =>
    path === "/ad_account"
      ? { id: "own", currency_code: "USD", timezone: "UTC" }
      : { data: [] },
  );
  await expect(readChatgptAccountsForBudget("t", start, now)).rejects.toThrow(
    "Missing ChatGPT daily spend",
  );
});
it("preserves the legacy managed reader alongside own-account reporting", async () => {
  const legacy = {
    platform: "chatgpt",
    account_id: "legacy",
    window: { since: "2026-10-01", until: "2026-10-01" },
    campaigns: [],
    spend: [],
  };
  m.legacy.mockResolvedValue(legacy);
  const accounts = await readChatgptAccountsForBudget("t", start, now);
  expect(accounts).toHaveLength(2);
  expect(accounts[0]).toBe(legacy);
});

it("converts customer budgets and actual spend into USD while preserving the bound identity",async()=>{
 const original=m.get.getMockImplementation()!;
 m.get.mockImplementation(async(key,path,...rest)=>path==="/ad_account"?{id:"own",currency_code:"EUR",timezone:"UTC"}:original(key,path,...rest));
 vi.stubGlobal("fetch",vi.fn(async()=>({ok:true,json:async()=>({result:"success",base_code:"USD",time_last_update_unix:Math.floor(Date.now()/1000)-3600,time_next_update_unix:Math.floor(Date.now()/1000)+3600,rates:{USD:1,EUR:0.8}})})));
 try{const [account]=await readChatgptAccountsForBudget("t",start,now);expect(account.campaigns[0]).toMatchObject({object_id:"internal",budget_usd:75,currency:"USD"});expect(account.spend[0].amount_usd).toBe(1.57);}finally{vi.unstubAllGlobals();}
});
