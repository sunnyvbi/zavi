import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLinkedInAdsReadCache } from "@/services/connectors/linkedin-ads/http";

type Row = Record<string, any>;

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const ACTION_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ACTION_B = "bbbbbbbb-0000-4000-8000-000000000001";
const BINDING_A = "10000000-0000-4000-8000-00000000000a";
const BINDING_B = "10000000-0000-4000-8000-00000000000b";
const ZAVI_PAGE = "urn:li:organization:777";
const UPCAR_PAGE = "urn:li:organization:888";
const OWN_POST = "urn:li:share:7000000000000000001";
const UPCAR_POST = "urn:li:share:7000000000000000002";
const MEMBER_POST = "urn:li:share:7000000000000000003";
const HIDDEN_POST = "urn:li:ugcPost:7000000000000000004";
const BRAND_POST = "urn:li:share:7000000000000000005";
const UPCAR_ACTIVITY = "7464457711406182401";
const WALLED_ACTIVITY = "7464457711406182999";
const SIBLING_POST = "urn:li:share:7521456406189867008";
const SIBLING_ACTIVITY = "7521456406655434752";
const SIBLING_PAGE = "urn:li:organization:146886823";
const PUBLIC_OWN_POST = "urn:li:share:7000000000000000006";
const PUBLIC_MEMBER_POST = "urn:li:share:7000000000000000007";
const PUBLIC_BARE_POST = "urn:li:share:7000000000000000008";
const PUBLIC_SHOWCASE_POST = "urn:li:share:7000000000000000009";
const MISSING_POST = "urn:li:share:7000000000000000010";
const DEBUT_POST = "urn:li:share:7000000000000000011";
const DEBUT_PAGE = "urn:li:organization:10093581";
const MISSING_ACTIVITY = "1234567890123456789";
const ZAVI_LOGO = "https://media.licdn.com/dms/image/v2/D4D0BAQ/company-logo_400_400/0?e=1&v=beta&t=z";
const ZAVI = { name: "Zavi Labs", logo_url: ZAVI_LOGO };
const UNCONFIRMED = (name: string) => `Zavi could not confirm that ${name} can sponsor this post, so LinkedIn may refuse the ad after Zavi makes the paused campaign. Check that the post is from that page, and that the connected LinkedIn user has the Sponsored Content poster role on it. Nothing can spend without an ad.`;

const h = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  role: "owner",
  revoked: new Set<string>(),
  refreshed: [] as string[],
  calls: [] as Array<{ url: string; method: string; auth: string | null; restli: string | null }>,
  rpcCalls: [] as Array<{ tenant: string; name: string }>,
  rows: {} as Record<string, Array<Record<string, any>>>,
  orgs: {} as Record<string, { status: number; body?: unknown }>,
  creatives: {} as Record<string, unknown[]>,
  publicPages: {} as Record<string, string>,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: h.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: async (_a: unknown, allowed: string[], res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    if (allowed.includes(h.role)) return true;
    res.status(403).json({ error: { code: "forbidden" } });
    return false;
  },
}));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: async () => ({ allowed: true }) }));
vi.mock("@/services/channels/lock", async (orig) => ({
  ...(await orig<typeof import("@/services/channels/lock")>()),
  isChannelLockedStrict: async () => false,
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => undefined }));
vi.mock("@/services/connectors/core/token", () => ({
  getConnectorToken: async (tenant: string) => `tok-${tenant}`,
  forceRefreshConnector: async (tenant: string) => { h.refreshed.push(tenant); },
}));
vi.mock("@/services/ads-wallet/accounts", () => ({
  accountChoices: async (tenant: string) => ({
    accounts: (h.rows.ads_account_binding_details ?? []).filter((b) => b.tenant_id === tenant).map((b) => ({ ...b, disabled: !!b.disabled })),
    managed: [],
    selected_id: null,
  }),
  connectCustomerAccount: async () => { throw new Error("preview must not bind an account"); },
  assertAccountAvailableForNewCampaign: async () => undefined,
}));
vi.mock("@/services/tenant-client", async (orig) => {
  const real = await orig<typeof import("@/services/tenant-client")>();
  const client = (tenant: string) => ({
    from: (table: string) => {
      const filters: Array<(r: Row) => boolean> = [(r) => r.tenant_id === tenant];
      const rows = () => (h.rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const b: any = {
        select: () => b,
        eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), b),
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        insert: () => { throw new Error(`preview wrote to ${table}`); },
        update: () => { throw new Error(`preview wrote to ${table}`); },
        upsert: () => { throw new Error(`preview wrote to ${table}`); },
        delete: () => { throw new Error(`preview wrote to ${table}`); },
      };
      return b;
    },
  });
  const tenantRpc = async (tenant: string, name: string) => {
    h.rpcCalls.push({ tenant, name });
    if (name === "ads_verify_account_binding") return { data: null, error: null };
    throw new Error(`unexpected rpc ${name}`);
  };
  return { ...real, tenantClient: client, tenantRpc };
});

import { linkedinPreviewPost } from "@/routes/channels/linkedin-ads";
import { POST_FROM_SHOWCASE, POST_NOT_FOUND, POST_PAGE_MISMATCH } from "@/services/connectors/linkedin-ads/post-link";

const ACCOUNTS: Record<string, Array<Record<string, unknown>>> = {
  [`tok-${TENANT_A}`]: [{ id: 50999, name: "Zavi Labs Ads", currency: "USD", status: "ACTIVE", reference: ZAVI_PAGE }],
  [`tok-${TENANT_B}`]: [{ id: 60111, name: "Upcar Ads", currency: "USD", status: "ACTIVE", reference: UPCAR_PAGE }],
};
const POSTS: Record<string, unknown> = {
  [OWN_POST]: { id: OWN_POST, author: ZAVI_PAGE, commentary: "  Zavi Labs ships the growth agent.\nRead the launch notes.  " },
  [UPCAR_POST]: { id: UPCAR_POST, author: UPCAR_PAGE, commentary: "Upcar.ai: rent a car from your neighbour." },
  [MEMBER_POST]: { id: MEMBER_POST, author: "urn:li:person:abc123", commentary: "Founder here." },
  [BRAND_POST]: { id: BRAND_POST, author: "urn:li:organizationBrand:42", commentary: "A showcase page post." },
};

const posting = (author: unknown, body: string) => `<html><head><script type="application/ld+json">
        ${JSON.stringify({ "@context": "http://schema.org", "@type": "SocialMediaPosting", articleBody: body, author })}
      </script></head><body><a href="https://www.linkedin.com/company/upcarapp?trk=public_post_feed-actor-name">x</a></body></html>`;
const org = (slug: string) => ({ name: slug, url: `https://www.linkedin.com/company/${slug}`, "@type": "Organization" });
const PUBLIC_POSTS: Record<string, string> = {
  [SIBLING_POST]: posting(org("zavitest"), "Zavi has two operating modes:\nApprove each action before it runs."),
  [PUBLIC_OWN_POST]: posting(org("zavi-labs"), "Zavi Labs, publicly."),
  [PUBLIC_MEMBER_POST]: posting({ name: "Founder", url: "https://www.linkedin.com/in/founder", "@type": "Person" }, "Founder, publicly."),
  [PUBLIC_BARE_POST]: "<html><head><title>LinkedIn</title></head><body>urn:li:organization:146886823</body></html>",
  [PUBLIC_SHOWCASE_POST]: posting({ name: "Zavi Ads", url: "https://www.linkedin.com/showcase/zavi-ads", "@type": "Organization" }, "A showcase post."),
  [DEBUT_POST]: posting({ name: "Debut Infotech", url: "https://in.linkedin.com/company/debut-infotech?trk=public_post_feed-actor-name", "@type": "Organization" }, "Debut Infotech builds apps."),
};
const tracking = (urn: string) => `<code id="flagshipOrganizationTracking" style="display: none"><!--${JSON.stringify({ organization: { objectUrn: urn }, module: "COMPANY_OVERVIEW_PAGE", viewerUrn: 0 })}--></code>`;
const COMPANY_PAGES: Record<string, string> = {
  zavitest: `<html><body><a data-semaphore-content-urn="${SIBLING_PAGE}"></a>${tracking(SIBLING_PAGE)}</body></html>`,
  "zavi-labs": `<html><body>${tracking(ZAVI_PAGE)}</body></html>`,
  "debut-infotech": `<html><body>${tracking(DEBUT_PAGE)}</body></html>`,
};

function json(status: number, body: unknown, url = "") {
  return { ok: status < 400, status, url, json: async () => body, text: async () => JSON.stringify(body) };
}

function linkedin() {
  return vi.fn(async (input: string, init?: { method?: string; headers?: Record<string, string> }) => {
    const url = new URL(input);
    const headers = init?.headers ?? {};
    h.calls.push({ url: input, method: init?.method ?? "GET", auth: headers.Authorization ?? null, restli: headers["X-RestLi-Method"] ?? null });
    if (url.hostname === "www.linkedin.com") {
      if (input.includes(WALLED_ACTIVITY) || input.includes(HIDDEN_POST)) return { ok: true, status: 200, url: "https://www.linkedin.com/authwall?trk=x", text: async () => "<html/>" };
      if (input.includes(SIBLING_ACTIVITY)) return {
        ok: true, status: 200, url: input,
        text: async () => `<div data-activity-urn="urn:li:activity:${SIBLING_ACTIVITY}" data-attributed-urn="${SIBLING_POST}"></div>`,
      };
      const publicPost = url.pathname.match(/^\/feed\/update\/(urn:li:share:\d+)\/$/)?.[1];
      if (publicPost && h.publicPages[publicPost]) return { ok: true, status: 200, url: input, text: async () => h.publicPages[publicPost] };
      if (publicPost && PUBLIC_POSTS[publicPost]) return { ok: true, status: 200, url: input, text: async () => PUBLIC_POSTS[publicPost] };
      const company = url.pathname.match(/^\/company\/([^/]+)\/$/)?.[1];
      if (company && COMPANY_PAGES[company]) return { ok: true, status: 200, url: input, text: async () => COMPANY_PAGES[company] };
      if (input.includes(UPCAR_ACTIVITY)) return {
        ok: true, status: 200, url: input,
        text: async () => `<div data-activity-urn="urn:li:activity:${UPCAR_ACTIVITY}" data-attributed-urn="${UPCAR_POST}"></div>`,
      };
      return json(404, {});
    }
    const token = (headers.Authorization ?? "").replace(/^Bearer /, "");
    const tenant = token.replace(/^tok-/, "");
    if (h.revoked.has(tenant)) return json(401, {});
    const path = url.pathname.replace(/^\/rest\//, "");
    if (path === "adAccounts" && url.searchParams.get("q") === "search") return json(200, { elements: ACCOUNTS[token] ?? [] });
    const adsOf = path.match(/^adAccounts\/(\d+)\/creatives$/)?.[1];
    if (adsOf) return h.creatives[adsOf] ? json(200, { elements: h.creatives[adsOf] }) : json(403, { status: 403, code: "ACCESS_DENIED" });
    const account = path.match(/^adAccounts\/(\d+)$/)?.[1];
    if (account) {
      const found = (ACCOUNTS[token] ?? []).find((a) => String(a.id) === account);
      return found ? json(200, found) : json(404, {});
    }
    const orgId = path.match(/^organizations\/(\d+)$/)?.[1];
    if (orgId) {
      const a = h.orgs[`${orgId}${url.searchParams.has("projection") ? ":logo" : ""}`] ?? { status: 404 };
      return json(a.status, a.body);
    }
    if (path.startsWith("posts/")) {
      const urn = decodeURIComponent(path.slice("posts/".length));
      if (PUBLIC_POSTS[urn]) return json(403, { status: 403, serviceErrorCode: 100, code: "ACCESS_DENIED", message: "Not enough permissions to access: partnerApiPostsExternal.GET.20260801" });
      return POSTS[urn] ? json(200, POSTS[urn]) : json(404, {});
    }
    return json(404, {});
  });
}

function res() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
}

async function preview(query: Record<string, string>, { tenant = TENANT_A, actionId = ACTION_A } = {}) {
  h.requireAuth.mockResolvedValue({ tenant_id: tenant, user_id: `user-${tenant}` });
  const r = res();
  await linkedinPreviewPost({ params: { actionId }, query } as never, r as never);
  return r;
}

const reviewable = (id: string, tenant: string) => ({
  id, tenant_id: tenant, channel_slug: "linkedin_ads", status: "pending", exec_class: null, exec_status: null, approved_by: null,
  body: { step: { responsibility: "client", deliverable: { presentation: { type: "campaign_draft" } } } },
});

function expectNothingChanged() {
  expect(h.calls.length).toBeGreaterThan(0);
  for (const c of h.calls) {
    expect(c.method).toBe("GET");
    expect(c.restli === null || c.restli === "FINDER" || c.restli === "BATCH_GET").toBe(true);
  }
  expect(h.rpcCalls.every((c) => c.name === "ads_verify_account_binding")).toBe(true);
}

beforeEach(() => {
  h.creatives = {};
  h.publicPages = {};
  resetLinkedInAdsReadCache();
  h.role = "owner";
  h.revoked.clear();
  h.refreshed = [];
  h.calls = [];
  h.rpcCalls = [];
  h.rows = {
    channel_actions: [reviewable(ACTION_A, TENANT_A), reviewable(ACTION_B, TENANT_B)],
    ads_account_binding_details: [
      { id: BINDING_A, tenant_id: TENANT_A, account_id: "acct-a", platform: "linkedin", provider_account_id: "50999", currency: "USD", verified_at: null, credential_source: "tenant_connector", credential_ref: "linkedin_ads.access_token", credential_tenant_id: TENANT_A, funding_source: "provider", legacy_key: null },
      { id: BINDING_B, tenant_id: TENANT_B, account_id: "acct-b", platform: "linkedin", provider_account_id: "60111", currency: "USD", verified_at: null, credential_source: "tenant_connector", credential_ref: "linkedin_ads.access_token", credential_tenant_id: TENANT_B, funding_source: "provider", legacy_key: null },
    ],
  };
  h.orgs = {
    "777": { status: 200, body: { id: 777, localizedName: "Zavi Labs" } },
    "777:logo": { status: 200, body: { logoV2: { original: "urn:li:digitalmediaAsset:D4D0BAQ", "original~": { elements: [{ identifiers: [{ identifier: "https://media.licdn.com/small" }] }, { identifiers: [{ identifier: ZAVI_LOGO }] }] } } } },
  };
  vi.stubGlobal("fetch", linkedin());
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("GET /api/channels/linkedin_ads/actions/:actionId/post-preview", () => {
  it("refuses the Upcar.ai post pasted for the Zavi Labs ad account with the submit-time mismatch copy", async () => {
    const r = await preview({ post: `https://www.linkedin.com/feed/update/urn:li:activity:${UPCAR_ACTIVITY}/`, account_id: "50999", account_binding_id: BINDING_A });
    expect(r.statusCode).toBe(422);
    expect(r.body).toEqual({ error: { code: "linkedin_ads_post_page_mismatch", message: POST_PAGE_MISMATCH } });
    expect(h.calls.some((c) => c.url.endsWith(`posts/${encodeURIComponent(UPCAR_POST)}`) && c.auth === `Bearer tok-${TENANT_A}`)).toBe(true);
    expectNothingChanged();
  });

  it("refuses the same mismatch on the account-id path with no binding", async () => {
    const r = await preview({ post: UPCAR_POST, account_id: "50999" });
    expect(r.statusCode).toBe(422);
    expect(r.body.error.code).toBe("linkedin_ads_post_page_mismatch");
    expectNothingChanged();
  });

  it("returns the own page's post text, trimmed, for the preview", async () => {
    const r = await preview({ post: `https://www.linkedin.com/feed/update/${OWN_POST}/`, account_id: "50999", account_binding_id: BINDING_A });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ post_urn: OWN_POST, author: "page", post_preview: "Zavi Labs ships the growth agent.\nRead the launch notes.", author_note: null, page: ZAVI });
    expectNothingChanged();
  });

  it("lets a member's Thought Leader post through with its text", async () => {
    const r = await preview({ post: MEMBER_POST, account_id: "50999" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ post_urn: MEMBER_POST, author: "member", post_preview: "Founder here.", author_note: null, page: ZAVI });
  });

  it("does not block a post it cannot read or a page it cannot rule out", async () => {
    const hidden = await preview({ post: HIDDEN_POST, account_id: "50999" });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.body).toEqual({ post_urn: HIDDEN_POST, author: "unknown", post_preview: null, author_note: UNCONFIRMED("Zavi Labs"), page: ZAVI });
  });

  it("drops the warning for an unreadable post already behind an ad on this account", async () => {
    h.creatives = { "50999": [{ account: "urn:li:sponsoredAccount:50999", content: { reference: HIDDEN_POST } }] };
    const own = await preview({ post: HIDDEN_POST, account_id: "50999" });
    expect(own.statusCode).toBe(200);
    expect(own.body).toEqual({ post_urn: HIDDEN_POST, author: "unknown", post_preview: null, author_note: null, page: ZAVI });
  });

  it("returns the pasted post's public image, and none for a post with no image", async () => {
    const withImage = "urn:li:share:7000000000000000555";
    PUBLIC_POSTS[withImage] = posting(org("zavi-labs"), "With a picture.").replace("<head>", '<head><meta property="og:image" content="https://media.licdn.com/dms/image/pic.png?a=1&amp;b=2">');
    try {
      const r = await preview({ post: withImage, account_id: "50999" });
      expect(r.body).toMatchObject({ post_urn: withImage, author: "page", post_preview: "With a picture.", image_url: "https://media.licdn.com/dms/image/pic.png?a=1&b=2" });
      const plain = await preview({ post: PUBLIC_OWN_POST, account_id: "50999" });
      expect(Object.keys(plain.body as object)).not.toContain("image_url");
    } finally {
      delete PUBLIC_POSTS[withImage];
    }
  });

  it("keeps the warning when the only ad behind the unreadable post belongs to another account", async () => {
    h.creatives = { "50999": [{ account: "urn:li:sponsoredAccount:60111", content: { reference: HIDDEN_POST } }] };
    const foreign = await preview({ post: HIDDEN_POST, account_id: "50999" });
    expect(foreign.body).toMatchObject({ author: "unknown", author_note: UNCONFIRMED("Zavi Labs") });
  });

  it("refuses a Showcase page's post, so the review never offers Create for an ad LinkedIn would refuse", async () => {
    const brand = await preview({ post: BRAND_POST, account_id: "50999" });
    expect(brand.statusCode).toBe(422);
    expect(brand.body).toEqual({ error: { code: "linkedin_ads_post_page_mismatch", message: POST_FROM_SHOWCASE } });
    expectNothingChanged();
  });

  it("refuses another company page's post by its public author when LinkedIn denies the posts read", async () => {
    const r = await preview({ post: `https://www.linkedin.com/feed/update/urn:li:activity:${SIBLING_ACTIVITY}/`, account_id: "50999", account_binding_id: BINDING_A });
    expect(r.statusCode).toBe(422);
    expect(r.body).toEqual({ error: { code: "linkedin_ads_post_page_mismatch", message: POST_PAGE_MISMATCH } });
    expect(h.calls.some((c) => c.url.endsWith(`posts/${encodeURIComponent(SIBLING_POST)}`))).toBe(true);
    expect(h.calls.some((c) => c.url === "https://www.linkedin.com/company/zavitest/")).toBe(true);
    expectNothingChanged();
  });

  it("refuses the same denied-read sibling post on the account-id path with no binding", async () => {
    const r = await preview({ post: SIBLING_POST, account_id: "50999" });
    expect(r.statusCode).toBe(422);
    expect(r.body.error.code).toBe("linkedin_ads_post_page_mismatch");
    expectNothingChanged();
  });

  it("lets the account's own page through by its public author when LinkedIn denies the posts read", async () => {
    const r = await preview({ post: PUBLIC_OWN_POST, account_id: "50999", account_binding_id: BINDING_A });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ post_urn: PUBLIC_OWN_POST, author: "page", post_preview: "Zavi Labs, publicly.", author_note: null, page: ZAVI });
    expectNothingChanged();
  });

  it("shows a member's post as a Thought Leader post by its public Person author when LinkedIn denies the posts read", async () => {
    for (const query of [{ post: PUBLIC_MEMBER_POST, account_id: "50999", account_binding_id: BINDING_A }, { post: PUBLIC_MEMBER_POST, account_id: "50999" }] as Record<string, string>[]) {
      h.calls = [];
      const r = await preview(query);
      expect(r.statusCode).toBe(200);
      expect(r.body).toEqual({ post_urn: PUBLIC_MEMBER_POST, author: "member", post_preview: "Founder, publicly.", author_note: null, page: ZAVI });
      expect(h.calls.some((c) => c.url.endsWith(`posts/${encodeURIComponent(PUBLIC_MEMBER_POST)}`))).toBe(true);
      expect(h.calls.some((c) => c.url === `https://www.linkedin.com/feed/update/${PUBLIC_MEMBER_POST}/`)).toBe(true);
      expect(h.calls.filter((c) => c.url.includes("/company/") || c.url.includes("/in/"))).toHaveLength(0);
      expectNothingChanged();
    }
  });

  it("stays unknown when the public post names no company page Zavi can pin to an id", async () => {
    for (const [post, text] of [[PUBLIC_BARE_POST, null], [PUBLIC_SHOWCASE_POST, "A showcase post."]] as const) {
      const r = await preview({ post, account_id: "50999" });
      expect(r.statusCode).toBe(200);
      expect(r.body).toEqual({ post_urn: post, author: "unknown", post_preview: text, author_note: UNCONFIRMED("Zavi Labs"), page: ZAVI });
    }
    expect(h.calls.filter((c) => c.url.includes("/company/") || c.url.includes("/showcase/"))).toHaveLength(0);
    expectNothingChanged();
  });

  it("reports an activity link LinkedIn walls off as unreadable and never asks the ads API", async () => {
    const r = await preview({ post: `urn:li:activity:${WALLED_ACTIVITY}`, account_id: "50999", account_binding_id: BINDING_A });
    expect(r.statusCode).toBe(422);
    expect(r.body.error.code).toBe("linkedin_ads_post_unreadable");
    expect(h.calls.filter((c) => c.url.startsWith("https://api.linkedin.com/"))).toHaveLength(0);
  });

  it("answers token_revoked when LinkedIn refuses the token even after one refresh", async () => {
    h.revoked.add(TENANT_A);
    const r = await preview({ post: OWN_POST, account_id: "50999" });
    expect(r.statusCode).toBe(403);
    expect(r.body.error.code).toBe("linkedin_ads_token_revoked");
    expect(h.refreshed).toEqual([TENANT_A]);
    expectNothingChanged();
  });

  it("names the ad account's company page and its logo, read with that account's token on both paths, and asks LinkedIn for the page only once", async () => {
    for (const [q, expected] of [[{ account_binding_id: BINDING_A }, ["/rest/organizations/777", "/rest/organizations/777"]], [{}, []]] as Array<[Record<string, string>, string[]]>) {
      h.calls = [];
      const r = await preview({ post: OWN_POST, account_id: "50999", ...q });
      expect(r.statusCode).toBe(200);
      expect(r.body.page).toEqual(ZAVI);
      const orgReads = h.calls.filter((c) => c.url.startsWith("https://api.linkedin.com/rest/organizations/"));
      expect(orgReads.map((c) => new URL(c.url).pathname)).toEqual(expected);
      expect(orgReads.every((c) => c.auth === `Bearer tok-${TENANT_A}`)).toBe(true);
      expectNothingChanged();
    }
  });

  it.each([
    ["the page reads answer 404", { "777": { status: 404 }, "777:logo": { status: 404 } }, { name: null, logo_url: null }],
    ["the page reads answer 500", { "777": { status: 500 }, "777:logo": { status: 500 } }, { name: null, logo_url: null }],
    ["only the logo read is refused", { "777": { status: 200, body: { localizedName: "Zavi Labs" } }, "777:logo": { status: 403 } }, { name: "Zavi Labs", logo_url: null }],
    ["the logo is not https", { "777": { status: 200, body: { localizedName: "Zavi Labs" } }, "777:logo": { status: 200, body: { logoV2: { "original~": { elements: [{ identifiers: [{ identifier: "http://media.licdn.com/x" }] }] } } } } }, { name: "Zavi Labs", logo_url: null }],
  ])("still previews the post with an empty page when %s", async (_label, orgs, page) => {
    h.orgs = orgs;
    const r = await preview({ post: OWN_POST, account_id: "50999", account_binding_id: BINDING_A });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ post_urn: OWN_POST, author: "page", post_preview: "Zavi Labs ships the growth agent.\nRead the launch notes.", author_note: null, page });
  });

  describe("company logo when LinkedIn refuses both company page reads", () => {
    const PUBLIC_LOGO = "https://media.licdn.com/dms/image/v2/D4D0BAQ/company-logo_100_100/company-logo_100_100/0/1698145130724?e=2147483647&v=beta&t=rbXa";
    const REFUSED = { "777": { status: 403 }, "777:logo": { status: 403 } };
    const byPage = (image: unknown, author: Record<string, unknown> = org("zavi-labs")) => posting({ ...author, image: { url: image, "@type": "ImageObject" } }, "Zavi Labs, publicly.");
    const publicReads = () => h.calls.filter((c) => new URL(c.url).hostname === "www.linkedin.com").map((c) => new URL(c.url).pathname);

    it("shows the logo LinkedIn prints beside the page's own post, from the one public read the preview already makes", async () => {
      h.orgs = REFUSED;
      h.publicPages = { [OWN_POST]: byPage(PUBLIC_LOGO) };
      const r = await preview({ post: OWN_POST, account_id: "50999", account_binding_id: BINDING_A });
      expect(r.statusCode).toBe(200);
      expect(r.body).toEqual({ post_urn: OWN_POST, author: "page", post_preview: "Zavi Labs ships the growth agent.\nRead the launch notes.", author_note: null, page: { name: null, logo_url: PUBLIC_LOGO } });
      expect(publicReads()).toEqual([`/feed/update/${OWN_POST}/`]);
      expectNothingChanged();
    });

    it("shows it too when the post itself is only readable in public and the public author is this page", async () => {
      h.orgs = REFUSED;
      h.publicPages = { [PUBLIC_OWN_POST]: byPage(PUBLIC_LOGO) };
      const r = await preview({ post: PUBLIC_OWN_POST, account_id: "50999" });
      expect(r.statusCode).toBe(200);
      expect(r.body.author).toBe("page");
      expect(r.body.page).toEqual({ name: null, logo_url: PUBLIC_LOGO });
      expectNothingChanged();
    });

    it("keeps the logo LinkedIn's own company read returned over the public one", async () => {
      h.publicPages = { [OWN_POST]: byPage(PUBLIC_LOGO) };
      const r = await preview({ post: OWN_POST, account_id: "50999" });
      expect(r.body.page).toEqual(ZAVI);
    });

    it.each([
      ["plain http", "http://media.licdn.com/dms/image/logo"],
      ["LinkedIn's generic placeholder", "https://static.licdn.com/aero-v1/sc/h/c45fy346jw096z9pbphyyhdz7"],
      ["another host", "https://cdn.example.com/logo.png"],
      ["a host that only starts like licdn", "https://media.licdn.com.example.com/logo.png"],
      ["a host that only ends like licdn", "https://evillicdn.com/logo.png"],
      ["a URL carrying credentials", "https://user:pass@media.licdn.com/logo.png"],
      ["a script URL", "javascript:alert(1)"],
      ["not a string", { url: PUBLIC_LOGO }],
    ])("shows no logo when the public one is %s", async (_label, image) => {
      h.orgs = REFUSED;
      h.publicPages = { [OWN_POST]: byPage(image) };
      const r = await preview({ post: OWN_POST, account_id: "50999" });
      expect(r.statusCode).toBe(200);
      expect(r.body.page).toEqual({ name: null, logo_url: null });
    });

    it("never puts a member's picture in the company header", async () => {
      h.orgs = REFUSED;
      h.publicPages = {
        [MEMBER_POST]: byPage(PUBLIC_LOGO),
        [OWN_POST]: byPage(PUBLIC_LOGO, { name: "Founder", url: "https://www.linkedin.com/in/founder", "@type": "Person" }),
      };
      const member = await preview({ post: MEMBER_POST, account_id: "50999" });
      expect(member.body.author).toBe("member");
      expect(member.body.page).toEqual({ name: null, logo_url: null });
      const person = await preview({ post: OWN_POST, account_id: "50999" });
      expect(person.body.author).toBe("page");
      expect(person.body.page).toEqual({ name: null, logo_url: null });
    });

    it("never shows another page's logo when the post's author could not be confirmed", async () => {
      h.orgs = REFUSED;
      h.publicPages = { [PUBLIC_SHOWCASE_POST]: byPage(PUBLIC_LOGO, { name: "Zavi Ads", url: "https://www.linkedin.com/showcase/zavi-ads", "@type": "Organization" }) };
      const r = await preview({ post: PUBLIC_SHOWCASE_POST, account_id: "50999" });
      expect(r.statusCode).toBe(200);
      expect(r.body.author).toBe("unknown");
      expect(r.body.page).toEqual({ name: null, logo_url: null });
    });
  });

  it("still previews when the page read alone answers 401, without spending the refresh token", async () => {
    h.orgs = { "777": { status: 401 }, "777:logo": { status: 401 } };
    const r = await preview({ post: OWN_POST, account_id: "50999" });
    expect(r.statusCode).toBe(200);
    expect(r.body.page).toEqual({ name: null, logo_url: null });
    expect(r.body.post_preview).toBe("Zavi Labs ships the growth agent.\nRead the launch notes.");
    expect(h.refreshed).toEqual([]);
  });

  it("warns with the generic page wording when the post's author is unknown and the page name is not readable", async () => {
    h.orgs = {};
    const r = await preview({ post: PUBLIC_BARE_POST, account_id: "50999" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ post_urn: PUBLIC_BARE_POST, author: "unknown", post_preview: null, author_note: UNCONFIRMED("the company page this ad account advertises for"), page: { name: null, logo_url: null } });
  });

  it("refuses a Debut Infotech post whose public author links to a regional company page with tracking", async () => {
    const r = await preview({ post: DEBUT_POST, account_id: "50999", account_binding_id: BINDING_A });
    expect(r.statusCode).toBe(422);
    expect(r.body).toEqual({ error: { code: "linkedin_ads_post_page_mismatch", message: POST_PAGE_MISMATCH } });
    expect(h.calls.some((c) => c.url === "https://www.linkedin.com/company/debut-infotech/")).toBe(true);
    expectNothingChanged();
  });

  it("says a share LinkedIn does not have is not found, instead of letting it through as unknown", async () => {
    const r = await preview({ post: MISSING_POST, account_id: "50999", account_binding_id: BINDING_A });
    expect(r.statusCode).toBe(422);
    expect(r.body).toEqual({ error: { code: "linkedin_ads_post_not_found", message: POST_NOT_FOUND } });
    expectNothingChanged();
  });

  it("says a pasted activity LinkedIn does not have is not found, not private, and never asks the ads API", async () => {
    const r = await preview({ post: `https://www.linkedin.com/feed/update/urn:li:activity:${MISSING_ACTIVITY}/`, account_id: "50999", account_binding_id: BINDING_A });
    expect(r.statusCode).toBe(422);
    expect(r.body).toEqual({ error: { code: "linkedin_ads_post_not_found", message: POST_NOT_FOUND } });
    expect(h.calls.filter((c) => c.url.startsWith("https://api.linkedin.com/"))).toHaveLength(0);
  });

  it("refuses another tenant's account binding without reading the post with any token", async () => {
    const r = await preview({ post: OWN_POST, account_id: "60111", account_binding_id: BINDING_B });
    expect(r.statusCode).toBe(502);
    expect(r.body.error.code).toBe("ads_binding_unavailable");
    expect(h.calls.filter((c) => c.url.includes("/posts/"))).toHaveLength(0);
    expect(h.calls.some((c) => c.auth === `Bearer tok-${TENANT_B}`)).toBe(false);
  });

  it("refuses another tenant's ad account id that its own token does not list", async () => {
    const r = await preview({ post: OWN_POST, account_id: "60111" });
    expect(r.statusCode).toBe(409);
    expect(r.body.error.message).toBe("That ad account is not linked to this workspace. Refresh and choose again.");
    expect(h.calls.filter((c) => c.url.includes("/posts/"))).toHaveLength(0);
    expect(h.calls.some((c) => c.auth === `Bearer tok-${TENANT_B}`)).toBe(false);
  });

  it("refuses a binding paired with another account id instead of reading the post for the bound page", async () => {
    const r = await preview({ post: UPCAR_POST, account_id: "60111", account_binding_id: BINDING_A });
    expect(r.statusCode).toBe(409);
    expect(r.body.error.message).toBe("The selected advertiser account changed. Review it again.");
    expect(h.calls.filter((c) => c.url.includes("/posts/"))).toHaveLength(0);
  });

  it("refuses another tenant's action", async () => {
    const r = await preview({ post: OWN_POST, account_id: "50999" }, { actionId: ACTION_B });
    expect(r.statusCode).toBe(404);
    expect(r.body.error.code).toBe("linkedin_ads_not_found");
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a member of the workspace who is not an owner or admin", async () => {
    h.role = "member";
    const r = await preview({ post: OWN_POST, account_id: "50999" });
    expect(r.statusCode).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses an action that is no longer waiting for review", async () => {
    h.rows.channel_actions[0].exec_class = "linkedin_ads.create_campaign_bundle";
    const r = await preview({ post: OWN_POST, account_id: "50999" });
    expect(r.statusCode).toBe(409);
    expect(r.body.error.code).toBe("linkedin_ads_conflict");
    expect(h.calls).toHaveLength(0);
  });

  it("previews the post of a prepared campaign from its own payload, ignoring any query the caller sends", async () => {
    Object.assign(h.rows.channel_actions[0], { exec_class: "linkedin_ads.create_campaign_bundle", exec_status: null, exec_payload: { account_id: "50999", account_binding_id: BINDING_A, creative: { post_urn: OWN_POST } } });
    const r = await preview({ post: UPCAR_POST, account_id: "60111" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ post_urn: OWN_POST, author: "page", post_preview: "Zavi Labs ships the growth agent.\nRead the launch notes.", author_note: null, page: ZAVI });
    expectNothingChanged();
  });

  it("reads a prepared campaign's post once from LinkedIn when previewed twice", async () => {
    Object.assign(h.rows.channel_actions[0], { exec_class: "linkedin_ads.create_campaign_bundle", exec_payload: { account_id: "50999", creative: { post_urn: OWN_POST } } });
    await preview({});
    expect(h.calls.filter((c) => c.url.includes("posts/"))).toHaveLength(1);
    await preview({});
    expect(h.calls.filter((c) => c.url.includes("posts/"))).toHaveLength(1);
  });

  it("still refuses a prepared action of another tenant", async () => {
    Object.assign(h.rows.channel_actions[1], { exec_class: "linkedin_ads.create_campaign_bundle", exec_payload: { account_id: "60111", creative: { post_urn: UPCAR_POST } } });
    const r = await preview({}, { tenant: TENANT_A, actionId: ACTION_B });
    expect(r.statusCode).toBe(404);
    expect(h.calls).toHaveLength(0);
  });
});
