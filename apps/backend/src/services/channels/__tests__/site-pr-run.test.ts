import { describe, expect, it } from "vitest";
import { channelOfSitePrClass, listingChannelOfRun, sitePrClassForChannel, sitePrClassOfRun } from "../site-pr-run";

const card = (exec_class: string) => ({ site_pr_card: { action_id: "a", claim_id: "c", exec_class } });

describe("site-pr-run", () => {
  it("recognises only a server-written run carrying a site-PR card", () => {
    expect(sitePrClassOfRun({ enqueued_by: null, payload: card("seo.create_pr.v1") })).toBe("seo.create_pr.v1");
    expect(sitePrClassOfRun({ enqueued_by: "u-1", payload: card("seo.create_pr.v1") })).toBeNull();
    expect(sitePrClassOfRun({ enqueued_by: null, payload: card("meta_ads.set_status") })).toBeNull();
    expect(sitePrClassOfRun({ enqueued_by: null, payload: { task_description: "x" } })).toBeNull();
  });

  it("maps classes and channels both ways, and only for the two PR classes", () => {
    expect(channelOfSitePrClass("geo.create_pr.v1")).toBe("geo");
    expect(channelOfSitePrClass("meta_ads.create_ad")).toBeNull();
    expect(sitePrClassForChannel("seo")).toBe("seo.create_pr.v1");
    expect(sitePrClassForChannel("meta_ads")).toBeNull();
  });

  it("a stamp always wins; an unstamped server site-PR run lists under its card's channel", () => {
    expect(listingChannelOfRun({ channel_slug: "meta_ads", enqueued_by: null, site_pr_class: "seo.create_pr.v1" })).toBe("meta_ads");
    expect(listingChannelOfRun({ channel_slug: null, enqueued_by: null, site_pr_class: "seo.create_pr.v1" })).toBe("seo");
    expect(listingChannelOfRun({ channel_slug: null, enqueued_by: "u-1", site_pr_class: "seo.create_pr.v1" })).toBeNull();
    expect(listingChannelOfRun({ channel_slug: null, enqueued_by: null, site_pr_class: null })).toBeNull();
  });
});
