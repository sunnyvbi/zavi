import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

const m = vi.hoisted(() => ({ get: vi.fn(), batch: vi.fn(), fetch: vi.fn() }));
vi.mock("@/services/connectors/linkedin-ads/client", () => ({
  withLinkedInAdsToken: async (_tenant: string, run: (token: string) => Promise<unknown>) => run("tok"),
  listLinkedInAdAccountsRaw: async () => [{ id: "558561881" }],
}));
vi.mock("@/services/connectors/linkedin-ads/http", () => ({ linkedinAdsGet: m.get, linkedinAdsBatchGet: m.batch, linkedinPostPath: (urn: string) => `posts/${encodeURIComponent(urn)}` }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (id: string) => id,
  tenantClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ range: async () => ({ data: [], error: null }) }), range: async () => ({ data: [], error: null }) }) }) }) }),
}));

import { linkedinCampaignMedia } from "../linkedin";

const SHARE = "urn:li:share:7523985502677389312";
const IMAGE = "https://media.licdn.com/dms/image/v2/D5610AQFnUlqAonm_5w/image-shrink_800/x/0/1793857507800/ad.png?e=2147483647&v=beta&t=abc";
const html = (image: string) =>
  `<html><head><meta property="og:image" content="${image.replace(/&/g, "&amp;")}"/><script type="application/ld+json">${JSON.stringify({ "@context": "http://schema.org", "@type": "SocialMediaPosting", text: "Find the right tool", image: { "@type": "ImageObject", url: image } })}</script></head><body></body></html>`;

beforeEach(() => {
  m.get.mockReset();
  m.batch.mockReset();
  m.fetch.mockReset();
  m.get.mockResolvedValue({ elements: [{ id: "urn:li:sponsoredCreative:1677655036", campaign: "urn:li:sponsoredCampaign:924565426", content: { reference: SHARE } }], metadata: {} });
  m.fetch.mockImplementation(async (url: string) => ({ ok: true, status: 200, url, text: async () => html(IMAGE) }));
  vi.stubGlobal("fetch", m.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a boosted post's image when the ad token cannot read the post", () => {
  it("must catch: the Posts API refusing with 403 no longer empties every thumbnail; the image comes from the public post page", async () => {
    m.batch.mockImplementation(async (_t: string, resource: string) => { if (resource === "posts") throw new ExpectedToolError("linkedin_ads_forbidden", "no role", { status: 403, http_status: 403 }); return {}; });
    await expect(linkedinCampaignMedia("t1", ["924565426"])).resolves.toEqual({ "924565426": [IMAGE] });
    expect(m.fetch).toHaveBeenCalledTimes(1);
    expect(String(m.fetch.mock.calls[0][0])).toBe(`https://www.linkedin.com/feed/update/${SHARE}/`);
  });

  it("a revoked token still surfaces as revoked instead of a silent empty thumbnail", async () => {
    m.batch.mockImplementation(async (_t: string, resource: string) => { if (resource === "posts") throw new ExpectedToolError("linkedin_ads_token_revoked", "revoked", { status: 401, http_status: 401 }); return {}; });
    await expect(linkedinCampaignMedia("t1", ["924565426"])).rejects.toMatchObject({ code: "linkedin_ads_token_revoked" });
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it("the public page is read only for a post the API did not return, and a page behind the sign-in wall leaves the thumbnail empty", async () => {
    m.batch.mockImplementation(async (_t: string, resource: string) => (resource === "posts" ? { [SHARE]: { content: { media: { thumbnail: "https://media.licdn.com/api.png" } } } } : {}));
    await expect(linkedinCampaignMedia("t1", ["924565426"])).resolves.toEqual({ "924565426": ["https://media.licdn.com/api.png"] });
    expect(m.fetch).not.toHaveBeenCalled();
    m.batch.mockResolvedValue({});
    m.fetch.mockImplementation(async () => ({ ok: true, status: 200, url: "https://www.linkedin.com/authwall?x=1", text: async () => "" }));
    await expect(linkedinCampaignMedia("t1", ["924565426"])).resolves.toEqual({ "924565426": [] });
  });
});
