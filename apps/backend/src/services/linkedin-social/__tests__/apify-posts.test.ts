import { describe, expect, it, vi } from "vitest";
import { ApifyLinkedInError, fetchLinkedInViaApify, pageFromApifyPosts } from "../apify-posts";

const COMPANY = "https://www.linkedin.com/company/upcarapp/";
const MEMBER = "https://www.linkedin.com/in/ravi-ramadasu/";
const companyItem = {
  id: "7366", linkedinUrl: "https://www.linkedin.com/posts/upcarapp_x", content: "We’re now live across 18 US states!",
  postedAt: { date: "2026-08-28T10:00:00.000Z" }, engagement: { likes: 12, comments: 1, shares: 2 },
  author: { universalName: "upcarapp", type: "company", name: "Upcar.ai", info: "10,840 followers" },
};
const memberItem = (likes: number, comments: number, shares: number, extra: object = {}) => ({
  id: `m-${likes}`, linkedinUrl: "https://www.linkedin.com/posts/ravi_x", content: "Distribution is hard.",
  postedAt: { date: "2026-09-01T10:00:00.000Z" }, engagement: { likes, comments, shares },
  author: { publicIdentifier: "ravi-ramadasu", type: "profile", name: "Ravi Ramadasu", info: "Building AI Magic at Zavi Labs" },
  ...extra,
});

describe("pageFromApifyPosts", () => {
  it("a company: posts, reposts, and the follower count out of `author.info`", () => {
    const page = pageFromApifyPosts([companyItem], COMPANY);
    expect(page).toMatchObject({ kind: "company", name: "Upcar.ai", followers: 10840 });
    expect(page.posts).toEqual([
      { id: "7366", url: companyItem.linkedinUrl, text: companyItem.content, posted_at: "2026-08-28T10:00:00.000Z", format: "post", reactions: 12, comments: 1, reposts: 2 },
    ]);
  });

  it("a member: a headline is NOT a follower count", () => {
    const page = pageFromApifyPosts([memberItem(63, 2, 0)], MEMBER);
    expect(page.kind).toBe("member");
    expect(page.followers).toBeNull();
    expect(page.posts[0]).toMatchObject({ reactions: 63, comments: 2, reposts: 0 });
  });

  it("drops a repost, and a post authored by somebody else", () => {
    const stranger = { ...memberItem(900, 50, 9), author: { publicIdentifier: "someone-else", name: "Someone" } };
    const page = pageFromApifyPosts([memberItem(10, 1, 0), memberItem(999, 9, 9, { repostId: "r1" }), stranger], MEMBER);
    expect(page.posts.map((p) => p.reactions)).toEqual([10]);
  });

  it("an item with no readable like count is skipped, never read as zero", () => {
    const page = pageFromApifyPosts([{ ...memberItem(1, 1, 1), engagement: {} }, null, "junk"], MEMBER);
    expect(page.posts).toEqual([]);
  });
});

describe("fetchLinkedInViaApify", () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });

  it("asks for the account's own recent posts, and nothing that costs extra", async () => {
    const fetchFn = vi.fn(async () => ok([companyItem]));
    const page = await fetchLinkedInViaApify(COMPANY, { fetchFn: fetchFn as never, token: "tok" });
    expect(page.followers).toBe(10840);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toContain("/acts/harvestapi~linkedin-profile-posts/run-sync-get-dataset-items");
    expect(JSON.parse(init.body)).toEqual({ targetUrls: [COMPANY], maxPosts: 10, includeReposts: false, scrapeReactions: false, scrapeComments: false });
  });

  it("no token → apify_unconfigured, and no request is made", async () => {
    const fetchFn = vi.fn();
    await expect(fetchLinkedInViaApify(COMPANY, { fetchFn: fetchFn as never, token: undefined })).rejects.toMatchObject({ code: "apify_unconfigured" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("an exhausted monthly cap is apify_quota_exhausted, not an auth failure", async () => {
    const fetchFn = async () => ({ ok: false, status: 403, text: async () => '{"error":{"type":"platform-feature-disabled","message":"Monthly usage hard limit exceeded"}}' });
    const err = await fetchLinkedInViaApify(COMPANY, { fetchFn: fetchFn as never, token: "tok" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApifyLinkedInError);
    expect(err.code).toBe("apify_quota_exhausted");
  });

  it("any other failure is apify_failed — the caller falls back either way", async () => {
    const fetchFn = async () => ({ ok: false, status: 500, text: async () => "boom" });
    await expect(fetchLinkedInViaApify(COMPANY, { fetchFn: fetchFn as never, token: "tok" })).rejects.toMatchObject({ code: "apify_failed" });
  });
});
