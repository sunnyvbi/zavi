
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  accounts: vi.fn(),
  accountsRef: vi.fn(),
  rpc: vi.fn(),
  targeting: vi.fn(),
  post: vi.fn(),
  refresh: vi.fn(),
  fx: vi.fn(),
  connect: vi.fn(),
  choices: vi.fn(),
  binding: vi.fn(),
  resolve: vi.fn(),
  createCheck: vi.fn(),
  managed: vi.fn(),
}));
vi.mock("@/services/ads-wallet/bindings", () => ({ getAccountBinding: m.binding }));
vi.mock("@/services/ads-wallet/consent", () => ({ sharedWalletConsent: async () => true }));
vi.mock("@/services/ads-wallet/adapters/linkedin-account", async (original) => ({ ...(await original<typeof import("@/services/ads-wallet/adapters/linkedin-account")>()), resolveLinkedinAccount: m.resolve, linkedinManagedAccountIds: m.managed }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantRpc: m.rpc,
  tenantClient: () => ({
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: m.row, error: null }) };
      return q;
    },
  }),
}));
vi.mock("../client", () => ({ listLinkedInAdAccounts: m.accounts, listLinkedInAdAccountsWithReference: m.accountsRef, linkedinAdsToken: async () => "token", withLinkedInAdsToken: async (_t: string, call: (token: string) => Promise<unknown>) => {
  try {
    return await call("token");
  } catch (e) {
    if ((e as { code?: string }).code !== "linkedin_ads_token_revoked") throw e;
    m.refresh();
    return call("refreshed-token");
  }
} }));
vi.mock("../http", async (original) => ({
  ...(await original<typeof import("../http")>()),
  linkedinAdsGet: (token: string, path: string, ...rest: unknown[]) => path.startsWith("posts/") ? m.post(token, path) : path === "audienceCounts" ? m.createCheck(token, path) : m.targeting(token, path, ...rest),
}));

vi.mock("@/services/ads-wallet/accounts",()=>({accountChoices:m.choices,connectCustomerAccount:m.connect,assertAccountAvailableForNewCampaign:async()=>undefined}));
vi.mock("@/services/ads-wallet/fx", async (original) => ({ ...(await original<typeof import("@/services/ads-wallet/fx")>()), adsFx: m.fx }));

import { LINKEDIN_WALLET_POST_PAGE, LINKEDIN_ALL_TURNED_OFF, LINKEDIN_NO_AD_ACCOUNT, LINKEDIN_VIEW_ONLY, linkedinSavedAccountClosed, linkedinSavedAccountViewOnly, prepareLinkedInCampaignAction, previewLinkedInPost, reviewLinkedInCampaignAction } from "../action-review";
import { linkedinCampaignDraftPresentationSchema, stepDecisionBodies } from "@/agents/lib/channel-recipe-step";
import { ExpectedToolError } from "@/services/tools/types";
import { LINKEDIN_ADS_FORBIDDEN_READ, LINKEDIN_ADS_READ_FAILED, LINKEDIN_ADS_RECONNECT } from "../http";
import { MANAGED_ACCOUNT_BILLING_HOLD } from "@/services/ads-wallet/adapters/linkedin-account";
import { POST_FROM_SHOWCASE } from "../post-link";

const id = "10000000-0000-4000-8000-000000000002";
const offBinding = "10000000-0000-4000-8000-0000000000aa";
const onBinding = "10000000-0000-4000-8000-0000000000bb";
const draft = {
  type: "campaign_draft",
  channel: "linkedin_ads",
  name: "Pilot sponsored post",
  group_name: "First test",
  rationale: "The hiring post drove the most profile visits last month.",
  post_preview: "We are hiring senior engineers…",
  country: "US",
  language: "en",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LINKEDIN_ADS_WRITE_ENABLED = "1";
  m.row = {
    status: "pending",
    exec_class: null,
    exec_status: null,
    approved_by: null,
    body: { step: { responsibility: "client", deliverable: { presentation: structuredClone(draft) } } },
  };
  m.accounts.mockResolvedValue([{ id: "11", name: "Acme Ads", currency: "USD", status: "ACTIVE" }]);
  m.accountsRef.mockResolvedValue([{ id: "11", name: "Acme Ads", currency: "USD", status: "ACTIVE", reference: "urn:li:organization:42" }]);
  m.rpc.mockResolvedValue({ data: { ok: true }, error: null });
  m.connect.mockResolvedValue("10000000-0000-4000-8000-000000000003");
  m.choices.mockResolvedValue({ accounts: [], managed: [], selected_id: null });
  m.fx.mockImplementation(async (currency: string) => ({ currency, units_per_usd: ({ USD: 1, INR: 86.95, EUR: 0.92 } as Record<string, number>)[currency], as_of: null, source: currency === "USD" ? "USD" : "ExchangeRate-API" }));
  m.post.mockResolvedValue({ id: "urn:li:ugcPost:7000000000000000009", author: "urn:li:organization:42" });
  m.targeting.mockResolvedValue({ elements: [{ urn: "urn:li:title:1", name: "Chief Executive Officer", facetUrn: "urn:li:adTargetingFacet:titles" }] });
  m.createCheck.mockResolvedValue({ elements: [{ total: 50000 }] });
  m.managed.mockResolvedValue(null);
});
afterEach(() => { delete process.env.LINKEDIN_ADS_WRITE_ENABLED; vi.unstubAllGlobals(); });

const input = {
  use_broad_audience: true,
  account_id: "11",
  currency: "USD",
  daily_budget: "15",
  unit_cost: "6",
  country: "US",
  post: "https://www.linkedin.com/feed/update/urn:li:ugcPost:7000000000000000009/",
};

describe("review", () => {
  it("preserves Zavi's audience suggestions when recipe output becomes a draft card", () => {
    const bodies = stepDecisionBodies({ rendered_markdown: "An evidenced audience test", steps: [{
      title: "Review the audience", body: "Reach these buyers", blocking: false, effort: "minutes",
      evidence: ["Company website"], responsibility: "client", action_type: "create_ad", intent: "create",
      deliverable: { kind: "ad", label: "Campaign draft", content: "Company post", presentation: { ...draft, audience_suggestions: { seniorities: ["Director"], industries: ["Software Development"], staffCountRanges: ["51-200 employees"] } } },
    }] });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].step.deliverable?.presentation).toMatchObject({ audience_suggestions: { seniorities: ["Director"], industries: ["Software Development"], staffCountRanges: ["51-200 employees"] } });
  });
  it("returns the draft, the linked accounts and labelled starter values", async () => {
    const r = await reviewLinkedInCampaignAction("tenant", id);
    expect(r.draft.name).toBe(draft.name);
    expect(r.accounts).toEqual([{ id: "11", name: "Acme Ads", currency: "USD", min_daily_budget: "10", account_binding_id:undefined, funding_source:"provider" }]);
    expect(r.suggested).toEqual({ daily_budget: "15", unit_cost: "6", country: "US", locations: [{ id: "urn:li:geo:103644278", name: "United States" }], excluded_locations: [], unresolved_locations: [] });
    expect(r.supported_countries.map((c) => c.code)).toEqual(["US", "GB", "CA", "IN"]);
    expect(m.targeting).not.toHaveBeenCalled();
  });

  it("starter money is USD-only: another account currency suggests nothing", async () => {
    m.accounts.mockResolvedValue([{ id: "11", name: "Acme", currency: "EUR", status: "ACTIVE" }]);
    const r = await reviewLinkedInCampaignAction("tenant", id);
    expect(r.suggested.daily_budget).toBeNull();
    expect(r.suggested.unit_cost).toBeNull();
  });

  it("gives each account LinkedIn's daily floor in its own currency, rounded up, and null when the rate cannot be read", async () => {
    m.accounts.mockResolvedValue([{ id: "11", name: "Acme", currency: "INR", status: "ACTIVE" }, { id: "12", name: "Acme EU", currency: "EUR", status: "ACTIVE" }]);
    m.fx.mockImplementation(async (currency: string) => {
      if (currency === "EUR") throw new ExpectedToolError("ads_fx_unavailable", "down");
      return { currency, units_per_usd: 86.95, as_of: null, source: "ExchangeRate-API" };
    });
    const r = await reviewLinkedInCampaignAction("tenant", id);
    expect(r.accounts.map((a) => [a.id, a.min_daily_budget])).toEqual([["11", "870"], ["12", null]]);
  });

  it("a login with no ad account is told what to do in LinkedIn, never to reconnect the same login", async () => {
    m.accounts.mockResolvedValue([]);
    const e = await reviewLinkedInCampaignAction("tenant", id).catch((x) => x);
    expect(e).toMatchObject({ code: "linkedin_ads_conflict", message: LINKEDIN_NO_AD_ACCOUNT });
    expect(e.message).not.toMatch(/Connect LinkedIn Ads|Reconnect LinkedIn/);
    expect(e.message).toContain("reconnecting the same login will not help");
  });

  it("an empty list does not wait out the read cache: an account made a minute ago opens the form", async () => {
    m.accounts.mockImplementation(async (_t: string, fresh?: boolean) => (fresh ? [{ id: "11", name: "New", currency: "USD", status: "ACTIVE" }] : []));
    const r = await reviewLinkedInCampaignAction("tenant", id);
    expect(r.accounts.map((a) => a.id)).toEqual(["11"]);
  });

  it("only closed accounts reads as no ad account too", async () => {
    m.accounts.mockResolvedValue([{ id: "11", name: "Closed", currency: "USD", status: "CANCELED" }]);
    await expect(reviewLinkedInCampaignAction("tenant", id)).rejects.toMatchObject({ message: LINKEDIN_NO_AD_ACCOUNT });
  });

  it("every account turned off is not called a missing account", async () => {
    m.choices.mockResolvedValue({ accounts: [{ id: offBinding, platform: "linkedin", provider_account_id: "11", funding_source: "provider", currency: "USD", disabled: true }], managed: [], selected_id: null });
    await expect(reviewLinkedInCampaignAction("tenant", id)).rejects.toMatchObject({ message: LINKEDIN_ALL_TURNED_OFF });
    expect(m.managed).not.toHaveBeenCalled();
  });

  it("a saved account closed in LinkedIn says closed, not that the login cannot see it", async () => {
    m.accounts.mockResolvedValue([{ id: "11", name: "Open", currency: "USD", status: "ACTIVE" }, { id: "99", name: "Closed", currency: "USD", status: "CANCELED" }]);
    m.choices.mockResolvedValue({ accounts: [{ id: onBinding, platform: "linkedin", provider_account_id: "99", funding_source: "provider", currency: "USD", disabled: false }], managed: [], selected_id: onBinding });
    await expect(reviewLinkedInCampaignAction("tenant", id)).rejects.toMatchObject({ message: linkedinSavedAccountClosed("99") });
  });

  it("a view-only login is refused before the form opens, naming the role to ask for", async () => {
    m.managed.mockResolvedValue(new Set());
    await expect(reviewLinkedInCampaignAction("tenant", id)).rejects.toMatchObject({ code: "linkedin_ads_conflict", message: LINKEDIN_VIEW_ONLY });
  });

  it("re-reads roles fresh before refusing, so a role granted a minute ago is not refused on a stale answer", async () => {
    m.managed.mockImplementation(async (_t: string, fresh: boolean) => new Set(fresh ? ["11"] : []));
    const r = await reviewLinkedInCampaignAction("tenant", id);
    expect(r.accounts.map((a) => a.id)).toEqual(["11"]);
    expect(m.managed.mock.calls.map((c) => c[1])).toEqual([false, true]);
  });

  it("offers only the accounts the login can manage when it has both kinds", async () => {
    m.accounts.mockResolvedValue([{ id: "11", name: "Can manage", currency: "USD", status: "ACTIVE" }, { id: "99", name: "View only", currency: "USD", status: "ACTIVE" }]);
    m.managed.mockResolvedValue(new Set(["11"]));
    const r = await reviewLinkedInCampaignAction("tenant", id);
    expect(r.accounts.map((a) => a.id)).toEqual(["11"]);
  });

  it("does not swap a view-only saved account for another one", async () => {
    m.accounts.mockResolvedValue([{ id: "11", name: "Can manage", currency: "USD", status: "ACTIVE" }, { id: "99", name: "Saved", currency: "USD", status: "ACTIVE" }]);
    m.choices.mockResolvedValue({ accounts: [{ id: onBinding, platform: "linkedin", provider_account_id: "99", funding_source: "provider", currency: "USD", disabled: false }], managed: [], selected_id: onBinding });
    m.managed.mockResolvedValue(new Set(["11"]));
    await expect(reviewLinkedInCampaignAction("tenant", id)).rejects.toMatchObject({ message: linkedinSavedAccountViewOnly("99") });
  });

  it.each([
    ["the role list is cut short", async () => null],
    ["the role read fails", async () => { throw new Error("down"); }],
  ])("keeps the form open when %s: prepare still enforces the role", async (_label, read) => {
    m.managed.mockImplementation(read);
    const r = await reviewLinkedInCampaignAction("tenant", id);
    expect(r.accounts.map((a) => a.id)).toEqual(["11"]);
  });

  it("reads no roles for accounts Zavi manages, which never rest on the founder's LinkedIn role", async () => {
    m.accounts.mockResolvedValue([]);
    m.choices.mockResolvedValue({ accounts: [{ id: onBinding, platform: "linkedin", provider_account_id: "m", funding_source: "wallet", currency: "USD", disabled: false }], managed: [], selected_id: onBinding });
    m.binding.mockResolvedValue({ id: onBinding });
    m.resolve.mockResolvedValue({ account: { id: "m", name: "Managed", currency: "USD", status: "ACTIVE" }, token: "t" });
    const r = await reviewLinkedInCampaignAction("tenant", id);
    expect(r.accounts.map((a) => a.id)).toEqual(["m"]);
    expect(m.managed).not.toHaveBeenCalled();
  });

  it("leaves out an ad account the founder turned off, and keeps the ones still in use", async () => {
    m.accounts.mockResolvedValue([{ id: "11", name: "Acme Ads", currency: "USD", status: "ACTIVE" }, { id: "12", name: "Acme Two", currency: "USD", status: "ACTIVE" }]);
    m.choices.mockResolvedValue({ accounts: [
      { id: offBinding, platform: "linkedin", provider_account_id: "11", funding_source: "provider", currency: "USD", disabled: true },
      { id: onBinding, platform: "linkedin", provider_account_id: "12", funding_source: "provider", currency: "USD", disabled: false },
    ], managed: [], selected_id: null });
    const r = await reviewLinkedInCampaignAction("tenant", id);
    expect(r.accounts.map((a) => [a.id, a.account_binding_id])).toEqual([["12", onBinding]]);
  });

  it("with every ad account turned off, the picker is empty and says how to link one", async () => {
    m.choices.mockResolvedValue({ accounts: [{ id: offBinding, platform: "linkedin", provider_account_id: "11", funding_source: "provider", currency: "USD", disabled: true }], managed: [], selected_id: null });
    await expect(reviewLinkedInCampaignAction("tenant", id)).rejects.toMatchObject({ code: "linkedin_ads_conflict" });
  });

  it("refuses a card that already carries an exec class", async () => {
    m.row.exec_class = "linkedin_ads.create_campaign_bundle";
    await expect(reviewLinkedInCampaignAction("tenant", id)).rejects.toThrow(/changed/i);
  });

  it("after the connection switched logins, refuses to swap the saved account for the only one the new token sees, and says how to fix it", async () => {
    m.accounts.mockResolvedValue([{ id: "560026764", name: "Other Login Ads", currency: "USD", status: "ACTIVE" }]);
    m.choices.mockResolvedValue({ accounts: [{ id: onBinding, platform: "linkedin", provider_account_id: "559148166", funding_source: "provider", currency: "USD", disabled: false }], managed: [], selected_id: onBinding });
    const e = await reviewLinkedInCampaignAction("tenant", id).then(() => null, (x: unknown) => x as ExpectedToolError);
    expect(e).toBeInstanceOf(ExpectedToolError);
    expect(e).toMatchObject({ code: "linkedin_ads_conflict" });
    expect(e!.message).toContain("559148166");
    expect(e!.message).not.toContain("560026764");
    expect(e!.message).toMatch(/Reconnect LinkedIn Ads in Connectors with the login that manages that account, or pick another account/);
    expect(m.targeting).not.toHaveBeenCalled();
  });

  it("treats a saved account the new token sees only as canceled as not available", async () => {
    m.accounts.mockResolvedValue([{ id: "559148166", name: "Zavi QA", currency: "USD", status: "CANCELED" }, { id: "560026764", name: "Other Login Ads", currency: "USD", status: "ACTIVE" }]);
    m.choices.mockResolvedValue({ accounts: [{ id: onBinding, platform: "linkedin", provider_account_id: "559148166", funding_source: "provider", currency: "USD", disabled: false }], managed: [], selected_id: onBinding });
    await expect(reviewLinkedInCampaignAction("tenant", id)).rejects.toMatchObject({ code: "linkedin_ads_conflict", message: expect.stringContaining("559148166") });
  });

  it("re-reads LinkedIn fresh before calling a saved account hidden, so a stale cached list does not block the review", async () => {
    m.accounts.mockImplementation(async (_t: string, fresh?: boolean) => fresh
      ? [{ id: "560026764", name: "Other Login Ads", currency: "USD", status: "ACTIVE" }, { id: "559148166", name: "Zavi QA", currency: "USD", status: "ACTIVE" }]
      : [{ id: "560026764", name: "Other Login Ads", currency: "USD", status: "ACTIVE" }]);
    m.choices.mockResolvedValue({ accounts: [{ id: onBinding, platform: "linkedin", provider_account_id: "559148166", funding_source: "provider", currency: "USD", disabled: false }], managed: [], selected_id: onBinding });
    const r = await reviewLinkedInCampaignAction("tenant", id);
    expect(m.accounts.mock.calls.map((c) => c[1] === true)).toEqual([false, true]);
    expect(r.accounts.map((a) => [a.id, a.account_binding_id])).toEqual([["559148166", onBinding], ["560026764", undefined]]);
  });

  it("still refuses with the saved-account message when the fresh re-read fails, and reads fresh only once", async () => {
    m.accounts.mockImplementation(async (_t: string, fresh?: boolean) => {
      if (fresh) throw new ExpectedToolError("linkedin_ads_busy", "LinkedIn is busy.");
      return [{ id: "560026764", name: "Other Login Ads", currency: "USD", status: "ACTIVE" }];
    });
    m.choices.mockResolvedValue({ accounts: [{ id: onBinding, platform: "linkedin", provider_account_id: "559148166", funding_source: "provider", currency: "USD", disabled: false }], managed: [], selected_id: onBinding });
    await expect(reviewLinkedInCampaignAction("tenant", id)).rejects.toMatchObject({ code: "linkedin_ads_conflict", message: expect.stringContaining("559148166") });
    expect(m.accounts.mock.calls.filter((c) => c[1] === true)).toHaveLength(1);
    expect(m.targeting).not.toHaveBeenCalled();
  });

  it("does not re-read LinkedIn when the cached list already holds the saved account", async () => {
    m.accounts.mockResolvedValue([{ id: "559148166", name: "Zavi QA", currency: "USD", status: "ACTIVE" }]);
    m.choices.mockResolvedValue({ accounts: [{ id: onBinding, platform: "linkedin", provider_account_id: "559148166", funding_source: "provider", currency: "USD", disabled: false }], managed: [], selected_id: onBinding });
    await reviewLinkedInCampaignAction("tenant", id);
    expect(m.accounts.mock.calls.some((c) => c[1] === true)).toBe(false);
  });

  it("keeps the saved account first when the token still sees it, alongside the others", async () => {
    m.accounts.mockResolvedValue([{ id: "560026764", name: "Other Login Ads", currency: "USD", status: "ACTIVE" }, { id: "559148166", name: "Zavi QA", currency: "USD", status: "ACTIVE" }]);
    m.choices.mockResolvedValue({ accounts: [{ id: onBinding, platform: "linkedin", provider_account_id: "559148166", funding_source: "provider", currency: "USD", disabled: false }], managed: [], selected_id: onBinding });
    const r = await reviewLinkedInCampaignAction("tenant", id);
    expect(r.accounts.map((a) => [a.id, a.account_binding_id])).toEqual([["559148166", onBinding], ["560026764", undefined]]);
  });

  it("a saved account the founder turned off does not block the review of the accounts still in use", async () => {
    m.accounts.mockResolvedValue([{ id: "560026764", name: "Other Login Ads", currency: "USD", status: "ACTIVE" }]);
    m.choices.mockResolvedValue({ accounts: [{ id: offBinding, platform: "linkedin", provider_account_id: "559148166", funding_source: "provider", currency: "USD", disabled: true }], managed: [], selected_id: offBinding });
    const r = await reviewLinkedInCampaignAction("tenant", id);
    expect(r.accounts.map((a) => a.id)).toEqual(["560026764"]);
  });

  it("does not fall back to a readable managed account when the saved own account is hidden from the new login", async () => {
    const wallet = "10000000-0000-4000-8000-0000000000cc";
    m.accounts.mockResolvedValue([{ id: "560026764", name: "Other Login Ads", currency: "USD", status: "ACTIVE" }]);
    m.choices.mockResolvedValue({ accounts: [
      { id: onBinding, platform: "linkedin", provider_account_id: "559148166", funding_source: "provider", currency: "USD", disabled: false },
      { id: wallet, platform: "linkedin", provider_account_id: "777", funding_source: "wallet", currency: "USD", disabled: false },
    ], managed: [], selected_id: onBinding });
    m.binding.mockImplementation(async (_t: string, bid: string) => ({ id: bid }));
    m.resolve.mockResolvedValue({ token: "managed", account: { id: "777", name: "Zavi managed", currency: "USD", status: "ACTIVE" } });
    await expect(reviewLinkedInCampaignAction("tenant", id)).rejects.toMatchObject({ code: "linkedin_ads_conflict", message: expect.stringContaining("559148166") });
  });

  it("refuses when the own LinkedIn login is disconnected and only a managed account can be read, rather than quietly offering the managed one", async () => {
    const wallet = "10000000-0000-4000-8000-0000000000cc";
    m.accounts.mockRejectedValue(new ExpectedToolError("linkedin_ads_not_connected", "Connect LinkedIn Ads"));
    m.choices.mockResolvedValue({ accounts: [
      { id: onBinding, platform: "linkedin", provider_account_id: "559148166", funding_source: "provider", currency: "USD", disabled: false },
      { id: wallet, platform: "linkedin", provider_account_id: "777", funding_source: "wallet", currency: "USD", disabled: false },
    ], managed: [], selected_id: onBinding });
    m.binding.mockImplementation(async (_t: string, bid: string) => ({ id: bid }));
    m.resolve.mockResolvedValue({ token: "managed", account: { id: "777", name: "Zavi managed", currency: "USD", status: "ACTIVE" } });
    await expect(reviewLinkedInCampaignAction("tenant", id)).rejects.toMatchObject({ code: "linkedin_ads_conflict", message: expect.stringContaining("559148166") });
  });

  it("a saved managed (wallet) account is not checked against the founder's own login, and stays first", async () => {
    const wallet = "10000000-0000-4000-8000-0000000000cc";
    m.accounts.mockResolvedValue([{ id: "560026764", name: "Other Login Ads", currency: "USD", status: "ACTIVE" }]);
    m.choices.mockResolvedValue({ accounts: [{ id: wallet, platform: "linkedin", provider_account_id: "559148166", funding_source: "wallet", currency: "USD", disabled: false }], managed: [], selected_id: wallet });
    m.binding.mockImplementation(async (_t: string, bid: string) => ({ id: bid }));
    m.resolve.mockResolvedValue({ token: "managed", account: { id: "559148166", name: "Zavi managed", currency: "USD", status: "ACTIVE" } });
    const r = await reviewLinkedInCampaignAction("tenant", id);
    expect(r.accounts.map((a) => [a.id, a.account_binding_id, a.funding_source])).toEqual([["559148166", wallet, "wallet"], ["560026764", undefined, "provider"]]);
  });
});

describe("prepare", () => {
  it("binds verified audience identifiers and LinkedIn labels into the exact change", async () => {
    await prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, audience: { titles: ["urn:li:title:1"] } });
    const call = m.rpc.mock.calls[0][2];
    expect(call.p_payload.campaign.audience).toEqual({ titles: ["urn:li:title:1"], seniorities: [], industries: [], staffCountRanges: [] });
    expect(call.p_exact_change.rows).toContainEqual({ item: "Job titles", before: "Not chosen", after: "Chief Executive Officer" });
  });
  it("does not silently discard the audience Zavi recommended", async () => {
    const presentation = { ...draft, audience_suggestions: { titles: ["Chief Executive Officer"] } };
    m.row.body = { step: { responsibility: "client", deliverable: { presentation } } };
    expect((await reviewLinkedInCampaignAction("tenant", id)).draft.audience_suggestions?.titles).toEqual(["Chief Executive Officer"]);
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, use_broad_audience: undefined })).rejects.toThrow("explicitly choose");
    expect(m.rpc).not.toHaveBeenCalled();
    await prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, audience: {}, use_broad_audience: true });
    expect(m.rpc.mock.calls[0][2].p_exact_change.rows).toContainEqual({ item: "Professional audience", before: "Not chosen", after: "Location and language only" });
    expect(m.targeting).not.toHaveBeenCalled();
  });
  it("a draft with no suggestion still cannot freeze a whole-country audience without the acknowledgement", async () => {
    m.row.body = { step: { responsibility: "client", deliverable: { presentation: { ...draft, audience_suggestions: {} } } } };
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, audience: {}, use_broad_audience: undefined })).rejects.toThrow("explicitly choose");
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("refuses an identifier LinkedIn no longer returns before freezing approval", async () => {
    m.targeting.mockResolvedValue({ elements: [] });
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, audience: { titles: ["urn:li:title:1"] } })).rejects.toThrow("verify");
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("binds the payload: hardcoded geo URN for the country, post URN extracted from the pasted link", async () => {
    const r = await prepareLinkedInCampaignAction("tenant", id, "owner-1", input);
    expect(r).toMatchObject({ id, executable: true });
    const payload = m.rpc.mock.calls[0][2].p_payload;
    expect(payload.campaign.geo_urns).toEqual(["urn:li:geo:103644278"]);
    expect(payload.creative.post_urn).toBe("urn:li:ugcPost:7000000000000000009");
    expect(payload.group.name).toBe("First test");
    expect(payload.campaign.associated_entity).toBe("urn:li:organization:42");
    expect(JSON.stringify(payload)).not.toContain("ACTIVE");
  });

  it("refuses while the write flag is OFF", async () => {
    delete process.env.LINKEDIN_ADS_WRITE_ENABLED;
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", input)).rejects.toThrow(/switched off/i);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["by its account id", {}],
    ["by its saved account choice", { account_binding_id: "10000000-0000-4000-8000-0000000000aa" }],
  ])("refuses an ad account the founder turned off, picked %s, before reading the post or saving anything", async (_label, extra) => {
    m.choices.mockResolvedValue({ accounts: [{ id: offBinding, platform: "linkedin", provider_account_id: "11", funding_source: "provider", currency: "USD", disabled: true }], managed: [], selected_id: null });
    const e = await prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, ...extra }).then(() => null, (x: unknown) => x);
    expect(e).toMatchObject({ code: "linkedin_ads_conflict", message: "You turned this ad account off in Zavi with Stop using this account. Choose another account, or turn it back on with Use this account again." });
    expect(m.post).not.toHaveBeenCalled();
    expect(m.connect).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("still prepares on an ad account in use when another one is turned off", async () => {
    m.choices.mockResolvedValue({ accounts: [{ id: offBinding, platform: "linkedin", provider_account_id: "12", funding_source: "provider", currency: "USD", disabled: true }], managed: [], selected_id: null });
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", input)).resolves.toMatchObject({ executable: true });
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });

  it("re-reads the ad accounts from LinkedIn at approve instead of trusting the review's cached list", async () => {
    await prepareLinkedInCampaignAction("tenant", id, "owner-1", input);
    expect(m.accountsRef).toHaveBeenCalledWith("tenant", true);
    expect(m.accountsRef.mock.calls.every((c) => c[1] === true)).toBe(true);
  });

  it("refuses an account the token does not own", async () => {
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, account_id: "99" })).rejects.toThrow(/not linked/i);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("refuses a currency that does not match the account", async () => {
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, currency: "EUR" })).rejects.toThrow(/currency/i);
  });

  it("refuses a country without a verified geo URN, and every EU country (no political-ads consent yet)", async () => {
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, country: "BR" })).rejects.toThrow(/not supported/i);
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, country: "DE" })).rejects.toThrow(/not supported/i);
  });

  it("refuses an account not tied to a company page (LinkedIn needs one as associatedEntity)", async () => {
    m.accountsRef.mockResolvedValue([{ id: "11", name: "Acme Ads", currency: "USD", status: "ACTIVE", reference: "urn:li:person:7" }]);
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", input)).rejects.toThrow(/company page/i);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("checks the post's author against the ad account's page before binding anything", async () => {
    await prepareLinkedInCampaignAction("tenant", id, "owner-1", input);
    expect(m.post).toHaveBeenCalledWith("token", "posts/urn%3Ali%3AugcPost%3A7000000000000000009");
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([["another company page", "urn:li:organization:99"], ["a company page whose id starts with the account's", "urn:li:organization:420"]])("refuses a post from %s on the review card, and binds nothing", async (_label, author) => {
    m.post.mockResolvedValue({ id: "urn:li:ugcPost:7000000000000000009", author });
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", input)).rejects.toMatchObject({
      code: "linkedin_ads_post_page_mismatch",
      message: "This post was not published by the company page this ad account advertises for, and LinkedIn only promotes posts from that page. Paste the link to one of that page's posts, or choose another ad account. Nothing was created.",
    });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("refuses a Showcase page's post at prepare with its own reason, and binds nothing for LinkedIn to refuse later", async () => {
    m.post.mockResolvedValue({ id: "urn:li:ugcPost:7000000000000000009", author: "urn:li:organizationBrand:99" });
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", input)).rejects.toMatchObject({ code: "linkedin_ads_post_page_mismatch", message: POST_FROM_SHOWCASE });
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.connect).not.toHaveBeenCalled();
  });

  describe("on the shared wallet, a post from the founder's own company page", () => {
    const wallet = "10000000-0000-4000-8000-0000000000cc";
    const walletInput = { ...input, account_id: "777", account_binding_id: wallet };
    beforeEach(() => {
      m.binding.mockResolvedValue({ id: wallet, funding_source: "wallet" });
      m.resolve.mockResolvedValue({ token: "managed", account: { id: "777", name: "Zavi managed", currency: "USD", status: "ACTIVE", reference: "urn:li:organization:42" } });
      m.post.mockResolvedValue({ id: "urn:li:ugcPost:7000000000000000009", author: "urn:li:organization:99" });
    });

    it("is refused at prepare with the wallet's way forward, not the own-account page mismatch, and binds nothing", async () => {
      await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", walletInput)).rejects.toMatchObject({ code: "linkedin_ads_post_page_mismatch", message: LINKEDIN_WALLET_POST_PAGE });
      expect(m.post).toHaveBeenCalledWith("managed", expect.any(String));
      expect(m.rpc).not.toHaveBeenCalled();
      expect(m.connect).not.toHaveBeenCalled();
    });

    it("is refused in the post preview with the same way forward", async () => {
      await expect(previewLinkedInPost("tenant", id, { post: walletInput.post, account_id: "777", account_binding_id: wallet })).rejects.toMatchObject({ code: "linkedin_ads_post_page_mismatch", message: LINKEDIN_WALLET_POST_PAGE });
    });

    it.each([
      ["the shared wallet", "wallet", MANAGED_ACCOUNT_BILLING_HOLD],
      ["the founder's own billing", "provider", "LinkedIn has paused your ad account for billing. Add or fix the payment method in LinkedIn Campaign Manager, then try again."],
    ])("on %s, a billing hold names whose account it is, before reading the post, and binds nothing", async (_label, funding, words) => {
      m.binding.mockResolvedValue({ id: wallet, funding_source: funding });
      m.resolve.mockResolvedValue({ token: "managed", account: { id: "777", name: "Zavi managed", currency: "USD", status: "ACTIVE", servingStatuses: ["BILLING_HOLD"], reference: "urn:li:organization:42" } });
      const refused = await prepareLinkedInCampaignAction("tenant", id, "owner-1", walletInput).catch((e: Error) => e);
      expect((refused as Error).message).toBe(words);
      if (funding === "wallet") expect((refused as Error).message).not.toMatch(/payment method|Campaign Manager|your ad account/);
      expect(m.post).not.toHaveBeenCalled();
      expect(m.rpc).not.toHaveBeenCalled();
      expect(m.connect).not.toHaveBeenCalled();
    });

    it("keeps the own-account wording on the founder's own billing", async () => {
      m.binding.mockResolvedValue({ id: wallet, funding_source: "provider" });
      await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", walletInput)).rejects.toMatchObject({ code: "linkedin_ads_post_page_mismatch", message: expect.stringContaining("choose another ad account") });
    });
  });

  it.each([["a Thought Leader post by a member", "urn:li:person:abc"], ["no author", undefined]])("binds the payload for %s and leaves the judgement to LinkedIn", async (_label, author) => {
    m.post.mockResolvedValue({ id: "urn:li:ugcPost:7000000000000000009", author });
    await prepareLinkedInCampaignAction("tenant", id, "owner-1", input);
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });

  it("warns on the prepared card, and still binds, when the post's author could not be read", async () => {
    m.post.mockResolvedValue({ id: "urn:li:ugcPost:7000000000000000009" });
    await prepareLinkedInCampaignAction("tenant", id, "owner-1", input);
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.rpc.mock.calls[0][2].p_exact_change.rows).toContainEqual({ item: "Post check", before: "Not chosen", after: "Zavi could not confirm that the company page this ad account advertises for can sponsor this post, so LinkedIn may refuse the ad after Zavi makes the paused campaign. Check that the post is from that page, and that the connected LinkedIn user has the Sponsored Content poster role on it. Nothing can spend without an ad." });
  });

  it("adds no post warning when the unreadable post already runs as an ad on the chosen account", async () => {
    m.post.mockResolvedValue({ id: "urn:li:ugcPost:7000000000000000009" });
    const before = m.targeting.getMockImplementation();
    m.targeting.mockImplementation(async (token: string, path: string, ...rest: unknown[]) => /^adAccounts\/\d+\/creatives$/.test(path)
      ? { elements: [{ content: { reference: "urn:li:ugcPost:7000000000000000009" } }] }
      : before ? before(token, path, ...rest) : {});
    await prepareLinkedInCampaignAction("tenant", id, "owner-1", input);
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect((m.rpc.mock.calls[0][2].p_exact_change.rows as Array<{ item: string }>).map((r) => r.item)).not.toContain("Post check");
  });

  it.each([["the page's own post", "urn:li:organization:42"], ["a member's post", "urn:li:person:abc"]])("adds no post warning to the prepared card for %s", async (_label, author) => {
    m.post.mockResolvedValue({ id: "urn:li:ugcPost:7000000000000000009", author });
    await prepareLinkedInCampaignAction("tenant", id, "owner-1", input);
    expect((m.rpc.mock.calls[0][2].p_exact_change.rows as Array<{ item: string }>).map((r) => r.item)).not.toContain("Post check");
  });

  it.each([
    ["403, outside Zavi's r_ads scopes", new ExpectedToolError("linkedin_ads_forbidden", LINKEDIN_ADS_FORBIDDEN_READ, { status: 403, http_status: 403 })],
    ["404", new ExpectedToolError("linkedin_ads_http_error", LINKEDIN_ADS_READ_FAILED, { status: 404, http_status: 404 })],
    ["a network failure", new TypeError("fetch failed")],
  ])("binds the payload when the post read fails with %s, rather than refusing every create", async (_label, failure) => {
    m.post.mockRejectedValue(failure);
    await prepareLinkedInCampaignAction("tenant", id, "owner-1", input);
    expect(m.post).toHaveBeenCalledTimes(1);
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.refresh).not.toHaveBeenCalled();
  });

  it("hands a revoked token on the post read to the refresh wrapper, then checks again on the fresh token", async () => {
    m.post.mockRejectedValueOnce(new ExpectedToolError("linkedin_ads_token_revoked", LINKEDIN_ADS_RECONNECT, { status: 401 })).mockResolvedValueOnce({ id: "urn:li:ugcPost:7000000000000000009", author: "urn:li:organization:99" });
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", input)).rejects.toMatchObject({ code: "linkedin_ads_post_page_mismatch" });
    expect(m.refresh).toHaveBeenCalledTimes(1);
    expect(m.post.mock.calls.map(([token]) => token)).toEqual(["token", "refreshed-token"]);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("refuses pasted text that names no post, without asking LinkedIn", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, post: "https://www.linkedin.com/company/acme/" })).rejects.toThrow(/link to the company post/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("binds the share behind a plain Copy-link-to-post URL into the payload the executor creates from", async () => {
    const fetchSpy = vi.fn(async (_url: string) => ({
      ok: true, status: 200, url: "https://www.linkedin.com/posts/upcarapp_x-share-7499123090770288640-F_PE/",
      text: async () =>
        `<article data-activity-urn="urn:li:activity:7000000000000000100" data-attributed-urn="urn:li:share:7000000000000000200"></article>` +
        `<article data-activity-urn="urn:li:activity:7499160133243912192" data-attributed-urn="urn:li:share:7499123090770288640"></article>`,
    }));
    vi.stubGlobal("fetch", fetchSpy);
    await prepareLinkedInCampaignAction("tenant", id, "owner-1", {
      ...input,
      post: "https://www.linkedin.com/posts/upcarapp_upcar-carrental-carrentals-activity-7499160133243912192-kidi?utm_source=share&utm_medium=member_desktop",
    });
    expect(fetchSpy.mock.calls[0][0]).toBe("https://www.linkedin.com/feed/update/urn:li:activity:7499160133243912192/");
    const call = m.rpc.mock.calls[0][2];
    expect(call.p_payload.creative.post_urn).toBe("urn:li:share:7499123090770288640");
    expect(call.p_exact_change.rows).toContainEqual({ item: "Promoted post", before: "Not chosen", after: "https://www.linkedin.com/feed/update/urn:li:share:7499123090770288640" });
    expect(call.p_exact_change.rows.filter((r: { after: string }) => /^urn:/.test(r.after))).toEqual([]);
  });

  it("a post page LinkedIn will not serve stops prepare before anything is bound", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 999, url: "https://www.linkedin.com/feed/update/urn:li:activity:7499160133243912192/", text: async () => "" })));
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, post: "urn:li:activity:7499160133243912192" }))
      .rejects.toMatchObject({ code: "linkedin_ads_post_unreadable" });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("a post page that does not attribute the activity is refused, not guessed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, url: "https://www.linkedin.com/feed/update/urn:li:activity:7499160133243912192/", text: async () => `<div>urn:li:share:7000000000000000200</div><article data-activity-urn="urn:li:activity:7499160133243912192"></article>` })));
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, post: "urn:li:activity:7499160133243912192" }))
      .rejects.toThrow(/link to the company post/i);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("refuses a USD daily budget under LinkedIn's 10 USD floor", async () => {
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, daily_budget: "9.99", unit_cost: "2" })).rejects.toThrow("LinkedIn's minimum daily budget is 10 USD.");
    expect(m.rpc).not.toHaveBeenCalled();
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, daily_budget: "10", unit_cost: "2" })).resolves.toMatchObject({ executable: true });
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });

  const inrAccount = () => m.accountsRef.mockResolvedValue([{ id: "11", name: "Acme India", currency: "INR", status: "ACTIVE", reference: "urn:li:organization:42" }]);
  const nothingTouched = () => {
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.connect).not.toHaveBeenCalled();
    expect(m.accounts).not.toHaveBeenCalled();
    expect(m.accountsRef).not.toHaveBeenCalled();
    expect(m.post).not.toHaveBeenCalled();
    expect(m.targeting).not.toHaveBeenCalled();
  };

  it("refuses an INR daily budget under LinkedIn's floor converted and rounded up, before saving or asking LinkedIn anything", async () => {
    inrAccount();
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, currency: "INR", daily_budget: "869.99", unit_cost: "50" })).rejects.toThrow("LinkedIn's minimum daily budget for this account is 870 INR (about 10 USD).");
    expect(m.fx).toHaveBeenCalledWith("INR");
    nothingTouched();
  });

  it("an INR daily budget at the converted floor is prepared in INR", async () => {
    inrAccount();
    await prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, currency: "INR", daily_budget: "870", unit_cost: "50" });
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.rpc.mock.calls[0][2].p_payload.campaign.daily_budget).toEqual({ amount: "870", currency: "INR" });
  });

  it("refuses a non-USD budget when today's exchange rate cannot be read, instead of guessing", async () => {
    inrAccount();
    m.fx.mockRejectedValue(new ExpectedToolError("ads_fx_unavailable", "A current exchange rate is unavailable."));
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, currency: "INR", daily_budget: "100000", unit_cost: "50" })).rejects.toThrow("Zavi could not read today's exchange rate to check LinkedIn's minimum daily budget in INR. Nothing was created. Try again in a few minutes.");
    nothingTouched();
  });

  it("refuses a bid above the daily budget", async () => {
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, unit_cost: "20" })).rejects.toThrow(/bid/i);
  });

  it.each([["0"], ["0.0"], ["0.00"]])("must catch: a bid of %s is refused in plain words before anything is read, saved or created", async (unit_cost) => {
    const fetchSpy = vi.fn(async () => { throw new Error("no network in this test"); });
    vi.stubGlobal("fetch", fetchSpy);
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, unit_cost })).rejects.toThrow("Enter a bid above 0. LinkedIn refuses a campaign with no bid. Nothing was created.");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(m.choices).not.toHaveBeenCalled();
    expect(m.accountsRef).not.toHaveBeenCalled();
    expect(m.post).not.toHaveBeenCalled();
    expect(m.targeting).not.toHaveBeenCalled();
    expect(m.connect).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("the smallest real bid still prepares", async () => {
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, unit_cost: "0.01" })).resolves.toMatchObject({ executable: true });
    expect(m.rpc).toHaveBeenCalled();
  });

  it("refuses a bid above the budget, an unsupported country and an included-and-excluded place before reading the account, its post or the page link from LinkedIn", async () => {
    const fetchSpy = vi.fn(async () => { throw new Error("no network in this test"); });
    vi.stubGlobal("fetch", fetchSpy);
    const activityLink = "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/";
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, post: activityLink, unit_cost: "20" })).rejects.toThrow("The bid cannot be higher than the daily budget.");
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, post: activityLink, country: "BR" })).rejects.toThrow("That country is not supported yet. Choose one from the list.");
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, post: activityLink, excluded_locations: ["urn:li:geo:103644278"] })).rejects.toThrow("A location cannot be both included and excluded. Remove it from one list.");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(m.choices).not.toHaveBeenCalled();
    expect(m.accountsRef).not.toHaveBeenCalled();
    expect(m.post).not.toHaveBeenCalled();
    expect(m.targeting).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("refuses an account LinkedIn put on billing hold, from the account list approve already read, before reading the post", async () => {
    m.accountsRef.mockResolvedValue([{ id: "11", name: "Acme Ads", currency: "USD", status: "ACTIVE", servingStatuses: ["BILLING_HOLD"], reference: "urn:li:organization:42" }]);
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", input)).rejects.toThrow("LinkedIn has paused your ad account for billing. Add or fix the payment method in LinkedIn Campaign Manager, then try again.");
    expect(m.accountsRef).toHaveBeenCalledTimes(1);
    expect(m.accountsRef).toHaveBeenCalledWith("tenant", true);
    expect(m.post).not.toHaveBeenCalled();
    expect(m.targeting).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("refuses an account whose currency changed before reading the post from LinkedIn", async () => {
    m.accountsRef.mockResolvedValue([{ id: "11", name: "Acme Ads", currency: "EUR", status: "ACTIVE", reference: "urn:li:organization:42" }]);
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", input)).rejects.toThrow("The account currency changed. Review the budget again.");
    expect(m.post).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("an RPC refusal (action changed under the founder) is a conflict, not success", async () => {
    m.rpc.mockResolvedValue({ data: { ok: false }, error: null });
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", input)).rejects.toThrow(/changed/i);
  });

  describe("a prepare whose response was lost, or a second tab", () => {
    const bindLikeTheRpc = () => m.rpc.mockImplementation(async (_t: string, _name: string, a: Record<string, any>) => {
      const row = m.row as Record<string, any>;
      if (row.exec_class) return { data: { ok: row.exec_class === "linkedin_ads.create_campaign_bundle" && JSON.stringify(row.exec_payload) === JSON.stringify(a.p_payload), replayed: true }, error: null };
      if (row.status !== "pending" || row.exec_status || JSON.stringify(row.body) !== JSON.stringify(a.p_expected_body)) return { data: { ok: false, code: "action_changed" }, error: null };
      m.row = { ...row, exec_class: "linkedin_ads.create_campaign_bundle", exec_payload: a.p_payload, body: { ...row.body, exact_change: a.p_exact_change } };
      return { data: { ok: true }, error: null };
    });

    it("the same submit again answers with the rows the card holds and binds nothing new", async () => {
      bindLikeTheRpc();
      const first = await prepareLinkedInCampaignAction("tenant", id, "owner-1", input);
      const payload = (m.row as Record<string, any>).exec_payload;
      m.accountsRef.mockResolvedValue([{ id: "11", name: "Acme Ads renamed", currency: "USD", status: "ACTIVE", reference: "urn:li:organization:42" }]);
      const again = await prepareLinkedInCampaignAction("tenant", id, "owner-1", input);
      expect(again).toEqual(first);
      expect((m.row as Record<string, any>).exec_payload).toBe(payload);
      expect(m.rpc).toHaveBeenCalledTimes(2);
    });

    it("a second tab with a different budget cannot replace what was bound", async () => {
      bindLikeTheRpc();
      await prepareLinkedInCampaignAction("tenant", id, "owner-1", input);
      const payload = (m.row as Record<string, any>).exec_payload;
      await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, daily_budget: "20" })).rejects.toThrow(/changed/i);
      expect((m.row as Record<string, any>).exec_payload).toBe(payload);
    });

    it.each([
      ["approved", { approved_by: "owner-1" }],
      ["queued", { exec_status: "queued" }],
      ["failed", { exec_status: "failed" }],
      ["closed", { status: "acted" }],
      ["bound to another class", { exec_class: "linkedin_ads.launch_campaign" }],
    ])("a card already %s is refused before any LinkedIn read or RPC", async (_label, over) => {
      m.row = { ...m.row, exec_class: "linkedin_ads.create_campaign_bundle", exec_payload: {}, ...over };
      await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", input)).rejects.toThrow(/changed/i);
      expect(m.rpc).not.toHaveBeenCalled();
      expect(m.post).not.toHaveBeenCalled();
    });
  });

  const geo = (urn: string, name: string) => ({ urn, name, facetUrn: "urn:li:adTargetingFacet:locations" });
  const places = { elements: [geo("urn:li:geo:102095887", "California, United States"), geo("urn:li:geo:101174742", "Canada"), geo("urn:li:geo:101857797", "Sacramento, California, United States"), geo("urn:li:geo:101282230", "Germany")] };

  it("binds verified include and exclude locations, with LinkedIn's names in the exact change", async () => {
    m.targeting.mockResolvedValue(places);
    await prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, locations: ["urn:li:geo:102095887", "urn:li:geo:101174742"], excluded_locations: ["urn:li:geo:101857797", "urn:li:geo:101282230"] });
    expect(m.targeting).toHaveBeenCalledWith("token", "adTargetingEntities", expect.objectContaining({ q: "urns", urns: ["urn:li:geo:102095887", "urn:li:geo:101174742", "urn:li:geo:101857797", "urn:li:geo:101282230"] }));
    const call = m.rpc.mock.calls[0][2];
    expect(call.p_payload.campaign.geo_urns).toEqual(["urn:li:geo:102095887", "urn:li:geo:101174742"]);
    expect(call.p_payload.campaign.excluded_geo_urns).toEqual(["urn:li:geo:101857797", "urn:li:geo:101282230"]);
    expect(call.p_exact_change.rows).toContainEqual({ item: "Where it shows", before: "Not chosen", after: "California, United States, Canada" });
    expect(call.p_exact_change.rows).toContainEqual({ item: "Where it does not show", before: "Not chosen", after: "Sacramento, California, United States, Germany" });
  });

  it("refuses a place that is both included and excluded, before asking LinkedIn", async () => {
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, locations: ["urn:li:geo:102095887"], excluded_locations: ["urn:li:geo:102095887"] })).rejects.toThrow(/both included and excluded/);
    expect(m.targeting).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("refuses an included EU place (no political-ads declaration yet) but allows excluding one", async () => {
    m.targeting.mockResolvedValue(places);
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, locations: ["urn:li:geo:101282230"] })).rejects.toThrow(/Germany is in or includes the EU or EEA/);
    expect(m.rpc).not.toHaveBeenCalled();
    await prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, locations: ["urn:li:geo:101174742"], excluded_locations: ["urn:li:geo:101282230"] });
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([["Africa", "urn:li:geo:103537801"], ["South America", "urn:li:geo:104514572"], ["Caribbean", "urn:li:geo:90009900"]])("refuses including %s, which contains EU outermost regions, and files nothing", async (name, urn) => {
    m.targeting.mockResolvedValue({ elements: [geo(urn, name), geo("urn:li:geo:101174742", "Canada")] });
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, locations: [urn, "urn:li:geo:101174742"] })).rejects.toThrow(new RegExp(`${name} is in or includes the EU or EEA`));
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("includes North America and files the action, while Latin America is still refused", async () => {
    m.targeting.mockResolvedValue({ elements: [geo("urn:li:geo:102221843", "North America"), geo("urn:li:geo:104514075", "Latin America")] });
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, locations: ["urn:li:geo:104514075"] })).rejects.toThrow(/Latin America is in or includes the EU or EEA/);
    expect(m.rpc).not.toHaveBeenCalled();
    await prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, locations: ["urn:li:geo:102221843"] });
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });

  it("refuses an included place that does not name its country, but allows excluding it", async () => {
    m.targeting.mockResolvedValue({ elements: [geo("urn:li:geo:90009", "Greater Munich Metropolitan Area"), geo("urn:li:geo:101174742", "Canada")] });
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, locations: ["urn:li:geo:90009"] })).rejects.toThrow(/does not name its country/);
    expect(m.rpc).not.toHaveBeenCalled();
    await prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, locations: ["urn:li:geo:101174742"], excluded_locations: ["urn:li:geo:90009"] });
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });

  it("refuses a location LinkedIn does not confirm, and binds nothing", async () => {
    m.targeting.mockResolvedValue({ elements: [geo("urn:li:geo:102095887", "California, United States")] });
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, locations: ["urn:li:geo:102095887"], excluded_locations: ["urn:li:geo:999"] })).rejects.toMatchObject({ code: "linkedin_ads_targeting_invalid" });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("excludes places inside the draft's whole country when no include list is sent", async () => {
    m.targeting.mockResolvedValue(places);
    await prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, excluded_locations: ["urn:li:geo:102095887"] });
    const payload = m.rpc.mock.calls[0][2].p_payload;
    expect(payload.campaign.geo_urns).toEqual(["urn:li:geo:103644278"]);
    expect(payload.campaign.excluded_geo_urns).toEqual(["urn:li:geo:102095887"]);
  });

  it("refuses excluding the whole country the campaign falls back to", async () => {
    await expect(prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, excluded_locations: ["urn:li:geo:103644278"] })).rejects.toThrow(/both included and excluded/);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("does not ask LinkedIn about places when none are chosen", async () => {
    await prepareLinkedInCampaignAction("tenant", id, "owner-1", input);
    expect(m.targeting).not.toHaveBeenCalled();
    expect(m.rpc.mock.calls[0][2].p_payload.campaign).not.toHaveProperty("excluded_geo_urns");
  });
});

describe("review of an agent draft that names places", () => {
  const withPlaces = (extra: Record<string, unknown>) => { m.row.body = { step: { responsibility: "client", deliverable: { presentation: { ...draft, ...extra } } } }; };

  it("pre-fills include and exclude pickers from the agent's place names, dropping EU includes and keeping overlaps visible so the founder must pick one", async () => {
    withPlaces({ locations: ["California", "Germany"], excluded_locations: ["Sacramento", "California"] });
    m.targeting
      .mockResolvedValueOnce({ elements: [{ urn: "urn:li:geo:102095887", name: "California, United States", facetUrn: "urn:li:adTargetingFacet:locations" }] })
      .mockResolvedValueOnce({ elements: [{ urn: "urn:li:geo:101282230", name: "Germany", facetUrn: "urn:li:adTargetingFacet:locations" }] })
      .mockResolvedValueOnce({ elements: [{ urn: "urn:li:geo:101857797", name: "Sacramento, California, United States", facetUrn: "urn:li:adTargetingFacet:locations" }] })
      .mockResolvedValueOnce({ elements: [{ urn: "urn:li:geo:102095887", name: "California, United States", facetUrn: "urn:li:adTargetingFacet:locations" }] });
    const r = await reviewLinkedInCampaignAction("tenant", id);
    expect(r.suggested.locations).toEqual([{ id: "urn:li:geo:102095887", name: "California, United States" }]);
    expect(r.suggested.excluded_locations).toEqual([{ id: "urn:li:geo:101857797", name: "Sacramento, California, United States" }, { id: "urn:li:geo:102095887", name: "California, United States" }]);
    expect(r.suggested.unresolved_locations).toEqual(["Germany"]);
  });

  it("when LinkedIn search fails the review survives, targets nowhere it was not asked to, and says the search failed rather than that nothing matched", async () => {
    withPlaces({ country: "CA", locations: ["Ontario"], excluded_locations: ["Toronto"] });
    m.targeting.mockRejectedValue(new Error("LinkedIn down"));
    const r = await reviewLinkedInCampaignAction("tenant", id);
    expect(r.suggested.locations).toEqual([]);
    expect(r.suggested.excluded_locations).toEqual([]);
    expect(r.suggested.unresolved_locations).toEqual([]);
    expect(r.suggested.location_search_failed).toBe("LinkedIn's location search didn't answer, so Zavi could not fill in Ontario, Toronto (exclude). Try again in a moment, or add the places you want.");
  });

  it("a failed location search is asked again on the next review, and a working one is not flagged and asks LinkedIn once per place", async () => {
    withPlaces({ country: "CA", locations: ["Ontario"] });
    m.targeting.mockRejectedValueOnce(new Error("LinkedIn down")).mockResolvedValue({ elements: [{ urn: "urn:li:geo:1", name: "Ontario, Canada", facetUrn: "urn:li:adTargetingFacet:locations" }] });
    expect((await reviewLinkedInCampaignAction("tenant", id)).suggested.location_search_failed).toBeTruthy();
    const calls = m.targeting.mock.calls.length;
    const r = await reviewLinkedInCampaignAction("tenant", id);
    expect(m.targeting.mock.calls.length - calls).toBe(1);
    expect(r.suggested.locations).toEqual([{ id: "urn:li:geo:1", name: "Ontario, Canada" }]);
    expect(r.suggested).not.toHaveProperty("location_search_failed");
    expect(r.suggested.unresolved_locations).toEqual([]);
  });

  it.each([
    ["no match", ["Atlantis"], { elements: [] }, ["Atlantis"]],
    ["only an EU place", ["Germany"], { elements: [{ urn: "urn:li:geo:101282230", name: "Germany", facetUrn: "urn:li:adTargetingFacet:locations" }] }, ["Germany"]],
  ])("named places that cannot be used (%s) never become the United States or the draft's country", async (_label, locations, found, unresolved) => {
    for (const country of ["US", "GB"]) {
      withPlaces({ country, locations });
      m.targeting.mockResolvedValue(found);
      const r = await reviewLinkedInCampaignAction("tenant", id);
      expect(r.suggested.locations).toEqual([]);
      expect(r.suggested.unresolved_locations).toEqual(unresolved);
    }
  });

  it.each([
    ["a two-letter code Zavi cannot pre-fill", "DE", "Germany"],
    ["a country name the schema does not accept as a code", "Germany", "Germany"],
    ["an object-prototype key", "constructor", "constructor"],
  ])("a draft that names %s pre-fills no place, says so, and asks LinkedIn nothing", async (_label, country, shown) => {
    withPlaces({ country });
    const r = await reviewLinkedInCampaignAction("tenant", id);
    expect(r.suggested.locations).toEqual([]);
    expect(r.suggested.unresolved_locations).toEqual([shown]);
    expect(m.targeting).not.toHaveBeenCalled();
  });

  it.each([["a two-letter code", "AU"], ["a country name", "Australia"]])("a draft for a country outside the four, named by %s, pre-fills that country from LinkedIn's own search and binds it, with no false no-match or EU warning", async (_label, country) => {
    withPlaces({ country });
    const australia = { urn: "urn:li:geo:101452733", name: "Australia", facetUrn: "urn:li:adTargetingFacet:locations" };
    m.targeting.mockResolvedValue({ elements: [australia, { urn: "urn:li:geo:100992797", name: "Western Australia, Australia", facetUrn: "urn:li:adTargetingFacet:locations" }] });
    const r = await reviewLinkedInCampaignAction("tenant", id);
    expect(m.targeting).toHaveBeenCalledTimes(1);
    expect(m.targeting).toHaveBeenCalledWith("token", "adTargetingEntities", expect.objectContaining({ q: "typeahead", query: "Australia" }));
    expect(r.suggested.locations).toEqual([{ id: "urn:li:geo:101452733", name: "Australia" }]);
    expect(r.suggested.unresolved_locations).toEqual([]);
    expect(r.suggested).not.toHaveProperty("location_search_failed");
    m.targeting.mockResolvedValue({ elements: [australia] });
    await prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, country: r.suggested.country, locations: r.suggested.locations.map((l) => l.id) });
    const call = m.rpc.mock.calls[0][2];
    expect(call.p_payload.campaign.geo_urns).toEqual(["urn:li:geo:101452733"]);
    expect(call.p_exact_change.rows).toContainEqual({ item: "Where it shows", before: "Not chosen", after: "Australia" });
  });

  it("a country outside the four that LinkedIn's search cannot reach says the search failed, not that nothing matched or that it is in the EU", async () => {
    withPlaces({ country: "AU" });
    m.targeting.mockRejectedValue(new Error("LinkedIn down"));
    const r = await reviewLinkedInCampaignAction("tenant", id);
    expect(r.suggested.locations).toEqual([]);
    expect(r.suggested.unresolved_locations).toEqual([]);
    expect(r.suggested.location_search_failed).toBe("LinkedIn's location search didn't answer, so Zavi could not fill in Australia. Try again in a moment, or add the places you want.");
  });

  it("an unusable country with a usable named place keeps the place and adds no false warning", async () => {
    withPlaces({ country: "DE", locations: ["Ontario"] });
    m.targeting.mockResolvedValue({ elements: [{ urn: "urn:li:geo:1", name: "Ontario, Canada", facetUrn: "urn:li:adTargetingFacet:locations" }] });
    const r = await reviewLinkedInCampaignAction("tenant", id);
    expect(r.suggested.locations).toEqual([{ id: "urn:li:geo:1", name: "Ontario, Canada" }]);
    expect(r.suggested.unresolved_locations ?? []).toEqual([]);
  });

  it("only a failed exclusion keeps the country the draft did name", async () => {
    withPlaces({ country: "CA", excluded_locations: ["Toronto"] });
    m.targeting.mockRejectedValue(new Error("LinkedIn down"));
    const r = await reviewLinkedInCampaignAction("tenant", id);
    expect(r.suggested.locations).toEqual([{ id: "urn:li:geo:101174742", name: "Canada" }]);
    expect(r.suggested.unresolved_locations).toEqual([]);
    expect(r.suggested.location_search_failed).toContain("Toronto (exclude)");
  });

  it("the draft schema keeps a country the agent named instead of rewriting it to US, and stays stable when read again", () => {
    const base = { type: "campaign_draft", channel: "linkedin_ads", name: "Name one", group_name: "Group one", rationale: "Why", post_preview: "Post" };
    const once = linkedinCampaignDraftPresentationSchema.parse({ ...base, country: " Germany " });
    expect(once.country).toBe("Germany");
    expect(linkedinCampaignDraftPresentationSchema.parse(once).country).toBe("Germany");
    expect(linkedinCampaignDraftPresentationSchema.parse({ ...base, country: "gb" }).country).toBe("GB");
    expect(linkedinCampaignDraftPresentationSchema.parse(base).country).toBe("US");
    expect(linkedinCampaignDraftPresentationSchema.parse({ ...base, country: 7 }).country).toBe("US");
  });

  it("an agent draft with no country still parses and defaults to the United States", async () => {
    const { country: _c, ...noCountry } = draft;
    m.row.body = { step: { responsibility: "client", deliverable: { presentation: { ...noCountry, locations: ["Texas"] } } } };
    m.targeting.mockResolvedValue({ elements: [{ urn: "urn:li:geo:1", name: "Texas, United States", facetUrn: "urn:li:adTargetingFacet:locations" }] });
    const r = await reviewLinkedInCampaignAction("tenant", id);
    expect(r.suggested.country).toBe("US");
    expect(r.suggested.locations).toEqual([{ id: "urn:li:geo:1", name: "Texas, United States" }]);
  });
});

describe("a pasted link that is a repost of an earlier post", () => {
  const ACTIVITY_LINK = "https://www.linkedin.com/feed/update/urn:li:activity:7464457711406182401/";
  const ORIGINAL = "urn:li:share:7463260970245758976";
  const NOTE = (by: string) => `This link is a repost. LinkedIn will run the original post${by}, first posted on 21 May 2026, not the repost. Open the promoted post to check it is the one you want.`;
  const linkedin = (attributed: string) => vi.fn(async (url: string) => ({
    ok: true, status: 200, url,
    text: async () => `<article data-activity-urn="urn:li:activity:7464457711406182400" data-attributed-urn="urn:li:share:7464457711406182400"></article><article data-activity-urn="urn:li:activity:7464457711406182401" data-attributed-urn="${attributed}"></article>`,
  }));

  it("binds the original post LinkedIn attributes, links it, and tells the founder on the card that the link was a repost", async () => {
    const fetchSpy = linkedin(ORIGINAL);
    vi.stubGlobal("fetch", fetchSpy);
    m.post.mockResolvedValue({ id: ORIGINAL, author: "urn:li:organization:42" });
    await prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, post: ACTIVITY_LINK });
    const call = m.rpc.mock.calls[0][2];
    expect(call.p_payload.creative.post_urn).toBe(ORIGINAL);
    const rows = call.p_exact_change.rows as Array<{ item: string; before: string; after: string }>;
    const at = rows.findIndex((r) => r.item === "Promoted post");
    expect(rows[at]).toEqual({ item: "Promoted post", before: "Not chosen", after: `https://www.linkedin.com/feed/update/${ORIGINAL}` });
    expect(rows[at + 1]).toEqual({ item: "Pasted link", before: "Not chosen", after: NOTE(" by your company page") });
    expect(rows.filter((r) => /^urn:/.test(r.after))).toEqual([]);
  });

  it("names no author on the card when the original is not confirmed as the page's own", async () => {
    vi.stubGlobal("fetch", linkedin(ORIGINAL));
    m.post.mockResolvedValue({ id: ORIGINAL, author: "urn:li:person:abc" });
    await prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, post: ACTIVITY_LINK });
    expect(m.rpc.mock.calls[0][2].p_exact_change.rows).toContainEqual({ item: "Pasted link", before: "Not chosen", after: NOTE("") });
  });

  it("adds no repost line when the activity is the post's own", async () => {
    vi.stubGlobal("fetch", linkedin("urn:li:share:7464457711300000000"));
    await prepareLinkedInCampaignAction("tenant", id, "owner-1", { ...input, post: ACTIVITY_LINK });
    const rows = m.rpc.mock.calls[0][2].p_exact_change.rows as Array<{ item: string }>;
    expect(rows.map((r) => r.item)).not.toContain("Pasted link");
  });

  it("the review preview says which post runs, by the page's name, as a link", async () => {
    vi.stubGlobal("fetch", linkedin(ORIGINAL));
    m.post.mockResolvedValue({ id: ORIGINAL, author: "urn:li:organization:42", commentary: "The original launch post" });
    m.targeting.mockImplementation(async (_t: string, path: string) => path === "organizations/42" ? { localizedName: "Upcar.ai" } : {});
    const r = await previewLinkedInPost("tenant", id, { post: ACTIVITY_LINK, account_id: "11" });
    expect(r).toMatchObject({ post_urn: ORIGINAL, repost_note: NOTE(" by Upcar.ai"), author: "page", post_preview: "The original launch post" });
  });

  it.each([
    ["finished", "acted", "executed"],
    ["failed", "pending", "failed"],
    ["closed after failing", "acted", "failed"],
    ["rejected", "rejected", null],
  ])("a %s card reads its own stored post, whatever the caller sends", async (_label, status, exec_status) => {
    const stored = "urn:li:share:7000000000000000007";
    Object.assign(m.row, { status, exec_status, exec_class: "linkedin_ads.create_campaign_bundle", exec_payload: { account_id: "11", creative: { post_urn: stored } } });
    const r = await previewLinkedInPost("tenant", id, { post: "urn:li:ugcPost:7000000000000000009", account_id: "99" });
    expect(r.post_urn).toBe(stored);
  });

  it("a card with no stored bundle that is no longer waiting stays refused", async () => {
    Object.assign(m.row, { status: "rejected", exec_class: null, exec_payload: null });
    await expect(previewLinkedInPost("tenant", id, { post: "urn:li:ugcPost:7000000000000000009", account_id: "11" })).rejects.toThrow("This action changed");
  });

  it("the review preview of a post pasted directly carries no repost note", async () => {
    const r = await previewLinkedInPost("tenant", id, { post: "urn:li:ugcPost:7000000000000000009", account_id: "11" });
    expect(r.post_urn).toBe("urn:li:ugcPost:7000000000000000009");
    expect(Object.keys(r)).not.toContain("repost_note");
  });
});
