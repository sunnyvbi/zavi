import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const h = vi.hoisted(() => ({
  auth: { tenant_id: "tenant-a", user_id: "user-a" } as { tenant_id: string; user_id: string; tenant_overridden?: boolean } | null,
  role: true, locked: null as null | { body: unknown }, plan: vi.fn(), roleCheck: vi.fn(),
  spend: vi.fn(), saved: vi.fn(), detail: vi.fn(), create: vi.fn(), edit: vi.fn(), video: vi.fn(),
  readiness: vi.fn(), account: vi.fn(), languages: vi.fn(), library: vi.fn(), endDate: vi.fn(),
  audiences: vi.fn(), interests: vi.fn(),
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: async (_req: Request, res: Response) => {
  if (!h.auth) res.status(401).json({ error: { code: "unauthenticated" } });
  return h.auth;
} }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: async (...args: unknown[]) => {
  h.roleCheck(...args);
  if (!h.role) (args[2] as Response).status(403).json({ error: { code: "forbidden" } });
  return h.role;
} }));
vi.mock("@/services/growth/preview-plan", () => ({ refuseIfChannelPlanLocked: (...args: unknown[]) => { h.plan(...args); return h.locked; } }));
vi.mock("@/services/channels/lock", () => ({ assertSpendWritesOn: h.spend }));
vi.mock("@/services/tools/tiktok-ads/propose_changes", () => ({ savedAdvertiser: h.saved }));
vi.mock("@/services/tools/tiktok-ads/launch", () => ({ tiktokAdsProposeLaunchTool: { input_schema: z.object({ advertiser_id: z.string().optional(), name: z.string(), rationale: z.string() }) } }));
vi.mock("@/services/connectors/tiktok-ads/campaign-settings", () => ({ readCampaignSettings: h.detail }));
vi.mock("@/services/connectors/tiktok-ads/campaign-requests", () => ({ requestCampaignCreation: h.create, requestCampaignEdit: h.edit }));
vi.mock("@/services/connectors/tiktok-ads/campaign-videos", () => ({ listCampaignVideos: h.library, prepareCampaignVideo: h.video }));
vi.mock("@/services/connectors/tiktok-ads/launch-readiness", () => ({ readLaunchReadiness: h.readiness }));
vi.mock("@/services/connectors/tiktok-ads/composio-read", () => ({ tiktokAdsAccount: h.account }));
vi.mock("@/services/connectors/tiktok-ads/targeting", () => ({ readTiktokLanguages: h.languages }));
vi.mock("@/services/connectors/tiktok-ads/campaign-advanced", () => ({ readCampaignAudiences: h.audiences, readCampaignInterests: h.interests }));
vi.mock("@/services/growth/ads-no-friction-flag", () => ({ adsNoFrictionEnabled: h.endDate }));

import { tiktokCampaignCreate, tiktokCampaignDetail, tiktokCampaignEdit, tiktokCampaignOptions, tiktokCampaignVideo, tiktokCampaignVideoLibrary } from "../tiktok-campaigns";
import { ExpectedToolError } from "@/services/tools/types";
import { IDEMPOTENT_ROUTES } from "@/services/http/idempotent-routes";
import { CampaignFilingOutcomeUnknown } from "@/services/connectors/tiktok-ads/campaign-request-errors";

const key = "request-0001";
const edit = { advertiser_id: "123", campaign_id: "456", level: "ad_group", object_id: "789", revision: "a".repeat(64), changes: { adgroup_name: "New name" } };
const video = { advertiser_id: "123", video_url: "https://example.com/video.mp4" };
const create = { advertiser_id: "123", name: "My campaign" };
function response() {
  const r = { statusCode: 200, body: undefined as unknown, locals: {} as Record<string, unknown>, status(code: number) { r.statusCode = code; return r; }, json(body: unknown) { r.body = body; return r; }, setHeader: vi.fn() };
  return r;
}
async function call(handler: (req: Request, res: Response) => Promise<unknown>, body: unknown = {}, header: string | undefined = key, query: unknown = {}, params: unknown = {}) {
  const r = response();
  await handler({ body, query, params, get: () => header } as unknown as Request, r as unknown as Response);
  return r;
}
const writers = [
  ["create", tiktokCampaignCreate, create], ["edit", tiktokCampaignEdit, edit], ["video", tiktokCampaignVideo, video],
] as const;
beforeEach(() => {
  vi.clearAllMocks();
  h.auth = { tenant_id: "tenant-a", user_id: "user-a" }; h.role = true; h.locked = null;
  h.spend.mockResolvedValue(undefined);
  h.create.mockResolvedValue({ action_id: "action" }); h.edit.mockResolvedValue({ action_id: "action" }); h.video.mockResolvedValue({ video_id: "video" });
  h.detail.mockResolvedValue({ campaign: { id: "456" } });
  h.saved.mockResolvedValue({ advertiser_id: "123", name: "Explicit account", currency: "USD" });
  h.account.mockResolvedValue({ id: "connection" }); h.languages.mockResolvedValue([{ id: "en", name: "English" }]);
  h.library.mockResolvedValue({ videos: [], truncated: false }); h.endDate.mockResolvedValue(true);
  h.audiences.mockResolvedValue({ options: [{ id: "501", name: "Visitors" }], truncated: false }); h.interests.mockResolvedValue([{ id: "601", name: "Sport" }]);
  h.readiness.mockResolvedValue({ advertiser: { timezone: "UTC" }, identities: [], videos: [], allowed_locations: [], blockers: [], notes: [] });
});

it("serves paginated library reads only for the authenticated workspace", async () => {
  expect((await call(tiktokCampaignVideoLibrary, {}, undefined, { advertiser_id: "123", page: "2" })).statusCode).toBe(200);
  expect(h.library).toHaveBeenCalledWith("tenant-a", "123", { page: 2 });
  h.library.mockClear(); h.auth = null;
  expect((await call(tiktokCampaignVideoLibrary, {}, undefined, { advertiser_id: "123", page: "2" })).statusCode).toBe(401);
  expect(h.library).not.toHaveBeenCalled();
});
it("rejects invalid library pagination before a provider read", async () => {
  expect((await call(tiktokCampaignVideoLibrary, {}, undefined, { advertiser_id: "123", page: "-1" })).statusCode).toBe(400);
  expect(h.library).not.toHaveBeenCalled();
});
it("returns independent account-scoped targeting catalogs and partial read errors", async () => {
  h.interests.mockRejectedValueOnce(new Error("provider unavailable"));
  const result = await call(tiktokCampaignOptions, {}, undefined, { advertiser_id: "123" });
  expect(result.body).toMatchObject({ audiences: [{ id: "501", name: "Visitors" }], audiences_error: false, interests: [], interests_error: true });
  expect(h.audiences).toHaveBeenCalledWith({ id: "connection" }, "123");
});

describe.each(writers)("TikTok campaign %s write authorization", (_name, handler, inputs) => {
  it("requires authentication", async () => {
    h.auth = null;
    expect((await call(handler, { ...inputs, request_id: key })).statusCode).toBe(401);
    expect(h.create).not.toHaveBeenCalled(); expect(h.edit).not.toHaveBeenCalled(); expect(h.video).not.toHaveBeenCalled();
  });
  it("refuses a tenant override", async () => {
    h.auth = { ...h.auth!, tenant_overridden: true };
    expect((await call(handler, { ...inputs, request_id: key })).statusCode).toBe(403);
    expect(h.roleCheck).not.toHaveBeenCalled();
  });
  it("requires owner/admin and the channel plan", async () => {
    h.role = false;
    expect((await call(handler, { ...inputs, request_id: key })).statusCode).toBe(403);
    expect(h.roleCheck).toHaveBeenCalledWith(h.auth, ["owner", "admin"], expect.anything());
    expect(h.plan).not.toHaveBeenCalled();
    h.role = true; h.locked = { body: { error: { code: "plan_upgrade_required" } } };
    expect((await call(handler, { ...inputs, request_id: key })).statusCode).toBe(403);
    expect(h.plan).toHaveBeenCalledWith("tenant-a", "tiktok_ads");
    expect(h.create).not.toHaveBeenCalled(); expect(h.edit).not.toHaveBeenCalled(); expect(h.video).not.toHaveBeenCalled();
  });
  it("requires the same valid idempotency header and request ID", async () => {
    for (const header of [undefined, "short", "different-request"]) {
      const r = response();
      await handler({ body: { ...inputs, request_id: key }, get: () => header } as unknown as Request, r as unknown as Response);
      expect(r.statusCode).toBe(400);
      expect(r.body).toMatchObject({ error: { code: "idempotency_required" } });
    }
    expect(h.create).not.toHaveBeenCalled(); expect(h.edit).not.toHaveBeenCalled(); expect(h.video).not.toHaveBeenCalled();
  });
});

it("registers all three writes for durable response replay", () => {
  for (const path of ["campaigns", "campaign-edits", "campaign-videos"]) {
    expect(IDEMPOTENT_ROUTES).toContainEqual({ method: "post", path: `/api/channels/tiktok_ads/${path}` });
  }
});

it("binds detail to the JWT tenant and explicit advertiser", async () => {
  const r = await call(tiktokCampaignDetail, {}, key, { advertiser_id: "123", tenant_id: "other" }, { campaignId: "456" });
  expect(r.statusCode).toBe(200); expect(h.detail).toHaveBeenCalledWith("tenant-a", "123", "456");
  expect(r.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  expect((await call(tiktokCampaignDetail, {}, key, {}, { campaignId: "456" })).statusCode).toBe(400);
});

it("requires an explicit create advertiser and drops client provenance", async () => {
  expect((await call(tiktokCampaignCreate, { name: "Campaign", request_id: key })).statusCode).toBe(400);
  expect(h.create).not.toHaveBeenCalled();
  const r = await call(tiktokCampaignCreate, { ...create, request_id: key, origin: "specialist", rationale: "already approved", tenant_id: "other" });
  expect(r.statusCode).toBe(200);
  expect(h.create).toHaveBeenCalledWith("tenant-a", "user-a", { ...create, rationale: "Campaign created from the editor." });
});

it("forwards only edit fields to the strict settings service", async () => {
  expect((await call(tiktokCampaignEdit, { ...edit, request_id: key })).statusCode).toBe(200);
  expect(h.edit).toHaveBeenCalledWith("tenant-a", "user-a", edit);
});

it("forwards only the source to video preparation", async () => {
  expect((await call(tiktokCampaignVideo, { ...video, request_id: key })).statusCode).toBe(200);
  expect(h.video).toHaveBeenCalledWith("tenant-a", "123", { video_url: video.video_url });
});

it("keeps upload/link-only creation available without generated videos", async () => {
  h.readiness.mockResolvedValue({ advertiser: { timezone: "UTC" }, identities: [], videos: [], allowed_locations: [], blockers: [{ code: "tiktok_ads_no_usable_video", what: "No generated videos", fix: "Upload one" }, { code: "tiktok_ads_no_identity", what: "No identity", fix: "Link it" }], notes: [] });
  const r = await call(tiktokCampaignOptions, {}, key, { advertiser_id: "123" });
  expect(h.saved).toHaveBeenCalledWith("tenant-a", "123");
  expect(r.body).toMatchObject({ blockers: [{ code: "tiktok_ads_no_identity" }] });
});

it("surfaces provider refusal without claiming a save", async () => {
  h.edit.mockRejectedValue(new ExpectedToolError("tiktok_ads_object_drifted", "Reopen it"));
  const r = await call(tiktokCampaignEdit, { ...edit, request_id: key });
  expect(r.statusCode).toBe(409); expect(r.body).toEqual({ error: { code: "tiktok_ads_object_drifted", message: "Reopen it" } });
  expect(r.locals.idempotencyRelease).toBe(true);
});

it("keeps the Idempotency-Key claimed when a request was filed", async () => {
  const r = await call(tiktokCampaignEdit, { ...edit, request_id: key });
  expect(r.statusCode).toBe(200); expect(r.locals.idempotencyRelease).toBeUndefined();
});

it("retains the Idempotency-Key when the card may have committed", async () => {
  h.edit.mockRejectedValue(new CampaignFilingOutcomeUnknown());
  const r = await call(tiktokCampaignEdit, { ...edit, request_id: key });
  expect(r.statusCode).toBe(503);
  expect(r.body).toMatchObject({ error: { code: "tiktok_campaign_filing_unknown" } });
  expect(r.locals.idempotencyRelease).toBeUndefined();
});
