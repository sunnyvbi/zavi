import { afterEach, beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  resolve: vi.fn(),
  bind: vi.fn(),
  fetch: vi.fn(),
  disabled: false,
  progressWrites: 0,
  lifecycleWrites: [] as Record<string, unknown>[],
}));
vi.mock("@/services/channels/lock", () => ({ isChannelLockedStrict: async () => false }));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: async () => ({ allowed: true, enforced: true }) }));
vi.mock("@/services/ads-wallet/accounts", () => ({ accountChoices: async () => ({ accounts: [{ id: "binding", platform: "linkedin", provider_account_id: "11", funding_source: "provider", currency: "USD", disabled: m.disabled }], managed: [], selected_id: null }), connectCustomerAccount: async () => "binding", assertAccountAvailableForNewCampaign: async () => {} }));
vi.mock("@/services/ads-wallet/bindings", () => ({ getAccountBinding: async () => ({ id: "binding" }), bindCampaign: m.bind }));
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
        upsert: async (row: Record<string, unknown>) => {
          if (table === "ads_campaign_lifecycle") m.lifecycleWrites.push(row);
          return { error: null };
        },
        insert: async (row: Record<string, unknown>) => {
          if (table === "ads_campaign_lifecycle") m.lifecycleWrites.push(row);
          return { error: null };
        },
        update: (values: Record<string, unknown>) => {
          update = values;
          if (table === "ads_campaign_lifecycle") m.lifecycleWrites.push(values);
          if (table === "channel_actions") {
            m.progressWrites++;
            m.row.exec_progress = values.exec_progress;
          }
          return q;
        },
      };
      return q;
    },
  }),
}));

import { executeLinkedInCampaignAction } from "../action-execution";
import { ExpectedToolError } from "@/services/tools/types";
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
const account = { id: "11", currency: "USD", reference: "urn:li:organization:42" };
const resp = (status: number, rid?: string) =>
  ({ ok: status < 400, status, headers: new Headers(rid ? { "x-restli-id": rid } : {}), json: async () => ({}), text: async () => "" }) as unknown as Response;
const posts = () => m.fetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");

beforeEach(() => {
  process.env.LINKEDIN_ADS_WRITE_ENABLED = "1";
  m.row = {
    status: "approved",
    exec_class: "linkedin_ads.create_campaign_bundle",
    exec_status: "dispatching",
    exec_payload: structuredClone(payload),
    approved_by: "owner-1",
    exec_claim_id: claim,
    exec_progress: null,
  };
  m.progressWrites = 0;
  m.lifecycleWrites = [];
  m.disabled = false;
  m.resolve.mockReset().mockResolvedValue({ token: "tok", account });
  m.bind.mockReset().mockResolvedValue({ id: "campaign-binding" });
  m.fetch.mockReset();
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
    String(url).startsWith("https://api.linkedin.com/rest/posts/")
      ? Promise.resolve({ ok: true, status: 200, json: async () => ({ id: payload.creative.post_urn, author: "urn:li:organization:42" }) })
      : m.fetch(url, init),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LINKEDIN_ADS_WRITE_ENABLED;
});

const fullCreate = () =>
  m.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(201, "700")).mockResolvedValueOnce(resp(201, "urn:li:sponsoredCreative:800"));

it("a LinkedIn role too low to manage campaigns is a clean refusal, and approving again after the fix creates the campaign", async () => {
  m.resolve.mockRejectedValueOnce(new ExpectedToolError("ads_account_read_only", "This LinkedIn connection does not have campaign-management permission for this account."));
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toEqual({
    ok: false,
    code: "exec_failed",
    error: "This LinkedIn connection does not have campaign-management permission for this account. Nothing was created in LinkedIn. Fix this, then approve the campaign again.",
  });
  expect(classifyExecFailure(r)!.bucket).not.toBe("partial_risk");
  expect(posts()).toHaveLength(0);
  expect(m.progressWrites).toBe(0);
  expect(m.row.exec_progress).toBeNull();

  fullCreate();
  const again = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(again).toMatchObject({ ok: true });
  expect(posts().map(([url]) => String(url).replace("https://api.linkedin.com/rest/", ""))).toEqual([
    "adAccounts/11/adCampaignGroups",
    "adAccounts/11/adCampaignGroups/600",
    "adAccounts/11/adCampaigns",
    "adAccounts/11/creatives",
  ]);
});

it("a launch on an ad account the founder turned off is a clean refusal that names the fix, and approving again once it is back on creates the campaign", async () => {
  m.disabled = true;
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toEqual({
    ok: false,
    code: "linkedin_ads_account_turned_off",
    error: "You turned this ad account off in Zavi with Stop using this account. Nothing was created in LinkedIn. Turn it back on with Use this account again, or review the campaign with another account, then approve it again.",
  });
  expect(classifyExecFailure(r)!.bucket).not.toBe("partial_risk");
  expect(m.fetch).not.toHaveBeenCalled();
  expect(m.resolve).not.toHaveBeenCalled();
  expect(m.progressWrites).toBe(0);

  m.disabled = false;
  fullCreate();
  expect(await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim)).toMatchObject({ ok: true });
  expect(posts()).toHaveLength(4);
});

it("an ad account that no longer matches the approval closes the card for a new review with nothing sent to LinkedIn", async () => {
  m.resolve.mockResolvedValue({ token: "tok", account: { ...account, currency: "EUR" } });
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toEqual({
    ok: false,
    code: "linkedin_ads_account_changed",
    error: "The approved account, company or currency changed. Review the campaign again. Nothing was created in LinkedIn. Start a new campaign and review it again.",
  });
  expect(classifyExecFailure(r)).toEqual({ bucket: "blocked_on_us", fix: null, platform_code: "linkedin_ads_account_changed" });
  expect(posts()).toHaveLength(0);
  expect(m.row.exec_progress).toBeNull();
});

it("a LinkedIn account read that fails before any create is a clean refusal, not an unknown outcome", async () => {
  m.resolve.mockRejectedValue(new ExpectedToolError("linkedin_ads_http_error", "LinkedIn Ads API HTTP 503."));
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toMatchObject({ ok: false, code: "exec_failed" });
  expect((r as { error: string }).error).toContain("Nothing was created in LinkedIn");
  expect(posts()).toHaveLength(0);
});

it("a group create that did not come back clearly stays an unknown outcome, never a clean refusal", async () => {
  m.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toMatchObject({ ok: false, code: "exec_outcome_unknown" });
  expect((r as { error: string }).error).not.toContain("Nothing was created in LinkedIn");
  expect(posts()).toHaveLength(1);
  expect(classifyExecFailure(r)!.bucket).toBe("partial_risk");
});

it("a group create that did not come back clearly never claims nothing was created, and names the group to look for", async () => {
  m.fetch.mockResolvedValueOnce(resp(503));
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toMatchObject({ ok: false, code: "exec_outcome_unknown" });
  const error = (r as { error: string }).error;
  expect(error).not.toMatch(/created nothing/i);
  expect(error).not.toMatch(/nothing was created/i);
  expect(error).not.toMatch(/^Created /);
  expect(error).toContain("cannot tell whether LinkedIn created it");
  expect(error).toContain("campaign group named First test");
  expect(error).not.toMatch(/approve the campaign again/i);
  expect(posts()).toHaveLength(1);
  expect(m.row.exec_progress).toMatchObject({ group_id: null, in_flight: "group_id" });
  expect(classifyExecFailure(r)!.bucket).toBe("partial_risk");
});

it("a group create LinkedIn refused outright says nothing was created, offers Try again, and never sends the founder to remove anything", async () => {
  m.fetch.mockResolvedValueOnce(resp(422));
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toMatchObject({ ok: false, code: "linkedin_ads_creation_incomplete" });
  const error = (r as { error: string }).error;
  expect(error).toMatch(/nothing was created in LinkedIn/i);
  expect(error).not.toMatch(/setup is saved/i);
  expect(error).not.toMatch(/keep the campaign paused/i);
  expect(error).not.toMatch(/remove it/i);
  expect(error).not.toMatch(/did not come back clearly/i);
  expect(error).toContain("choose Try again");
  expect(posts()).toHaveLength(1);
  expect(m.row.exec_progress).toMatchObject({ group_id: null, in_flight: null });
  expect(classifyExecFailure(r)!.bucket).toBe("temporary");

  fullCreate();
  expect(await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim)).toMatchObject({ ok: true });
  expect(posts().map(([url]) => String(url).replace("https://api.linkedin.com/rest/", ""))).toEqual([
    "adAccounts/11/adCampaignGroups",
    "adAccounts/11/adCampaignGroups",
    "adAccounts/11/adCampaignGroups/600",
    "adAccounts/11/adCampaigns",
    "adAccounts/11/creatives",
  ]);
});

it("a lost answer on the campaign create after the group was created says the group exists and offers a Try again that checks first", async () => {
  m.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockRejectedValueOnce(new TypeError("fetch failed"));
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toMatchObject({ ok: false, code: "linkedin_ads_creation_unconfirmed" });
  expect((r as { error: string }).error).toContain("the campaign group it made, First test (Zavi 10000000)");
  expect((r as { error: string }).error).not.toContain("Nothing was created in LinkedIn");
  expect((r as { error: string }).error).not.toContain("fetch failed");
  expect(posts()).toHaveLength(3);
  expect(m.row.exec_progress).toMatchObject({ group_id: "600", in_flight: "campaign_id" });
  expect(classifyExecFailure(r)!.bucket).toBe("temporary");
});

it("an internal error before any create gives plain copy with no internal detail", async () => {
  m.resolve.mockRejectedValue(new Error("relation ads_account_bindings does not exist"));
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toEqual({
    ok: false,
    code: "linkedin_ads_zavi_incomplete",
    error: "Zavi could not finish its own checks before creating the campaign. This was a problem on Zavi's side, not in LinkedIn, and nothing was created in LinkedIn. Choose Try again.",
  });
  expect(classifyExecFailure(r)).toEqual({ bucket: "temporary", fix: null, platform_code: null });
  expect((r as { error: string }).error).not.toContain("ads_account_bindings");
  expect(posts()).toHaveLength(0);
});

const campaignCreated = () => {
  const sent = posts().find(([url]) => String(url).endsWith("/adCampaigns"));
  if (!sent) throw new Error("No campaign was created in the first attempt");
  return { id: 700, ...(JSON.parse(String((sent[1] as RequestInit).body)) as Record<string, unknown>) };
};
const read = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
const refusedAd = () =>
  m.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(201, "700")).mockResolvedValueOnce(resp(422));
const postedPaths = () => posts().map(([url]) => String(url).replace("https://api.linkedin.com/rest/", ""));

it("a founder who follows the card and edits the paused campaign in LinkedIn can Try again, and Zavi adds only the draft ad", async () => {
  refusedAd();
  const first = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(first).toMatchObject({ ok: false, code: "linkedin_ads_creation_incomplete" });
  expect((first as { error: string }).error).toContain("Correct the issue in LinkedIn, then choose Try again");
  expect(classifyExecFailure(first)!.bucket).not.toBe("partial_risk");
  const edited = { ...campaignCreated(), name: "Pilot v2", dailyBudget: { amount: "40", currencyCode: "USD" }, unitCost: { amount: "9", currencyCode: "USD" }, targetingCriteria: { include: { and: [{ or: { "urn:li:adTargetingFacet:locations": ["urn:li:geo:101165590"] } }] } }, audienceExpansionEnabled: true };
  m.fetch.mockReset();
  m.fetch
    .mockResolvedValueOnce(read({ id: 600, account: "urn:li:sponsoredAccount:11", status: "PAUSED", name: "First test, renamed" }))
    .mockResolvedValueOnce(read(edited))
    .mockResolvedValueOnce(resp(201, "urn:li:sponsoredCreative:800"));
  const again = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(again).toMatchObject({ ok: true });
  expect(postedPaths()).toEqual(["adAccounts/11/creatives"]);
  expect(JSON.parse(String((posts()[0][1] as RequestInit).body))).toEqual({ campaign: "urn:li:sponsoredCampaign:700", content: { reference: payload.creative.post_urn }, intendedStatus: "DRAFT" });
  expect(m.row.exec_progress).toMatchObject({ group_id: "600", campaign_id: "700", creative_id: "800", in_flight: null });
});

it("a campaign switched on in LinkedIn outside Zavi stops the Try again for good, says so plainly, and sends nothing", async () => {
  refusedAd();
  await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  const switchedOn = { ...campaignCreated(), status: "ACTIVE" };
  m.fetch.mockReset();
  m.fetch
    .mockResolvedValueOnce(read({ id: 600, account: "urn:li:sponsoredAccount:11", status: "PAUSED", name: "First test" }))
    .mockResolvedValueOnce(read(switchedOn));
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toEqual({
    ok: false,
    code: "exec_partial",
    error: "The campaign Zavi made is no longer paused in LinkedIn, outside Zavi. Edits to its name, budget, bid or audience are fine, but this one means Zavi cannot be sure the next step lands on the campaign it made, so Zavi stopped and will not finish this campaign. Open LinkedIn Campaign Manager to pause or remove what Zavi made, then approve a new campaign in Zavi. Do not activate it there: launch only from Zavi, which holds the budget first.",
  });
  expect((r as { error: string }).error).not.toContain("did not come back clearly");
  expect((r as { error: string }).error).not.toContain("Try again");
  expect(posts()).toHaveLength(0);
  expect(classifyExecFailure(r)!.bucket).toBe("partial_risk");
  expect(m.row.exec_progress).toMatchObject({ group_id: "600", campaign_id: "700", creative_id: null });
});

it("a campaign moved to another campaign group in LinkedIn is never given Zavi's ad, and the card says it was changed outside Zavi", async () => {
  refusedAd();
  await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  const moved = { ...campaignCreated(), campaignGroup: "urn:li:sponsoredCampaignGroup:999" };
  m.fetch.mockReset();
  m.fetch
    .mockResolvedValueOnce(read({ id: 600, account: "urn:li:sponsoredAccount:11", status: "PAUSED", name: "First test" }))
    .mockResolvedValueOnce(read(moved));
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toMatchObject({ ok: false, code: "exec_partial" });
  expect((r as { error: string }).error).toMatch(/^The campaign Zavi made was moved to another ad account, campaign group or company page in LinkedIn, outside Zavi\. /);
  expect((r as { error: string }).error).not.toContain("did not come back clearly");
  expect(posts()).toHaveLength(0);
  expect(classifyExecFailure(r)!.bucket).toBe("partial_risk");
});

const PAUSED_AD_REFUSAL = "/Creative/status transition is not allowed from null to PAUSED if /Creative/review/reviewStatus is not set to APPROVED.";

function realLinkedIn() {
  const li = {
    groups: new Map<string, Record<string, unknown>>(),
    campaigns: new Map<string, Record<string, unknown>>(),
    ads: new Map<string, Record<string, unknown>>(),
    groupCreates: 0,
    campaignCreates: 0,
    adRefusals: [] as unknown[],
    refuseEveryAd: false,
  };
  const reply = (status: number, body: unknown, rid?: string) =>
    ({ ok: status < 400, status, headers: new Headers(rid ? { "x-restli-id": rid } : {}), json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
  m.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = decodeURIComponent(String(url).replace("https://api.linkedin.com/rest/adAccounts/11/", ""));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const [kind, rawId] = path.split("/");
    const objects = kind === "adCampaignGroups" ? li.groups : kind === "adCampaigns" ? li.campaigns : kind === "creatives" ? li.ads : null;
    if (!objects) throw new Error(`The fake LinkedIn has no route for ${path}`);
    if (init?.method !== "POST") {
      const found = objects.get(rawId.replace("urn:li:sponsoredCreative:", ""));
      return found ? reply(200, found) : reply(404, { message: "not found" });
    }
    if (rawId) {
      const patch = (body.patch as { $set: Record<string, unknown> }).$set;
      Object.assign(objects.get(rawId)!, patch);
      return reply(204, {});
    }
    if (kind === "adCampaignGroups") {
      li.groupCreates++;
      const newId = String(599 + li.groupCreates);
      li.groups.set(newId, { id: Number(newId), ...body });
      return reply(201, {}, newId);
    }
    if (kind === "adCampaigns") {
      const parent = li.groups.get(String(body.campaignGroup).replace("urn:li:sponsoredCampaignGroup:", ""));
      if (body.status === "PAUSED" && parent?.status === "DRAFT") return reply(400, { status: 400, message: "/Campaign/status cannot be set to PAUSED if /CampaignGroup/status is set to DRAFT" });
      li.campaignCreates++;
      const newId = String(699 + li.campaignCreates);
      li.campaigns.set(newId, { id: Number(newId), ...body });
      return reply(201, {}, newId);
    }
    if (li.refuseEveryAd || body.intendedStatus === "PAUSED") {
      li.adRefusals.push(body);
      return reply(400, { status: 400, message: PAUSED_AD_REFUSAL });
    }
    const newId = String(800 + li.ads.size);
    li.ads.set(newId, { id: `urn:li:sponsoredCreative:${newId}`, ...body });
    return reply(201, {}, `urn:li:sponsoredCreative:${newId}`);
  });
  return li;
}

function expectNoOrphans(li: ReturnType<typeof realLinkedIn>) {
  const campaigns = [...li.campaigns.entries()];
  const ads = [...li.ads.values()];
  for (const groupId of li.groups.keys()) expect(campaigns.filter(([, c]) => c.campaignGroup === `urn:li:sponsoredCampaignGroup:${groupId}`)).toHaveLength(1);
  for (const [campaignId] of campaigns) expect(ads.filter((a) => a.campaign === `urn:li:sponsoredCampaign:${campaignId}`)).toHaveLength(1);
}

it("against a LinkedIn that refuses a new PAUSED ad, the real create flow ends with one DRAFT ad, a paused campaign and group, and no orphan", async () => {
  const li = realLinkedIn();
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(li.adRefusals).toEqual([]);
  expect(r).toMatchObject({ ok: true });
  expect((li.groups.get("600") as { status: string }).status).toBe("PAUSED");
  expect((li.campaigns.get("700") as { status: string }).status).toBe("PAUSED");
  expect([...li.ads.values()]).toEqual([{ id: "urn:li:sponsoredCreative:800", campaign: "urn:li:sponsoredCampaign:700", content: { reference: payload.creative.post_urn }, intendedStatus: "DRAFT" }]);
  expectNoOrphans(li);
  expect(m.bind).toHaveBeenCalledTimes(1);
  expect(m.row.exec_progress).toMatchObject({ group_id: "600", campaign_id: "700", creative_id: "800", in_flight: null });
  expect(m.lifecycleWrites).toContainEqual(expect.objectContaining({ provider_group_id: "600", created_paused: true }));
  expect(m.lifecycleWrites).toContainEqual({ provider_creative_ids: ["800"] });
});

it("replays the live Flow 10 failure: LinkedIn refused the ad once, and Try again adds exactly one DRAFT ad to the same campaign with no second group or campaign", async () => {
  const li = realLinkedIn();
  li.refuseEveryAd = true;
  const first = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(first).toMatchObject({ ok: false, code: "linkedin_ads_creation_incomplete" });
  expect((first as { error: string }).error).toContain(`LinkedIn said: "${PAUSED_AD_REFUSAL}"`);
  expect(li.ads.size).toBe(0);
  expect(m.row.exec_progress).toMatchObject({ group_id: "600", campaign_id: "700", creative_id: null, in_flight: null });
  li.refuseEveryAd = false;
  li.adRefusals = [];
  const again = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(li.adRefusals).toEqual([]);
  expect(again).toMatchObject({ ok: true });
  expect(li.groupCreates).toBe(1);
  expect(li.campaignCreates).toBe(1);
  expect([...li.ads.values()].map((a) => [a.campaign, a.intendedStatus])).toEqual([["urn:li:sponsoredCampaign:700", "DRAFT"]]);
  expectNoOrphans(li);
});
