import { describe, expect, it } from "vitest";
import { fetchLinkedInPublicPage, normalizeLinkedInUrl, parseLinkedInPublicPage } from "../public-page";

const ld = (graph: unknown[]) => `<script type="application/ld+json">${JSON.stringify({ "@graph": graph })}</script>`;
const post = (author: string, id: string, likes?: number) => ({
  "@type": "DiscussionForumPosting",
  author: { url: author },
  datePublished: "2026-09-10T10:00:00Z",
  text: `post ${id}`,
  url: `https://www.linkedin.com/posts/acme_slug-activity-${id}-abcd`,
  ...(likes === undefined ? {} : { interactionStatistic: { userInteractionCount: likes } }),
});

describe("normalizeLinkedInUrl", () => {
  it("canonicalizes member and company pages and refuses everything else", () => {
    expect(normalizeLinkedInUrl("be.linkedin.com/in/jane-doe/recent-activity/all/?x=1")).toBe("https://www.linkedin.com/in/jane-doe/");
    expect(normalizeLinkedInUrl("https://www.linkedin.com/company/acme")).toBe("https://www.linkedin.com/company/acme/");
    expect(normalizeLinkedInUrl("https://evil.com/in/jane")).toBeNull();
    expect(normalizeLinkedInUrl("https://linkedin.com.evil.com/in/jane")).toBeNull();
    expect(normalizeLinkedInUrl("https://www.linkedin.com/feed/")).toBeNull();
  });
});

describe("parseLinkedInPublicPage", () => {
  it("company: counters come from the post's own card", () => {
    const page = "https://www.linkedin.com/company/acme/";
    const html =
      `<h3>4,899 followers</h3>` +
      `<article data-activity-urn="urn:li:activity:7500000000000000001"><a data-num-reactions="120" data-num-comments="9"></a></article>` +
      ld([post("https://www.linkedin.com/company/acme", "7500000000000000001"), { "@type": "Organization", name: "Acme", sameAs: "https://acme.test/", description: "We make anvils.", logo: { contentUrl: "https://media.licdn.com/logo" } }]) +
      `<img class="cover-img__image x" src="https://static.licdn.com/aero-v1/sc/h/default">`;
    const r = parseLinkedInPublicPage(html, page);
    expect(r).toMatchObject({ kind: "company", name: "Acme", followers: 4899, website: "https://acme.test/", about: "We make anvils.", banner_url: null });
    expect(r.photo_url).toBe("https://media.licdn.com/logo");
    expect(r.posts).toEqual([expect.objectContaining({ id: "7500000000000000001", reactions: 120, comments: 9 })]);
  });

  it("member: only the page's own posts, comments joined only when unambiguous", () => {
    const me = "https://www.linkedin.com/in/jane/";
    const html =
      `<a data-num-reactions="999"></a><a data-num-comments="50"></a>` +
      `<a data-num-reactions="40"></a><a data-num-comments="7"></a>` +
      `<a data-num-reactions="15"></a><a data-num-comments="1"></a>` +
      `<a data-num-reactions="15"></a><a data-num-comments="2"></a>` +
      ld([
        post("https://www.linkedin.com/in/jane", "7500000000000000002", 40),
        post("https://www.linkedin.com/in/jane", "7500000000000000003", 15),
        post("https://www.linkedin.com/in/someone-else", "7500000000000000004", 999),
        { "@type": "Person", name: "Jane", interactionStatistic: { userInteractionCount: 1234 } },
      ]);
    const r = parseLinkedInPublicPage(html, me);
    expect(r.followers).toBe(1234);
    expect(r.posts.map((p) => [p.id, p.reactions, p.comments])).toEqual([
      ["7500000000000000002", 40, 7],
      ["7500000000000000003", 15, null],
    ]);
  });

  it("garbage in, empty page out", () => {
    expect(parseLinkedInPublicPage("<html>", "https://www.linkedin.com/in/x/")).toMatchObject({ kind: "member", name: null, followers: null, photo_url: null, posts: [] });
  });
});

describe("fetchLinkedInPublicPage", () => {
  it("a refusal while a control page still reads means THIS page is not public, and says so", async () => {
    const f = (async (u: string) => (u.includes("/company/linkedin/") ? { status: 200, ok: true, url: u, text: async () => "" } : { status: 999, ok: false, url: u, text: async () => "" })) as unknown as typeof fetch;
    await expect(fetchLinkedInPublicPage("https://www.linkedin.com/in/x/", f)).rejects.toMatchObject({ code: "linkedin_page_not_public" });
  });

  it("names LinkedIn's 999 and its login redirect as a refusal when the control is refused too", async () => {
    const as = (status: number, url: string) => (async () => ({ status, ok: status < 400, url, text: async () => "" })) as unknown as typeof fetch;
    await expect(fetchLinkedInPublicPage("https://www.linkedin.com/in/x/", as(999, "https://www.linkedin.com/in/x/"))).rejects.toMatchObject({ code: "linkedin_refused" });
    await expect(fetchLinkedInPublicPage("https://www.linkedin.com/in/x/", as(200, "https://www.linkedin.com/uas/login?x"))).rejects.toMatchObject({ code: "linkedin_refused" });
    await expect(fetchLinkedInPublicPage("https://www.linkedin.com/in/x/", as(404, "https://www.linkedin.com/in/x/"))).rejects.toMatchObject({ code: "linkedin_refused" });
  });
});
