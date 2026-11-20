import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPartialRiskExecCode } from "@zavi/shared";

const m = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  token: "no-role-token",
  li: {
    groups: [] as Array<{ id: number; status: string }>,
    campaigns: [] as Array<{ id: number; group: string; status: string }>,
    adAttempts: [] as Array<{ auth: string; body: Record<string, unknown> }>,
    ads: [] as Array<{ id: number; campaign: string; post: string }>,
    patches: [] as Array<{ path: string; status: string }>,
    postRead: { status: 403, body: { message: "Not enough permissions to access: posts.GET.20260901", status: 403 } as unknown },
    adReply: (() => null) as (auth: string) => { status: number; raw: string } | null,
    groupReply: null as { status: number; raw: string } | null,
  },
  bindCalls: [] as string[],
  lifecycle: [] as Record<string, unknown>[],
  logged: [] as Array<{ message: string; code: string }>,
}));
vi.mock("@/services/channels/lock", async (original) => ({ ...(await original<typeof import("@/services/channels/lock")>()), isChannelLockedStrict: async () => false }));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: async () => ({ allowed: true, enforced: true }) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async (e: { message: string; code: string }) => { m.logged.push(e); } }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantClient: () => ({
    from: (table: string) => {
      if (table === "tenant_users") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: "owner" }, error: null }) }) }) };
      if (table === "ads_campaign_lifecycle") return {
        upsert: async (row: Record<string, unknown>) => { m.lifecycle.push(row); return { error: null }; },
        insert: async (row: Record<string, unknown>) => { m.lifecycle.push(row); return { error: null }; },
        update: (row: Record<string, unknown>) => ({ eq: async () => { m.lifecycle.push(row); return { error: null }; } }),
      };
      const filters: Array<[string, unknown]> = [];
      let patch: Record<string, unknown> | null = null;
      const matches = () => filters.every(([k, v]) => v === null ? m.row[k] === null : k === "exec_progress" ? JSON.stringify(m.row[k]) === v : k === "id" || k === "channel_slug" || m.row[k] === v);
      const q: Record<string, unknown> = {
        eq: (k: string, v: unknown) => { filters.push([k, v]); return q; },
        is: (k: string, v: unknown) => { filters.push([k, v]); return q; },
        update: (values: Record<string, unknown>) => { patch = values; return q; },
        select: () => {
          if (!patch) return q;
          if (!matches()) return Promise.resolve({ data: [], error: null });
          Object.assign(m.row, structuredClone(patch));
          return Promise.resolve({ data: [{ id: "a" }], error: null });
        },
        maybeSingle: async () => ({ data: structuredClone(m.row), error: null }),
      };
      return q;
    },
  }),
}));
vi.mock("@/services/ads-wallet/accounts", () => ({
  accountChoices: async () => ({ accounts: [{ id: "binding", platform: "linkedin", provider_account_id: "559148166", funding_source: "provider", currency: "USD", disabled: false }], managed: [], selected_id: "binding" }),
  connectCustomerAccount: async () => "binding",
  assertAccountAvailableForNewCampaign: async () => {},
}));
vi.mock("@/services/ads-wallet/bindings", () => ({
  getAccountBinding: async (_t: string, id: string) => ({ id }),
  bindCampaign: async (_t: string, _b: unknown, campaignId: string) => { m.bindCalls.push(campaignId); return { id: `binding-of-${campaignId}` }; },
}));
vi.mock("@/services/ads-wallet/adapters/linkedin-account", () => ({
  resolveLinkedinAccount: async () => ({ token: m.token, account: { id: "559148166", currency: "USD", reference: "urn:li:organization:42" } }),
}));

import { executeLinkedInCampaignAction } from "../action-execution";
import { AD_REFUSED_MEMBER_POST, AD_REFUSED_PAGE_ROLE, AD_REFUSED_POST } from "../write";
import { LINKEDIN_ADS_FORBIDDEN_WRITE, resetLinkedInAdsReadCache } from "../http";
import { classifyExecFailure } from "@/services/channels/exec-failure";

const id = "10000000-0000-4000-8000-000000000001";
const claim = (n: number) => `20000000-0000-4000-8000-00000000000${n}`;
const POST = "urn:li:share:7000000000000000001";
const payload = {
  account_id: "559148166",
  group: { name: "First test" },
  campaign: { name: "Pilot", daily_budget: { amount: "18", currency: "USD" }, unit_cost: { amount: "6", currency: "USD" }, geo_urns: ["urn:li:geo:103644278"], country: "US", language: "en", associated_entity: "urn:li:organization:42" },
  creative: { post_urn: POST },
};
const MIRROR_REASON = "com.linkedin.restli.server.RestLiServiceException [HTTP Status:403]: com.linkedin.content.common.exception.BadRequestResponseException: denied by [resource: organizationUgcAuthorizations => responseStatus: DENIED]";
const MIRROR_403 = JSON.stringify({ message: MIRROR_REASON, status: 403 });
const SAVED_SUFFIX = "Campaign setup is saved. Correct the issue in LinkedIn, then choose Try again to finish the remaining steps. Zavi will reuse the saved setup and keep the campaign paused.";

const reply = (status: number, raw: string, headers: Record<string, string> = {}) =>
  ({ ok: status < 300, status, headers: new Headers(headers), json: async () => JSON.parse(raw), text: async () => raw }) as unknown as Response;

function fakeLinkedIn(url: string, init?: RequestInit): Response {
  const path = String(url).replace("https://api.linkedin.com/rest/", "").split("?")[0];
  const method = init?.method ?? "GET";
  const auth = String((init?.headers as Record<string, string>).Authorization);
  const li = m.li;
  if (path.startsWith("posts/")) return reply(li.postRead.status, JSON.stringify(li.postRead.body));
  const group = path.match(/adCampaignGroups\/(\d+)$/)?.[1];
  const campaign = path.match(/adCampaigns\/(\d+)$/)?.[1];
  if (method === "GET" && group) {
    const g = li.groups.find((x) => String(x.id) === group)!;
    return reply(200, JSON.stringify({ id: g.id, account: "urn:li:sponsoredAccount:559148166", name: "First test", status: g.status }));
  }
  if (method === "GET" && campaign) {
    const c = li.campaigns.find((x) => String(x.id) === campaign)!;
    return reply(200, JSON.stringify({ id: c.id, account: "urn:li:sponsoredAccount:559148166", campaignGroup: c.group, associatedEntity: "urn:li:organization:42", type: "SPONSORED_UPDATES", status: c.status, dailyBudget: { amount: "18", currencyCode: "USD" }, unitCost: { amount: "6", currencyCode: "USD" } }));
  }
  const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, never>;
  if (method === "POST" && group) {
    const status = (body.patch as { $set: { status: string } }).$set.status;
    li.patches.push({ path, status });
    li.groups.find((x) => String(x.id) === group)!.status = status;
    return reply(204, "{}");
  }
  if (method === "POST" && campaign) {
    const status = (body.patch as { $set: { status: string } }).$set.status;
    li.patches.push({ path, status });
    li.campaigns.find((x) => String(x.id) === campaign)!.status = status;
    return reply(204, "{}");
  }
  if (method === "POST" && path.endsWith("/adCampaignGroups")) {
    if (li.groupReply) return reply(li.groupReply.status, li.groupReply.raw);
    const made = { id: 600 + li.groups.length, status: String(body.status) };
    li.groups.push(made);
    return reply(201, "{}", { "x-restli-id": String(made.id) });
  }
  if (method === "POST" && path.endsWith("/adCampaigns")) {
    const made = { id: 700 + li.campaigns.length, group: String(body.campaignGroup), status: String(body.status) };
    li.campaigns.push(made);
    return reply(201, "{}", { "x-restli-id": String(made.id) });
  }
  if (method === "POST" && path.endsWith("/creatives")) {
    li.adAttempts.push({ auth, body });
    const refused = li.adReply(auth);
    if (refused) return reply(refused.status, refused.raw);
    const made = { id: 800 + li.ads.length, campaign: String(body.campaign), post: String((body.content as unknown as { reference: string }).reference) };
    li.ads.push(made);
    return reply(201, "{}", { "x-restli-id": `urn:li:sponsoredCreative:${made.id}` });
  }
  throw new Error(`unexpected LinkedIn call: ${method} ${path}`);
}

const exec = (n: number) => {
  m.row.exec_claim_id = claim(n);
  return executeLinkedInCampaignAction(id, "tenant", "owner-1", claim(n)) as Promise<{ ok: boolean; code?: string; error?: string; notice?: string }>;
};

beforeEach(() => {
  process.env.LINKEDIN_ADS_WRITE_ENABLED = "1";
  resetLinkedInAdsReadCache();
  m.token = "no-role-token";
  m.row = { status: "approved", exec_class: "linkedin_ads.create_campaign_bundle", exec_status: "dispatching", exec_payload: structuredClone(payload), approved_by: "owner-1", exec_claim_id: claim(1), exec_progress: null };
  m.li.groups = []; m.li.campaigns = []; m.li.adAttempts = []; m.li.ads = []; m.li.patches = [];
  m.li.postRead = { status: 403, body: { message: "Not enough permissions to access: posts.GET.20260901", status: 403 } };
  m.li.groupReply = null;
  m.li.adReply = () => null;
  m.bindCalls = []; m.lifecycle = []; m.logged = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => fakeLinkedIn(url, init));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LINKEDIN_ADS_WRITE_ENABLED;
});

describe("LinkedIn's organizationUgcAuthorizations denial at the ad step", () => {
  it("names the page permission on the card, keeps the saved setup, and Try again after a reconnect adds one ad to the same campaign", async () => {
    m.li.adReply = (auth) => auth === "Bearer poster-token" ? null : { status: 403, raw: MIRROR_403 };

    const first = await exec(1);
    expect(first).toEqual({ ok: false, code: "linkedin_ads_creation_incomplete", error: `${AD_REFUSED_PAGE_ROLE} ${SAVED_SUFFIX}` });
    expect(first.error).toContain("the LinkedIn user connected to Zavi is not allowed to sponsor this page's posts");
    expect(first.error).toContain("Ask a page admin to give that user the Sponsored Content poster role");
    expect(first.error).toContain("reconnect LinkedIn Ads with a LinkedIn user who has it");
    expect(first.error).not.toMatch(/post is public/);
    expect(first.error).not.toMatch(/organizationUgcAuthorizations|restli|Campaign Manager or Account Manager/i);
    expect(isPartialRiskExecCode(first.code ?? null)).toBe(false);
    expect(classifyExecFailure(first)!.bucket).toBe("temporary");
    expect(m.row.exec_progress).toMatchObject({ account_binding_id: "binding", group_id: "600", campaign_id: "700", creative_id: null, in_flight: null, group_paused: true });
    expect(m.row.exec_progress).not.toHaveProperty("archived");
    expect(m.li.patches).toEqual([{ path: "adAccounts/559148166/adCampaignGroups/600", status: "PAUSED" }]);
    expect(m.logged).toEqual([expect.objectContaining({ code: "linkedin_ads.write_refused", message: MIRROR_REASON })]);

    const stillDenied = await exec(2);
    expect(stillDenied).toEqual(first);

    m.token = "poster-token";
    const fixed = await exec(3);
    expect(fixed).toMatchObject({ ok: true });
    expect(m.li.groups).toHaveLength(1);
    expect(m.li.campaigns).toHaveLength(1);
    expect(m.li.campaigns[0]).toMatchObject({ id: 700, group: "urn:li:sponsoredCampaignGroup:600", status: "PAUSED" });
    expect(m.li.adAttempts.map((a) => a.auth)).toEqual(["Bearer no-role-token", "Bearer no-role-token", "Bearer poster-token"]);
    expect(m.li.ads).toEqual([{ id: 800, campaign: "urn:li:sponsoredCampaign:700", post: POST }]);
    expect(m.li.patches).toHaveLength(1);
    expect(new Set(m.bindCalls)).toEqual(new Set(["700"]));
    expect(m.row.exec_progress).toMatchObject({ group_id: "600", campaign_id: "700", creative_id: "800", in_flight: null });
    expect(m.lifecycle.at(-1)).toEqual({ provider_creative_ids: ["800"] });
  });

  it("does not let a retry on a stale claim make anything new", async () => {
    m.li.adReply = () => ({ status: 403, raw: MIRROR_403 });
    await exec(1);
    const stale = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim(9)).catch((e: Error) => e);
    expect((stale as Error).message).toBe("This campaign needs administrator approval.");
    expect(m.li.groups).toHaveLength(1);
    expect(m.li.campaigns).toHaveLength(1);
    expect(m.li.adAttempts).toHaveLength(1);
  });

  it("keeps the Thought Leader copy when the post is a member's, since the post is not the page's", async () => {
    m.li.postRead = { status: 200, body: { id: POST, author: "urn:li:person:abc" } };
    m.li.adReply = () => ({ status: 403, raw: MIRROR_403 });
    const r = await exec(1);
    expect(r.error).toBe(`${AD_REFUSED_MEMBER_POST} ${SAVED_SUFFIX}`);
  });

  it("keeps the account role copy when the denial comes before the ad step, where no campaign exists", async () => {
    m.li.groupReply = { status: 403, raw: MIRROR_403 };
    const r = await exec(1);
    expect(r.error).toContain(LINKEDIN_ADS_FORBIDDEN_WRITE);
    expect(r.error).not.toContain(AD_REFUSED_PAGE_ROLE);
    expect(m.li.campaigns).toHaveLength(0);
  });
});

describe("other refusals of the ad keep the generic copy", () => {
  it.each([
    ["a different permission", JSON.stringify({ message: "Not enough permissions to access: creatives.CREATE.20260901", status: 403 })],
    ["another denied resource", JSON.stringify({ message: "denied by [resource: organizationAuthorizations => responseStatus: DENIED]", status: 403 })],
    ["a longer name that only starts the same", JSON.stringify({ message: "denied by [resource: organizationUgcAuthorizationsV2 => responseStatus: DENIED]", status: 403 })],
    ["a page role mentioned in other words", JSON.stringify({ message: "Sponsored Content poster role required", status: 403 })],
    ["no reason at all", "{}"],
    ["a body that is not JSON", "<html>denied by organizationUgcAuthorizations</html>"],
  ])("%s on a 403", async (_label, raw) => {
    m.li.adReply = () => ({ status: 403, raw });
    const r = await exec(1);
    expect(r).toEqual({ ok: false, code: "linkedin_ads_creation_incomplete", error: `${AD_REFUSED_POST} ${SAVED_SUFFIX}` });
    expect(m.row.exec_progress).toMatchObject({ group_id: "600", campaign_id: "700", creative_id: null, in_flight: null });
  });

  it("a 400 naming the same resource is not a 403 and never gets the page role copy", async () => {
    m.li.adReply = () => ({ status: 400, raw: JSON.stringify({ message: "denied by [resource: organizationUgcAuthorizations => responseStatus: DENIED]", status: 400 }) });
    const r = await exec(1);
    expect(r.error).not.toContain(AD_REFUSED_PAGE_ROLE);
    expect(r.error).toContain("LinkedIn did not accept the ad, the last step of this campaign");
  });
});
