import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  upsert: vi.fn(),
  post: vi.fn(),
  status: "ACTIVE",
  stop: null as string | null,
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      upsert: m.upsert,
      update: (v: { stop_requested_at?: string }) => {
        let expected: unknown = undefined;
        const q = {
          eq: (col: string, value: unknown) => {
            if (col === "stop_requested_at") expected = value;
            return q;
          },
          select: () => q,
          then: (resolve: any) => {
            if (expected !== undefined && expected !== m.stop)
              return Promise.resolve({ data: [], error: null }).then(resolve);
            if (v.stop_requested_at) m.stop = v.stop_requested_at;
            return Promise.resolve({ data: [{}], error: null }).then(resolve);
          },
        };
        return q;
      },
    }),
  }),
}));
vi.mock("../bindings", () => ({
  getCampaignBinding: async () => ({
    platform: "linkedin",
    provider_campaign_id: "123",
    account_binding_id: "a",
  }),
  getAccountBinding: async () => ({ id: "a" }),
}));
vi.mock("../adapters/linkedin-account", () => ({
  resolveLinkedinAccount: async () => ({
    token: "fixture",
    account: { id: "42", currency: "USD" },
  }),
}));
vi.mock("../wallet", () => ({ readWallet: vi.fn() }));
vi.mock("@/services/decisions/ad-budget", () => ({
  adBudgetIdemKey: vi.fn(),
  commitAdSpend: vi.fn(),
  committedAdHoldIds: vi.fn(async () => []),
  releaseAdSpendHolds: vi.fn(),
}));
vi.mock("@/services/connectors/linkedin-ads/http", () => ({
  linkedinAdsPost: m.post,
  linkedinAdsGet: async () => ({
    id: 123,
    account: "urn:li:sponsoredAccount:42",
    name: "Campaign",
    status: m.status,
    campaignGroup: "urn:li:sponsoredCampaignGroup:7",
    runSchedule: { start: 1 },
    changeAuditStamps: { created: { time: 1 }, lastModified: { time: 1 } },
  }),
}));
import { pauseLinkedinBoundCampaign } from "../adapters/linkedin";
beforeEach(() => {
  vi.clearAllMocks();
  m.status = "ACTIVE";
  m.stop = null;
  m.upsert.mockImplementation(async (rows: Array<{ stop_requested_at: string }>) => {
    m.stop = rows[0].stop_requested_at;
    return { error: null };
  });
  m.post.mockImplementation(async () => {
    m.status = "PAUSED";
    return {};
  });
});
it("records tenant-scoped stop intent through the real facade before a verified provider pause", async () => {
  await pauseLinkedinBoundCampaign("tenant-a", "bound");
  expect(m.upsert).toHaveBeenCalledWith(
    [
      expect.objectContaining({
        tenant_id: "tenant-a",
        campaign_binding_id: "bound",
      }),
    ],
    { onConflict: "tenant_id,campaign_binding_id" },
  );
  expect(m.post).toHaveBeenCalledTimes(1);
  expect(m.upsert.mock.invocationCallOrder[0]).toBeLessThan(
    m.post.mock.invocationCallOrder[0],
  );
  expect(m.status).toBe("PAUSED");
});
it("does not send an unrecorded pause when stop-intent storage fails", async () => {
  m.upsert.mockReset();
  m.upsert.mockResolvedValue({ error: { message: "offline" } });
  await expect(pauseLinkedinBoundCampaign("tenant-a", "bound")).rejects.toThrow(
    "record the pause",
  );
  expect(m.post).not.toHaveBeenCalled();
});
