import { beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ campaignFetch: api }));
import { cachedCampaignReview, holdCampaignReview, invalidateCampaignReviews, loadCampaignReview } from "./campaignReviewPrefetch";

const path = "/api/channels/linkedin_ads/actions/a1/review";
const failed = { suggested: { locations: [], unresolved_locations: [], location_search_failed: "LinkedIn's location search didn't answer, so Zavi could not fill in Ontario. Try again in a moment, or add the places you want." } };
const good = { suggested: { locations: [{ id: "urn:li:geo:1", name: "Ontario, Canada" }], unresolved_locations: [] } };

beforeEach(() => { invalidateCampaignReviews(); api.mockReset(); });

it("a review whose location search failed is not kept, so reopening asks again and shows the places, and the working review is then kept", async () => {
  api.mockResolvedValueOnce(failed).mockResolvedValueOnce(good);
  const release = holdCampaignReview(path, "r1");
  expect(await loadCampaignReview(path, "r1")).toEqual(failed);
  expect(api).toHaveBeenCalledTimes(1);
  expect(cachedCampaignReview(path, "r1")).toBeUndefined();
  expect(await loadCampaignReview(path, "r1")).toEqual(good);
  expect(api).toHaveBeenCalledTimes(2);
  expect(cachedCampaignReview(path, "r1")).toEqual(good);
  expect(await loadCampaignReview(path, "r1")).toEqual(good);
  expect(api).toHaveBeenCalledTimes(2);
  release();
});

it("a working review is fetched once and served from memory to the next opener", async () => {
  api.mockResolvedValue(good);
  const release = holdCampaignReview(path);
  await loadCampaignReview(path);
  await loadCampaignReview(path);
  expect(cachedCampaignReview(path)).toEqual(good);
  expect(api).toHaveBeenCalledTimes(1);
  release();
});
