import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ get: vi.fn(), batch: vi.fn() }));
vi.mock("@/services/connectors/linkedin-ads/client", () => ({
  withLinkedInAdsToken: async (_tenant: string, run: (token: string) => Promise<unknown>) => run("tok"),
  listLinkedInAdAccountsRaw: async () => [{ id: "558561881" }],
}));
vi.mock("@/services/connectors/linkedin-ads/http", () => ({ linkedinAdsGet: m.get, linkedinAdsBatchGet: m.batch, linkedinCreativePath: (a: string, c: string) => `adAccounts/${a}/creatives/${c}` }));
vi.mock("@/services/connectors/linkedin-ads/post-link", () => ({ readPublicPostImage: async () => null }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (id: string) => id,
  tenantClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ range: async () => ({ data: [], error: null }) }), range: async () => ({ data: [], error: null }) }) }) }) }),
}));

import { linkedinCampaignMedia } from "../linkedin";

const CAMPAIGN = "924565426";
const SHARE_A = "urn:li:share:7000000000000000001";
const SHARE_B = "urn:li:share:7000000000000000002";
const IMAGE_A = "https://media.licdn.com/dms/image/a.png";
const IMAGE_B = "https://media.licdn.com/dms/image/b.png";

beforeEach(() => {
  m.get.mockReset();
  m.batch.mockReset();
  m.get.mockResolvedValue({
    elements: [
      { id: "urn:li:sponsoredCreative:1001", campaign: `urn:li:sponsoredCampaign:${CAMPAIGN}`, content: { reference: SHARE_A } },
      { id: "urn:li:sponsoredCreative:1002", campaign: `urn:li:sponsoredCampaign:${CAMPAIGN}`, content: { reference: SHARE_B } },
      { id: "urn:li:sponsoredCreative:9009", campaign: "urn:li:sponsoredCampaign:555", content: { reference: SHARE_A } },
    ],
    metadata: {},
  });
  m.batch.mockImplementation(async (_t: string, resource: string) =>
    resource === "posts"
      ? { [SHARE_A]: { content: { media: { thumbnail: IMAGE_A } } }, [SHARE_B]: { content: { media: { thumbnail: IMAGE_B } } } }
      : {},
  );
});

describe("one preview per LinkedIn ad", () => {
  it("must catch: each ad gets its own post image, not the first ad's, keyed by the ad id", async () => {
    await expect(linkedinCampaignMedia("t1", [CAMPAIGN], "ad")).resolves.toEqual({ "1001": [IMAGE_A], "1002": [IMAGE_B] });
  });

  it("an ad from a campaign that was not asked for is left out", async () => {
    const result = await linkedinCampaignMedia("t1", [CAMPAIGN], "ad");
    expect(result["9009"]).toBeUndefined();
  });

  it("the ad set preview is unchanged: one campaign key holding its ads' images", async () => {
    await expect(linkedinCampaignMedia("t1", [CAMPAIGN])).resolves.toEqual({ [CAMPAIGN]: [IMAGE_A, IMAGE_B] });
  });
});
