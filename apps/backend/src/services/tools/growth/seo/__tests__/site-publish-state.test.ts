import { describe, it, expect, vi } from "vitest";
import { getSitePublishState, siteForCrawl } from "../site-publish-state";
import type { SiteRow } from "@/services/sites/contract";

const site = (over: Partial<SiteRow>): SiteRow =>
  ({
    id: "s1",
    tenant_id: "t1",
    hostname: "evently.zaviagent.com",
    status: "live",
    live_url: "https://evently.zaviagent.com",
    live_deploy_id: "d1",
    ...over,
  }) as SiteRow;

describe("siteForCrawl", () => {
  it("matches the crawled address to the published site, ignoring path and www", () => {
    expect(siteForCrawl([site({})], "https://www.evently.zaviagent.com/events")?.id).toBe("s1");
  });

  it("never matches a site that was never published, or another address", () => {
    expect(siteForCrawl([site({ live_deploy_id: null })], "https://evently.zaviagent.com")).toBeNull();
    expect(siteForCrawl([site({})], "https://example.com")).toBeNull();
    expect(siteForCrawl([site({})], null)).toBeNull();
  });
});

describe("getSitePublishState", () => {
  it("counts the changes waiting for Publish on the crawled site", async () => {
    const loadPending = vi.fn(async () => ({ changes: [{}, {}], capped: false }));
    const s = await getSitePublishState("t1", "https://evently.zaviagent.com", {
      listSites: async () => [site({ id: "other", hostname: "x.zaviagent.com", live_url: "https://x.zaviagent.com" }), site({})],
      loadPending,
    });
    expect(loadPending).toHaveBeenCalledWith("t1", "s1");
    expect(s).toEqual({ pending: 2, capped: false });
  });

  it("is null for a site Zavi did not build, and never throws on a failed read", async () => {
    const loadPending = vi.fn();
    expect(await getSitePublishState("t1", "https://example.com", { listSites: async () => [site({})], loadPending })).toBeNull();
    expect(loadPending).not.toHaveBeenCalled();
    const failing = await getSitePublishState("t1", "https://evently.zaviagent.com", {
      listSites: async () => [site({})],
      loadPending: async () => {
        throw new Error("db down");
      },
    });
    expect(failing).toBeNull();
  });
});
