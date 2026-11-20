import { beforeEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const m = vi.hoisted(() => ({
  auth: vi.fn(),
  error: vi.fn(),
  tenants: [] as string[],
  calls: [] as Array<{ tenant: string; table: string; ops: unknown[][] }>,
  results: {} as Record<string, { data: unknown; error: unknown }>,
}));
vi.mock("../wallet-auth", () => ({ walletAuth: m.auth, walletError: m.error }));
vi.mock("@/services/ads-wallet/bindings", () => ({ getCampaignBinding: vi.fn() }));
vi.mock("@/services/ads-wallet/linkedin-launch", () => ({
  linkedinLaunchSummary: vi.fn(),
  linkedinLaunchObservedCents: vi.fn(),
  linkedinLaunchOwnHoldUsd: vi.fn(),
  launchLinkedinCampaign: vi.fn(),
}));
vi.mock("@/services/ads-wallet/adapters/linkedin", () => ({ requestLinkedinPause: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantClient: (tenant: string) => {
    m.tenants.push(tenant);
    return {
      from: (table: string) => {
        const call = { tenant, table, ops: [] as unknown[][] };
        m.calls.push(call);
        const chain: Record<string, unknown> = {};
        for (const op of ["select", "eq", "in", "order", "range"])
          chain[op] = (...args: unknown[]) => {
            call.ops.push([op, ...args]);
            return chain;
          };
        chain.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
          Promise.resolve(m.results[table]).then(ok, bad);
        chain.maybeSingle = () => Promise.resolve(m.results[table] ?? { data: null, error: null });
        return chain;
      },
    };
  },
}));
import { adsBoundCampaigns } from "../campaigns";
const req = { query: { platform: "linkedin" } } as unknown as Request;
const res = () => {
  const r = { status: vi.fn(), json: vi.fn() };
  r.status.mockReturnValue(r);
  return r as unknown as Response & { json: ReturnType<typeof vi.fn> };
};
const bindings = [
  { id: "own-camp", tenant_id: "tenant-a", platform: "linkedin", provider_campaign_id: "905998344", account_binding_id: "own-acct", funding_source: "provider" },
  { id: "wallet-camp", tenant_id: "tenant-a", platform: "linkedin", provider_campaign_id: "906039044", account_binding_id: "zavi-acct", funding_source: "wallet" },
];
const accounts = [
  { id: "own-acct", tenant_id: "tenant-a", provider_account_id: "559148166", funding_source: "provider" },
  { id: "zavi-acct", tenant_id: "tenant-a", provider_account_id: "510000001", funding_source: "wallet" },
];
const selectMode = (mode: "wallet" | "provider") => {
  m.results.ads_account_selections = { data: { account_binding_id: mode === "wallet" ? "zavi-acct" : "own-acct", tenant_id: "tenant-a" }, error: null };
};
const listed = async () => {
  const r = res();
  await adsBoundCampaigns(req, r);
  expect(m.error).not.toHaveBeenCalled();
  const out = r.json.mock.calls[0][0].campaigns as Array<{ id: string; funding_source: string; provider_account_id?: string; pause_only?: boolean }>;
  return Object.fromEntries(out.map((c) => [c.id, { funding: c.funding_source, account: c.provider_account_id ?? null, ...(c.pause_only ? { pause_only: true } : {}) }]));
};
beforeEach(() => {
  vi.clearAllMocks();
  m.tenants.length = 0;
  m.calls.length = 0;
  m.auth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "u" });
  m.results = {
    ads_campaign_binding_details: { data: bindings, error: null },
    ads_account_binding_details: { data: accounts, error: null },
    ads_account_binding_status: { data: [], error: null },
    channel_actions: { data: [], error: null },
    ads_campaign_lifecycle: { data: [], error: null },
  };
});
it("gives each campaign its own funding and the ad account it lives in while the workspace is on its own ad account", async () => {
  selectMode("provider");
  expect(await listed()).toEqual({
    "own-camp": { funding: "provider", account: "559148166" },
    "wallet-camp": { funding: "wallet", account: "510000001" },
  });
  const read = m.calls.find((c) => c.table === "ads_account_binding_details" && c.ops.some((op) => op[0] === "in"))!;
  expect(read.tenant).toBe("tenant-a");
  expect(read.ops).toContainEqual(["in", "id", ["own-acct", "zavi-acct"]]);
  expect(m.calls.find((c) => c.table === "ads_account_selections")?.tenant).toBe("tenant-a");
});
it("on the shared wallet the own account's campaigns stay listed as pause-only, and switching back makes them launchable again without a reload", async () => {
  selectMode("wallet");
  expect(await listed()).toEqual({ "own-camp": { funding: "provider", account: "559148166", pause_only: true }, "wallet-camp": { funding: "wallet", account: "510000001" } });
  m.calls.length = 0;
  m.error.mockClear();
  selectMode("provider");
  const back = await listed();
  expect(back["own-camp"]).toEqual({ funding: "provider", account: "559148166" });
  expect(back["wallet-camp"].funding).toBe("wallet");
});
it("never shows another workspace's ad account, or the campaigns bound to it, on this workspace's list", async () => {
  selectMode("provider");
  m.results.ads_account_binding_details = { data: [
    { id: "own-acct", tenant_id: "tenant-b", provider_account_id: "777000777", funding_source: "provider" },
    accounts[1],
  ], error: null };
  const out = await listed();
  expect(out).toEqual({ "wallet-camp": { funding: "wallet", account: "510000001" } });
  expect(JSON.stringify(out)).not.toContain("777000777");
  expect(new Set(m.tenants)).toEqual(new Set(["tenant-a"]));
});
it("refuses the list rather than guess which account is in use when the account read fails", async () => {
  selectMode("provider");
  m.results.ads_account_binding_details = { data: null, error: { message: "boom" } };
  const r = res();
  await adsBoundCampaigns(req, r);
  expect(m.error).toHaveBeenCalledTimes(1);
  expect(r.json).not.toHaveBeenCalled();
});
