import { afterEach, beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  resolve: vi.fn(),
  bind: vi.fn(),
  fetch: vi.fn(),
  disabled: false,
  progressWrites: 0,
  failWrite: 0,
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
        select: () => (update ? Promise.resolve({ data: table === "channel_actions" && m.progressWrites === m.failWrite ? [] : [{ id: "a" }], error: null }) : q),
        eq: () => (table === "ads_campaign_lifecycle" ? Promise.resolve({ error: null }) : q),
        is: () => q,
        maybeSingle: async () => ({ data: table === "tenant_users" ? { role: "owner" } : m.row, error: null }),
        upsert: async () => ({ error: null }),
        insert: async () => ({ error: null }),
        update: (values: Record<string, unknown>) => {
          update = values;
          if (table === "channel_actions") {
            m.progressWrites++;
            if (m.progressWrites !== m.failWrite) m.row.exec_progress = values.exec_progress;
          }
          return q;
        },
      };
      return q;
    },
  }),
}));

import { executeLinkedInCampaignAction, linkedinGroupName } from "../action-execution";
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
  m.failWrite = 0;
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

for (const [step, write] of [["the account checkpoint", 1], ["the in-flight mark for the campaign group", 2]] as const) {
  it(`a lost save of ${step} before any LinkedIn call is a retryable clean failure, and Try again creates each object once`, async () => {
    m.failWrite = write;
    const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
    expect(m.progressWrites).toBe(write);
    expect(posts()).toHaveLength(0);
    expect(r).toMatchObject({ ok: false, code: "exec_failed" });
    const error = (r as { error: string }).error;
    expect(error).toMatch(/nothing was created in LinkedIn/i);
    expect(error).not.toMatch(/campaign group named/i);
    expect(error).not.toMatch(/cannot tell whether/i);
    expect(error).not.toMatch(/remove it/i);
    expect(classifyExecFailure(r)!.bucket).not.toBe("partial_risk");
    expect(classifyExecFailure(r)!.bucket).not.toBe("blocked_on_us");

    m.failWrite = 0;
    fullCreate();
    expect(await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim)).toMatchObject({ ok: true });
    expect(posts().map(([url]) => String(url).replace("https://api.linkedin.com/rest/", ""))).toEqual([
      "adAccounts/11/adCampaignGroups",
      "adAccounts/11/adCampaignGroups/600",
      "adAccounts/11/adCampaigns",
      "adAccounts/11/creatives",
    ]);
    expect(m.row.exec_progress).toMatchObject({ group_id: "600", campaign_id: "700", creative_id: "800", in_flight: null, group_paused: true });
  });
}

type Li = { groups: string[]; campaigns: string[]; creatives: string[]; fail: Record<string, number>; lost?: boolean };
const linkedin = (li: Li) =>
  m.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url).replace("https://api.linkedin.com/rest/", "");
    const json = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
    if (init?.method === "POST") {
      const kind = path === "adAccounts/11/adCampaignGroups" ? "groups" : path === "adAccounts/11/adCampaigns" ? "campaigns" : path === "adAccounts/11/creatives" ? "creatives" : null;
      if (!kind) return resp(204);
      const made = { groups: "600", campaigns: "700", creatives: "800" }[kind];
      if (li.fail[kind]) {
        li.fail[kind]--;
        if (!li.lost) li[kind].push(made);
        return resp(503);
      }
      li[kind].push(made);
      return resp(201, kind === "creatives" ? `urn:li:sponsoredCreative:${made}` : made);
    }
    if (path.startsWith("adAccounts/11/adCampaignGroups/600")) return json({ id: 600, account: "urn:li:sponsoredAccount:11", name: "First test", status: "PAUSED" });
    if (path.startsWith("adAccounts/11/adCampaigns/700")) return json({ id: 700, account: "urn:li:sponsoredAccount:11", campaignGroup: "urn:li:sponsoredCampaignGroup:600", associatedEntity: "urn:li:organization:42", type: "SPONSORED_UPDATES", status: "PAUSED" });
    if (path.startsWith("adAccounts/11/adCampaigns?")) return json({ elements: li.campaigns.map((c) => ({ id: Number(c), campaignGroup: "urn:li:sponsoredCampaignGroup:600" })) });
    if (path.startsWith("adAccounts/11/creatives/")) return json({ id: "urn:li:sponsoredCreative:800", campaign: "urn:li:sponsoredCampaign:700", content: { reference: payload.creative.post_urn }, intendedStatus: "DRAFT" });
    if (path.startsWith("adAccounts/11/creatives?")) return json({ elements: li.creatives.map((c) => ({ id: `urn:li:sponsoredCreative:${c}`, campaign: "urn:li:sponsoredCampaign:700", content: { reference: payload.creative.post_urn } })) });
    throw new Error(`unexpected LinkedIn call ${init?.method ?? "GET"} ${path}`);
  });
const created = (kind: string) => posts().filter(([url]) => String(url).endsWith(`/rest/adAccounts/11/${kind}`)).length;

for (const step of ["campaigns", "creatives"] as const) {
  it(`a LinkedIn 5xx on the ${step === "campaigns" ? "campaign" : "ad"} create that DID land offers Try again, and Try again finds it instead of creating a second one`, async () => {
    const li: Li = { groups: [], campaigns: [], creatives: [], fail: { [step]: 1 } };
    linkedin(li);
    const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
    expect(r).toMatchObject({ ok: false, code: "linkedin_ads_creation_unconfirmed" });
    expect(classifyExecFailure(r)!.bucket).toBe("temporary");
    const error = (r as { error: string }).error;
    expect(error).toMatch(/Choose Try again/);
    expect(error).toContain("First test (Zavi 10000000)");
    expect(error).not.toMatch(/not responding|Zavi did not try again|remove it/i);
    expect(m.row.exec_progress).toMatchObject({ in_flight: step === "campaigns" ? "campaign_id" : "creative_id" });

    expect(await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim)).toMatchObject({ ok: true });
    expect(created("adCampaigns")).toBe(1);
    expect(created("creatives")).toBe(1);
    expect(m.row.exec_progress).toMatchObject({ group_id: "600", campaign_id: "700", creative_id: "800", in_flight: null });
  });
}

it("a LinkedIn 5xx on the campaign create that did NOT land creates it on Try again, exactly once", async () => {
  const li: Li = { groups: [], campaigns: [], creatives: [], fail: { campaigns: 1 }, lost: true };
  linkedin(li);
  expect(await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim)).toMatchObject({ ok: false, code: "linkedin_ads_creation_unconfirmed" });
  expect(li.campaigns).toEqual([]);
  expect(await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim)).toMatchObject({ ok: true });
  expect(li.campaigns).toEqual(["700"]);
  expect(m.row.exec_progress).toMatchObject({ campaign_id: "700", creative_id: "800", in_flight: null });
});

it("Try again refuses to adopt when the campaign group holds a campaign Zavi did not make", async () => {
  const li: Li = { groups: [], campaigns: [], creatives: [], fail: { campaigns: 1 } };
  linkedin(li);
  await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  li.campaigns.push("701");
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toMatchObject({ ok: false, code: "exec_partial" });
  expect(created("adCampaigns")).toBe(1);
});

it("a lost save right after LinkedIn made the campaign names the campaign, not just the group, and Try again reuses it", async () => {
  const li: Li = { groups: [], campaigns: [], creatives: [], fail: {} };
  linkedin(li);
  m.failWrite = 6;
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toMatchObject({ ok: false, code: "linkedin_ads_creation_unconfirmed" });
  const error = (r as { error: string }).error;
  expect(error).toMatch(/LinkedIn made the paused campaign/);
  expect(error).not.toMatch(/may not exist|did not come back clearly|cannot tell/i);
  m.failWrite = 0;
  expect(await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim)).toMatchObject({ ok: true });
  expect(created("adCampaigns")).toBe(1);
  expect(m.row.exec_progress).toMatchObject({ campaign_id: "700", creative_id: "800" });
});

it("a lost save right after LinkedIn made the campaign group names that group and its ID, and is not re-run", async () => {
  const li: Li = { groups: [], campaigns: [], creatives: [], fail: {} };
  linkedin(li);
  m.failWrite = 3;
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toMatchObject({ ok: false, code: "exec_partial" });
  const error = (r as { error: string }).error;
  expect(error).toContain("First test (Zavi 10000000) (ID 600)");
  expect(error).not.toMatch(/cannot tell whether|did not come back clearly/i);
});

it("the campaign group is created under a name only this card uses", async () => {
  const li: Li = { groups: [], campaigns: [], creatives: [], fail: {} };
  linkedin(li);
  await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  const body = JSON.parse(String((posts().find(([url]) => String(url).endsWith("/adCampaignGroups"))![1] as RequestInit).body));
  expect(body.name).toBe("First test (Zavi 10000000)");
  expect(linkedinGroupName("LinkedIn audience - 2026-11-03", "aaaaaaaa-0000-4000-8000-000000000001")).not.toBe(linkedinGroupName("LinkedIn audience - 2026-11-03", "bbbbbbbb-0000-4000-8000-000000000001"));
  expect(linkedinGroupName("x".repeat(300), id)).toHaveLength(200);
});
