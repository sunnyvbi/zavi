import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPartialRiskExecCode } from "@zavi/shared";

const m = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  calls: [] as string[],
  bind: vi.fn(),
  lifecycleError: null as null | { message: string },
  disabled: false,
  refuseCampaign: false,
  refusal: { status: 422, body: { message: "/dailyBudget: below minimum" } as unknown },
  refuseGroup: null as unknown,
}));
vi.mock("@/services/channels/lock", async (original) => ({ ...(await original<typeof import("@/services/channels/lock")>()), isChannelLockedStrict: async () => false }));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: async () => ({ allowed: true, enforced: true }) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantClient: () => ({
    from: (table: string) => {
      let result: unknown = { data: [{ id: "row" }], error: null };
      const q: Record<string, unknown> = {
        then: (done: (v: unknown) => void) => done(result),
        select: () => q,
        eq: () => q,
        is: () => q,
        update: (patch: Record<string, unknown>) => {
          if (table === "channel_actions") m.row.exec_progress = patch.exec_progress;
          return q;
        },
        insert: () => q,
        upsert: () => {
          if (table === "ads_campaign_lifecycle" && m.lifecycleError) result = { data: null, error: m.lifecycleError };
          return q;
        },
        maybeSingle: async () => ({ data: table === "tenant_users" ? { role: "owner" } : structuredClone(m.row), error: null }),
      };
      return q;
    },
  }),
}));
vi.mock("@/services/ads-wallet/accounts", () => ({
  accountChoices: async () => ({ accounts: [{ id: "binding", platform: "linkedin", provider_account_id: "11", funding_source: "provider", currency: "USD", disabled: m.disabled }], managed: [], selected_id: "binding" }),
  connectCustomerAccount: async () => "binding",
  assertAccountAvailableForNewCampaign: async () => {},
}));
vi.mock("@/services/ads-wallet/bindings", () => ({ getAccountBinding: async (_t: string, id: string) => ({ id }), bindCampaign: m.bind }));
vi.mock("@/services/ads-wallet/adapters/linkedin-account", () => ({
  resolveLinkedinAccount: async () => ({ token: "tok", account: { id: "11", currency: "USD", reference: "urn:li:organization:42" } }),
}));

import { executeLinkedInCampaignAction } from "../action-execution";
import { classifyExecFailure } from "@/services/channels/exec-failure";

const id = "10000000-0000-4000-8000-000000000001";
const claim = "20000000-0000-4000-8000-000000000002";
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
const ids: Record<string, string> = { adCampaignGroups: "600", adCampaigns: "700", creatives: "800" };
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ({ ok: status < 300, status, headers: new Headers(headers), json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const creates = () => m.calls.filter((c) => c.startsWith("POST") && !/\/\d+$/.test(c));

beforeEach(() => {
  process.env.LINKEDIN_ADS_WRITE_ENABLED = "1";
  m.calls.length = 0;
  m.lifecycleError = null;
  m.disabled = false;
  m.refuseCampaign = false;
  m.refusal = { status: 422, body: { message: "/dailyBudget: below minimum" } };
  m.refuseGroup = null;
  m.bind.mockReset().mockResolvedValue({ id: "campaign-binding" });
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
    const u = String(url).replace("https://api.linkedin.com/rest/", "");
    if (u.startsWith("posts/")) return reply(200, { id: payload.creative.post_urn, author: "urn:li:organization:42" });
    const method = init?.method ?? "GET";
    m.calls.push(`${method} ${u.split("?")[0]}`);
    if (method === "GET" && /adCampaignGroups\/600/.test(u)) return reply(200, { id: 600, account: "urn:li:sponsoredAccount:11", name: "First test", status: "PAUSED" });
    if (method === "GET" && /adCampaigns\/700/.test(u))
      return reply(200, { id: 700, account: "urn:li:sponsoredAccount:11", campaignGroup: "urn:li:sponsoredCampaignGroup:600", associatedEntity: "urn:li:organization:42", type: "SPONSORED_UPDATES", status: "PAUSED", dailyBudget: { amount: "18", currencyCode: "USD" }, unitCost: { amount: "6", currencyCode: "USD" } });
    const kind = u.split("/").pop() ?? "";
    if (method === "POST" && kind === "adCampaignGroups" && m.refuseGroup) return reply(422, m.refuseGroup);
    if (method === "POST" && kind === "adCampaigns" && m.refuseCampaign) return reply(m.refusal.status, m.refusal.body);
    if (method === "POST" && ids[kind]) return reply(201, {}, { "x-restli-id": ids[kind] });
    return reply(204, {});
  });
});
afterEach(() => {
  delete process.env.LINKEDIN_ADS_WRITE_ENABLED;
  vi.unstubAllGlobals();
});

const exec = () => executeLinkedInCampaignAction(id, "tenant", "owner-1", claim) as Promise<{ ok: boolean; code?: string; error?: string }>;

it.each([
  ["Zavi could not record the campaign it made", () => m.bind.mockRejectedValueOnce(new Error("connection reset by Postgres"))],
  ["Zavi could not save the campaign's launch inventory", () => { m.lifecycleError = { message: "db down" }; }],
])("when %s, the card says Zavi could not finish, never tells the founder to fix LinkedIn, and Try again finishes without creating anything twice", async (_label, breakIt) => {
  breakIt();
  const first = await exec();
  expect(first.code).toBe("linkedin_ads_zavi_incomplete");
  expect(classifyExecFailure(first)).toEqual({ bucket: "temporary", fix: null, platform_code: null });
  expect(first.error).toContain("LinkedIn made the paused campaign, but Zavi could not finish saving its setup.");
  expect(first.error).toContain("problem on Zavi's side, not in LinkedIn");
  expect(first.error).not.toMatch(/Correct the issue in LinkedIn|LinkedIn refused/);
  expect(first.error).not.toContain("connection reset");
  expect(creates()).toEqual(["POST adAccounts/11/adCampaignGroups", "POST adAccounts/11/adCampaigns"]);

  m.lifecycleError = null;
  m.calls.length = 0;
  const again = await exec();
  expect(again.ok).toBe(true);
  expect(creates()).toEqual(["POST adAccounts/11/creatives"]);
});

it("a LinkedIn refusal partway through creation is still LinkedIn's to fix", async () => {
  m.refuseCampaign = true;
  const r = await exec();
  expect(creates()).toEqual(["POST adAccounts/11/adCampaignGroups", "POST adAccounts/11/adCampaigns"]);
  expect(r.code).toBe("linkedin_ads_creation_incomplete");
  expect(r.error).toContain("Correct the issue in LinkedIn");
});

it("an account the founder turned off says so on a fresh approval and on a Try again, and sends nothing to LinkedIn", async () => {
  m.disabled = true;
  const fresh = await exec();
  expect(fresh.code).toBe("linkedin_ads_account_turned_off");
  expect(fresh.error).toContain("You turned this ad account off in Zavi");
  expect(classifyExecFailure(fresh)).toMatchObject({ bucket: "temporary" });

  m.disabled = false;
  m.refuseCampaign = true;
  await exec();
  expect(m.row.exec_progress).toMatchObject({ group_id: "600", campaign_id: null, in_flight: null });
  m.disabled = true;
  m.calls.length = 0;
  const retry = await exec();
  expect(retry.code).toBe("linkedin_ads_account_turned_off");
  expect(retry.error).toContain("Campaign setup is saved and stays paused. Turn the account back on with Use this account again, then choose Try again.");
  expect(retry.error).not.toMatch(/in LinkedIn, then|LinkedIn refused/);
  expect(m.calls).toEqual([]);
});

const fieldRefusal = (fieldPath: string, description: string) => ({ errorDetails: { inputErrors: [{ description, input: { inputPath: { fieldPath } } }] } });

describe("a campaign LinkedIn refuses for a setting that is fixed once approved", () => {
  it.each([
    ["the bid field", fieldRefusal("unitCost/amount", "Value is below the minimum")],
    ["the word bid", { message: "The bid is too low for this audience" }],
  ])("%s closes the retry, says what to change, and tells the founder to start a new campaign", async (_label, body) => {
    m.refuseCampaign = true;
    m.refusal = { status: 422, body };
    const r = await exec();
    expect(r).toEqual({ ok: false, code: "exec_partial", error: "LinkedIn refused this campaign's bid of 6 USD, and a bid cannot be changed once a campaign is approved. Start a new campaign in Zavi and enter a higher bid. The empty campaign group Zavi made, First test (Zavi 10000000), stays paused, so nothing can spend. You can remove it in LinkedIn Campaign Manager." });
    expect(r.error).not.toMatch(/try again|correct the issue|in LinkedIn, then/i);
    expect(classifyExecFailure(r)).toMatchObject({ bucket: "partial_risk" });
    expect(isPartialRiskExecCode(r.code)).toBe(true);
    expect(creates()).toEqual(["POST adAccounts/11/adCampaignGroups", "POST adAccounts/11/adCampaigns"]);
    expect(m.row.exec_progress).toMatchObject({ group_id: "600", group_paused: true, campaign_id: null, in_flight: null });
  });

  it.each([
    ["the targeting field", fieldRefusal("targetingCriteria", "Not enough members match")],
    ["the word audience", { message: "Audience size is below the minimum of 300" }],
  ])("%s closes the retry the same way, naming the audience and how to widen it", async (_label, body) => {
    m.refuseCampaign = true;
    m.refusal = { status: 400, body };
    const r = await exec();
    expect(r).toEqual({ ok: false, code: "exec_partial", error: "LinkedIn refused this campaign's audience, and an audience cannot be changed once a campaign is approved. Start a new campaign in Zavi with more locations or a wider professional audience. The empty campaign group Zavi made, First test (Zavi 10000000), stays paused, so nothing can spend. You can remove it in LinkedIn Campaign Manager." });
    expect(r.error).not.toMatch(/try again|correct the issue/i);
    expect(classifyExecFailure(r)).toMatchObject({ bucket: "partial_risk" });
  });

  it.each([
    ["a budget refusal", 422, { message: "/dailyBudget: below minimum" }],
    ["a date refusal", 422, fieldRefusal("runSchedule/start", "Start is in the past")],
    ["a refusal with no reason", 422, {}],
    ["a conflict that mentions the bid", 409, { message: "The bid is being updated" }],
    ["a billing refusal that mentions the audience", 402, { message: "No credit for this audience" }],
    ["a field that only contains the words", 422, fieldRefusal("audienceExpansionEnabled", "Not allowed; forbidden value")],
  ])("%s keeps Try again", async (_label, status, body) => {
    m.refuseCampaign = true;
    m.refusal = { status, body };
    const r = await exec();
    expect(r.code).toBe("linkedin_ads_creation_incomplete");
    expect(r.error).toContain("Try again");
    expect(classifyExecFailure(r)).not.toMatchObject({ bucket: "partial_risk" });
  });

  it("a refusal of the first step that mentions the audience made nothing, so it keeps Try again and blames no leftover group", async () => {
    m.refuseGroup = { message: "Audience not allowed" };
    const r = await exec();
    expect(r.code).toBe("linkedin_ads_creation_incomplete");
    expect(r.error).toMatch(/nothing was created in LinkedIn/i);
    expect(r.error).not.toContain("empty campaign group");
  });

  it("a refusal of the ad step that mentions the bid keeps the existing path: the campaign exists and can be edited in LinkedIn", async () => {
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const u = String(url).replace("https://api.linkedin.com/rest/", "");
      if (u.startsWith("posts/")) return reply(200, { id: payload.creative.post_urn, author: "urn:li:organization:42" });
      const kind = u.split("/").pop() ?? "";
      if ((init?.method ?? "GET") === "POST" && kind === "creatives") return reply(422, { message: "The bid is too low" });
      if ((init?.method ?? "GET") === "POST" && ids[kind]) return reply(201, {}, { "x-restli-id": ids[kind] });
      return reply(204, {});
    });
    const r = await exec();
    expect(r.code).toBe("linkedin_ads_creation_incomplete");
    expect(r.error).toContain("Correct the issue in LinkedIn");
  });
});
