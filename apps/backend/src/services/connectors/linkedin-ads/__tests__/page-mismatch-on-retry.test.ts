import { afterEach, beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  resolve: vi.fn(),
  bind: vi.fn(),
  author: "unreadable" as string,
  archive: { campaign: true, group: true },
  calls: [] as Array<{ method: string; path: string; body: unknown }>,
}));
vi.mock("@/services/channels/lock", () => ({ isChannelLockedStrict: async () => false }));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: async () => ({ allowed: true, enforced: true }) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => undefined }));
vi.mock("@/services/ads-wallet/accounts", () => ({ accountChoices: async () => ({ accounts: [{ id: "binding", platform: "linkedin", provider_account_id: "11", funding_source: "provider", currency: "USD", disabled: false }], managed: [], selected_id: null }), connectCustomerAccount: async () => "binding", assertAccountAvailableForNewCampaign: async () => {} }));
vi.mock("@/services/ads-wallet/bindings", () => ({ getAccountBinding: async () => ({ id: "binding", funding_source: "provider" }), bindCampaign: m.bind }));
vi.mock("@/services/ads-wallet/adapters/linkedin-account", () => ({ resolveLinkedinAccount: m.resolve }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantClient: () => ({
    from: (table: string) => {
      let update: Record<string, unknown> | null = null;
      const q: Record<string, unknown> = {
        select: () => (update ? Promise.resolve({ data: [{ id: "a" }], error: null }) : q),
        eq: () => (table === "ads_campaign_lifecycle" ? Promise.resolve({ error: null }) : q),
        is: () => q,
        maybeSingle: async () => ({ data: table === "tenant_users" ? { role: "owner" } : m.row, error: null }),
        upsert: async () => ({ error: null }),
        insert: async () => ({ error: null }),
        update: (values: Record<string, unknown>) => {
          update = values;
          if (table === "channel_actions") m.row.exec_progress = values.exec_progress;
          return q;
        },
      };
      return q;
    },
  }),
}));

import { executeLinkedInCampaignAction } from "../action-execution";
import { verdictFor } from "@/services/channels/exec-failure";

const id = "10000000-0000-4000-8000-000000000001";
const claim = "20000000-0000-4000-8000-000000000002";
const POST = "urn:li:share:7000000000000000001";
const payload = {
  account_id: "11",
  group: { name: "First test" },
  campaign: { name: "Pilot", daily_budget: { amount: "18", currency: "USD" }, unit_cost: { amount: "6", currency: "USD" }, geo_urns: ["urn:li:geo:103644278"], country: "US", language: "en", associated_entity: "urn:li:organization:42" },
  creative: { post_urn: POST },
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ({ ok: status < 400, status, url: "", headers: new Headers(headers), json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

let creativeAnswer = 429;

beforeEach(() => {
  process.env.LINKEDIN_ADS_WRITE_ENABLED = "1";
  m.row = { status: "approved", exec_class: "linkedin_ads.create_campaign_bundle", exec_status: "dispatching", exec_payload: structuredClone(payload), approved_by: "owner-1", exec_claim_id: claim, exec_progress: null };
  m.resolve.mockReset().mockImplementation(async () => ({ token: `tok-${Math.random()}`, account: { id: "11", currency: "USD", reference: "urn:li:organization:42" } }));
  m.bind.mockReset().mockResolvedValue({ id: "campaign-binding" });
  m.author = "unreadable";
  m.archive = { campaign: true, group: true };
  m.calls = [];
  creativeAnswer = 429;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const href = String(url);
    if (href.startsWith("https://www.linkedin.com/")) return json(403, {});
    const path = href.replace("https://api.linkedin.com/rest/", "");
    const method = init?.method === "POST" ? String((init.headers as Record<string, string>)["X-RestLi-Method"]) : "GET";
    m.calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path.startsWith("posts/")) return m.author === "unreadable" ? json(500, {}) : json(200, { id: POST, author: m.author });
    if (method === "CREATE" && path === "adAccounts/11/adCampaignGroups") return json(201, {}, { "x-restli-id": "600" });
    if (method === "CREATE" && path === "adAccounts/11/adCampaigns") return json(201, {}, { "x-restli-id": "700" });
    if (method === "CREATE" && path === "adAccounts/11/creatives") return creativeAnswer === 201 ? json(201, {}, { "x-restli-id": "urn:li:sponsoredCreative:800" }) : json(creativeAnswer, { message: "Too many requests" });
    if (method === "PARTIAL_UPDATE" && path === "adAccounts/11/adCampaigns/700") return m.archive.campaign ? json(204, {}) : json(500, {});
    if (method === "PARTIAL_UPDATE" && path === "adAccounts/11/adCampaignGroups/600") {
      const archiving = (m.calls.at(-1)?.body as { patch?: { $set?: { status?: string } } })?.patch?.$set?.status === "ARCHIVED";
      return archiving && !m.archive.group ? json(500, {}) : json(204, {});
    }
    if (path.startsWith("adAccounts/11/adCampaignGroups/600")) return json(200, { id: 600, account: "urn:li:sponsoredAccount:11", name: "First test", status: "PAUSED" });
    if (path.startsWith("adAccounts/11/adCampaigns/700")) return json(200, { id: 700, account: "urn:li:sponsoredAccount:11", campaignGroup: "urn:li:sponsoredCampaignGroup:600", associatedEntity: "urn:li:organization:42", type: "SPONSORED_UPDATES", status: "PAUSED" });
    throw new Error(`unexpected LinkedIn call ${method} ${path}`);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LINKEDIN_ADS_WRITE_ENABLED;
});

const creates = () => m.calls.filter((c) => c.method === "CREATE").map((c) => c.path);
const archives = () => m.calls.filter((c) => c.method === "PARTIAL_UPDATE" && (c.body as { patch: { $set: { status: string } } }).patch.$set.status === "ARCHIVED").map((c) => c.path);

async function firstAttemptRateLimited() {
  const first = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(first).toMatchObject({ ok: false, code: "linkedin_ads_rate_limited" });
  expect(m.row.exec_progress).toMatchObject({ group_id: "600", campaign_id: "700", creative_id: null, in_flight: null });
  expect(archives()).toEqual([]);
  m.calls = [];
}

it.each([
  ["another company page", "urn:li:organization:99"],
  ["a Showcase page", "urn:li:organizationBrand:77"],
])("a post from %s caught only on Try again archives the campaign and group Zavi made and closes the card, as a refusal at the ad step does", async (_, author) => {
  await firstAttemptRateLimited();
  m.author = author;
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toMatchObject({ ok: false, code: "linkedin_ads_post_author_refused", archived: { group: true, group_name: "First test (Zavi 10000000)" } });
  const error = (r as { error: string }).error;
  expect(error).toMatch(/Zavi archived the paused campaign and campaign group it had already made, so nothing can spend/);
  expect(error).not.toMatch(/Campaign Manager|remove it|Nothing was created|Try again/i);
  expect(creates()).toEqual([]);
  expect(archives()).toEqual(["adAccounts/11/adCampaigns/700", "adAccounts/11/adCampaignGroups/600"]);
  expect(m.row.exec_progress).toMatchObject({ group_id: "600", campaign_id: "700", archived: true });
  const verdict = verdictFor(r, "linkedin_ads.create_campaign_bundle")!;
  expect(verdict.bucket).toBe("blocked_on_us");
  expect(verdict.note).not.toMatch(/Campaign Manager/);

  m.calls = [];
  const again = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(again).toMatchObject({ ok: false, code: "linkedin_ads_post_author_refused" });
  expect(m.calls).toEqual([]);
});

it("says the empty group stays paused when only the campaign could be archived", async () => {
  await firstAttemptRateLimited();
  m.author = "urn:li:organization:99";
  m.archive.group = false;
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toMatchObject({ ok: false, code: "linkedin_ads_post_author_refused", archived: { group: false } });
  expect((r as { error: string }).error).toMatch(/archived the paused campaign it had already made, so nothing can spend; the empty campaign group stays paused in LinkedIn/);
  expect(creates()).toEqual([]);
});

it("keeps the remove-it-yourself path when the campaign could not be archived, so it never claims a cleanup that did not happen", async () => {
  await firstAttemptRateLimited();
  m.author = "urn:li:organization:99";
  m.archive.campaign = false;
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toMatchObject({ ok: false, code: "exec_partial" });
  expect((r as { error: string }).error).toMatch(/Campaign Manager/);
  expect((r as { error: string }).error).not.toMatch(/archived/);
  expect(archives()).toEqual(["adAccounts/11/adCampaigns/700"]);
  expect(creates()).toEqual([]);
});

it("non-regression guard: a post from the campaign's own page on Try again finishes the ad without archiving anything", async () => {
  await firstAttemptRateLimited();
  m.author = "urn:li:organization:42";
  creativeAnswer = 201;
  expect(await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim)).toMatchObject({ ok: true });
  expect(creates()).toEqual(["adAccounts/11/creatives"]);
  expect(archives()).toEqual([]);
});
