import { beforeEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const m = vi.hoisted(() => ({ auth: vi.fn(), role: vi.fn(), tier: vi.fn(), locked: vi.fn(), disable: vi.fn(), read: vi.fn(), fund: vi.fn(), update: vi.fn(), ad: vi.fn(), group: vi.fn(), safety: vi.fn(), cards: vi.fn(), setup: vi.fn(), complete: vi.fn(), select: vi.fn(), pay: vi.fn(), status: vi.fn(), get: vi.fn(), preview: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.auth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: m.role }));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: m.tier }));
vi.mock("@/services/channels/lock", () => ({ isChannelLocked: m.locked, isChannelLockedStrict: m.locked }));
vi.mock("@/services/connectors/chatgpt-ads/http", () => ({ chatgptAdsGet: m.get }));
vi.mock("@/services/ads-wallet/chatgpt-account-preview", () => ({ previewChatgptAccount: m.preview }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/connectors/chatgpt-ads/workspace", async original => ({ ...await original<typeof import("@/services/connectors/chatgpt-ads/workspace")>(), updateCampaign: m.update, updateAdStatus: m.ad, updateGroupStatus: m.group, readCampaignSafety: m.safety }));
vi.mock("@/services/ads-wallet/wallet", () => ({ disableRefill: m.disable, readWallet: m.read, startFunding: m.fund, listCards: m.cards, createSetup: m.setup, completeSetup: m.complete, selectCard: m.select, payWithCard: m.pay, orderStatus: m.status, CREATOR_CONSENT_VERSION: "v1" }));
import { chatgptCardPay, chatgptCards, chatgptCardSelect, chatgptCardSetup, chatgptCardSetupComplete, chatgptDisableRefill, chatgptFund, chatgptOrderStatus, chatgptWallet } from "../chatgpt-ads-wallet";
import { adsAuth, chatgptUpdateCampaign, chatgptUpdateAd, chatgptUpdateGroup, chatgptSafety, chatgptLocations } from "../chatgpt-ads";
const req = {} as Request;
const response = () => { const r = { status: vi.fn(), json: vi.fn() }; r.status.mockReturnValue(r); return r; };
beforeEach(() => { vi.resetAllMocks(); m.auth.mockResolvedValue({ tenant_id: "t1", user_id: "u1" }); m.role.mockResolvedValue(true); m.tier.mockResolvedValue({ allowed: true, enforced: true }); m.locked.mockResolvedValue(false); });
it("requires owner/admin for mutations", async () => {
  m.role.mockResolvedValue(false); const res = response();
  expect(await adsAuth(req, res as unknown as Response, true)).toBeNull();
  expect(m.role).toHaveBeenCalledWith({ tenant_id: "t1", user_id: "u1" }, ["owner", "admin"], res);
  expect(m.tier).not.toHaveBeenCalled();
});
it("refuses staff tenant impersonation writes", async () => {
  m.auth.mockResolvedValue({ tenant_id: "t1", user_id: "u1", tenant_overridden: true }); const res = response();
  expect(await adsAuth(req, res as unknown as Response, true)).toBeNull(); expect(res.status).toHaveBeenCalledWith(403);
});
it("respects the channel kill switch", async () => {
  m.locked.mockResolvedValue(true); const res = response();
  expect(await adsAuth(req, res as unknown as Response, true)).toBeNull(); expect(res.status).toHaveBeenCalledWith(403);
});
it("returns a closed, recoverable error if role storage fails", async () => {
  m.role.mockRejectedValue(new Error("db failure")); const res = response();
  expect(await adsAuth(req, res as unknown as Response, true)).toBeNull(); expect(res.status).toHaveBeenCalledWith(503);
});

it.each(["downgrade", "lock"])("allows mandate revocation after %s while funding stays blocked", async reason => {
  if (reason === "downgrade") m.tier.mockResolvedValue({ allowed: false }); else m.locked.mockResolvedValue(true);
  const res = response();
  await chatgptDisableRefill(req, res as unknown as Response);
  expect(m.disable).toHaveBeenCalledWith("t1"); expect(res.json).toHaveBeenCalledWith({ ok: true });
  await chatgptFund(req, res as unknown as Response);
  expect(m.fund).not.toHaveBeenCalled(); expect(res.status).toHaveBeenCalledWith(403);
});
it("still rejects a member or staff override disabling another tenant's mandate", async () => {
  m.role.mockResolvedValue(false);
  await chatgptDisableRefill(req, response() as unknown as Response);
  m.role.mockResolvedValue(true); m.auth.mockResolvedValue({ tenant_id: "other", tenant_overridden: true });
  await chatgptDisableRefill(req, response() as unknown as Response);
  expect(m.disable).not.toHaveBeenCalled();
});
it("returns balance with funding unavailable after downgrade", async () => {
  m.read.mockResolvedValue({ balance_cents: 5000, funding_enabled: true, auto_refill_enabled: true });
  m.tier.mockResolvedValue({ allowed: false }); const res = response();
  await chatgptWallet(req, res as unknown as Response);
  expect(res.json).toHaveBeenCalledWith({ balance_cents: 5000, funding_enabled: false, auto_refill_enabled: true });
});

it.each(["downgrade", "lock"])("keeps campaign, group, and ad pauses available after %s", async reason => {
  if (reason === "downgrade") m.tier.mockResolvedValue({ allowed: false }); else m.locked.mockResolvedValue(true);
  const r = { body: { status: "paused" }, params: { campaignId: "c1", groupId: "g1", adId: "a1" } } as unknown as Request;
  await chatgptUpdateCampaign(r, response() as unknown as Response);
  await chatgptUpdateGroup(r, response() as unknown as Response);
  r.body.ad_group_id = "g1";
  await chatgptUpdateAd(r, response() as unknown as Response);
  expect(m.update).toHaveBeenCalledWith("t1", "c1", { status: "paused" });
  expect(m.group).toHaveBeenCalledWith("t1", "c1", "g1", "paused", undefined);
  expect(m.ad).toHaveBeenCalledWith("t1", "c1", "g1", "a1", "paused", undefined);
  await chatgptSafety(r, response() as unknown as Response);
  expect(m.safety).toHaveBeenCalledWith("t1");
});
it.each([{ status: "active" }, { status: "paused", name: "edit" }, { status: "paused", lifetime_budget_micros: 200000000 }])("blocks other campaign changes while locked: %j", async body => {
  m.locked.mockResolvedValue(true); const res = response();
  await chatgptUpdateCampaign({ body, params: { campaignId: "c1" } } as unknown as Request, res as unknown as Response);
  expect(res.status).toHaveBeenCalledWith(403); expect(m.update).not.toHaveBeenCalled();
});
it("pause bypass still rejects members and staff impersonation", async () => {
  const r = { body: { status: "paused" }, params: { campaignId: "c1" } } as unknown as Request;
  m.role.mockResolvedValue(false);
  await chatgptUpdateCampaign(r, response() as unknown as Response);
  m.role.mockResolvedValue(true); m.auth.mockResolvedValue({ tenant_id: "t1", tenant_overridden: true });
  await chatgptUpdateCampaign(r, response() as unknown as Response);
  expect(m.update).not.toHaveBeenCalled();
});

it("passes the confirmed campaign version through on child activation", async () => {
  const r = { body: { status: "active", expected_campaign_updated_at: 10 }, params: { campaignId: "c1", groupId: "g1", adId: "a1" } } as unknown as Request;
  await chatgptUpdateGroup(r, response() as unknown as Response);
  r.body.ad_group_id = "g1";
  await chatgptUpdateAd(r, response() as unknown as Response);
  expect(m.group).toHaveBeenCalledWith("t1", "c1", "g1", "active", 10);
  expect(m.ad).toHaveBeenCalledWith("t1", "c1", "g1", "a1", "active", 10);
});
it.each([
  [{ enable_refill: true }, true],
  [{ enable_refill: false }, false],
  [{}, true],
])("passes the save-card refill choice %j to setup; only an explicit false opts out", async (extra, expected) => {
  const res = response();
  await chatgptFund({ body: { amount_cents: 10000, mode: "setup", consent: true, request_id: "11111111-1111-4111-8111-111111111111", ...extra } } as unknown as Request, res as unknown as Response);
  expect(m.fund).toHaveBeenCalledWith("t1", "u1", 10000, "setup", "11111111-1111-4111-8111-111111111111", expected);
});
it("a top-up never turns refill on", async () => {
  const res = response();
  await chatgptFund({ body: { amount_cents: 10000, mode: "topup", request_id: "11111111-1111-4111-8111-111111111111" } } as unknown as Request, res as unknown as Response);
  expect(m.fund).toHaveBeenCalledWith("t1", "u1", 10000, "topup", "11111111-1111-4111-8111-111111111111", false);
});
it("rejects a non-boolean refill choice", async () => {
  const res = response();
  await chatgptFund({ body: { amount_cents: 10000, mode: "setup", consent: true, request_id: "11111111-1111-4111-8111-111111111111", enable_refill: "yes" } } as unknown as Request, res as unknown as Response);
  expect(m.fund).not.toHaveBeenCalled(); expect(res.status).toHaveBeenCalledWith(400);
});

it.each([
  ["cards", chatgptCards], ["setup", chatgptCardSetup], ["complete", chatgptCardSetupComplete], ["select", chatgptCardSelect], ["pay", chatgptCardPay], ["order", chatgptOrderStatus],
] as const)("saved-card route %s is owner/admin only", async (_name, handler) => {
  m.role.mockResolvedValue(false);
  await handler({ body: {}, params: {} } as unknown as Request, response() as unknown as Response);
  expect(m.role).toHaveBeenCalledWith(expect.anything(), ["owner", "admin"], expect.anything());
  for (const fn of [m.cards, m.setup, m.complete, m.select, m.pay, m.status]) expect(fn).not.toHaveBeenCalled();
});
it("rejects a card save signed against an outdated consent text", async () => {
  const res = response();
  await chatgptCardSetup({ body: { request_id: "00000000-0000-4000-8000-000000000001", amount_cents: 5000, enable_refill: false, allow_creators: false, consent: true, consent_version: "old" } } as unknown as Request, res as unknown as Response);
  expect(res.status).toHaveBeenCalledWith(409); expect(m.setup).not.toHaveBeenCalled();
});
it("rejects a refill amount outside $50-$1,000 on card choice", async () => {
  const res = response();
  await chatgptCardSelect({ body: { payment_method_id: "pm_1", amount_cents: 200000, enable_refill: true, allow_creators: false, consent: true, consent_version: "v1" } } as unknown as Request, res as unknown as Response);
  expect(res.status).toHaveBeenCalledWith(400); expect(m.select).not.toHaveBeenCalled();
});
it("passes the shown card to pay", async () => {
  m.pay.mockResolvedValue({ order_id: "o1", status: "pending" }); const res = response();
  await chatgptCardPay({ body: { request_id: "00000000-0000-4000-8000-000000000002", amount_cents: 10000, payment_method_id: "pm_1" } } as unknown as Request, res as unknown as Response);
  expect(m.pay).toHaveBeenCalledWith("t1", 10000, "00000000-0000-4000-8000-000000000002", "pm_1");
  expect(res.json).toHaveBeenCalledWith({ order_id: "o1", status: "pending" });
});

it("preserves geographic type and region metadata without merging different provider IDs", async () => {
  m.preview.mockResolvedValue({ key: "account-key" });
  m.get.mockResolvedValue({ results: [
    { id: "2000075", canonical_name: "New York, United States", type: "region", country_code: "US", region_code: "US-NY", parent_country: "United States", parent_id: "country-us", private_field: "drop" },
    { id: "3000001", canonical_name: "New York, United States", type: "market", country_code: "US", parent_country: "United States" },
    { id: "9331802", canonical_name: "NE27, New York, ENG, United Kingdom", type: "postal_code", country_code: "GB", region_code: "NE27", parent_country: "United Kingdom" },
    { id: "2000075", canonical_name: "Duplicate entry", type: "region" },
    { id: "old", canonical_name: "Older result", type: null, country_code: 1 },
    null, { id: "bad" },
  ] });
  const res = response();
  await chatgptLocations({ query: { q: "New York" } } as unknown as Request, res as unknown as Response);
  expect(m.preview).toHaveBeenCalledWith("t1");
  expect(m.get).toHaveBeenCalledWith("account-key", "/geo_lookup/search", { q: "New York", limit: 20 });
  expect(res.json).toHaveBeenCalledWith({ locations: [
    { id: "2000075", name: "New York, United States", type: "region", country_code: "US", region_code: "US-NY", parent_country: "United States" },
    { id: "3000001", name: "New York, United States", type: "market", country_code: "US", parent_country: "United States" },
    { id: "9331802", name: "NE27, New York, ENG, United Kingdom", type: "postal_code", country_code: "GB", region_code: "NE27", parent_country: "United Kingdom" },
    { id: "old", name: "Older result" },
  ] });
});
