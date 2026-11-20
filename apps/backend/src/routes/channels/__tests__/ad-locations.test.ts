
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

let authResult: { tenant_id: string; user_id: string; access_token: string; tenant_overridden?: boolean } | null = null;
let roleAllowed = true;
const h = vi.hoisted(() => ({ status: vi.fn(), save: vi.fn(), search: vi.fn(), suggest: vi.fn(), tiktok: vi.fn(), xSearch: vi.fn(), xToken: vi.fn(), honest: vi.fn(async (_t: string, _k: string, _l: string, e: unknown) => e) }));
vi.mock("@/services/connectors/composio/account", () => ({ honestComposioToolError: h.honest }));
vi.mock("@/services/connectors/tiktok-ads/locations", () => ({ searchTiktokPlacesForTenant: h.tiktok }));
vi.mock("@/services/connectors/x-ads/client", () => ({ searchXLocations: h.xSearch, xAdsTenantToken: h.xToken }));
vi.mock("@/services/ad-locations/country", async (orig) => ({ ...(await orig<object>()), businessCountry: async () => ({ code: "US", name: "United States" }) }));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (authResult) return authResult;
    res.status(401).json({ error: { code: "unauthenticated", message: "no auth" } });
    return null;
  }),
}));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn(async (_a: unknown, _r: unknown, res: Response) => {
    if (roleAllowed) return true;
    res.status(403).json({ error: { code: "forbidden", message: "nope" } });
    return false;
  }),
}));
vi.mock("@/services/ad-locations/service", async (orig) => ({
  ...(await orig<typeof import("@/services/ad-locations/service")>()),
  locationStatus: h.status,
  saveLocations: h.save,
  searchPlaces: h.search,
  locationSuggestions: h.suggest,
}));

import { adLocationsSave, adLocationsSearch, adLocationsStatus, tiktokAdLocationsSearch, xAdLocationsSearch, xPickerPlaces } from "../ad-locations";
import { ExpectedToolError } from "@/services/tools/types";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const USER = "0335f3eb-8f08-4f72-91e1-6cd085503f13";
const FP = "a".repeat(64);
function res() {
  const r: { _status: number; _body: unknown; status: (n: number) => typeof r; json: (b: unknown) => typeof r } = {
    _status: 200,
    _body: undefined,
    status(n) {
      r._status = n;
      return r;
    },
    json(b) {
      r._body = b;
      return r;
    },
  };
  return r;
}
const req = (slug: string, body: unknown = {}, query: unknown = {}) => ({ params: { slug }, body, query }) as unknown as Request;

beforeEach(() => {
  authResult = { tenant_id: TENANT, user_id: USER, access_token: "t" };
  roleAllowed = true;
  for (const f of Object.values(h)) f.mockReset();
  h.status.mockResolvedValue({ state: "none" });
  h.save.mockResolvedValue({ ok: true, state: "places", decision_id: "d", approved: true, places: [] });
  h.search.mockResolvedValue([]);
});

describe("GET /api/channels/:slug/ad-locations", () => {
  it("reads the caller's own tenant", async () => {
    const r = res();
    await adLocationsStatus(req("google_ads"), r as never);
    expect(h.status).toHaveBeenCalledWith(TENANT, "google_ads");
    expect(r._status).toBe(200);
  });

  it("a channel with no ad locations is a 404, nothing read", async () => {
    const r = res();
    await adLocationsStatus(req("seo"), r as never);
    expect(r._status).toBe(404);
    expect(h.status).not.toHaveBeenCalled();
  });

  it("unauthenticated reaches nothing", async () => {
    authResult = null;
    const r = res();
    await adLocationsStatus(req("google_ads"), r as never);
    expect(r._status).toBe(401);
    expect(h.status).not.toHaveBeenCalled();
  });
});

describe("POST /api/channels/:slug/ad-locations", () => {
  const good = { campaign_id: "555", fingerprint: FP, places: [{ id: "1014221", name: "San Francisco, CA" }] };

  it("saves for the caller's tenant and user, ignoring any tenant in the body", async () => {
    const r = res();
    await adLocationsSave(req("google_ads", { ...good, tenant_id: "other", user_id: "someone" }), r as never);
    expect(h.save).toHaveBeenCalledWith(TENANT, USER, "google_ads", { campaign_id: "555", fingerprint: FP, places: good.places });
    expect(r._status).toBe(200);
  });

  it("owner/admin only", async () => {
    roleAllowed = false;
    const r = res();
    await adLocationsSave(req("google_ads", good), r as never);
    expect(r._status).toBe(403);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("refuses a staff tenant override", async () => {
    authResult = { ...authResult!, tenant_overridden: true };
    const r = res();
    await adLocationsSave(req("google_ads", good), r as never);
    expect(r._status).toBe(403);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("a body without the card's fingerprint, or with more than 50 places, reaches nothing", async () => {
    for (const body of [{ ...good, fingerprint: undefined }, { ...good, places: Array.from({ length: 51 }, (_, i) => ({ id: String(i) })) }]) {
      const r = res();
      await adLocationsSave(req("google_ads", body), r as never);
      expect(r._status).toBe(400);
    }
    expect(h.save).not.toHaveBeenCalled();
  });

  it("a stale card is a 409 with the founder's sentence", async () => {
    h.save.mockRejectedValue(new ExpectedToolError("ad_locations_campaign_changed", "Where this campaign shows changed since you opened it."));
    const r = res();
    await adLocationsSave(req("google_ads", good), r as never);
    expect(r._status).toBe(409);
    expect(r._body).toMatchObject({ error: { code: "ad_locations_campaign_changed" } });
  });
});

describe("GET /api/channels/tiktok_ads/ad-locations/search", () => {
  it("carries the editor's advertiser instead of silently using the selected account", async () => {
    h.tiktok.mockResolvedValue([]);
    await tiktokAdLocationsSearch(req("tiktok_ads", {}, { q: "Austin", advertiser_id: "222" }), res() as never);
    expect(h.tiktok).toHaveBeenCalledWith(TENANT, "Austin", "US", "222");
  });
  it("rejects a malformed advertiser before a provider lookup", async () => {
    const r = res();
    await tiktokAdLocationsSearch(req("tiktok_ads", {}, { q: "Austin", advertiser_id: "not-an-id" }), r as never);
    expect(r._status).toBe(400);
    expect(h.tiktok).not.toHaveBeenCalled();
  });
  it("searches the tenant's own TikTok ad account in the business's country and answers picker places", async () => {
    h.tiktok.mockResolvedValue([{ location_id: "4671654", name: "Austin, Texas, United States", level: "CITY", country_code: "US", kind: "City" }]);
    const r = res();
    await tiktokAdLocationsSearch(req("tiktok_ads", {}, { q: "Austin" }), r as never);
    expect(h.tiktok).toHaveBeenCalledWith(TENANT, "Austin", "US");
    expect(r._body).toEqual({ places: [{ id: "4671654", name: "Austin, Texas, United States", kind: "City" }] });
  });
  it("the generic route still has no TikTok save or status", async () => {
    const r = res();
    await adLocationsStatus(req("tiktok_ads"), r as never);
    expect(r._status).toBe(404);
  });
  it("a saved but stopped TikTok login answers reconnect, not never connected", async () => {
    h.tiktok.mockRejectedValue(new ExpectedToolError("tiktok_ads_not_connected", "TikTok Ads is not connected."));
    h.honest.mockResolvedValueOnce(new ExpectedToolError("tiktok_ads_connection_stopped", "Reconnect TikTok Ads."));
    const r = res();
    await tiktokAdLocationsSearch(req("tiktok_ads", {}, { q: "Austin" }), r as never);
    expect(h.honest).toHaveBeenCalledWith(TENANT, "tiktok_ads", "TikTok Ads", expect.any(ExpectedToolError));
    expect(r._status).toBe(502);
    expect(r._body).toEqual({ error: { code: "tiktok_ads_connection_stopped", message: "Reconnect TikTok Ads." } });
  });
  it("a failed connection-status read still answers with the original error", async () => {
    h.tiktok.mockRejectedValue(new ExpectedToolError("tiktok_ads_not_connected", "TikTok Ads is not connected."));
    h.honest.mockRejectedValueOnce(new Error("db down"));
    const r = res();
    await tiktokAdLocationsSearch(req("tiktok_ads", {}, { q: "Austin" }), r as never);
    expect(r._status).toBe(502);
    expect(r._body).toEqual({ error: { code: "tiktok_ads_not_connected", message: "TikTok Ads is not connected." } });
  });
  it("unauthenticated or a short query asks TikTok nothing", async () => {
    const r = res();
    await tiktokAdLocationsSearch(req("tiktok_ads", {}, { q: "a" }), r as never);
    expect(r._body).toEqual({ places: [] });
    authResult = null;
    await tiktokAdLocationsSearch(req("tiktok_ads", {}, { q: "Austin" }), res() as never);
    expect(h.tiktok).not.toHaveBeenCalled();
  });
});

describe("GET /api/channels/:slug/ad-locations/search", () => {
  it("a too-short query returns no places without asking the platform", async () => {
    const r = res();
    await adLocationsSearch(req("meta_ads", {}, { q: "a" }), r as never);
    expect(r._body).toEqual({ places: [] });
    expect(h.search).not.toHaveBeenCalled();
  });
});

describe("GET /api/channels/x_ads/ad-locations/search", () => {
  it("searches X's places with the caller's own X token and labels each kind", async () => {
    h.xToken.mockResolvedValue({ key: "k", secret: "s" });
    h.xSearch.mockResolvedValue([
      { id: "3b77caf94bfc81fe", name: "Los Angeles, Los Angeles CA, CA, USA", type: "CITIES", country_code: "US" },
      { id: "96683cc9126741d1", name: "United States", type: "COUNTRY", country_code: "US" },
      { id: "m803", name: "Los Angeles CA", type: "METROS", country_code: "US" },
    ]);
    const r = res();
    await xAdLocationsSearch(req("x_ads", {}, { q: "Los Angeles" }), r as never);
    expect(h.xToken).toHaveBeenCalledWith(TENANT);
    expect(h.xSearch).toHaveBeenCalledWith({ key: "k", secret: "s" }, { query: "Los Angeles" });
    expect(r._body).toEqual({
      places: [
        { id: "3b77caf94bfc81fe", name: "Los Angeles, Los Angeles CA, CA, USA", kind: "City" },
        { id: "96683cc9126741d1", name: "United States", kind: "Country" },
        { id: "m803", name: "Los Angeles CA, United States", kind: "Metro" },
      ],
    });
  });
  it("puts the business's country's places first and names the country of every other place", () => {
    const name = (c: string) => ({ GB: "United Kingdom", US: "United States", CA: "Canada" })[c] ?? c;
    const rows = [
      { id: "a", name: "London, England, UK", type: "CITIES", country_code: "GB" },
      { id: "b", name: "London, KY", type: "CITIES", country_code: "US" },
      { id: "c", name: "London, ON", type: "CITIES", country_code: "CA" },
      { id: "d", name: "London, OH, USA", type: "CITIES", country_code: "US" },
      { id: "e", name: "United Kingdom", type: "COUNTRIES", country_code: "GB" },
    ];
    expect(xPickerPlaces(rows, "US", name)).toEqual([
      { id: "b", name: "London, KY, United States", kind: "City" },
      { id: "d", name: "London, OH, USA", kind: "City" },
      { id: "a", name: "London, England, UK", kind: "City" },
      { id: "c", name: "London, ON, Canada", kind: "City" },
      { id: "e", name: "United Kingdom", kind: "Country" },
    ]);
    expect(xPickerPlaces(rows, undefined, name).map((p) => p.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(xPickerPlaces(Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, type: "CITIES", country_code: "US" })), "US", name)).toHaveLength(8);
  });
  it("not connected answers X's own sentence", async () => {
    h.xToken.mockRejectedValue(new ExpectedToolError("x_ads_not_connected", "X Ads is not connected for this workspace."));
    const r = res();
    await xAdLocationsSearch(req("x_ads", {}, { q: "Austin" }), r as never);
    expect(r._status).toBe(502);
    expect(r._body).toEqual({ error: { code: "x_ads_not_connected", message: "X Ads is not connected for this workspace." } });
  });
  it("a short query asks X nothing", async () => {
    h.xSearch.mockClear();
    const r = res();
    await xAdLocationsSearch(req("x_ads", {}, { q: "a" }), r as never);
    expect(r._body).toEqual({ places: [] });
    expect(h.xSearch).not.toHaveBeenCalled();
  });
});
