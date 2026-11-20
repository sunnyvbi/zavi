import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  locked: new Set<string>(),
  lockReads: 0,
  db: vi.fn(),
  summary: vi.fn(),
  getCampaign: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("@/services/channels/lock", async (original) => ({
  ...(await original<typeof import("@/services/channels/lock")>()),
  isChannelLocked: async (slug: string) => {
    m.lockReads += 1;
    return m.locked.has(slug);
  },
}));
vi.mock("@/services/tenant-client", async (original) => ({
  ...(await original<typeof import("@/services/tenant-client")>()),
  tenantClient: () => {
    m.db();
    throw new Error("database read");
  },
}));
vi.mock("@/services/ads-wallet/linkedin-launch", async (original) => ({
  ...(await original<typeof import("@/services/ads-wallet/linkedin-launch")>()),
  linkedinLaunchSummary: async (...a: unknown[]) => {
    m.summary(...a);
    throw new Error("LinkedIn read");
  },
}));
vi.mock("@/services/connectors/linkedin-ads/client", async (original) => ({
  ...(await original<typeof import("@/services/connectors/linkedin-ads/client")>()),
  getLinkedInCampaign: async (...a: unknown[]) => {
    m.getCampaign(...a);
    throw new Error("LinkedIn read");
  },
}));
vi.mock("@/services/connectors/linkedin-ads/own-accounts", async (original) => ({
  ...(await original<typeof import("@/services/connectors/linkedin-ads/own-accounts")>()),
  linkedinAccountInUse: async () => true,
}));
vi.mock("@/services/ads-wallet/bindings", async (original) => ({
  ...(await original<typeof import("@/services/ads-wallet/bindings")>()),
  findCampaignBinding: async () => null,
}));
vi.mock("@/services/tools/linkedin-ads/write/_flag-check", async (original) => ({
  ...(await original<typeof import("@/services/tools/linkedin-ads/write/_flag-check")>()),
  isLinkedInAdsWriteEnabled: async () => true,
}));
vi.mock("@/services/tools/linkedin-ads/_exec-action", async (original) => ({
  ...(await original<typeof import("@/services/tools/linkedin-ads/_exec-action")>()),
  resolveLinkedInAdsEmit: async () => m.emit,
}));

import { callLinkedinAdsTool } from "../linkedin-ads";

const ctx = { tenant_id: "00000000-0000-4000-8000-000000000001", run_id: "r1", run_trigger: "chat" };
const binding = "00000000-0000-4000-8000-0000000000aa";
const launchArgs = {
  campaign_binding_id: binding,
  total_budget_cents: 10000,
  end_time: Date.now() + 86_400_000,
};

beforeEach(() => {
  m.locked = new Set();
  m.lockReads = 0;
  for (const f of [m.db, m.summary, m.getCampaign, m.emit]) f.mockReset();
});

it.each([
  ["bound_campaigns", {}],
  ["launch_review", { campaign_binding_id: binding }],
  ["propose_launch_campaign", launchArgs],
])("a Coming soon LinkedIn channel answers %s as coming soon before any read or card", async (tool, args) => {
  m.locked.add("linkedin_ads");
  const r = await callLinkedinAdsTool(ctx, tool, args);
  expect(r.ok).toBe(false);
  expect(JSON.parse(r.content)).toEqual({ error: "coming_soon", message: "LinkedIn Ads is coming soon." });
  expect(m.db).not.toHaveBeenCalled();
  expect(m.summary).not.toHaveBeenCalled();
  expect(m.emit).not.toHaveBeenCalled();
});

it("a Coming soon LinkedIn channel still lets a pause proposal read the campaign", async () => {
  m.locked.add("linkedin_ads");
  await expect(
    callLinkedinAdsTool(ctx, "propose_pause_campaign", { campaign_id: "123", account_id: "42", rationale: "spend with no clicks" }),
  ).rejects.toThrow("LinkedIn read");
  expect(m.getCampaign).toHaveBeenCalledTimes(1);
  expect(m.lockReads).toBe(0);
});

it("a lock on another channel leaves the LinkedIn launch tools reading as before", async () => {
  m.locked.add("reddit_ads");
  await expect(callLinkedinAdsTool(ctx, "launch_review", { campaign_binding_id: binding })).rejects.toThrow("LinkedIn read");
  expect(m.summary).toHaveBeenCalledTimes(1);
});
