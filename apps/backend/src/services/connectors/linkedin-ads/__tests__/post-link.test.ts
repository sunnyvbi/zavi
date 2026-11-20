import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPostFromPage, attributedPostUrn, POST_FROM_SHOWCASE, POST_NOT_FOUND, POST_PAGE_MISMATCH, readCompanyPage, readPostForPage, readPublicPost, repostNote, resolvePastedPost, resolvePromotablePost, type FetchPostPage, type FollowShortLink } from "../post-link";

const ACTIVITY = "7499160133243912192";
const SHARE = "7499123090770288640";
const DECOY_ACTIVITY = "7499160133243912100";
const DECOY_SHARE = "7400000000000000001";

const page = (articles: string) => `<!doctype html><html><head><link rel="canonical" href="https://www.linkedin.com/posts/acme-share-${DECOY_SHARE}-x"></head><body>
<div data-test="related">urn:li:share:${DECOY_SHARE}</div>
${articles}
</body></html>`;

const article = (activity: string, attributed: string | null) =>
  `<article class="main-feed-activity-card" data-activity-urn="urn:li:activity:${activity}" data-featured-activity-urn="urn:li:activity:${activity}"${attributed ? ` data-attributed-urn="${attributed}"` : ""}> <div class="flex">post</div></article>`;

const LI_URL = "https://www.linkedin.com/posts/acme_x-share-7499123090770288640-F_PE/";
const ok = (html: string, url = LI_URL): FetchPostPage => vi.fn(async () => ({ ok: true, status: 200, url, text: async () => html }));
const neverCalled = (): FetchPostPage => vi.fn(async () => { throw new Error("must not fetch"); });

describe("resolvePromotablePost", () => {
  it("resolves the plain Copy-link-to-post URL to the share the post page attributes to that activity", async () => {
    const fetchPage = ok(page(article(DECOY_ACTIVITY, `urn:li:share:${DECOY_SHARE}`) + article(ACTIVITY, `urn:li:share:${SHARE}`)));
    const urn = await resolvePromotablePost(
      `https://www.linkedin.com/posts/upcarapp_upcar-carrental-carrentals-activity-${ACTIVITY}-kidi?utm_source=share&utm_medium=member_desktop&rcm=ACoAAG2aL8IBis1EgGtWGKyT43juslAzU2hQPqc`,
      fetchPage,
    );
    expect(urn).toBe(`urn:li:share:${SHARE}`);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(`https://www.linkedin.com/feed/update/urn:li:activity:${ACTIVITY}/`);
  });

  it("resolves a post link with no text slug before the activity or share id", async () => {
    const fetchPage = ok(page(article(ACTIVITY, `urn:li:share:${SHARE}`)));
    await expect(resolvePromotablePost(`https://www.linkedin.com/posts/acme_activity-${ACTIVITY}-abcd/`, fetchPage)).resolves.toBe(`urn:li:share:${SHARE}`);
    await expect(resolvePromotablePost(`https://www.linkedin.com/posts/acme_share-${SHARE}-abcd/`, neverCalled())).resolves.toBe(`urn:li:share:${SHARE}`);
  });

  it("resolves a feed/update link whose activity URN is percent-encoded", async () => {
    const fetchPage = ok(page(article(ACTIVITY, `urn:li:ugcPost:${SHARE}`)));
    await expect(resolvePromotablePost(`https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A${ACTIVITY}/`, fetchPage)).resolves.toBe(`urn:li:ugcPost:${SHARE}`);
  });

  it("never takes a share that sits elsewhere on the page when the asked activity carries no attribution", async () => {
    const fetchPage = ok(page(article(DECOY_ACTIVITY, `urn:li:share:${DECOY_SHARE}`) + article(ACTIVITY, null)));
    await expect(resolvePromotablePost(`urn:li:activity:${ACTIVITY}`, fetchPage)).resolves.toBeNull();
  });

  it("does not match an activity id that only starts with the asked one", async () => {
    const fetchPage = ok(page(article(`${ACTIVITY}9`, `urn:li:share:${DECOY_SHARE}`)));
    await expect(resolvePromotablePost(`urn:li:activity:${ACTIVITY}`, fetchPage)).resolves.toBeNull();
  });

  it("uses a share or ugcPost already in the paste without calling LinkedIn", async () => {
    const fetchPage = neverCalled();
    await expect(resolvePromotablePost(`urn:li:ugcPost:${SHARE}`, fetchPage)).resolves.toBe(`urn:li:ugcPost:${SHARE}`);
    await expect(resolvePromotablePost(`https://www.linkedin.com/posts/upcar-carrental-carrentals-share-${SHARE}-F_PE/`, fetchPage)).resolves.toBe(`urn:li:share:${SHARE}`);
    await expect(
      resolvePromotablePost(`<iframe src="https://www.linkedin.com/embed/feed/update/urn:li:share:${SHARE}" height="600" title="Embedded post"></iframe>`, fetchPage),
    ).resolves.toBe(`urn:li:share:${SHARE}`);
    await expect(resolvePromotablePost(`https://www.linkedin.com/embed/feed/update/urn%3Ali%3Augcpost%3A${SHARE}`, fetchPage)).resolves.toBe(`urn:li:ugcPost:${SHARE}`);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("returns null without calling LinkedIn when the paste names no post at all", async () => {
    const fetchPage = neverCalled();
    await expect(resolvePromotablePost("https://www.linkedin.com/company/acme/", fetchPage)).resolves.toBeNull();
    await expect(resolvePromotablePost("https://www.linkedin.com/posts/acme_share-your-car-activity-12-x", fetchPage)).resolves.toBeNull();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("a page LinkedIn will not serve is a named error, never a silent miss", async () => {
    const fetchPage: FetchPostPage = vi.fn(async () => ({ ok: false, status: 999, url: LI_URL, text: async () => page(article(ACTIVITY, `urn:li:share:${SHARE}`)) }));
    await expect(resolvePromotablePost(`urn:li:activity:${ACTIVITY}`, fetchPage)).rejects.toMatchObject({ code: "linkedin_ads_post_unreadable" });
  });

  it("a network failure or timeout is the same named error", async () => {
    const fetchPage: FetchPostPage = vi.fn(async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); });
    await expect(resolvePromotablePost(`urn:li:activity:${ACTIVITY}`, fetchPage)).rejects.toMatchObject({ code: "linkedin_ads_post_unreadable" });
  });
});

  it("a response that ended up off linkedin.com is refused even when its body looks right", async () => {
    const fetchPage = ok(page(article(ACTIVITY, `urn:li:share:${SHARE}`)), "https://evil.example.com/linkedin.com/feed/");
    await expect(resolvePromotablePost(`urn:li:activity:${ACTIVITY}`, fetchPage)).rejects.toMatchObject({ code: "linkedin_ads_post_unreadable" });
    const sub = ok(page(article(ACTIVITY, `urn:li:share:${SHARE}`)), "https://in.linkedin.com/feed/update/x/");
    await expect(resolvePromotablePost(`urn:li:activity:${ACTIVITY}`, sub)).resolves.toBe(`urn:li:share:${SHARE}`);
  });

  it("LinkedIn's sign-up wall (a personal-profile post, signed out) is unreadable, never a silent miss", async () => {
    const wall = ok("<html><title>Sign Up | LinkedIn</title></html>", `https://www.linkedin.com/signup/cold-join?session_redirect=https%3A%2F%2Fwww.linkedin.com%2Ffeed%2Fupdate%2Furn%3Ali%3Aactivity%3A${ACTIVITY}`);
    await expect(resolvePromotablePost(`https://www.linkedin.com/posts/dev-zavi_x-activity-${ACTIVITY}-QHUj`, wall)).rejects.toMatchObject({ code: "linkedin_ads_post_unreadable" });
    const authwall = ok(page(article(ACTIVITY, `urn:li:share:${SHARE}`)), "https://www.linkedin.com/authwall?trk=bf");
    await expect(resolvePromotablePost(`urn:li:activity:${ACTIVITY}`, authwall)).rejects.toMatchObject({ code: "linkedin_ads_post_unreadable" });
  });

  it("a run of more than 25 digits is not silently cut to an id", async () => {
    const fetchPage = neverCalled();
    await expect(resolvePromotablePost(`urn:li:share:${"7".repeat(26)}`, fetchPage)).resolves.toBeNull();
    await expect(resolvePromotablePost(`https://www.linkedin.com/posts/acme_x-activity-${"7".repeat(26)}-ab`, fetchPage)).resolves.toBeNull();
    expect(fetchPage).not.toHaveBeenCalled();
  });

describe("attributedPostUrn", () => {
  it("reads the attribution off the tag that carries the asked activity, in either attribute order", () => {
    const reversed = `<article data-attributed-urn="urn:li:share:${SHARE}" class="x" data-activity-urn="urn:li:activity:${ACTIVITY}">`;
    expect(attributedPostUrn(page(reversed), ACTIVITY)).toBe(`urn:li:share:${SHARE}`);
  });
});

describe("assertPostFromPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const answer = (status: number, body: unknown = {}) => {
    const fetchSpy = vi.fn(async () => ({ ok: status < 400, status, json: async () => body }));
    vi.stubGlobal("fetch", fetchSpy);
    return fetchSpy;
  };
  const POST = "urn:li:share:7000000000000000001";

  it.each([
    ["the same page", "urn:li:organization:42", "urn:li:organization:42", "page"],
    ["a member's Thought Leader post", "urn:li:organization:42", "urn:li:person:abc", "member"],
    ["a company page under a brand-page account", "urn:li:organizationBrand:42", "urn:li:organization:99", "other_page"],
    ["the same brand page", "urn:li:organizationBrand:42", "urn:li:organizationBrand:42", "page"],
    ["no author", "urn:li:organization:42", undefined, "unknown"],
    ["an author that is not a string", "urn:li:organization:42", { id: "urn:li:organization:99" }, "unknown"],
    ["an organization urn with a suffix", "urn:li:organization:42", "urn:li:organization:99x", "unknown"],
  ])("lets %s through for LinkedIn to judge", async (_label, page, author, kind) => {
    const fetchSpy = answer(200, { id: POST, author });
    await expect(assertPostFromPage("tok", POST, page)).resolves.toBe(kind);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another company page", "urn:li:organization:42", "urn:li:organization:99"],
    ["a company page whose id starts with the account's", "urn:li:organization:42", "urn:li:organization:420"],
    ["another brand page", "urn:li:organizationBrand:42", "urn:li:organizationBrand:99"],
  ])("refuses a post from %s", async (_label, page, author) => {
    answer(200, { id: POST, author });
    await expect(assertPostFromPage("tok", POST, page)).rejects.toMatchObject({ code: "linkedin_ads_post_page_mismatch", message: POST_PAGE_MISMATCH });
  });

  it.each(["urn:li:organizationBrand:99", "urn:li:organizationBrand:42"])("refuses a Showcase page post (%s) under a company-page account, which LinkedIn never runs as that page's ad", async (author) => {
    answer(200, { id: POST, author });
    await expect(assertPostFromPage("tok", POST, "urn:li:organization:42")).rejects.toMatchObject({ code: "linkedin_ads_post_page_mismatch", message: POST_FROM_SHOWCASE });
    await expect(readPostForPage("tok", POST, "urn:li:organization:42")).rejects.toMatchObject({ code: "linkedin_ads_post_page_mismatch", message: POST_FROM_SHOWCASE });
  });

  it.each([403, 404, 429, 500, 502])("does not block when the post read answers %s", async (status) => {
    answer(status);
    await expect(assertPostFromPage("tok", POST, "urn:li:organization:42")).resolves.toBe("unknown");
  });

  it("does not block when the post read never answers or returns junk", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(assertPostFromPage("tok", POST, "urn:li:organization:42")).resolves.toBe("unknown");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); } })));
    await expect(assertPostFromPage("tok", POST, "urn:li:organization:42")).resolves.toBe("unknown");
  });

  it("rethrows a 401 as token_revoked so the refresh wrapper can spend the refresh token", async () => {
    answer(401);
    await expect(assertPostFromPage("tok", POST, "urn:li:organization:42")).rejects.toMatchObject({ code: "linkedin_ads_token_revoked" });
  });
});

describe("readPublicPost", () => {
  const POST = "urn:li:share:7000000000000000001";
  const ld = (node: unknown) => `<script type="application/ld+json">${JSON.stringify(node)}</script>`;
  const posting = (author: unknown) => ({ "@type": "SocialMediaPosting", articleBody: " Hello. ", author });
  const company = { name: "Acme", url: "https://www.linkedin.com/company/acme", "@type": "Organization" };
  const tracked = (urn: string) => `<code id="flagshipOrganizationTracking" style="display: none"><!--${JSON.stringify({ organization: { objectUrn: urn } })}--></code>`;
  const site = (postHtml: string, companyHtml: string, companyLanded = "https://www.linkedin.com/company/acme/"): FetchPostPage => vi.fn(async (url: string) =>
    url === `https://www.linkedin.com/feed/update/${POST}/`
      ? { ok: true, status: 200, url, text: async () => postHtml }
      : url === "https://www.linkedin.com/company/acme/"
        ? { ok: true, status: 200, url: companyLanded, text: async () => companyHtml }
        : { ok: false, status: 404, url, text: async () => "" });

  it("names the company page id behind the post's public author", async () => {
    await expect(readPublicPost(POST, site(ld(posting(company)), tracked("urn:li:organization:99")))).resolves.toEqual({ author_page: "urn:li:organization:99", text: "Hello." });
  });

  it.each([
    ["the company page lands on a sign-in wall", ld(posting(company)), tracked("urn:li:organization:99"), "https://www.linkedin.com/authwall?trk=x"],
    ["the company page redirects to another page", ld(posting(company)), tracked("urn:li:organization:99"), "https://www.linkedin.com/company/other/"],
    ["the company page id has a suffix", ld(posting(company)), tracked("urn:li:organization:99x"), undefined],
    ["the company page carries no tracking block", ld(posting(company)), `<a data-semaphore-content-urn="urn:li:organization:99"></a>`, undefined],
    ["the page shows two posts", ld(posting(company)) + ld(posting({ ...company, url: "https://www.linkedin.com/company/other" })), tracked("urn:li:organization:99"), undefined],
    ["the author is a person", ld(posting({ name: "A", url: "https://www.linkedin.com/in/a", "@type": "Person" })), tracked("urn:li:organization:99"), undefined],
    ["the author url leaves linkedin.com", ld(posting({ ...company, url: "https://evil.example/company/acme" })), tracked("urn:li:organization:99"), undefined],
  ])("names no page when %s", async (_label, postHtml, companyHtml, landed) => {
    const r = await readPublicPost(POST, site(postHtml, companyHtml, landed));
    expect(r.author_page).toBeNull();
  });

  it("names nothing when the post page is unreadable or its JSON is broken", async () => {
    await expect(readPublicPost(POST, vi.fn(async () => { throw new TypeError("fetch failed"); }))).resolves.toEqual({ author_page: null, text: null });
    await expect(readPublicPost(POST, site(`<script type="application/ld+json">{"@type":</script>`, tracked("urn:li:organization:99")))).resolves.toEqual({ author_page: null, text: null });
  });
});

describe("assertPostFromPage with the public post as fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const POST = "urn:li:share:7000000000000000001";
  const denied = () => vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ code: "ACCESS_DENIED" }) })));

  it("refuses a post the public page credits to another company page", async () => {
    denied();
    await expect(assertPostFromPage("tok", POST, "urn:li:organization:42", async () => ({ author_page: "urn:li:organization:99", text: null }))).rejects.toMatchObject({ code: "linkedin_ads_post_page_mismatch" });
  });

  it("passes the account's own page and stays unknown with no public author", async () => {
    denied();
    await expect(assertPostFromPage("tok", POST, "urn:li:organization:42", async () => ({ author_page: "urn:li:organization:42", text: null }))).resolves.toBe("page");
    await expect(assertPostFromPage("tok", POST, "urn:li:organization:42", async () => ({ author_page: null, text: "x" }))).resolves.toBe("unknown");
  });

  it("never asks the public page when the posts read answers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ author: "urn:li:organization:42" }) })));
    const readPublic = vi.fn(async () => ({ author_page: "urn:li:organization:99", text: null }));
    await expect(assertPostFromPage("tok", POST, "urn:li:organization:42", readPublic)).resolves.toBe("page");
    expect(readPublic).not.toHaveBeenCalled();
  });
});

describe("readPostForPage when the posts read fails and the public post names its author", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const POST = "urn:li:share:7464457711406182401";
  const ld = (author: unknown) => `<script type="application/ld+json">${JSON.stringify({ "@type": "SocialMediaPosting", articleBody: " Personal post. ", author })}</script>`;
  const tracked = (urn: string) => `<code id="flagshipOrganizationTracking" style="display: none"><!--${JSON.stringify({ organization: { objectUrn: urn } })}--></code>`;
  const person = { name: "Mohit", url: "https://www.linkedin.com/in/mohit", "@type": "Person" };
  const site = (postHtml: string, companies: Record<string, { html: string; landed?: string }> = {}) => vi.fn(async (url: string) => {
    if (url === `https://www.linkedin.com/feed/update/${POST}/`) return { ok: true, status: 200, url, text: async () => postHtml };
    const slug = url.match(/^https:\/\/www\.linkedin\.com\/company\/([^/]+)\/$/)?.[1];
    const company = slug ? companies[slug] : undefined;
    return company ? { ok: true, status: 200, url: company.landed ?? url, text: async () => company.html } : { ok: false, status: 404, url, text: async () => "" };
  });
  const postsRead = (status: number) => {
    const spy = vi.fn(async () => ({ ok: false, status, json: async () => ({ code: "ACCESS_DENIED" }) }));
    vi.stubGlobal("fetch", spy);
    return spy;
  };

  it.each([403, 404, 500])("calls a public Person author a member when the posts read answers %s", async (status) => {
    const posts = postsRead(status);
    const fetchPage = site(ld(person));
    await expect(readPostForPage("tok", POST, "urn:li:organization:559148166", () => readPublicPost(POST, fetchPage))).resolves.toEqual({ author: "member", text: "Personal post." });
    expect(posts).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(`https://www.linkedin.com/feed/update/${POST}/`);
  });

  it("marks a Person author as a member on the public read without naming a page", async () => {
    await expect(readPublicPost(POST, site(ld(person)))).resolves.toEqual({ author_page: null, author_kind: "member", text: "Personal post." });
    await expect(readPublicPost(POST, site(ld({ "@type": "Person" })))).resolves.toEqual({ author_page: null, author_kind: "member", text: "Personal post." });
  });

  it("still refuses or flags an Organization author whose company page is not the account's", async () => {
    postsRead(403);
    const acme = { name: "Acme", url: "https://www.linkedin.com/company/acme", "@type": "Organization" };
    const other = site(ld(acme), { acme: { html: tracked("urn:li:organization:99") } });
    await expect(readPostForPage("tok", POST, "urn:li:organization:42", () => readPublicPost(POST, other))).rejects.toMatchObject({ code: "linkedin_ads_post_page_mismatch", message: POST_PAGE_MISMATCH });
    await expect(readPostForPage("tok", POST, "urn:li:organizationBrand:42", () => readPublicPost(POST, other))).resolves.toEqual({ author: "other_page", text: "Personal post." });
    const moved = site(ld(acme), { acme: { html: tracked("urn:li:organization:99"), landed: "https://www.linkedin.com/company/elsewhere/" } });
    await expect(readPostForPage("tok", POST, "urn:li:organization:42", () => readPublicPost(POST, moved))).resolves.toEqual({ author: "unknown", text: "Personal post." });
    const untracked = site(ld(acme), { acme: { html: "<html></html>" } });
    await expect(readPostForPage("tok", POST, "urn:li:organization:42", () => readPublicPost(POST, untracked))).resolves.toEqual({ author: "unknown", text: "Personal post." });
  });

  it.each([
    ["no author", undefined],
    ["an author with no @type", { name: "Mohit", url: "https://www.linkedin.com/in/mohit" }],
    ["a lower-case person type", { ...person, "@type": "person" }],
    ["a padded Person type", { ...person, "@type": " Person " }],
    ["a type list", { ...person, "@type": ["Person"] }],
    ["a ProfilePage type", { ...person, "@type": "ProfilePage" }],
    ["an author that is a string", "Mohit"],
    ["an author list", [person]],
  ])("stays unknown with %s", async (_label, author) => {
    postsRead(403);
    const fetchPage = site(ld(author));
    await expect(readPostForPage("tok", POST, "urn:li:organization:42", () => readPublicPost(POST, fetchPage))).resolves.toEqual({ author: "unknown", text: "Personal post." });
    expect((await readPublicPost(POST, fetchPage)).author_kind).toBeUndefined();
  });

  it("stays unknown for a Person author when two postings are on the page", async () => {
    postsRead(403);
    const fetchPage = site(ld(person) + ld(person));
    await expect(readPostForPage("tok", POST, "urn:li:organization:42", () => readPublicPost(POST, fetchPage))).resolves.toEqual({ author: "unknown", text: null });
  });

  it("trusts the posts read over a public Person author", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ author: "urn:li:organization:42", commentary: "Own." }) })));
    const readPublic = vi.fn(async () => ({ author_page: null, author_kind: "member" as const, text: "x" }));
    await expect(readPostForPage("tok", POST, "urn:li:organization:42", readPublic)).resolves.toEqual({ author: "page", text: "Own." });
    expect(readPublic).not.toHaveBeenCalled();
  });

  it("never reads the public page on the launch path, so a member post stays unknown there", async () => {
    postsRead(403);
    await expect(assertPostFromPage("tok", POST, "urn:li:organization:42")).resolves.toBe("unknown");
  });
});

describe("resolvePromotablePost with an lnkd.in short link", () => {
  const SHORT = "https://lnkd.in/p/d7CRxdu7";
  const goesTo = (location: string | null, status = 301): FollowShortLink => vi.fn(async () => ({ status, location }));

  it("follows one lnkd.in redirect to the post's linkedin.com address and reads the share from it", async () => {
    const followLink = goesTo(`https://www.linkedin.com/posts/acme_halloween-share-${SHARE}-6Y8D/?utm_source=share&utm_medium=member_desktop`);
    const fetchPage = neverCalled();
    await expect(resolvePromotablePost(SHORT, fetchPage, followLink)).resolves.toBe(`urn:li:share:${SHARE}`);
    expect(followLink).toHaveBeenCalledTimes(1);
    expect(followLink).toHaveBeenCalledWith(SHORT);
  });

  it("asks lnkd.in over https for a short link pasted with http and surrounding text", async () => {
    const followLink = goesTo(`https://www.linkedin.com/posts/acme-ugcPost-${SHARE}-x/`);
    await expect(resolvePromotablePost(`look at this http://lnkd.in/p/d7CRxdu7?trk=x please`, neverCalled(), followLink)).resolves.toBe(`urn:li:ugcPost:${SHARE}`);
    expect(followLink).toHaveBeenCalledWith(SHORT);
  });

  it("resolves an activity the short link lands on through the post page, as for a pasted activity link", async () => {
    const followLink = goesTo(`https://www.linkedin.com/posts/acme_x-activity-${ACTIVITY}-kidi?utm_source=share`);
    const fetchPage = ok(page(article(DECOY_ACTIVITY, `urn:li:share:${DECOY_SHARE}`) + article(ACTIVITY, `urn:li:share:${SHARE}`)));
    await expect(resolvePromotablePost(SHORT, fetchPage, followLink)).resolves.toBe(`urn:li:share:${SHARE}`);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(`https://www.linkedin.com/feed/update/urn:li:activity:${ACTIVITY}/`);
  });

  it.each([
    ["another site whose path names a post", `https://evil.example/www.linkedin.com/posts/acme-share-${SHARE}-x/`],
    ["another site whose query names a post urn", `https://evil.example/?post=urn:li:share:${SHARE}`],
    ["a host that only starts with linkedin.com", `https://linkedin.com.evil.example/?u=linkedin.com/posts/acme-share-${SHARE}-x/`],
    ["a host that only ends with linkedin.com", `https://evillinkedin.com/posts/acme-share-${SHARE}-x/`],
    ["plain http linkedin.com", `http://www.linkedin.com/posts/acme-share-${SHARE}-x/`],
    ["another lnkd.in link", `https://lnkd.in/p/other?u=urn:li:share:${SHARE}`],
    ["a relative lnkd.in path", `/feed/update/urn:li:share:${SHARE}/`],
  ])("does not take a post id from a short link that leads to %s, and follows no second hop", async (_label, location) => {
    const followLink = goesTo(location);
    const fetchPage = neverCalled();
    await expect(resolvePromotablePost(SHORT, fetchPage, followLink)).resolves.toBeNull();
    expect(followLink).toHaveBeenCalledTimes(1);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it.each([
    ["answers 200 with no redirect", goesTo(null, 200)],
    ["answers 404", goesTo(null, 404)],
    ["redirects with no location", goesTo(null, 301)],
    ["times out", vi.fn(async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }) as FollowShortLink],
  ])("asks for the full link when lnkd.in %s", async (_label, followLink) => {
    await expect(resolvePromotablePost(SHORT, neverCalled(), followLink)).rejects.toMatchObject({ code: "linkedin_ads_post_unreadable", message: expect.stringContaining("lnkd.in short link") });
  });

  it("never calls lnkd.in when the paste already names the post", async () => {
    const followLink = vi.fn() as unknown as FollowShortLink;
    await expect(resolvePromotablePost(`${SHORT} urn:li:share:${SHARE}`, neverCalled(), followLink)).resolves.toBe(`urn:li:share:${SHARE}`);
    expect(followLink).not.toHaveBeenCalled();
  });

  it("never calls lnkd.in for a look-alike host", async () => {
    const followLink = vi.fn() as unknown as FollowShortLink;
    await expect(resolvePromotablePost("https://lnkd.in.evil.example/p/d7CRxdu7", neverCalled(), followLink)).resolves.toBeNull();
    await expect(resolvePromotablePost("https://xlnkd.in/p/d7CRxdu7", neverCalled(), followLink)).resolves.toBeNull();
    expect(followLink).not.toHaveBeenCalled();
  });
});

describe("a post LinkedIn says does not exist", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const POST = "urn:li:share:7000000000000000001";
  const answered = (status: number): FetchPostPage => vi.fn(async (url: string) => ({ ok: status < 400, status, url, text: async () => "<html/>" }));
  const api = (status: number) => vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status < 400, status, json: async () => ({}) })));

  it.each([404, 410])("says a pasted activity is not found, not private, when its public page answers %s", async (status) => {
    const r = resolvePromotablePost("https://www.linkedin.com/feed/update/urn:li:activity:1234567890123456789/", answered(status));
    await expect(r).rejects.toMatchObject({ code: "linkedin_ads_post_not_found", message: POST_NOT_FOUND });
  });

  it.each([403, 429, 500, 999])("keeps the privacy answer when the public page answers %s", async (status) => {
    await expect(resolvePromotablePost("urn:li:activity:1234567890123456789", answered(status))).rejects.toMatchObject({ code: "linkedin_ads_post_unreadable", message: expect.stringContaining("did not show this post") });
  });

  it("keeps the privacy answer for a sign-in wall or a network failure", async () => {
    const walled: FetchPostPage = vi.fn(async () => ({ ok: true, status: 200, url: "https://www.linkedin.com/authwall?trk=x", text: async () => "" }));
    await expect(resolvePromotablePost("urn:li:activity:1234567890123456789", walled)).rejects.toMatchObject({ code: "linkedin_ads_post_unreadable" });
    await expect(resolvePromotablePost("urn:li:activity:1234567890123456789", vi.fn(async () => { throw new TypeError("fetch failed"); }))).rejects.toMatchObject({ code: "linkedin_ads_post_unreadable" });
  });

  it("tells the user to check the link when a made-up activity link is redirected to the signup wall", async () => {
    const fake = "7000000000000000001";
    const redirected: FetchPostPage = vi.fn(async () => ({ ok: true, status: 200, url: `https://www.linkedin.com/signup/cold-join?session_redirect=https%3A%2F%2Fwww.linkedin.com%2Ffeed%2Fupdate%2Furn%3Ali%3Aactivity%3A${fake}%2F`, text: async () => "<html><title>Sign Up | LinkedIn</title></html>" }));
    const caught = await resolvePromotablePost(`https://www.linkedin.com/feed/update/urn:li:activity:${fake}/`, redirected).catch((e) => e);
    expect(caught).toMatchObject({ code: "linkedin_ads_post_unreadable" });
    expect(caught.message.startsWith("LinkedIn did not show this post to Zavi. Check the link opens the right post.")).toBe(true);
    expect(caught.message).toContain("members-only");
    expect(caught.message).toContain("Embed this post");
    expect(redirected).toHaveBeenCalledTimes(1);
  });

  it.each([404, 410])("marks the public post missing only when its page answers %s", async (status) => {
    await expect(readPublicPost(POST, answered(status))).resolves.toEqual({ author_page: null, text: null, missing: true });
  });

  it.each([403, 500])("does not mark the public post missing when its page answers %s", async (status) => {
    await expect(readPublicPost(POST, answered(status))).resolves.toEqual({ author_page: null, text: null });
  });

  it("does not mark the post missing when only the author's company page is gone", async () => {
    const posting = `<script type="application/ld+json">${JSON.stringify({ "@type": "SocialMediaPosting", articleBody: "Hi", author: { "@type": "Organization", url: "https://www.linkedin.com/company/gone" } })}</script>`;
    const fetchPage: FetchPostPage = vi.fn(async (url: string) => url.includes("/feed/update/") ? { ok: true, status: 200, url, text: async () => posting } : { ok: false, status: 404, url, text: async () => "" });
    await expect(readPublicPost(POST, fetchPage)).resolves.toEqual({ author_page: null, text: "Hi" });
  });

  it("refuses as not found when the posts read answers 404 and the public page is gone", async () => {
    api(404);
    await expect(assertPostFromPage("tok", POST, "urn:li:organization:42", async () => ({ author_page: null, text: null, missing: true }))).rejects.toMatchObject({ code: "linkedin_ads_post_not_found", message: POST_NOT_FOUND });
  });

  it.each([403, 429, 500])("stays unknown when the posts read answers %s even if the public page is gone", async (status) => {
    api(status);
    await expect(assertPostFromPage("tok", POST, "urn:li:organization:42", async () => ({ author_page: null, text: null, missing: true }))).resolves.toBe("unknown");
  });

  it("stays unknown on a posts 404 when the public page is walled, or when no public read is offered", async () => {
    api(404);
    await expect(assertPostFromPage("tok", POST, "urn:li:organization:42", async () => ({ author_page: null, text: null }))).resolves.toBe("unknown");
    await expect(assertPostFromPage("tok", POST, "urn:li:organization:42")).resolves.toBe("unknown");
  });
});

describe("readPublicPost with a regional or tracked author link", () => {
  const POST = "urn:li:share:7000000000000000001";
  const tracked = (urn: string) => `<code id="flagshipOrganizationTracking" style="display: none"><!--${JSON.stringify({ organization: { objectUrn: urn } })}--></code>`;
  const authored = (url: string) => `<script type="application/ld+json">${JSON.stringify({ "@type": "SocialMediaPosting", articleBody: "Debut ships apps.", author: { "@type": "Organization", name: "Debut Infotech", url } })}</script>`;
  const site = (authorUrl: string, landed = "https://www.linkedin.com/company/debut-infotech/") => vi.fn(async (url: string) =>
    url === `https://www.linkedin.com/feed/update/${POST}/`
      ? { ok: true, status: 200, url, text: async () => authored(authorUrl) }
      : url === "https://www.linkedin.com/company/debut-infotech/"
        ? { ok: true, status: 200, url: landed, text: async () => tracked("urn:li:organization:9001") }
        : { ok: false, status: 404, url, text: async () => "" });

  it.each([
    "https://in.linkedin.com/company/debut-infotech",
    "https://in.linkedin.com/company/debut-infotech?trk=public_post_feed-actor-name",
    "https://www.linkedin.com/company/debut-infotech/?trk=public_post_feed-actor-image",
    "https://linkedin.com/company/debut-infotech#about",
  ])("names the author page from %s", async (authorUrl) => {
    const fetchPage = site(authorUrl);
    await expect(readPublicPost(POST, fetchPage)).resolves.toEqual({ author_page: "urn:li:organization:9001", text: "Debut ships apps." });
    expect(fetchPage).toHaveBeenCalledWith("https://www.linkedin.com/company/debut-infotech/");
  });

  it("follows a regional redirect of the company page when it keeps the same slug", async () => {
    await expect(readPublicPost(POST, site("https://in.linkedin.com/company/debut-infotech", "https://in.linkedin.com/company/debut-infotech/"))).resolves.toMatchObject({ author_page: "urn:li:organization:9001" });
  });

  it.each([
    "https://evil.linkedin.com.example/company/debut-infotech",
    "https://in.linkedin.com.evil.example/company/debut-infotech",
    "https://xyz.linkedin.com/company/debut-infotech",
    "http://in.linkedin.com/company/debut-infotech",
    "https://in.linkedin.com/company/debut-infotech/jobs",
    "https://in.linkedin.com/showcase/debut-infotech",
    "https://in.linkedin.com/company/debut-infotech?trk=x y",
  ])("names no page from %s", async (authorUrl) => {
    const fetchPage = site(authorUrl);
    await expect(readPublicPost(POST, fetchPage)).resolves.toEqual({ author_page: null, text: "Debut ships apps." });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});

describe("readCompanyPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const LOGO = "https://media.licdn.com/dms/image/v2/C4D0BAQ/company-logo_400_400/0?e=1&v=beta&t=x";
  const streams = (...urls: unknown[]) => ({ logoV2: { original: "urn:li:digitalmediaAsset:C4D0BAQ", "original~": { elements: urls.map((identifier) => ({ identifiers: [{ identifier }] })) } } });
  const org = (named: { status: number; body?: unknown }, logo: { status: number; body?: unknown }) => {
    const spy = vi.fn(async (input: string) => {
      const a = new URL(input).searchParams.has("projection") ? logo : named;
      return { ok: a.status < 400, status: a.status, json: async () => (a.body === "junk" ? Promise.reject(new SyntaxError("x")) : a.body) };
    });
    vi.stubGlobal("fetch", spy);
    return spy;
  };

  it("reads the page's name and its largest https logo with the given token", async () => {
    const spy = org({ status: 200, body: { id: 42, localizedName: "  Zavi Labs " } }, { status: 200, body: streams("https://media.licdn.com/small", LOGO) });
    await expect(readCompanyPage("tok-a", "urn:li:organization:42")).resolves.toEqual({ name: "Zavi Labs", logo_url: LOGO });
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [url, init] of spy.mock.calls as unknown as Array<[string, { headers: Record<string, string> }]>) {
      expect(new URL(url).pathname).toBe("/rest/organizations/42");
      expect(init.headers.Authorization).toBe("Bearer tok-a");
    }
  });

  it.each([
    ["the name read answers 404", { status: 404 }, { status: 200, body: streams(LOGO) }, { name: null, logo_url: LOGO }],
    ["the logo read answers 403", { status: 200, body: { localizedName: "Zavi Labs" } }, { status: 403 }, { name: "Zavi Labs", logo_url: null }],
    ["both reads answer 401", { status: 401 }, { status: 401 }, { name: null, logo_url: null }],
    ["both reads answer 500", { status: 500 }, { status: 500 }, { name: null, logo_url: null }],
    ["both answers are junk", { status: 200, body: "junk" }, { status: 200, body: "junk" }, { name: null, logo_url: null }],
    ["the name is blank and the logo has no streams", { status: 200, body: { localizedName: "  " } }, { status: 200, body: { logoV2: { original: "urn:li:digitalmediaAsset:x" } } }, { name: null, logo_url: null }],
    ["the name is not a string and the logo is http or not a url", { status: 200, body: { localizedName: { en_US: "Zavi" } } }, { status: 200, body: streams("http://media.licdn.com/x", "javascript:alert(1)", "not a url", 7) }, { name: null, logo_url: null }],
    ["the body is null", { status: 200, body: null }, { status: 200, body: null }, { name: null, logo_url: null }],
  ])("returns nulls instead of failing when %s", async (_label, named, logo, want) => {
    org(named, logo);
    await expect(readCompanyPage("tok", "urn:li:organization:42")).resolves.toEqual(want);
  });

  it("does not fail when LinkedIn never answers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(readCompanyPage("tok", "urn:li:organization:42")).resolves.toEqual({ name: null, logo_url: null });
  });

  it.each(["urn:li:organizationBrand:42", "urn:li:organization:42/x", "urn:li:person:42", ""])("calls nothing for %j", async (page) => {
    const spy = org({ status: 200, body: { localizedName: "x" } }, { status: 200, body: streams(LOGO) });
    await expect(readCompanyPage("tok", page)).resolves.toEqual({ name: null, logo_url: null });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("a pasted activity that LinkedIn attributes to an earlier post", () => {
  const REPOST_ACTIVITY = "7464457711406182401";
  const ORIGINAL = "urn:li:share:7463260970245758976";
  const at = (activity: string, attributed: string) => ok(page(article(DECOY_ACTIVITY, `urn:li:share:${DECOY_SHARE}`) + article(activity, attributed)));

  it("keeps the original post LinkedIn attributes, and marks the link as a repost of a post first made on its own day", async () => {
    const fetchPage = at(REPOST_ACTIVITY, ORIGINAL);
    await expect(resolvePastedPost(`https://www.linkedin.com/feed/update/urn:li:activity:${REPOST_ACTIVITY}/`, fetchPage)).resolves.toEqual({ post_urn: ORIGINAL, reposted_from: "2026-05-21" });
    await expect(resolvePromotablePost(`https://www.linkedin.com/feed/update/urn:li:activity:${REPOST_ACTIVITY}/`, at(REPOST_ACTIVITY, ORIGINAL))).resolves.toBe(ORIGINAL);
  });

  it("marks a repost reached through an lnkd.in short link the same way", async () => {
    const followLink = vi.fn(async () => ({ status: 301, location: `https://www.linkedin.com/posts/upcarapp_x-activity-${REPOST_ACTIVITY}-kidi?utm_source=share` })) as FollowShortLink;
    await expect(resolvePastedPost("https://lnkd.in/p/abc123", at(REPOST_ACTIVITY, ORIGINAL), followLink)).resolves.toEqual({ post_urn: ORIGINAL, reposted_from: "2026-05-21" });
  });

  it.each([
    ["published the same moment as its activity", "7521456406655434752", "urn:li:share:7521456406189867008"],
    ["whose activity came a few hours after the share", ACTIVITY, `urn:li:share:${SHARE}`],
    ["one day apart less a minute", String((BigInt("7463260970245758976") >> BigInt(22)) + BigInt(86_340_000) << BigInt(22)), "urn:li:share:7463260970245758976"],
    ["whose share id is later than its activity", "7463260970245758976", "urn:li:ugcPost:7464457711406182401"],
  ])("does not call a post %s a repost", async (_label, activity, attributed) => {
    await expect(resolvePastedPost(`urn:li:activity:${activity}`, at(activity, attributed))).resolves.toEqual({ post_urn: attributed });
  });

  it("never marks a pasted share or embed as a repost, and never reads LinkedIn for it", async () => {
    await expect(resolvePastedPost(`urn:li:share:7463260970245758976 urn:li:activity:${REPOST_ACTIVITY}`, neverCalled())).resolves.toEqual({ post_urn: ORIGINAL });
  });

  it("says plainly that LinkedIn runs the original, by whom, and on what day it was first posted", () => {
    expect(repostNote("2026-05-21", "Upcar.ai")).toBe("This link is a repost. LinkedIn will run the original post by Upcar.ai, first posted on 21 May 2026, not the repost. Open the promoted post to check it is the one you want.");
    expect(repostNote("2026-05-21", null)).toBe("This link is a repost. LinkedIn will run the original post, first posted on 21 May 2026, not the repost. Open the promoted post to check it is the one you want.");
  });
});

describe("readPublicPostImage", () => {
  const shown = (image: string) => async (url: string) => ({ ok: true, status: 200, url, text: async () => `<html><head><meta property="og:image" content="${image}"></head><body></body></html>` });

  it("returns the post's own image and never LinkedIn's generic placeholder", async () => {
    const { readPublicPostImage } = await import("../post-link");
    await expect(readPublicPostImage("urn:li:share:7000000000000000001", shown("https://media.licdn.com/dms/image/abc/0?e=1&amp;v=beta"))).resolves.toBe("https://media.licdn.com/dms/image/abc/0?e=1&v=beta");
    await expect(readPublicPostImage("urn:li:share:7000000000000000001", shown("https://static.licdn.com/aero-v1/sc/h/c45fy346jw096z9pbphyyhdz7"))).resolves.toBeNull();
  });
});
