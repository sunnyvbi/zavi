
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ fbGet: vi.fn(), fbGetAllPages: vi.fn(), fbPost: vi.fn(), cap: vi.fn(), scopes: vi.fn(), token: vi.fn(), adSets: vi.fn() }));
vi.mock("../../_client", () => ({ fbGet: h.fbGet, fbGetAllPages: h.fbGetAllPages, fbPost: h.fbPost }));
vi.mock("../../_scopes", () => ({ assertMetaScopes: h.scopes }));
vi.mock("../../pages", () => ({ pageAccessToken: h.token }));
vi.mock("../../list_ad_sets", () => ({ enumerateAccountAdSets: h.adSets }));
vi.mock("../_library-ad-capability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../_library-ad-capability")>()),
  resolveMetaAdCapability: h.cap,
}));

import { createBoostAd, mostEngagedPost, readBoostOptions, toBoostPost } from "../boost_post";
import { boostObjectStoryId, shapeBoostPostCreativeRequest } from "../_library-ad-shapers";
import { ExpectedToolError } from "@/services/tools/types";

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.cap.mockResolvedValue({ ok: true, ad_account_id: "act_9", page_id: "100", page_name: "A", ad_sets: [] });
  h.fbGetAllPages.mockResolvedValue([{ id: "100", name: "Upcar" }, { id: "200", name: "Upcar LA" }]);
  h.adSets.mockResolvedValue([{ id: "555", name: "Traffic", effective_status: "ACTIVE" }]);
  h.scopes.mockResolvedValue(undefined);
  h.token.mockResolvedValue("page-token");
  h.fbGet.mockResolvedValue({ id: "100_7", from: { id: "100" } });
  h.fbPost.mockImplementation(async (_t: string, path: string) => ({ id: path.endsWith("/adcreatives") ? "cr-1" : "ad-1" }));
});

describe("shapeBoostPostCreativeRequest", () => {
  it("names the post by a canonical object_story_id and nothing else", () => {
    const r = shapeBoostPostCreativeRequest({ ad_account_id: "act_9", page_id: "100", post_id: "7", name: "Boost" });
    expect(r).toEqual({ path: "act_9/adcreatives", params: { name: "Boost", object_story_id: "100_7" } });
    expect(boostObjectStoryId("100", "100_7")).toBe("100_7");
    expect(() => boostObjectStoryId("100", "200_7")).toThrow(/not on the Page/);
  });

  it("the boost service has no live-status literal anywhere", () => {
    const src = readFileSync(join(__dirname, "..", "boost_post.ts"), "utf8");
    expect(src).not.toMatch(/(['"`])ACTIVE\1/);
  });
});

describe("createBoostAd", () => {
  it("creates a PAUSED ad from the post in the picked ad set", async () => {
    const r = await createBoostAd("t", { page_id: "100", post_id: "7", ad_set_id: "555" });
    expect(r).toMatchObject({ ad_id: "ad-1", creative_id: "cr-1", status: "PAUSED" });
    expect(r.ads_manager_url).toContain("act=9");
    const [, , creativeParams] = h.fbPost.mock.calls[0];
    expect(creativeParams.object_story_id).toBe("100_7");
    const [, adPath, adParams] = h.fbPost.mock.calls[1];
    expect(adPath).toBe("act_9/ads");
    expect(adParams).toMatchObject({ adset_id: "555", status: "PAUSED" });
    expect(h.fbGet).toHaveBeenCalledWith("t", "100_7", { fields: "id,from" }, { page_access_token: "page-token" });
  });

  it("removes the creative when the ad create fails", async () => {
    h.fbPost.mockImplementation(async (_t: string, path: string) => {
      if (path.endsWith("/adcreatives")) return { id: "cr-1" };
      if (path.endsWith("/ads")) throw new ExpectedToolError("meta_ads_write_failed", "Meta Ads write failed: 400");
      return { success: true };
    });
    await expect(createBoostAd("t", { page_id: "100", post_id: "7", ad_set_id: "555" })).rejects.toMatchObject({ code: "meta_ads_write_failed", message: "Meta Ads write failed: 400" });
    expect(h.fbPost).toHaveBeenLastCalledWith("t", "cr-1", { method: "delete" });
  });

  it("names the creative when that cleanup fails too, and never throws from cleanup", async () => {
    h.fbPost.mockImplementation(async (_t: string, path: string) => {
      if (path.endsWith("/adcreatives")) return { id: "cr-1" };
      throw new ExpectedToolError("meta_ads_write_failed", "Meta Ads write failed: 400");
    });
    await expect(createBoostAd("t", { page_id: "100", post_id: "7", ad_set_id: "555" })).rejects.toMatchObject({
      code: "meta_ads_write_failed",
      message: expect.stringContaining("cr-1"),
      meta: { orphan_creative_id: "cr-1" },
    });
  });

  it("refuses a Page the account cannot promote, with nothing created", async () => {
    await expect(createBoostAd("t", { page_id: "999", post_id: "7", ad_set_id: "555" })).rejects.toMatchObject({ code: "meta_ads_boost_page_not_promotable" });
    expect(h.fbPost).not.toHaveBeenCalled();
  });

  it("refuses an ad set that is not in the account", async () => {
    await expect(createBoostAd("t", { page_id: "100", post_id: "7", ad_set_id: "777" })).rejects.toMatchObject({ code: "meta_ads_boost_ad_set_not_in_account" });
    expect(h.fbPost).not.toHaveBeenCalled();
  });

  it("refuses a post that is not on the Page", async () => {
    h.fbGet.mockResolvedValue({ id: "100_7", from: { id: "200" } });
    await expect(createBoostAd("t", { page_id: "100", post_id: "7", ad_set_id: "555" })).rejects.toMatchObject({ code: "meta_ads_post_not_on_page" });
    expect(h.fbPost).not.toHaveBeenCalled();
  });

  it("refuses when the connection cannot advertise, with the Page reason", async () => {
    h.cap.mockResolvedValue({ ok: false, reason_code: "page_permission_missing", reason: "x" });
    await expect(createBoostAd("t", { page_id: "100", post_id: "7", ad_set_id: "555" })).rejects.toMatchObject({ code: "meta_ads_page_permission_missing" });
  });
});

describe("readBoostOptions", () => {
  it("lists every promotable Page, the chosen Page's posts and the ad sets", async () => {
    h.fbGet.mockResolvedValue({ data: [{ id: "200_1", message: "hi", likes: { summary: { total_count: 3 } }, comments: { summary: { total_count: 1 } }, shares: { count: 2 } }] });
    const r = await readBoostOptions("t", "200");
    expect(r).toMatchObject({ eligible: true, page_id: "200", pages: [{ id: "100" }, { id: "200" }], ad_sets: [{ id: "555", status: "ACTIVE" }] });
    if (r.eligible) expect(r.posts[0]).toMatchObject({ id: "200_1", likes: 3, comments: 1, shares: 2 });
    expect(h.token).toHaveBeenCalledWith("t", "200");
  });

  it("says why when the connection has no Page access", async () => {
    h.cap.mockResolvedValue({ ok: false, reason_code: "page_permission_missing", reason: "x" });
    expect(await readBoostOptions("t")).toMatchObject({ eligible: false, reason_code: "page_permission_missing" });
  });

  it("says why when Page posts cannot be read", async () => {
    h.scopes.mockRejectedValue(Object.assign(new Error("no"), { code: "meta_ads_scope_missing" }));
    expect(await readBoostOptions("t")).toMatchObject({ eligible: false, reason_code: "page_posts_permission_missing" });
  });

  it("re-reads without like and comment counts when Meta gates the summaries", async () => {
    h.fbGet
      .mockRejectedValueOnce(new ExpectedToolError("meta_ads_page_read_failed", "(#10) needs pages_read_user_content", { http_status: 403, graph_code: 10 }))
      .mockResolvedValueOnce({ data: [{ id: "100_1", message: "hi", shares: { count: 2 } }] });
    const r = await readBoostOptions("t");
    expect(r).toMatchObject({ eligible: true, counts_hidden: true });
    if (r.eligible) expect(r.posts[0]).toMatchObject({ id: "100_1", likes: 0, comments: 0, shares: 2 });
    const fieldsSent = h.fbGet.mock.calls.map((c) => (c[2] as { fields: string }).fields);
    expect(fieldsSent[0]).toContain("likes.summary");
    expect(fieldsSent[1]).not.toContain("likes.summary");
  });

  it("a permission error on the posts read asks for a reconnect, never a retry", async () => {
    h.fbGet.mockRejectedValue(new ExpectedToolError("meta_ads_permission_revoked", "page grant gone"));
    expect(await readBoostOptions("t")).toMatchObject({ eligible: false, reason_code: "page_posts_permission_missing" });
  });

  it("a Page read failure that is not a permission refusal still says try again", async () => {
    h.fbGet.mockRejectedValue(new ExpectedToolError("meta_ads_page_read_failed", "boom", { http_status: 500, graph_code: 2 }));
    expect(await readBoostOptions("t")).toMatchObject({ eligible: false, reason_code: "lookup_failed" });
    expect(h.fbGet).toHaveBeenCalledTimes(1);
  });

  it("a permission error on the ad set read is lost account access, not a Page problem", async () => {
    h.adSets.mockRejectedValue(new ExpectedToolError("meta_ads_permission_revoked", "no"));
    expect(await readBoostOptions("t")).toMatchObject({ eligible: false, reason_code: "account_not_writable" });
  });

  it("an expired token says so instead of try again in a minute", async () => {
    h.fbGetAllPages.mockRejectedValue(new ExpectedToolError("meta_ads_token_expired", "expired"));
    expect(await readBoostOptions("t")).toMatchObject({ eligible: false, reason_code: "token_expired" });
  });

  it("a rate limited account says Meta is busy, on the account reads and the posts read", async () => {
    h.fbGetAllPages.mockRejectedValue(new ExpectedToolError("meta_ads_busy", "busy"));
    expect(await readBoostOptions("t")).toMatchObject({ eligible: false, reason_code: "meta_busy" });
    h.fbGetAllPages.mockResolvedValue([{ id: "100", name: "Upcar" }]);
    h.fbGet.mockRejectedValue(new ExpectedToolError("meta_ads_busy", "busy"));
    expect(await readBoostOptions("t")).toMatchObject({ eligible: false, reason_code: "meta_busy" });
  });
});

describe("mostEngagedPost", () => {
  it("picks the most likes + comments + shares", () => {
    const posts = [
      toBoostPost({ id: "1", likes: { summary: { total_count: 5 } } })!,
      toBoostPost({ id: "2", likes: { summary: { total_count: 2 } }, comments: { summary: { total_count: 2 } }, shares: { count: 2 } })!,
    ];
    expect(mostEngagedPost(posts)?.id).toBe("2");
    expect(mostEngagedPost([])).toBeNull();
  });
});
