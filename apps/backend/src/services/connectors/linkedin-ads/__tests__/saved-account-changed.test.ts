import { afterEach, beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  linkedin: [] as string[],
  connect: vi.fn(),
}));
vi.mock("@/services/channels/lock", async (original) => ({ ...(await original<typeof import("@/services/channels/lock")>()), isChannelLockedStrict: async () => false }));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: async () => ({ allowed: true, enforced: true }) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {
        then: (done: (v: unknown) => void) => done({ data: [{ id: "row" }], error: null }),
        select: () => q,
        eq: () => q,
        is: () => q,
        update: () => q,
        insert: () => q,
        upsert: () => q,
        maybeSingle: async () => ({ data: table === "tenant_users" ? { role: "owner" } : m.row, error: null }),
      };
      return q;
    },
  }),
}));
vi.mock("@/services/ads-wallet/accounts", () => ({
  accountChoices: async () => ({ accounts: [{ id: "binding-new", platform: "linkedin", provider_account_id: "11", funding_source: "provider", currency: "USD", disabled: false }], managed: [], selected_id: "binding-new" }),
  connectCustomerAccount: m.connect,
  assertAccountAvailableForNewCampaign: async () => {},
}));
vi.mock("@/services/ads-wallet/bindings", () => ({ getAccountBinding: async (_t: string, id: string) => ({ id }), bindCampaign: vi.fn() }));
vi.mock("@/services/ads-wallet/adapters/linkedin-account", () => ({
  resolveLinkedinAccount: async () => ({ token: "tok", account: { id: "11", currency: "USD", reference: "urn:li:organization:42" } }),
}));

import { executeLinkedInCampaignAction } from "../action-execution";
import { creationJournal } from "../creation-progress";
import { classifyExecFailure } from "@/services/channels/exec-failure";

const id = "10000000-0000-4000-8000-000000000001";
const claim = "20000000-0000-4000-8000-000000000002";
const CHANGED = "Your LinkedIn ad account changed since this campaign was drafted. Start a new campaign.";
const payload = {
  account_id: "11",
  group: { name: "First test" },
  campaign: {
    name: "Pilot",
    daily_budget: { amount: "18", currency: "USD" },
    unit_cost: { amount: "6", currency: "USD" },
    geo_urns: ["urn:li:geo:103644278"],
    country: "US",
    language: "en",
    associated_entity: "urn:li:organization:42",
  },
  creative: { post_urn: "urn:li:share:7000000000000000001" },
};

function savedOn(bindingId: string, made: { group_id?: string; campaign_id?: string; creative_id?: string } = {}) {
  const fresh = creationJournal("tenant", id, claim, payload, null).state;
  m.row.exec_progress = { ...fresh, account_binding_id: bindingId, ...made, group_paused: !!made.group_id };
}

beforeEach(() => {
  process.env.LINKEDIN_ADS_WRITE_ENABLED = "1";
  m.linkedin.length = 0;
  m.connect.mockReset().mockResolvedValue("binding-new");
  m.row = {
    status: "approved",
    exec_class: "linkedin_ads.create_campaign_bundle",
    exec_status: "dispatching",
    exec_payload: structuredClone(payload),
    approved_by: "owner-1",
    exec_claim_id: claim,
    exec_progress: null,
  };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://api.linkedin.com/rest/posts/"))
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ id: payload.creative.post_urn, author: "urn:li:organization:42" }) } as unknown as Response;
    m.linkedin.push(`${init?.method ?? "GET"} ${u}`);
    return { ok: true, status: 201, headers: new Headers({ "x-restli-id": "999" }), json: async () => ({}) } as unknown as Response;
  });
});
afterEach(() => {
  delete process.env.LINKEDIN_ADS_WRITE_ENABLED;
  vi.unstubAllGlobals();
});

it("a Try again after the saved LinkedIn ad account changed, before anything was made, closes the card for a new campaign and never offers Try again", async () => {
  savedOn("binding-old");
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toEqual({ ok: false, code: "linkedin_ads_account_changed", error: `${CHANGED} Nothing was created in LinkedIn.` });
  expect(classifyExecFailure(r)).toEqual({ bucket: "blocked_on_us", fix: null, platform_code: "linkedin_ads_account_changed" });
  expect((r as { error: string }).error).not.toMatch(/approve the campaign again|Try again/i);
  expect(m.linkedin).toEqual([]);
});

it("a Try again after the saved LinkedIn ad account changed, once a campaign group and campaign exist, stops for good and says what is left paused", async () => {
  savedOn("binding-old", { group_id: "600", campaign_id: "700" });
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toEqual({
    ok: false,
    code: "exec_partial",
    error: `${CHANGED} Zavi stopped and will not try this campaign again. What it already made in LinkedIn, the campaign group and the paused campaign named First test (Zavi 10000000), stays paused, so nothing can spend. Remove it in LinkedIn Campaign Manager.`,
  });
  expect(classifyExecFailure(r)).toMatchObject({ bucket: "partial_risk" });
  expect((r as { error: string }).error).not.toMatch(/did not come back clearly|Try again|approve the campaign again/i);
  expect(m.linkedin).toEqual([]);
});

it("a Try again after the saved LinkedIn ad account changed, once the ad exists too, calls it a draft ad and says nothing can spend", async () => {
  savedOn("binding-old", { group_id: "600", campaign_id: "700", creative_id: "800" });
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toEqual({
    ok: false,
    code: "exec_partial",
    error: `${CHANGED} Zavi stopped and will not try this campaign again. What it already made in LinkedIn, the campaign group, the paused campaign and its draft ad named First test (Zavi 10000000), stays off, so nothing can spend. Remove it in LinkedIn Campaign Manager.`,
  });
  expect((r as { error: string }).error).not.toMatch(/paused ad/);
  expect(m.linkedin).toEqual([]);
});

it("a Try again on the same saved account goes on to create in LinkedIn", async () => {
  savedOn("binding-new");
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect((r as { code?: string }).code).not.toBe("linkedin_ads_account_changed");
  expect((r as { error?: string }).error ?? "").not.toContain(CHANGED);
  expect(m.linkedin[0]).toBe("POST https://api.linkedin.com/rest/adAccounts/11/adCampaignGroups");
});
