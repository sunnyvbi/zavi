import { describe, expect, it } from "vitest";
import { projectAdReview } from "../ad-review-presentation";

describe("ad review for a Reddit replacement creative", () => {
  const body = {
    ad_account_id: "a2_1", name: "Group", rationale: "r", operation_key: "op_key_123", ad_group_id: "g1", profile_id: "t2_p",
    creative: { name: "v2", headline: "Rent a car near you", image_url: "https://x.test/car.png", destination_url: "https://x.test/cars", allow_comments: false },
  };

  it("previews the nested creative's headline, picture and destination", () => {
    const review = projectAdReview("reddit_ads.replace_creative", body);
    expect(review?.creatives).toEqual([expect.objectContaining({ title: "Rent a car near you", image_url: "https://x.test/car.png", target_url: "https://x.test/cars", media_kind: "image" })]);
  });

  it("still reads a LinkedIn post reference from the same key", () => {
    const review = projectAdReview("linkedin_ads.create_campaign", { creative: { post_urn: "urn:li:share:123" } });
    expect(review?.creatives).toEqual([expect.objectContaining({ target_url: "https://www.linkedin.com/feed/update/urn:li:share:123/" })]);
  });

  it("names a Zavi-made picture by its artifact so the card can sign a preview", () => {
    const art = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
    const review = projectAdReview("reddit_ads.replace_creative", { ...body, creative: { ...body.creative, image_url: undefined, image_artifact_id: art } });
    expect(review?.creatives).toEqual([expect.objectContaining({ image_artifact_id: art, media_kind: "image" })]);
  });

  it("passes a photo attached in chat through as its private path", () => {
    const path = "0b0c5f7e-1111-4222-8333-944455556666/2c9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed.jpg";
    const review = projectAdReview("reddit_ads.prepare_campaign", { creatives: [{ headline: "h", image_path: path, destination_url: "https://x.test/a" }] });
    expect(review?.creatives).toEqual([expect.objectContaining({ image_path: path })]);
  });
});
