import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ fetch: vi.fn(), inUse: vi.fn() }));
vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: async () => "tok", forceRefreshConnector: vi.fn(), markConnectorTokenRevoked: vi.fn() }));
vi.mock("@/services/connectors/linkedin-ads/own-accounts", () => ({ linkedinAccountInUse: m.inUse }));

import { resetLinkedInAdsReadCache } from "@/services/connectors/linkedin-ads/http";
import { linkedinAdsSearchTargetingTool } from "../search_targeting";
import { linkedinAdsPreviewAdTool, previewUrlOf } from "../preview_ad";
import { linkedinAdsListMediaTool } from "../list_media";

const LOC = "urn:li:adTargetingFacet:locations";
const ok = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
const ctx = { tenant_id: "t1", log: () => {} } as never;
const entity = (urn: string, name: string, facetUrn: string, isTargetable = true) => ({ urn, name, facetUrn, isTargetable });
const gets = () => m.fetch.mock.calls.map(([u]) => decodeURIComponent(String(u)));
let previews: unknown;
let media: unknown;

beforeEach(() => {
  resetLinkedInAdsReadCache();
  for (const f of Object.values(m)) f.mockReset();
  m.inUse.mockResolvedValue(true);
  previews = {
    elements: [
      { preview: "<iframe src='https://www.linkedin.com/ads/ad-preview/?d=desk' height=580 width=650></iframe>", creative: "urn:li:sponsoredCreative:7", placement: { linkedin: { placementName: "FEED", contentPresentationType: "DESKTOP_WEBSITE" } } },
      { preview: "<iframe src='https://www.linkedin.com/mwlite/ads/ad-preview?d=mob' height=375 width=700></iframe>", creative: "urn:li:sponsoredCreative:7", placement: { linkedin: { placementName: "FEED", contentPresentationType: "MOBILE_WEBSITE" } } },
      { preview: "<iframe src='https://x/other'></iframe>", creative: "urn:li:sponsoredCreative:99" },
    ],
  };
  media = {
    elements: [
      { id: "urn:li:image:A1", owner: "urn:li:organization:5", status: "AVAILABLE", downloadUrl: "https://media/a1", downloadUrlExpiresAt: 1_800_000_000_000, mediaLibraryMetadata: { associatedAccount: "urn:li:sponsoredAccount:11", assetName: "Hero image", mediaLibraryStatus: "ACTIVE" } },
      { id: "urn:li:image:B2", status: "PROCESSING", mediaLibraryMetadata: { associatedAccount: "urn:li:sponsoredAccount:12", assetName: "Someone else's" } },
      { id: "urn:li:video:V1", status: "AVAILABLE", duration: 6827, thumbnail: "https://media/t", aspectRatioWidth: 9, aspectRatioHeight: 16, mediaLibraryMetadata: { associatedAccount: "urn:li:sponsoredAccount:11", assetName: "Clip" } },
      { status: "AVAILABLE" },
    ],
    paging: { total: 7 },
  };
  m.fetch.mockImplementation(async (url: unknown) => {
    const u = decodeURIComponent(String(url));
    if (u.includes("/adPreviews?")) return ok(previews);
    if (u.includes("/images?") || u.includes("/videos?")) return ok(media);
    if (u.includes("adTargetingEntities") && u.includes("typeahead")) {
      const facet = /facet=urn:li:adTargetingFacet:(\w+)/.exec(u)?.[1];
      if (facet === "locations") return ok({ elements: [entity("urn:li:geo:1", "Berlin, Germany", LOC), entity("urn:li:geo:2", "Berlin, Connecticut, United States", LOC), entity("urn:li:geo:3", "Berlin Twp, Ohio, United States", LOC, false), entity("urn:li:title:9", "Mislabelled", "urn:li:adTargetingFacet:titles")] });
      if (facet === "titles") return ok({ elements: [entity("urn:li:title:1", "Berlin Correspondent", "urn:li:adTargetingFacet:titles")] });
      if (facet === "skills") return ok({ elements: [entity("urn:li:skill:1", "Berlin Dialect", "urn:li:adTargetingFacet:skills"), entity("urn:li:skill:1", "Berlin Dialect", "urn:li:adTargetingFacet:skills")] });
      return ok({ elements: [] });
    }
    return ok({});
  });
  vi.stubGlobal("fetch", m.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("linkedin_ads_search_targeting", () => {
  it("searches the default facets in one pass, marks EU locations, drops untargetable and mislabelled entities and duplicates", async () => {
    const out = (await linkedinAdsSearchTargetingTool.execute(ctx, { account_id: "11", query: "Berlin" })) as { facets: string[]; entities: Array<Record<string, unknown>> };
    expect(out.facets).toEqual(["locations", "titles", "industries", "skills"]);
    expect(out.entities).toEqual([
      { urn: "urn:li:geo:1", name: "Berlin, Germany", facet: "locations", in_eu: true },
      { urn: "urn:li:geo:2", name: "Berlin, Connecticut, United States", facet: "locations" },
      { urn: "urn:li:title:1", name: "Berlin Correspondent", facet: "titles" },
      { urn: "urn:li:skill:1", name: "Berlin Dialect", facet: "skills" },
    ]);
    expect(gets()).toHaveLength(4);
    expect(gets().every((u) => u.includes("q=typeahead") && u.includes("query=Berlin"))).toBe(true);
  });

  it("one facet, a limit, and refusals for an unused account, a short query and an unknown facet", async () => {
    const out = (await linkedinAdsSearchTargetingTool.execute(ctx, { account_id: "11", query: "Berlin", facet: "locations", limit: 1 })) as { entities: unknown[] };
    expect(out.entities).toEqual([{ urn: "urn:li:geo:1", name: "Berlin, Germany", facet: "locations", in_eu: true }]);
    expect(gets()).toHaveLength(1);
    await expect(linkedinAdsSearchTargetingTool.execute(ctx, { account_id: "11", query: "B" })).rejects.toThrow();
    await expect(linkedinAdsSearchTargetingTool.execute(ctx, { account_id: "11", query: "Berlin", facet: "memberBehaviors" })).rejects.toThrow();
    m.inUse.mockResolvedValue(false);
    await expect(linkedinAdsSearchTargetingTool.execute(ctx, { account_id: "11", query: "Berlin" })).rejects.toMatchObject({ code: "linkedin_ads_account_not_in_use" });
    expect(gets()).toHaveLength(1);
  });

  it("an answer LinkedIn did not shape as a list is refused, not read as empty", async () => {
    m.fetch.mockResolvedValue(ok({ nope: true }));
    await expect(linkedinAdsSearchTargetingTool.execute(ctx, { account_id: "11", query: "Berlin", facet: "titles" })).rejects.toMatchObject({ code: "linkedin_ads_bad_response" });
  });
});

describe("linkedin_ads_preview_ad", () => {
  it("asks adPreviews for the creative in the account and returns the desktop iframe first, with every placement", async () => {
    const out = (await linkedinAdsPreviewAdTool.execute(ctx, { account_id: "11", creative_id: "7" })) as Record<string, unknown>;
    expect(gets()[0]).toContain("/adPreviews?q=creative&creative=urn:li:sponsoredCreative:7&account=urn:li:sponsoredAccount:11");
    expect(out).toMatchObject({ creative_id: "7", preview_url: "https://www.linkedin.com/ads/ad-preview/?d=desk", preview_html: expect.stringContaining("<iframe") });
    expect(out.previews).toEqual([
      { placement: "FEED", presentation: "DESKTOP_WEBSITE", preview_html: expect.stringContaining("d=desk"), preview_url: "https://www.linkedin.com/ads/ad-preview/?d=desk" },
      { placement: "FEED", presentation: "MOBILE_WEBSITE", preview_html: expect.stringContaining("d=mob"), preview_url: "https://www.linkedin.com/mwlite/ads/ad-preview?d=mob" },
    ]);
    expect(previewUrlOf("<iframe srcdoc='<html>x</html>'></iframe>")).toBeNull();
  });

  it("no preview, an unshaped answer, and an unused account are refused", async () => {
    previews = { elements: [] };
    await expect(linkedinAdsPreviewAdTool.execute(ctx, { account_id: "11", creative_id: "7" })).rejects.toMatchObject({ code: "linkedin_ads_preview_unavailable" });
    previews = { elements: [{ preview: "<iframe src='https://x'></iframe>", creative: "urn:li:sponsoredCreative:99" }] };
    resetLinkedInAdsReadCache();
    await expect(linkedinAdsPreviewAdTool.execute(ctx, { account_id: "11", creative_id: "7" })).rejects.toMatchObject({ code: "linkedin_ads_preview_unavailable" });
    previews = {};
    resetLinkedInAdsReadCache();
    await expect(linkedinAdsPreviewAdTool.execute(ctx, { account_id: "11", creative_id: "7" })).rejects.toMatchObject({ code: "linkedin_ads_bad_response" });
    m.inUse.mockResolvedValue(false);
    m.fetch.mockClear();
    await expect(linkedinAdsPreviewAdTool.execute(ctx, { account_id: "11", creative_id: "7" })).rejects.toMatchObject({ code: "linkedin_ads_account_not_in_use" });
    expect(m.fetch).not.toHaveBeenCalled();
  });
});

describe("linkedin_ads_list_media", () => {
  it("lists the account's image library through the associatedAccount finder and keeps only this account's assets", async () => {
    const out = (await linkedinAdsListMediaTool.execute(ctx, { account_id: "11", limit: 3 })) as Record<string, unknown>;
    expect(gets()[0]).toContain("/images?q=associatedAccount&associatedAccount=urn:li:sponsoredAccount:11&start=0&count=3");
    expect(out).toMatchObject({ account_id: "11", kind: "images", source: "media_library", total: 7, truncated: true });
    expect(out.media).toEqual([
      { urn: "urn:li:image:A1", kind: "image", name: "Hero image", status: "AVAILABLE", library_status: "ACTIVE", download_url: "https://media/a1", download_url_expires_at: new Date(1_800_000_000_000).toISOString(), duration_ms: null, thumbnail_url: null, aspect_ratio: null },
      { urn: "urn:li:video:V1", kind: "image", name: "Clip", status: "AVAILABLE", library_status: null, download_url: null, download_url_expires_at: null, duration_ms: 6827, thumbnail_url: "https://media/t", aspect_ratio: "9:16" },
    ]);
  });

  it("videos go to the videos finder; an unshaped answer and an unused account are refused", async () => {
    const out = (await linkedinAdsListMediaTool.execute(ctx, { account_id: "11", kind: "videos" })) as { kind: string; media: Array<{ kind: string }> };
    expect(gets()[0]).toContain("/videos?q=associatedAccount&associatedAccount=urn:li:sponsoredAccount:11&start=0&count=25");
    expect(out.kind).toBe("videos");
    expect(out.media.every((x) => x.kind === "video")).toBe(true);
    media = { paging: {} };
    resetLinkedInAdsReadCache();
    await expect(linkedinAdsListMediaTool.execute(ctx, { account_id: "11" })).rejects.toMatchObject({ code: "linkedin_ads_bad_response" });
    m.inUse.mockResolvedValue(false);
    m.fetch.mockClear();
    await expect(linkedinAdsListMediaTool.execute(ctx, { account_id: "11" })).rejects.toMatchObject({ code: "linkedin_ads_account_not_in_use" });
    expect(m.fetch).not.toHaveBeenCalled();
  });
});
