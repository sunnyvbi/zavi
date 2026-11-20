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
import { adsBoundCampaigns, adsCampaignLaunch, adsCampaignLaunchSummary } from "../campaigns";
import { launchLinkedinCampaign, linkedinLaunchObservedCents, linkedinLaunchOwnHoldUsd, linkedinLaunchSummary } from "@/services/ads-wallet/linkedin-launch";
import { getCampaignBinding } from "@/services/ads-wallet/bindings";
const req = (platform: string) => ({ query: { platform } }) as unknown as Request;
const res = () => {
  const r = { status: vi.fn(), json: vi.fn() };
  r.status.mockReturnValue(r);
  return r as unknown as Response & { json: ReturnType<typeof vi.fn> };
};
const rows = [
  { id: "b1", platform: "linkedin", provider_campaign_id: "555001", account_binding_id: "a", funding_source: "provider" },
  { id: "b2", platform: "linkedin", provider_campaign_id: "555002", account_binding_id: "a", funding_source: "wallet" },
  { id: "b3", platform: "linkedin", provider_campaign_id: "555003", account_binding_id: "a", funding_source: "provider" },
];
beforeEach(() => {
  vi.clearAllMocks();
  m.tenants.length = 0;
  m.calls.length = 0;
  m.auth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "u" });
  vi.mocked(getCampaignBinding).mockResolvedValue({ platform: "linkedin", funding_source: "wallet", account_binding_id: "a" } as never);
  m.results = {
    ads_campaign_binding_details: { data: rows, error: null },
    ads_account_binding_details: { data: [{ id: "a", tenant_id: "tenant-a", platform: "linkedin", provider_account_id: null, funding_source: "wallet" }], error: null },
    ads_account_selections: { data: { account_binding_id: "a", tenant_id: "tenant-a" }, error: null },
    ads_account_binding_status: { data: [], error: null },
    channel_actions: {
      data: [
        { campaign_id: "555002", name: "  Spring hiring push  " },
        { campaign_id: "555001", name: "Founder webinar signups" },
        { campaign_id: "555003", name: "   " },
      ],
      error: null,
    },
    ads_campaign_lifecycle: {
      data: rows.map((c) => ({ campaign_binding_id: c.id, provider_creative_ids: ["9001"] })),
      error: null,
    },
  };
});
it("hands back each campaign's own binding funding, even when two rows share a provider campaign id or an account binding", async () => {
  m.results.ads_campaign_binding_details = { data: [
    { id: "w", platform: "linkedin", provider_campaign_id: "777", account_binding_id: "shared", funding_source: "wallet" },
    { id: "p", platform: "linkedin", provider_campaign_id: "777", account_binding_id: "own", funding_source: "provider" },
    { id: "x", platform: "linkedin", provider_campaign_id: "778", account_binding_id: "own", funding_source: "provider" },
  ], error: null };
  m.results.ads_account_binding_details = { data: [
    { id: "shared", tenant_id: "tenant-a", platform: "linkedin", provider_account_id: null, funding_source: "wallet" },
    { id: "own", tenant_id: "tenant-a", platform: "linkedin", provider_account_id: "559148166", funding_source: "provider" },
  ], error: null };
  m.results.ads_account_selections = { data: { account_binding_id: "own", tenant_id: "tenant-a" }, error: null };
  m.results.channel_actions = { data: [], error: null };
  const r = res();
  await adsBoundCampaigns(req("linkedin"), r);
  const out = r.json.mock.calls[0][0].campaigns as Array<{ id: string; funding_source: string }>;
  expect(Object.fromEntries(out.map((c) => [c.id, c.funding_source]))).toEqual({ w: "wallet", p: "provider", x: "provider" });
  expect(m.calls.find((c) => c.table === "ads_campaign_binding_details")!.ops[0][1]).toContain("funding_source");
});
it("names each LinkedIn campaign from the founder's reviewed create action, scoped to the caller's tenant", async () => {
  const r = res();
  await adsBoundCampaigns(req("linkedin"), r);
  expect(m.error).not.toHaveBeenCalled();
  expect(r.json).toHaveBeenCalledWith({
    campaigns: [
      { ...rows[0], name: "Founder webinar signups" },
      { ...rows[1], name: "Spring hiring push" },
      { ...rows[2], name: null },
    ],
  });
  expect(new Set(m.tenants)).toEqual(new Set(["tenant-a"]));
  const names = m.calls.find((c) => c.table === "channel_actions")!;
  expect(names.tenant).toBe("tenant-a");
  expect(names.ops).toEqual([
    ["select", "campaign_id:exec_progress->>campaign_id,name:exec_payload->campaign->>name,archived:exec_progress->>archived,exec_status,exec_result,status"],
    ["eq", "channel_slug", "linkedin_ads"],
    ["eq", "exec_class", "linkedin_ads.create_campaign_bundle"],
    ["in", "exec_progress->>campaign_id", ["555001", "555002", "555003"]],
  ]);
});
it("leaves out a campaign Zavi archived after LinkedIn refused its post", async () => {
  m.results.channel_actions = { data: [{ campaign_id: "555002", name: "Showcase post", archived: "true" }, { campaign_id: "555001", name: "Founder webinar signups", archived: null }], error: null };
  const r = res();
  await adsBoundCampaigns(req("linkedin"), r);
  expect(r.json).toHaveBeenCalledWith({ campaigns: [{ ...rows[0], name: "Founder webinar signups" }, { ...rows[2], name: null }] });
});
it("still lists every campaign with its Pause target when the name lookup fails", async () => {
  m.results.channel_actions = { data: null, error: { message: "boom" } };
  const r = res();
  await adsBoundCampaigns(req("linkedin"), r);
  expect(m.error).not.toHaveBeenCalled();
  expect(r.json).toHaveBeenCalledWith({ campaigns: rows.map((c) => ({ ...c, name: null })) });
});
it("does not read LinkedIn actions for ChatGPT campaigns", async () => {
  const chatgpt = [{ ...rows[0], platform: "chatgpt" }];
  m.results.ads_campaign_binding_details = { data: chatgpt, error: null };
  const r = res();
  await adsBoundCampaigns(req("chatgpt"), r);
  expect(m.calls.map((c) => c.table)).toEqual(["ads_campaign_binding_details"]);
  expect(r.json).toHaveBeenCalledWith({ campaigns: [{ ...chatgpt[0], name: null }] });
});
it("marks a Zavi campaign whose ad was never made as still being set up, and only that one", async () => {
  m.results.ads_campaign_lifecycle = {
    data: [
      { campaign_binding_id: "b1", provider_creative_ids: ["9001"] },
      { campaign_binding_id: "b2", provider_creative_ids: [] },
    ],
    error: null,
  };
  const r = res();
  await adsBoundCampaigns(req("linkedin"), r);
  expect(m.error).not.toHaveBeenCalled();
  expect(r.json).toHaveBeenCalledWith({
    campaigns: [
      { ...rows[0], name: "Founder webinar signups" },
      { ...rows[1], name: "Spring hiring push", setting_up: "check" },
      { ...rows[2], name: null, setting_up: "check" },
    ],
  });
  const life = m.calls.find((c) => c.table === "ads_campaign_lifecycle")!;
  expect(life.tenant).toBe("tenant-a");
  expect(life.ops).toEqual([
    ["select", "campaign_binding_id,provider_creative_ids"],
    ["in", "campaign_binding_id", ["b1", "b2", "b3"]],
  ]);
});
it("does not mark an imported campaign Zavi never made, and keeps launch when the ad lookup fails", async () => {
  m.results.channel_actions = { data: [{ campaign_id: "555001", name: "Founder webinar signups" }], error: null };
  m.results.ads_campaign_lifecycle = { data: null, error: { message: "boom" } };
  const r = res();
  await adsBoundCampaigns(req("linkedin"), r);
  expect(r.json).toHaveBeenCalledWith({
    campaigns: [{ ...rows[0], name: "Founder webinar signups" }, { ...rows[1], name: null }, { ...rows[2], name: null }],
  });
  expect(m.calls.find((c) => c.table === "ads_campaign_lifecycle")!.ops).toContainEqual(["in", "campaign_binding_id", ["b1"]]);
});
it("says Try again only for a campaign whose setup card can still be retried, and points the rest to Campaign Manager", async () => {
  const four = [...rows, { id: "b4", platform: "linkedin", provider_campaign_id: "555004", account_binding_id: "a", funding_source: "wallet" }];
  m.results.ads_campaign_binding_details = { data: four, error: null };
  m.results.channel_actions = {
    data: [
      { campaign_id: "555001", name: "Retryable", status: "pending", exec_status: "failed", exec_result: { code: "linkedin_ads_creation_incomplete", error: "Campaign setup is saved. Correct the issue in LinkedIn, then choose Try again to finish the remaining steps.", bucket: "temporary" } },
      { campaign_id: "555002", name: "Ad lost", exec_status: "failed", exec_result: { code: "exec_partial", error: "Created the campaign group and the paused campaign, then the rest did not come back clearly (LinkedIn failed: 503).", bucket: "temporary" } },
      { campaign_id: "555003", name: "Blocked", exec_status: "failed", exec_result: { code: "linkedin_ads_write_refused", error: "refused", bucket: "blocked_on_us" } },
      { campaign_id: "555004", name: "Finished", exec_status: "failed", exec_result: { code: "linkedin_ads_creation_incomplete", error: "x", bucket: "temporary" } },
    ],
    error: null,
  };
  m.results.ads_campaign_lifecycle = {
    data: [
      { campaign_binding_id: "b1", provider_creative_ids: [] },
      { campaign_binding_id: "b4", provider_creative_ids: ["9004"] },
    ],
    error: null,
  };
  const r = res();
  await adsBoundCampaigns(req("linkedin"), r);
  expect(m.error).not.toHaveBeenCalled();
  expect(r.json).toHaveBeenCalledWith({
    campaigns: [
      { ...four[0], name: "Retryable", setting_up: "retry" },
      { ...four[1], name: "Ad lost", setting_up: "check" },
      { ...four[2], name: "Blocked", setting_up: "check" },
      { ...four[3], name: "Finished" },
    ],
  });
  expect(new Set(m.tenants)).toEqual(new Set(["tenant-a"]));
});
it("does not offer Try again while the setup is still running", async () => {
  m.results.channel_actions = { data: [{ campaign_id: "555001", name: "Running", exec_status: "dispatching", exec_result: null }], error: null };
  m.results.ads_campaign_lifecycle = { data: [], error: null };
  const r = res();
  await adsBoundCampaigns(req("linkedin"), r);
  expect(r.json).toHaveBeenCalledWith({
    campaigns: [{ ...rows[0], name: "Running", setting_up: "check" }, { ...rows[1], name: null }, { ...rows[2], name: null }],
  });
});
const launchReq = (body: unknown) =>
  ({ params: { bindingId: "6f1c2b8e-4f0a-4d5e-9c3b-1a2b3c4d5e6f" }, body }) as unknown as Request;
const launchBody = { request_id: "0d6f3a4e-8b1c-4d2e-9f3a-5b6c7d8e9f01", snapshot: "a".repeat(64), total_budget_cents: 10000, end_time: 1 };
it("hands the dashboard's reviewed exchange rate to the launch as the founder's approval, and keeps it out of the launch body", async () => {
  vi.mocked(launchLinkedinCampaign).mockResolvedValue({ status: "active" });
  await adsCampaignLaunch(launchReq({ ...launchBody, reviewed_units_per_usd: 0.8 }), res());
  expect(vi.mocked(launchLinkedinCampaign).mock.calls[0]!.slice(2)).toEqual([launchBody, undefined, { approved_by: "u", reviewed_units_per_usd: 0.8 }]);
});
it("passes no reviewed rate as null, so a non-USD launch from an old dashboard tab is checked rather than skipped", async () => {
  vi.mocked(launchLinkedinCampaign).mockResolvedValue({ status: "active" });
  await adsCampaignLaunch(launchReq(launchBody), res());
  expect(vi.mocked(launchLinkedinCampaign).mock.calls[0]![4]).toEqual({ approved_by: "u", reviewed_units_per_usd: null });
});
it("returns the campaign's observed lifetime spend with the launch review, read for the binding's funding source", async () => {
  vi.mocked(getCampaignBinding).mockResolvedValue({ platform: "linkedin", funding_source: "provider" } as never);
  vi.mocked(linkedinLaunchSummary).mockResolvedValue({ snapshot: "s", total_budget_cents: 50000 } as never);
  vi.mocked(linkedinLaunchObservedCents).mockResolvedValue(42000);
  vi.mocked(linkedinLaunchOwnHoldUsd).mockResolvedValue(10);
  const r = res();
  await adsCampaignLaunchSummary(launchReq(undefined), r);
  expect(vi.mocked(linkedinLaunchObservedCents)).toHaveBeenCalledWith("tenant-a", launchReq(undefined).params.bindingId, "provider");
  expect(vi.mocked(linkedinLaunchOwnHoldUsd)).toHaveBeenCalledWith("tenant-a", launchReq(undefined).params.bindingId);
  expect(r.json).toHaveBeenCalledWith({ snapshot: "s", total_budget_cents: 50000, observed_spend_cents: 42000, own_hold_usd: 10 });
});
it("still answers the launch review with observed spend null when the spend cannot be read", async () => {
  vi.mocked(getCampaignBinding).mockResolvedValue({ platform: "linkedin", funding_source: "wallet" } as never);
  vi.mocked(linkedinLaunchSummary).mockResolvedValue({ snapshot: "s" } as never);
  vi.mocked(linkedinLaunchObservedCents).mockResolvedValue(null);
  vi.mocked(linkedinLaunchOwnHoldUsd).mockResolvedValue(null);
  const r = res();
  await adsCampaignLaunchSummary(launchReq(undefined), r);
  expect(r.json).toHaveBeenCalledWith({ snapshot: "s", observed_spend_cents: null, own_hold_usd: null });
  expect(m.error).not.toHaveBeenCalled();
});
it("a rejected setup card has no Try again, so its empty campaign is closed, not retryable", async () => {
  m.results.ads_campaign_binding_details = { data: rows, error: null };
  m.results.ads_campaign_lifecycle = { data: [{ campaign_binding_id: "b3", provider_creative_ids: ["1"] }], error: null };
  m.results.channel_actions = {
    data: [
      { campaign_id: "555001", name: "Rejected", status: "rejected", exec_status: "failed", exec_result: { code: "linkedin_ads_creation_incomplete", error: "x", bucket: "temporary" } },
      { campaign_id: "555002", name: "Redone", status: "rejected", exec_status: "failed", exec_result: { code: "linkedin_ads_creation_incomplete", error: "x", bucket: "temporary" } },
      { campaign_id: "555002", name: "Redone", status: "pending", exec_status: "failed", exec_result: { code: "linkedin_ads_creation_incomplete", error: "x", bucket: "temporary" } },
      { campaign_id: "555003", name: "Has ads", status: "acted", exec_status: "executed", exec_result: null },
    ],
    error: null,
  };
  const r = res();
  await adsBoundCampaigns(req("linkedin"), r);
  const by = Object.fromEntries((r.json.mock.calls[0][0].campaigns as Array<{ id: string; setting_up?: string }>).map((c) => [c.id, c.setting_up]));
  expect(by).toEqual({ b1: "closed", b2: "retry", b3: undefined });
});
it("refuses to launch a campaign on an own LinkedIn account the workspace replaced, and never reaches LinkedIn", async () => {
  vi.mocked(getCampaignBinding).mockResolvedValue({ platform: "linkedin", funding_source: "provider", account_binding_id: "old" } as never);
  m.results.ads_account_binding_details = { data: [
    { id: "old", tenant_id: "tenant-a", platform: "linkedin", provider_account_id: "1", funding_source: "provider" },
    { id: "new", tenant_id: "tenant-a", platform: "linkedin", provider_account_id: "2", funding_source: "provider" },
  ], error: null };
  m.results.ads_account_selections = { data: { account_binding_id: "new", tenant_id: "tenant-a" }, error: null };
  const r = res();
  await adsCampaignLaunch(launchReq(launchBody), r);
  expect(r.status).toHaveBeenCalledWith(409);
  expect(r.json.mock.calls[0][0].error.code).toBe("ads_account_not_in_use");
  expect(vi.mocked(launchLinkedinCampaign)).not.toHaveBeenCalled();
});
it("still launches a campaign on the selected own LinkedIn account", async () => {
  vi.mocked(getCampaignBinding).mockResolvedValue({ platform: "linkedin", funding_source: "provider", account_binding_id: "new" } as never);
  vi.mocked(launchLinkedinCampaign).mockResolvedValue({ status: "active" });
  m.results.ads_account_binding_details = { data: [{ id: "new", tenant_id: "tenant-a", platform: "linkedin", provider_account_id: "2", funding_source: "provider" }], error: null };
  m.results.ads_account_selections = { data: { account_binding_id: "new", tenant_id: "tenant-a" }, error: null };
  await adsCampaignLaunch(launchReq(launchBody), res());
  expect(vi.mocked(launchLinkedinCampaign)).toHaveBeenCalledTimes(1);
});
