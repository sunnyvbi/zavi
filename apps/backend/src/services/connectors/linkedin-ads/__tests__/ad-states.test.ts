import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/connectors/core/token", () => ({
  getConnectorToken: async () => "tok",
  forceRefreshConnector: vi.fn(),
  markConnectorTokenRevoked: vi.fn(),
}));

import { resetLinkedInAdsReadCache } from "../http";
import { readLinkedInAdStates, readLinkedInAdStatesWithToken } from "../client";

const ok = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });

beforeEach(() => {
  resetLinkedInAdsReadCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("reads the account's creatives by campaign with a finder call and maps LinkedIn's own fields", async () => {
  fetchMock.mockResolvedValueOnce(
    ok({
      elements: [
        { id: "urn:li:sponsoredCreative:9", campaign: "urn:li:sponsoredCampaign:22", intendedStatus: "ACTIVE", isServing: false, servingHoldReasons: ["UNDER_REVIEW", 7], review: { status: "PENDING" } },
      ],
    }),
  );
  await expect(readLinkedInAdStates("t1", "11", ["22", "23"])).resolves.toEqual([
    { campaign_id: "22", intended_status: "ACTIVE", is_serving: false, hold_reasons: ["UNDER_REVIEW"], review_status: "PENDING" },
  ]);
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toContain("adAccounts/11/creatives?");
  expect(String(url)).toContain("q=criteria");
  expect(String(url)).toContain("campaigns=List(urn%3Ali%3AsponsoredCampaign%3A22,urn%3Ali%3AsponsoredCampaign%3A23)");
  expect(init.headers.Authorization).toBe("Bearer tok");
});

it("must catch: a second page of ads is read, so a rejected ad on page two is not missed", async () => {
  fetchMock
    .mockResolvedValueOnce(ok({ elements: [{ campaign: "urn:li:sponsoredCampaign:22", intendedStatus: "ACTIVE", isServing: true }], metadata: { nextPageToken: "n" } }))
    .mockResolvedValueOnce(ok({ elements: [{ campaign: "urn:li:sponsoredCampaign:22", intendedStatus: "ACTIVE", isServing: false, review: { status: "REJECTED" } }] }));
  const ads = await readLinkedInAdStatesWithToken("tok", "11", ["22"]);
  expect(ads.map((a) => a.review_status)).toEqual([null, "REJECTED"]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("splits a long campaign list so one call never carries more than fifty campaigns", async () => {
  fetchMock.mockImplementation(async () => ok({ elements: [] }));
  await readLinkedInAdStatesWithToken("tok", "11", Array.from({ length: 51 }, (_, i) => String(i + 1)));
  const sizes = fetchMock.mock.calls.map(([url]) => (String(url).match(/sponsoredCampaign/g) ?? []).length);
  expect(sizes).toEqual([50, 1]);
});

it("must catch: an answer with no elements is a failed read, not a campaign with no ads", async () => {
  fetchMock.mockResolvedValueOnce(ok({ message: "nope" }));
  await expect(readLinkedInAdStatesWithToken("tok", "11", ["22"])).rejects.toMatchObject({ code: "linkedin_ads_bad_response" });
});
