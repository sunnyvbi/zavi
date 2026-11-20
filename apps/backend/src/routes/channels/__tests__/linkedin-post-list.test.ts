import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLinkedInAdsReadCache } from "@/services/connectors/linkedin-ads/http";

type Row = Record<string, any>;

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const ACTION_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ACTION_B = "bbbbbbbb-0000-4000-8000-000000000001";
const OWN_ACCOUNT = "50999";
const OTHER_ACCOUNT = "60111";
const MANAGED_ACCOUNT = "900";
const ZAVI_PAGE = "urn:li:organization:777";
const UPCAR_PAGE = "urn:li:organization:888";
const OWN_POST = "urn:li:share:7000000000000000001";
const UPCAR_POST = "urn:li:share:7000000000000000002";
const MEMBER_POST = "urn:li:share:7000000000000000003";
const PUBLIC_OWN_POST = "urn:li:share:7000000000000000006";
const PUBLIC_SIBLING_POST = "urn:li:share:7521456406189867008";
const UNREADABLE_POST = "urn:li:share:7523985502677389312";
const WALLED_PAGE_POST = "urn:li:share:7524031113225326592";
const PUBLIC_MEMBER_POST = "urn:li:share:7524031113225326999";
const PAGE_ONLY_POST = "urn:li:ugcPost:7390000000000000000";
const STRANGER_PAGE_POST = "urn:li:share:7390000000000000111";
const DRAFT_PAGE_POST = "urn:li:share:7390000000000000222";
const OWN_IMAGE = "urn:li:image:D4D10AQownimage";
const OWN_IMAGE_URL = "https://media.licdn.com/dms/image/own-post/0?e=1&v=beta&t=z";
const OWN_PUBLISHED = Date.UTC(2026, 9, 1, 8, 0, 0);
const PAGE_ONLY_PUBLISHED = Date.UTC(2026, 10, 1, 8, 0, 0);
const urnDate = (urn: string) => new Date(Number(BigInt(urn.split(":").pop()!) >> BigInt(22))).toISOString();

const h = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  role: "owner",
  revoked: new Set<string>(),
  calls: [] as Array<{ url: string; method: string; auth: string | null; restli: string | null }>,
  secretReads: [] as unknown[],
  rows: {} as Record<string, Array<Record<string, any>>>,
  claims: [] as Array<Record<string, any>>,
  claimsError: false,
  creatives: {} as Record<string, Array<Record<string, unknown>>>,
  authorFinder: { status: 403, body: {} as unknown },
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
  forceRefreshConnector: async () => undefined,
}));
vi.mock("@/services/tenant-client", async (orig) => {
  const real = await orig<typeof import("@/services/tenant-client")>();
  const query = (source: () => Row[], failing: () => boolean) => {
    const filters: Array<(r: Row) => boolean> = [];
    const rows = () => source().filter((r) => filters.every((f) => f(r)));
    const b: any = {
      select: () => b,
      eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), b),
      in: (col: string, v: unknown[]) => (filters.push((r) => v.includes(r[col])), b),
      range: async () => (failing() ? { data: null, error: { message: "down" } } : { data: rows(), error: null }),
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      insert: () => { throw new Error("the post list wrote to the database"); },
      update: () => { throw new Error("the post list wrote to the database"); },
      upsert: () => { throw new Error("the post list wrote to the database"); },
      delete: () => { throw new Error("the post list wrote to the database"); },
    };
    return b;
  };
  return {
    ...real,
    tenantClient: (tenant: string) => ({ from: (table: string) => query(() => (h.rows[table] ?? []).filter((r) => r.tenant_id === tenant), () => false) }),
    globalClient: () => ({ from: (table: string) => query(() => (table === "ads_provider_accounts" ? h.claims : []), () => h.claimsError) }),
    tenantRpc: async (_t: string, name: string) => { throw new Error(`the post list called rpc ${name}`); },
    platformSecretRpc: async (...args: unknown[]) => { h.secretReads.push(args); return { data: "managed-token", error: null }; },
  };
});

import { linkedinListPosts } from "@/routes/channels/linkedin-ads";
import { PAGE_POST, POST_LIST_ACCOUNT_NOT_LINKED, USED_IN_AD, resetLinkedInPostListCache } from "@/services/connectors/linkedin-ads/post-list";

const account = (id: string, reference: string) => ({ id: Number(id), name: `Account ${id}`, currency: "USD", status: "ACTIVE", reference });
const ACCOUNTS: Record<string, Array<Record<string, unknown>>> = {
  [`tok-${TENANT_A}`]: [account(OWN_ACCOUNT, ZAVI_PAGE), account(MANAGED_ACCOUNT, ZAVI_PAGE)],
  [`tok-${TENANT_B}`]: [account(OTHER_ACCOUNT, UPCAR_PAGE)],
  "managed-token": [account(MANAGED_ACCOUNT, ZAVI_PAGE)],
};
const POSTS: Record<string, Record<string, unknown>> = {
  [OWN_POST]: { id: OWN_POST, author: ZAVI_PAGE, publishedAt: OWN_PUBLISHED, commentary: "\n  Zavi Labs ships the {hashtag|\\#|growth} agent with @[Upcar](urn:li:organization:888).  \nRead the launch notes.", content: { media: { id: OWN_IMAGE } } },
  [UPCAR_POST]: { id: UPCAR_POST, author: UPCAR_PAGE, commentary: "Upcar.ai: rent a car from your neighbour." },
  [MEMBER_POST]: { id: MEMBER_POST, author: "urn:li:person:abc123", commentary: "Founder here." },
};
const posting = (slug: string, body: string) => `<html><head><script type="application/ld+json">${JSON.stringify({ "@type": "SocialMediaPosting", articleBody: body, author: { name: slug, url: `https://www.linkedin.com/company/${slug}`, "@type": "Organization" } })}</script></head></html>`;
const PUBLIC_POSTS: Record<string, string> = {
  [PUBLIC_OWN_POST]: posting("zavi-labs", "Zavi Labs, publicly.\nSecond line."),
  [PUBLIC_SIBLING_POST]: posting("zavitest", "A sibling company's post."),
  [WALLED_PAGE_POST]: posting("walled-page", "Skip the overwhelm.\nSecond line.").replace("<head>", '<head><meta property="og:image" content="https://media.licdn.com/dms/image/walled/0?e=1&amp;v=beta">'),
  [PUBLIC_MEMBER_POST]: `<html><head><script type="application/ld+json">${JSON.stringify({ "@type": "SocialMediaPosting", articleBody: "A founder's own post.", author: { name: "Founder", url: "https://www.linkedin.com/in/founder", "@type": "Person" } })}</script></head></html>`,
};
const tracking = (urn: string) => `<html><body><code id="flagshipOrganizationTracking" style="display: none"><!--${JSON.stringify({ organization: { objectUrn: urn } })}--></code></body></html>`;
const COMPANY_PAGES: Record<string, string> = { "zavi-labs": tracking(ZAVI_PAGE), zavitest: tracking("urn:li:organization:146886823") };

function json(status: number, body: unknown) {
  return { ok: status < 400, status, url: "", headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) };
}

function linkedin() {
  return vi.fn(async (input: string, init?: { method?: string; headers?: Record<string, string> }) => {
    const url = new URL(input);
    const headers = init?.headers ?? {};
    h.calls.push({ url: input, method: init?.method ?? "GET", auth: headers.Authorization ?? null, restli: headers["X-RestLi-Method"] ?? null });
    if (url.hostname === "www.linkedin.com") {
      const post = url.pathname.match(/^\/feed\/update\/(urn:li:share:\d+)\/$/)?.[1];
      if (post && PUBLIC_POSTS[post]) return { ok: true, status: 200, url: input, text: async () => PUBLIC_POSTS[post] };
      const company = url.pathname.match(/^\/company\/([^/]+)\/$/)?.[1];
      if (company && COMPANY_PAGES[company]) return { ok: true, status: 200, url: input, text: async () => COMPANY_PAGES[company] };
      return json(404, {});
    }
    const token = (headers.Authorization ?? "").replace(/^Bearer /, "");
    if (h.revoked.has(token.replace(/^tok-/, ""))) return json(401, {});
    const path = url.pathname.replace(/^\/rest\//, "");
    const visible = ACCOUNTS[token] ?? [];
    if (path === "adAccounts" && url.searchParams.get("q") === "search") return json(200, { elements: visible });
    const creativesOf = path.match(/^adAccounts\/(\d+)\/creatives$/)?.[1];
    if (creativesOf) return visible.some((a) => String(a.id) === creativesOf) ? json(200, { elements: h.creatives[creativesOf] ?? [] }) : json(403, {});
    if (path.match(/^organizations\/777$/)) return url.searchParams.has("projection") ? json(404, {}) : json(200, { id: 777, localizedName: "Zavi Labs" });
    if (path === "posts" && url.searchParams.get("q") === "author") return json(h.authorFinder.status, h.authorFinder.body);
    const ids = [...(url.searchParams.get("ids") ?? "").matchAll(/urn:li:[A-Za-z]+:[\w-]+/g)].map((m) => m[0]);
    if (path === "posts" && ids.length) return json(200, { results: Object.fromEntries(ids.filter((id) => POSTS[id]).map((id) => [id, POSTS[id]])), errors: {} });
    if (path === "images" && ids.length) return json(200, { results: Object.fromEntries(ids.filter((id) => id === OWN_IMAGE).map((id) => [id, { id, downloadUrl: OWN_IMAGE_URL }])) });
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

async function list(query: Record<string, string>, { tenant = TENANT_A, actionId = ACTION_A } = {}) {
  h.requireAuth.mockResolvedValue({ tenant_id: tenant, user_id: `user-${tenant}` });
  const r = res();
  await linkedinListPosts({ params: { actionId }, query } as never, r as never);
  return r;
}

const reviewable = (id: string, tenant: string) => ({
  id, tenant_id: tenant, channel_slug: "linkedin_ads", status: "pending", exec_class: null, exec_status: null, approved_by: null,
  body: { step: { responsibility: "client", deliverable: { presentation: { type: "campaign_draft" } } } },
});
const creative = (accountId: string, n: number, reference: string) => ({ id: `urn:li:sponsoredCreative:${n}`, account: `urn:li:sponsoredAccount:${accountId}`, campaign: "urn:li:sponsoredCampaign:1", content: { reference } });
const providerBinding = (tenant: string, accountId: string) => ({ id: `binding-${tenant}-${accountId}`, tenant_id: tenant, platform: "linkedin", provider_account_id: accountId, funding_source: "provider", credential_source: "tenant_connector", credential_ref: "linkedin_ads.access_token", credential_tenant_id: tenant });
const walletBinding = (tenant: string) => ({ id: `wallet-${tenant}`, tenant_id: tenant, platform: "linkedin", provider_account_id: MANAGED_ACCOUNT, funding_source: "wallet", credential_source: "platform", credential_ref: "linkedin_ads_managed_main", credential_tenant_id: null });
const apiCalls = () => h.calls.filter((c) => c.url.startsWith("https://api.linkedin.com/"));
const authorFinderCalls = () => apiCalls().filter((c) => new URL(c.url).pathname === "/rest/posts" && new URL(c.url).searchParams.get("q") === "author");
const OWN_ROW = { post_urn: OWN_POST, text: "Zavi Labs ships the #growth agent with Upcar.", date: new Date(OWN_PUBLISHED).toISOString(), thumbnail_url: OWN_IMAGE_URL, label: USED_IN_AD };
const PUBLIC_OWN_ROW = { post_urn: PUBLIC_OWN_POST, text: "Zavi Labs, publicly.", date: urnDate(PUBLIC_OWN_POST), thumbnail_url: null, label: USED_IN_AD };

beforeEach(() => {
  resetLinkedInAdsReadCache();
  resetLinkedInPostListCache();
  h.role = "owner";
  h.revoked.clear();
  h.calls = [];
  h.secretReads = [];
  h.claims = [];
  h.claimsError = false;
  h.authorFinder = { status: 403, body: { status: 403, serviceErrorCode: 100, code: "ACCESS_DENIED", message: "Not enough permissions to access: posts.FINDER-author.20260801" } };
  h.rows = {
    channel_actions: [reviewable(ACTION_A, TENANT_A), reviewable(ACTION_B, TENANT_B)],
    ads_account_binding_details: [providerBinding(TENANT_A, OWN_ACCOUNT), providerBinding(TENANT_B, OTHER_ACCOUNT)],
  };
  h.creatives = {
    [OWN_ACCOUNT]: [creative(OWN_ACCOUNT, 1, OWN_POST), creative(OWN_ACCOUNT, 2, UPCAR_POST), creative(OWN_ACCOUNT, 3, MEMBER_POST), creative(OWN_ACCOUNT, 4, PUBLIC_OWN_POST), creative(OWN_ACCOUNT, 5, PUBLIC_SIBLING_POST), creative(OWN_ACCOUNT, 6, OWN_POST)],
    [OTHER_ACCOUNT]: [creative(OTHER_ACCOUNT, 9, UPCAR_POST)],
    [MANAGED_ACCOUNT]: [creative(MANAGED_ACCOUNT, 7, OWN_POST)],
  };
  vi.stubGlobal("fetch", linkedin());
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("GET /api/channels/linkedin_ads/actions/:actionId/posts", () => {
  it("returns nothing for a shared-wallet account and asks LinkedIn nothing, even when the founder's own login can see that account", async () => {
    h.rows.ads_account_binding_details.push(walletBinding(TENANT_A));
    const r = await list({ account_id: MANAGED_ACCOUNT });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ posts: [], page_name: null });
    expect(h.calls).toEqual([]);
    expect(h.secretReads).toEqual([]);
  });

  it("returns nothing for an account Zavi manages when the wallet binding is not offered to this workspace", async () => {
    h.claims = [{ platform: "linkedin", provider_account_id: MANAGED_ACCOUNT, credential_source: "platform", credential_tenant_id: null, claim_released_at: null }];
    const r = await list({ account_id: MANAGED_ACCOUNT });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ posts: [], page_name: null });
    expect(h.calls).toEqual([]);
    expect(h.secretReads).toEqual([]);
  });

  it("lists only posts the ad account's own page wrote, and drops another page's, a member's and a sibling company's", async () => {
    const r = await list({ account_id: OWN_ACCOUNT });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ posts: [OWN_ROW, PUBLIC_OWN_ROW], page_name: "Zavi Labs" });
    expect(apiCalls().every((c) => c.method === "GET" && c.auth === `Bearer tok-${TENANT_A}`)).toBe(true);
    expect(apiCalls().some((c) => c.url.includes(`adAccounts/${OTHER_ACCOUNT}`) || c.url.includes(`adAccounts/${MANAGED_ACCOUNT}`))).toBe(false);
    expect(h.secretReads).toEqual([]);
  });

  it("keeps a post behind an ad when LinkedIn lets nobody read who wrote it, and still drops one a member or another page wrote", async () => {
    h.creatives[OWN_ACCOUNT] = [creative(OWN_ACCOUNT, 1, UNREADABLE_POST), creative(OWN_ACCOUNT, 2, WALLED_PAGE_POST), creative(OWN_ACCOUNT, 3, PUBLIC_MEMBER_POST), creative(OWN_ACCOUNT, 4, PUBLIC_SIBLING_POST)];
    const r = await list({ account_id: OWN_ACCOUNT });
    expect(r.statusCode).toBe(200);
    expect(r.body.posts).toEqual([
      { post_urn: WALLED_PAGE_POST, text: "Skip the overwhelm.", date: urnDate(WALLED_PAGE_POST), thumbnail_url: "https://media.licdn.com/dms/image/walled/0?e=1&v=beta", label: USED_IN_AD },
      { post_urn: UNREADABLE_POST, text: null, date: urnDate(UNREADABLE_POST), thumbnail_url: null, label: USED_IN_AD },
    ]);
  });

  it("refuses a member before anything is read", async () => {
    h.role = "member";
    const r = await list({ account_id: OWN_ACCOUNT });
    expect(r.statusCode).toBe(403);
    expect(r.body).toEqual({ error: { code: "forbidden" } });
    expect(h.calls).toEqual([]);
  });

  it("refuses another workspace's action id before anything is read", async () => {
    const r = await list({ account_id: OWN_ACCOUNT }, { actionId: ACTION_B });
    expect(r.statusCode).toBe(404);
    expect(r.body.error.code).toBe("linkedin_ads_not_found");
    expect(h.calls).toEqual([]);
  });

  it("refuses another workspace's ad account and never reads its ads", async () => {
    const r = await list({ account_id: OTHER_ACCOUNT });
    expect(r.statusCode).toBe(409);
    expect(r.body).toEqual({ error: { code: "linkedin_ads_conflict", message: POST_LIST_ACCOUNT_NOT_LINKED } });
    expect(apiCalls().some((c) => c.url.includes("/creatives") || c.url.includes("/rest/posts"))).toBe(false);
  });

  it("refuses an account this login can see once another workspace holds it, and fails closed when the holder read fails", async () => {
    h.claims = [{ platform: "linkedin", provider_account_id: OWN_ACCOUNT, credential_source: "tenant_connector", credential_tenant_id: TENANT_B, claim_released_at: null }];
    const held = await list({ account_id: OWN_ACCOUNT });
    expect(held.statusCode).toBe(409);
    expect(held.body.error.message).toBe(POST_LIST_ACCOUNT_NOT_LINKED);
    h.claims = [];
    h.claimsError = true;
    const down = await list({ account_id: OWN_ACCOUNT });
    expect(down.statusCode).toBe(502);
    expect(h.calls).toEqual([]);
  });

  it("falls back to the posts behind ads when LinkedIn refuses the page-posts read for a missing scope, and surfaces no error", async () => {
    const r = await list({ account_id: OWN_ACCOUNT });
    expect(r.statusCode).toBe(200);
    expect(r.body.error).toBeUndefined();
    expect(r.body.posts).toEqual([OWN_ROW, PUBLIC_OWN_ROW]);
    const asked = authorFinderCalls();
    expect(asked).toHaveLength(1);
    expect(asked[0].auth).toBe(`Bearer tok-${TENANT_A}`);
    expect(asked[0].restli).toBe("FINDER");
    expect(new URL(asked[0].url).searchParams.get("author")).toBe(ZAVI_PAGE);
    resetLinkedInAdsReadCache();
    h.creatives[OWN_ACCOUNT] = [creative(OWN_ACCOUNT, 1, OWN_POST)];
    const cached = await list({ account_id: OWN_ACCOUNT });
    expect(cached.body.posts).toEqual([OWN_ROW, PUBLIC_OWN_ROW]);
    expect(authorFinderCalls()).toHaveLength(1);
  });

  it("adds the page's own recent posts when the read is allowed: newest first, one row per post, ad use wins the label", async () => {
    h.authorFinder = { status: 200, body: { elements: [
      { id: PAGE_ONLY_POST, author: ZAVI_PAGE, lifecycleState: "PUBLISHED", publishedAt: PAGE_ONLY_PUBLISHED, commentary: "Hiring a growth engineer." },
      { id: OWN_POST, author: ZAVI_PAGE, lifecycleState: "PUBLISHED", publishedAt: OWN_PUBLISHED, commentary: "Zavi Labs ships the growth agent." },
      { id: STRANGER_PAGE_POST, author: UPCAR_PAGE, lifecycleState: "PUBLISHED", publishedAt: PAGE_ONLY_PUBLISHED, commentary: "Not this page." },
      { id: DRAFT_PAGE_POST, author: ZAVI_PAGE, lifecycleState: "DRAFT", publishedAt: PAGE_ONLY_PUBLISHED, commentary: "Not published." },
      { id: "urn:li:share:7390000000000000333", author: ZAVI_PAGE, lifecycleState: "PUBLISHED", publishedAt: PAGE_ONLY_PUBLISHED, commentary: "", reshareContext: { parent: "urn:li:share:7000000000000000001", root: "urn:li:share:7000000000000000001" } },
    ] } };
    const r = await list({ account_id: OWN_ACCOUNT });
    expect(r.statusCode).toBe(200);
    expect(r.body.posts).toEqual([
      { post_urn: PAGE_ONLY_POST, text: "Hiring a growth engineer.", date: new Date(PAGE_ONLY_PUBLISHED).toISOString(), thumbnail_url: null, label: PAGE_POST },
      OWN_ROW,
      PUBLIC_OWN_ROW,
    ]);
  });

  it("answers token_revoked, not an empty list, when LinkedIn refuses the token", async () => {
    h.revoked.add(TENANT_A);
    const r = await list({ account_id: OWN_ACCOUNT });
    expect(r.statusCode).toBe(403);
    expect(r.body.error.code).toBe("linkedin_ads_token_revoked");
  });

  it("refuses a malformed account id", async () => {
    const r = await list({ account_id: "50999/creatives" });
    expect(r.statusCode).toBe(400);
    expect(h.calls).toEqual([]);
  });
});
