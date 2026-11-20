
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { ExpectedToolError } from "@/services/tools/types";
import {
  MAX_PLACES,
  isAdLocationChannel,
  locationStatus,
  locationSuggestions,
  saveLocations,
  searchPlaces,
  type AdLocationChannel,
} from "@/services/ad-locations/service";

function channelOf(req: Request, res: Response): AdLocationChannel | null {
  const slug = String(req.params.slug ?? "");
  if (!isAdLocationChannel(slug)) {
    res.status(404).json({ error: { code: "not_an_ad_location_channel", message: "This channel has no ad locations." } });
    return null;
  }
  return slug;
}

function fail(res: Response, e: unknown, what: string): void {
  if (e instanceof ExpectedToolError) {
    const status =
      e.code === "ad_locations_campaign_changed" || e.code === "ad_locations_mixed"
        ? 409
        : e.code === "ad_locations_unverified"
          ? 503
          : e.code.startsWith("ad_locations_")
            ? 400
            : 502;
    res.status(status).json({ error: { code: e.code, message: e.message } });
    return;
  }
  console.warn(`[ad-locations] ${what} failed: ${(e as Error).message}`);
  res.status(502).json({ error: { code: "ad_locations_unavailable", message: "Zavi couldn't read your ad account just now. Try again in a minute." } });
}

export async function adLocationsStatus(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const channel = channelOf(req, res);
  if (!channel) return;
  try {
    res.json(await locationStatus(auth.tenant_id, channel));
  } catch (e) {
    fail(res, e, "status");
  }
}

export async function adLocationsSuggestions(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const channel = channelOf(req, res);
  if (!channel) return;
  try {
    res.json(await locationSuggestions(auth.tenant_id, channel));
  } catch (e) {
    fail(res, e, "suggestions");
  }
}

const SearchQuery = z.object({ q: z.string().trim().min(2).max(100) });

export async function adLocationsSearch(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const channel = channelOf(req, res);
  if (!channel) return;
  const parsed = SearchQuery.safeParse(req.query);
  if (!parsed.success) {
    res.json({ places: [] });
    return;
  }
  try {
    res.json({ places: await searchPlaces(auth.tenant_id, channel, parsed.data.q) });
  } catch (e) {
    fail(res, e, "search");
  }
}

export async function tiktokAdLocationsSearch(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const advertiser = z.string().regex(/^\d{1,32}$/).optional().safeParse(req.query.advertiser_id);
  if (!advertiser.success) { res.status(400).json({ error: { code: "validation", message: "Choose a valid TikTok advertiser." } }); return; }
  const parsed = SearchQuery.safeParse(req.query);
  if (!parsed.success) {
    res.json({ places: [] });
    return;
  }
  try {
    const { searchTiktokPlacesForTenant } = await import("@/services/connectors/tiktok-ads/locations");
    const { businessCountry } = await import("@/services/ad-locations/country");
    const country = (await businessCountry(auth.tenant_id))?.code;
    const rows = advertiser.data
      ? await searchTiktokPlacesForTenant(auth.tenant_id, parsed.data.q, country, advertiser.data)
      : await searchTiktokPlacesForTenant(auth.tenant_id, parsed.data.q, country);
    res.json({ places: rows.slice(0, 8).map((p) => ({ id: p.location_id, name: p.name, kind: p.kind })) });
  } catch (e) {
    let err: unknown = e;
    try {
      const { honestComposioToolError } = await import("@/services/connectors/composio/account");
      err = await honestComposioToolError(auth.tenant_id, "tiktok_ads", "TikTok Ads", e);
    } catch {
    }
    fail(res, err, "tiktok search");
  }
}

const X_KIND: Record<string, string> = { COUNTRIES: "Country", COUNTRY: "Country", REGIONS: "Region", REGION: "Region", METROS: "Metro", METRO: "Metro", CITIES: "City", CITY: "City", POSTAL_CODES: "Postal code", POSTAL_CODE: "Postal code" };

type XPlaceRow = { id: string; name: string; type: string | null; country_code: string | null };

export function xPickerPlaces(rows: readonly XPlaceRow[], businessCountry: string | undefined, nameOf: (code: string) => string): Array<{ id: string; name: string; kind: string }> {
  const home = businessCountry?.toUpperCase();
  const ranked = home ? [...rows.filter((r) => r.country_code?.toUpperCase() === home), ...rows.filter((r) => r.country_code?.toUpperCase() !== home)] : [...rows];
  return ranked.slice(0, 8).map((p) => {
    const kind = X_KIND[p.type ?? ""] ?? "Place";
    const code = p.country_code?.toUpperCase();
    if (kind === "Country" || !code) return { id: p.id, name: p.name, kind };
    const country = nameOf(code);
    const tail = (p.name.split(",").pop() ?? "").trim().toLowerCase();
    const says = tail === code.toLowerCase() || tail === country.toLowerCase() || (code === "US" && tail === "usa") || (code === "GB" && (tail === "uk" || tail === "united kingdom"));
    return { id: p.id, name: says ? p.name : `${p.name}, ${country}`, kind };
  });
}

export async function xAdLocationsSearch(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = SearchQuery.safeParse(req.query);
  if (!parsed.success) {
    res.json({ places: [] });
    return;
  }
  try {
    const { searchXLocations, xAdsTenantToken } = await import("@/services/connectors/x-ads/client");
    const { businessCountry, countryName } = await import("@/services/ad-locations/country");
    const [rows, biz] = await Promise.all([searchXLocations(await xAdsTenantToken(auth.tenant_id), { query: parsed.data.q }), businessCountry(auth.tenant_id)]);
    res.json({ places: xPickerPlaces(rows, biz?.code, countryName) });
  } catch (e) {
    fail(res, e, "x search");
  }
}

const SaveBody = z.object({
  campaign_id: z.string().regex(/^[0-9]{1,64}$/),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  places: z
    .array(z.object({ id: z.string().min(1).max(64), name: z.string().max(200).optional() }))
    .max(MAX_PLACES),
  apply_to_all: z.boolean().optional(),
});

export async function adLocationsSave(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if ((auth as { tenant_overridden?: boolean }).tenant_overridden) {
    res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Switch to your own workspace to make changes." } });
    return;
  }
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  const channel = channelOf(req, res);
  if (!channel) return;
  const parsed = SaveBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: "Check the places and try again." } });
    return;
  }
  try {
    res.json(await saveLocations(auth.tenant_id, auth.user_id, channel, parsed.data));
  } catch (e) {
    fail(res, e, "save");
  }
}
