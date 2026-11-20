import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  accountsRef: vi.fn(),
  connect: vi.fn(),
  choices: vi.fn(),
  fx: vi.fn(),
  binding: vi.fn(),
  resolve: vi.fn(),
  log: vi.fn(),
  row: {} as Record<string, unknown>,
}));
vi.mock("@/services/ads-wallet/bindings", () => ({ getAccountBinding: m.binding, bindCampaign: vi.fn() }));
vi.mock("@/services/ads-wallet/adapters/linkedin-account", () => ({ resolveLinkedinAccount: m.resolve }));
vi.mock("@/services/ads-wallet/accounts", () => ({ accountChoices: m.choices, connectCustomerAccount: m.connect, assertAccountAvailableForNewCampaign: async () => undefined }));
vi.mock("@/services/ads-wallet/fx", async (original) => ({ ...(await original<typeof import("@/services/ads-wallet/fx")>()), adsFx: m.fx }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.log }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantRpc: m.rpc,
  tenantClient: () => ({ from: () => {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: m.row, error: null }) };
    return q;
  } }),
}));
vi.mock("../client", () => ({
  listLinkedInAdAccounts: vi.fn(),
  listLinkedInAdAccountsWithReference: m.accountsRef,
  linkedinAdsToken: async () => "tenant-token",
  withLinkedInAdsToken: async (_t: string, call: (token: string) => Promise<unknown>) => call("tenant-token"),
}));

import { prepareLinkedInCampaignAction } from "../action-review";
import { linkedinCreateRefusal } from "../create-preflight";
import { countLinkedInAdsCalls, linkedinAdsGet, resetLinkedInAdsReadCache } from "../http";
import { LINKEDIN_API_VERSION } from "../constants";

const actionId = "10000000-0000-4000-8000-000000000002";
const bindingId = "10000000-0000-4000-8000-0000000000bb";
const draft = { type: "campaign_draft", channel: "linkedin_ads", name: "Pilot", group_name: "First test", rationale: "Worked last month.", post_preview: "Hiring", country: "US", language: "en" };
const USD = {
  use_broad_audience: true, account_id: "11", currency: "USD", daily_budget: "100", unit_cost: "0.01", country: "US", post: "https://www.linkedin.com/feed/update/urn:li:ugcPost:7000000000000000009/" };
const COPY = "This audience is under LinkedIn's minimum of 300 members. Nothing was created. Add more locations or widen the professional audience, then try again.";

type Answer = { status?: number; body?: unknown; garbled?: boolean; headers?: Record<string, string>; throws?: Error };
let audience: Answer;

const respond = (a: Answer) => {
  if (a.throws) throw a.throws;
  const status = a.status ?? 200;
  return {
    ok: status < 400,
    status,
    headers: new Headers(a.headers ?? {}),
    json: async () => { if (a.garbled) throw new SyntaxError("Unexpected token <"); return a.body; },
    text: async () => (a.garbled ? "<html>" : JSON.stringify(a.body ?? {})),
  };
};
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
  if (url.includes("/rest/posts/")) return respond({ body: { author: "urn:li:organization:42" } });
  if (url.includes("/rest/audienceCounts?")) return respond(audience);
  if (url.includes("/rest/adAccounts")) return respond({ body: { elements: [] } });
  return respond({ body: { elements: [{ bidLimits: { min: { amount: "1000000", currencyCode: "USD" } } }] } });
});
const audienceCalls = () => fetchMock.mock.calls.filter(([url]) => url.includes("/rest/audienceCounts?"));
const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== "GET");
const warns = () => m.log.mock.calls.map(([e]) => e as { level: string; code: string; tenant_id: string; meta: Record<string, unknown> });
const members = (total: number) => ({ body: { elements: [{ active: 0, total }] } });
const prepare = (input: unknown = USD) => prepareLinkedInCampaignAction("tenant", actionId, "user", input);
const refusal = async (input: unknown = USD) => (await prepare(input).then(() => { throw new Error("expected a refusal"); }, (e: Error) => e));
const expectAllowed = async (input: unknown = USD) => {
  await expect(prepare(input)).resolves.toMatchObject({ id: actionId, executable: true });
  expect(m.rpc).toHaveBeenCalledWith("tenant", "prepare_channel_campaign_action", expect.objectContaining({ p_action_id: actionId }));
};
const expectNothingPrepared = () => {
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.connect).not.toHaveBeenCalled();
  expect(writes()).toEqual([]);
};

beforeEach(() => {
  vi.clearAllMocks();
  resetLinkedInAdsReadCache();
  process.env.LINKEDIN_ADS_WRITE_ENABLED = "1";
  vi.stubGlobal("fetch", fetchMock);
  audience = members(50000);
  m.row = { status: "pending", exec_class: null, exec_status: null, approved_by: null, body: { step: { responsibility: "client", deliverable: { presentation: structuredClone(draft) } } } };
  m.accountsRef.mockResolvedValue([{ id: "11", name: "Acme", currency: "USD", status: "ACTIVE", reference: "urn:li:organization:42" }]);
  m.rpc.mockResolvedValue({ data: { ok: true }, error: null });
  m.connect.mockResolvedValue("10000000-0000-4000-8000-000000000003");
  m.choices.mockResolvedValue({ accounts: [], managed: [], selected_id: null });
  m.fx.mockImplementation(async (currency: string) => ({ currency, units_per_usd: 1, as_of: null, source: "test" }));
  m.log.mockResolvedValue(undefined);
});
afterEach(() => {
  delete process.env.LINKEDIN_ADS_WRITE_ENABLED;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("audience size", () => {
  it("refuses total 0, LinkedIn's privacy answer for under 300, and prepares nothing and sends no write", async () => {
    audience = members(0);
    const e = await refusal();
    expect(e).toMatchObject({ code: "linkedin_ads_conflict" });
    expect(e.message).toBe(COPY);
    expect(e.message).not.toMatch(/about|\b0\b/);
    expectNothingPrepared();
    expect(audienceCalls()).toHaveLength(1);
    expect(warns()).toEqual([]);
  });

  it("refuses a positive count under 300 too, should LinkedIn ever send one, without naming it", async () => {
    audience = members(299);
    const e = await refusal();
    expect(e.message).toBe(COPY);
    expect(e.message).not.toContain("299");
    expectNothingPrepared();
  });

  it("allows exactly 300", async () => {
    audience = members(300);
    await expectAllowed();
    expect(warns()).toEqual([]);
  });

  it("reads total, not the active field", async () => {
    audience = { body: { elements: [{ active: 1000000, total: 0 }] } };
    expect((await refusal()).message).toBe(COPY);
  });

  it("asks LinkedIn about the targeting Create would send, encoded the Rest.li way, on the versioned API", async () => {
    await expectAllowed();
    const [url, init] = audienceCalls()[0];
    expect(url).toBe("https://api.linkedin.com/rest/audienceCounts?q=targetingCriteriaV2&targetingCriteria=(include:(and:List((or:(urn%3Ali%3AadTargetingFacet%3Alocations:List(urn%3Ali%3Ageo%3A103644278))),(or:(urn%3Ali%3AadTargetingFacet%3AinterfaceLocales:List(urn%3Ali%3Alocale%3Aen_US))))))");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer tenant-token", "Linkedin-Version": LINKEDIN_API_VERSION, "X-Restli-Protocol-Version": "2.0.0" });
    expect(init?.headers).not.toHaveProperty("X-RestLi-Method");
  });

  it("carries every facet Create would send, with exclusions and company-size parentheses encoded as leaf values", async () => {
    const campaign = {
      name: "Pilot",
      daily_budget: { amount: "100", currency: "EUR" },
      unit_cost: { amount: "6.00", currency: "EUR" },
      geo_urns: ["urn:li:geo:101174742"],
      excluded_geo_urns: ["urn:li:geo:102095887"],
      country: "CA",
      language: "fr",
      associated_entity: "urn:li:organization:42",
      audience: { titles: [], seniorities: ["urn:li:seniority:3"], industries: [], staffCountRanges: ["urn:li:staffCountRange:(51,200)"] },
    };
    await expect(linkedinCreateRefusal("tenant", campaign, async () => "tok")).resolves.toBeNull();
    expect(audienceCalls()[0][0]).toBe("https://api.linkedin.com/rest/audienceCounts?q=targetingCriteriaV2&targetingCriteria=(include:(and:List((or:(urn%3Ali%3AadTargetingFacet%3Alocations:List(urn%3Ali%3Ageo%3A101174742))),(or:(urn%3Ali%3AadTargetingFacet%3AinterfaceLocales:List(urn%3Ali%3Alocale%3Afr_CA))),(or:(urn%3Ali%3AadTargetingFacet%3Aseniorities:List(urn%3Ali%3Aseniority%3A3))),(or:(urn%3Ali%3AadTargetingFacet%3AstaffCountRanges:List(urn%3Ali%3AstaffCountRange%3A%2851%2C200%29))))),exclude:(or:(urn%3Ali%3AadTargetingFacet%3Alocations:List(urn%3Ali%3Ageo%3A102095887))))");
  });
});

describe("the bid", () => {
  it("never asks for a bid floor, and a bid of one cent is not refused: for Sponsored Content bidLimits.min is delivery advice, not a limit", async () => {
    const seen = countLinkedInAdsCalls(() => prepare({ ...USD, unit_cost: "0.01" }));
    await expect(seen.result).resolves.toMatchObject({ executable: true });
    expect(seen.calls.filter((c) => c !== "GET posts")).toEqual(["GET audienceCounts"]);
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("adBudgetPricing"))).toEqual([]);
  });
});

describe("fails open", () => {
  it.each<[string, Answer, string, number | undefined]>([
    ["a 500", { status: 500 }, "read_failed", 500],
    ["a 429", { status: 429, headers: { "retry-after": "30" } }, "rate_limited", 429],
    ["a 403", { status: 403 }, "read_failed", 403],
    ["a 401", { status: 401 }, "read_failed", 401],
    ["a garbled body", { garbled: true }, "read_failed", undefined],
    ["a network failure", { throws: new TypeError("fetch failed") }, "read_failed", undefined],
    ["a timeout", { throws: new DOMException("timed out", "TimeoutError") }, "read_failed", undefined],
    ["an empty object", { body: {} }, "unrecognised_shape", undefined],
    ["no elements", { body: { elements: [] } }, "unrecognised_shape", undefined],
    ["two elements", { body: { elements: [{ total: 5 }, { total: 5 }] } }, "unrecognised_shape", undefined],
    ["a null body", { body: null }, "unrecognised_shape", undefined],
    ["a missing total", { body: { elements: [{ active: 12 }] } }, "unrecognised_shape", undefined],
    ["a null total", { body: { elements: [{ total: null }] } }, "unrecognised_shape", undefined],
    ["total as a string", { body: { elements: [{ total: "0" }] } }, "unrecognised_shape", undefined],
    ["total as a float", { body: { elements: [{ total: 12.5 }] } }, "unrecognised_shape", undefined],
    ["a negative total", { body: { elements: [{ total: -1 }] } }, "unrecognised_shape", undefined],
    ["elements not a list", { body: { elements: { total: 0 } } }, "unrecognised_shape", undefined],
  ])("%s allows Create and logs a warn, never the token", async (_name, answer, reason, status) => {
    audience = answer;
    await expectAllowed();
    expect(warns()).toEqual([expect.objectContaining({ level: "warn", code: "linkedin_ads.create_check_skipped", tenant_id: "tenant", meta: { stage: "audience_check", skipped_reason: reason, ...(status ? { http_status: status } : {}) } })]);
    expect(JSON.stringify(m.log.mock.calls)).not.toContain("tenant-token");
  });

  it("a failed token lookup fails open too, and asks LinkedIn nothing", async () => {
    const campaign = { name: "Pilot", daily_budget: { amount: "100", currency: "USD" }, unit_cost: { amount: "6.00", currency: "USD" }, geo_urns: ["urn:li:geo:101174742"], country: "CA", language: "en", associated_entity: "urn:li:organization:42" };
    await expect(linkedinCreateRefusal("tenant", campaign, async () => { throw new Error("vault down"); })).resolves.toBeNull();
    expect(warns().map((w) => w.meta)).toEqual([{ stage: "audience_check", skipped_reason: "read_failed" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a 429 on the check does not make LinkedIn look busy to the reads Create itself needs", async () => {
    audience = { status: 429 };
    await expectAllowed();
    const before = fetchMock.mock.calls.length;
    await linkedinAdsGet("tenant-token", "adAccounts/11");
    expect(fetchMock.mock.calls.length).toBe(before + 1);
  });

  it("after a 429 the check is not asked again until the wait ends, and Create stays allowed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 30, 12));
    audience = { status: 429, headers: { "retry-after": "30" } };
    await expectAllowed();
    await expectAllowed();
    expect(audienceCalls()).toHaveLength(1);
    expect(warns().map((w) => w.meta)).toEqual([
      { stage: "audience_check", skipped_reason: "rate_limited", http_status: 429 },
      { stage: "audience_check", skipped_reason: "rate_limited", http_status: 429 },
    ]);
    vi.setSystemTime(Date.UTC(2026, 9, 30, 12) + 31_000);
    audience = members(0);
    expect((await refusal()).message).toBe(COPY);
    expect(audienceCalls()).toHaveLength(2);
  });

  it("a daily-limit 429 stays on the check's own endpoint", async () => {
    audience = { status: 429, body: { message: "Member DAY limit reached" } };
    await expectAllowed();
    await expectAllowed();
    expect(audienceCalls()).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([u]) => u.includes("/rest/posts/"))).toHaveLength(2);
  });

  it("gives up on the check after five seconds, not the twenty every other read waits", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await expectAllowed();
    expect(timeout.mock.calls.map(([ms]) => ms).sort((a, b) => a - b)).toEqual([5000, 20000]);
  });
});

describe("call budget", () => {
  it("a second review with the same choices makes no extra call", async () => {
    const first = countLinkedInAdsCalls(() => prepare());
    await first.result;
    const second = countLinkedInAdsCalls(() => prepare());
    await second.result;
    expect(first.calls.filter((c) => c !== "GET posts")).toEqual(["GET audienceCounts"]);
    expect(second.calls.filter((c) => c !== "GET posts")).toEqual([]);
    expect(audienceCalls()).toHaveLength(1);
  });

  it("a cached under-300 answer still refuses without a call", async () => {
    audience = members(0);
    expect((await refusal()).message).toBe(COPY);
    expect((await refusal()).message).toBe(COPY);
    expect(audienceCalls()).toHaveLength(1);
  });

  it("changing the country is a new question for LinkedIn, and an answer lasts fifteen minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 30, 12));
    await expectAllowed();
    await expectAllowed({ ...USD, country: "CA" });
    expect(audienceCalls()).toHaveLength(2);
    vi.setSystemTime(Date.UTC(2026, 9, 30, 12) + 15 * 60_000 - 1);
    await expectAllowed();
    expect(audienceCalls()).toHaveLength(2);
    vi.setSystemTime(Date.UTC(2026, 9, 30, 12) + 15 * 60_000 + 1);
    await expectAllowed();
    expect(audienceCalls()).toHaveLength(3);
  });

  it("does not cache a failed read: the next review may ask again", async () => {
    audience = { status: 500 };
    await expectAllowed();
    audience = members(0);
    expect((await refusal()).message).toBe(COPY);
    expect(audienceCalls()).toHaveLength(2);
  });

  it("reads a shared-wallet account with that account's token, never the tenant's, and never shares its cache", async () => {
    m.binding.mockResolvedValue({ id: bindingId, funding_source: "wallet" });
    m.resolve.mockResolvedValue({ token: "wallet-token", account: { id: "11", name: "Managed", currency: "USD", reference: "urn:li:organization:42" } });
    await expectAllowed({ ...USD, account_binding_id: bindingId });
    expect((audienceCalls()[0][1]?.headers as Record<string, string>).Authorization).toBe("Bearer wallet-token");
    await expectAllowed();
    expect((audienceCalls()[1][1]?.headers as Record<string, string>).Authorization).toBe("Bearer tenant-token");
  });
});
