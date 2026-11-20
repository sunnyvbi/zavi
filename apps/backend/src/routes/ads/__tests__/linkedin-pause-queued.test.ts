import { beforeEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const m = vi.hoisted(() => ({
  post: vi.fn(),
  status: "ACTIVE",
  upsertError: null as unknown,
  writes: [] as Array<{ op: string; value: unknown }>,
}));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ tenant_id: "tenant-a", user_id: "user-a" }),
}));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: async () => true }));
vi.mock("@/services/ads-wallet/providers", () => ({ refillEligibility: async () => "allowed" }));
vi.mock("@/services/ads-wallet/linkedin-launch", () => ({ linkedinLaunchSummary: vi.fn(), launchLinkedinCampaign: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/ads-wallet/bindings", () => ({
  getCampaignBinding: async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    platform: "linkedin",
    provider_campaign_id: "123",
    account_binding_id: "a",
    funding_source: "wallet",
  }),
  getAccountBinding: async () => ({ id: "a" }),
}));
vi.mock("@/services/ads-wallet/adapters/linkedin-account", () => ({
  resolveLinkedinAccount: async () => ({ token: "fixture", account: { id: "42", currency: "USD" } }),
}));
vi.mock("@/services/ads-wallet/wallet", () => ({ readWallet: vi.fn() }));
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
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: vi.fn(),
  tenantClient: () => ({
    from: () => {
      const q: any = {
        select: () => q,
        eq: () => q,
        upsert: (value: unknown) => {
          m.writes.push({ op: "upsert", value });
          return Promise.resolve({ error: m.upsertError });
        },
        update: (value: unknown) => {
          m.writes.push({ op: "update", value });
          return q;
        },
        then: (resolve: any) => Promise.resolve({ data: [{ campaign_binding_id: "x" }], error: null }).then(resolve),
      };
      return q;
    },
  }),
}));
import { adsCampaignPause } from "../campaigns";
import { ExpectedToolError } from "@/services/tools/types";

const BINDING = "11111111-1111-4111-8111-111111111111";
const QUEUED = "Zavi saved your pause request and will keep retrying it. Check back in a few minutes.";
const GENERIC = "The request could not be completed. Refresh before trying again.";

async function pause() {
  const out: { status?: number; body?: any } = {};
  const res = {
    status(code: number) { out.status = code; return res; },
    json(body: unknown) { out.body = body; return res; },
  } as unknown as Response;
  await adsCampaignPause({ params: { bindingId: BINDING }, body: {} } as unknown as Request, res);
  return out;
}
const savedStop = () =>
  m.writes.some((w) => w.op === "upsert" && (w.value as any).stop_requested_at && (w.value as any).campaign_binding_id === BINDING);

beforeEach(() => {
  vi.clearAllMocks();
  m.status = "ACTIVE";
  m.upsertError = null;
  m.writes = [];
  m.post.mockImplementation(async () => { m.status = "PAUSED"; return {}; });
});

it("tells the founder a saved pause is being retried when LinkedIn answers 5xx", async () => {
  m.post.mockRejectedValue(new ExpectedToolError("linkedin_ads_http_error", "LinkedIn Ads is unavailable right now.", { status: 503 }));
  const out = await pause();
  expect(savedStop()).toBe(true);
  expect(out.body.error).toEqual({ code: "ads_pause_queued", message: QUEUED });
  expect(out.status).toBe(503);
  expect(m.writes.some((w) => w.op === "update" && (w.value as any).stop_confirmed_at)).toBe(false);
});

it("tells the founder a saved pause is being retried when LinkedIn cannot confirm it", async () => {
  m.post.mockResolvedValue({});
  const out = await pause();
  expect(savedStop()).toBe(true);
  expect(out.body.error.message).toBe(QUEUED);
  expect(out.body.error.message).not.toBe(GENERIC);
});

it("keeps the generic copy when the stop request itself could not be saved", async () => {
  m.upsertError = { message: "offline" };
  const out = await pause();
  expect(m.post).not.toHaveBeenCalled();
  expect(out.body.error.message).toBe(GENERIC);
  expect(out.body.error.code).not.toBe("ads_pause_queued");
});

it("keeps the reconnect instruction when LinkedIn revoked the token", async () => {
  m.post.mockRejectedValue(new ExpectedToolError("linkedin_ads_token_revoked", "Reconnect LinkedIn Ads in Settings."));
  const out = await pause();
  expect(out.status).toBe(403);
  expect(out.body.error).toEqual({ code: "linkedin_ads_token_revoked", message: "Zavi could not pause this campaign, so it keeps running on LinkedIn and can keep spending. Reconnect LinkedIn Ads in Settings." });
});

it("reports a confirmed pause as paused", async () => {
  const out = await pause();
  expect(out.body).toEqual({ status: "paused" });
});

it("tells the founder a saved pause is being retried when LinkedIn rate-limits the pause write", async () => {
  m.post.mockRejectedValue(new ExpectedToolError("linkedin_ads_write_refused", "LinkedIn Ads is busy right now. Try again in a few minutes.", { status: 429, http_status: 429 }));
  const out = await pause();
  expect(savedStop()).toBe(true);
  expect(out.body.error).toEqual({ code: "ads_pause_queued", message: QUEUED });
  expect(out.status).toBe(503);
});

it("keeps a permanent LinkedIn refusal of the pause as a refusal", async () => {
  m.post.mockRejectedValue(new ExpectedToolError("linkedin_ads_write_refused", "LinkedIn did not accept this change.", { status: 400, http_status: 400 }));
  const out = await pause();
  expect(out.body.error.code).toBe("linkedin_ads_write_refused");
});

it("a view-only founder pressing Pause is told the campaign keeps running, and the 403 stays a 403", async () => {
  m.post.mockRejectedValue(new ExpectedToolError("linkedin_ads_forbidden", "LinkedIn did not let Zavi make changes in this ad account."));
  const out = await pause();
  expect(out.status).toBe(403);
  expect(out.body.error.code).toBe("linkedin_ads_forbidden");
  expect(out.body.error.message).toBe("Zavi could not pause this campaign, so it keeps running on LinkedIn and can keep spending. LinkedIn did not let Zavi make changes in this ad account.");
});
