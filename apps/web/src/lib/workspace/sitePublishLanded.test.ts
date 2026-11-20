import { describe, expect, it } from "vitest";
import { sitePublishLanded } from "./useBuildSession";

const LIVE = "https://dog-1.zaviagent.com";

describe("sitePublishLanded", () => {
  it("the first publish gives the site its address", () => {
    expect(sitePublishLanded({ liveUrl: null }, { liveUrl: LIVE })).toBe(true);
  });

  it("a later publish empties the waiting changes", () => {
    expect(sitePublishLanded({ liveUrl: LIVE, unpublished: { count: 2 } }, { liveUrl: LIVE, unpublished: null })).toBe(true);
    expect(sitePublishLanded({ liveUrl: LIVE, unpublished: { count: 1 } }, { liveUrl: LIVE, unpublished: { count: 0 } })).toBe(true);
  });

  it("is false while changes still wait, when nothing waited, or when the count could not be read", () => {
    expect(sitePublishLanded({ liveUrl: LIVE, unpublished: { count: 2 } }, { liveUrl: LIVE, unpublished: { count: 1 } })).toBe(false);
    expect(sitePublishLanded({ liveUrl: LIVE, unpublished: null }, { liveUrl: LIVE, unpublished: null })).toBe(false);
    expect(sitePublishLanded({ liveUrl: LIVE, unpublished: { count: 2 } }, { liveUrl: LIVE, unpublished: null, unpublishedUnknown: true })).toBe(false);
    expect(sitePublishLanded(null, { liveUrl: LIVE })).toBe(false);
  });
});
