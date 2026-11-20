import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  accounts: vi.fn(),
  choices: vi.fn(),
  binding: vi.fn(),
  resolve: vi.fn(),
  places: vi.fn(),
  consent: vi.fn(),
  managedIds: vi.fn(),
  locations: undefined as string[] | undefined,
  claims: [] as Array<{ provider_account_id: string; credential_source: string; credential_tenant_id: string | null; claim_released_at: string | null }>,
  claimReads: [] as string[][],
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantRpc: vi.fn(),
  globalClient: () => ({
    from: (table: string) => {
      let ids: string[] = [];
      const q = {
        select: () => q,
        eq: () => q,
        in: (_c: string, v: string[]) => { ids = v; return q; },
        range: async () => {
          m.claimReads.push(ids);
          return { data: table === "ads_provider_accounts" ? m.claims.filter((c) => ids.includes(c.provider_account_id)) : [], error: null };
        },
      };
      return q;
    },
  }),
  tenantClient: () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data: {
            status: "pending",
            exec_class: null,
            exec_status: null,
            approved_by: null,
            body: { step: { responsibility: "client", deliverable: { presentation: { type: "campaign_draft", channel: "linkedin_ads", name: "Pilot", group_name: "First", rationale: "Why", post_preview: "Post", country: "US", language: "en", ...(m.locations ? { locations: m.locations } : {}) } } } },
          },
          error: null,
        }),
      };
      return q;
    },
  }),
}));
vi.mock("../client", () => ({
  listLinkedInAdAccounts: m.accounts,
  listLinkedInAdAccountsWithReference: vi.fn(),
  linkedinAdsToken: async () => "token",
  withLinkedInAdsToken: async (_t: string, call: (token: string) => Promise<unknown>) => call("token"),
}));
vi.mock("@/services/ads-wallet/accounts", () => ({ accountChoices: m.choices, connectCustomerAccount: vi.fn(), assertAccountAvailableForNewCampaign: vi.fn() }));
vi.mock("@/services/ads-wallet/bindings", () => ({ getAccountBinding: m.binding }));
vi.mock("@/services/ads-wallet/consent", () => ({ sharedWalletConsent: m.consent }));
vi.mock("@/services/ads-wallet/adapters/linkedin-account", () => ({ resolveLinkedinAccount: m.resolve, linkedinManagedAccountIds: m.managedIds }));
vi.mock("../targeting", async (original) => ({ ...(await original<typeof import("../targeting")>()), resolveLinkedinLocationNames: m.places }));
vi.mock("@/services/ads-wallet/fx", () => ({ adsFx: async (currency: string) => ({ currency, units_per_usd: 1, as_of: null, source: "USD" }) }));

import { LINKEDIN_ALL_OWNED_ELSEWHERE, LINKEDIN_ALL_TURNED_OFF, LINKEDIN_WALLET_READ_FAILED, reviewLinkedInCampaignAction } from "../action-review";
import { ExpectedToolError } from "@/services/tools/types";

const actionId = "10000000-0000-4000-8000-000000000002";
const walletA = "10000000-0000-4000-8000-0000000000a1";
const walletB = "10000000-0000-4000-8000-0000000000b2";

beforeEach(() => {
  vi.clearAllMocks();
  m.locations = undefined;
  m.claims = [];
  m.claimReads = [];
  m.managedIds.mockResolvedValue(null);
  m.consent.mockResolvedValue(true);
  m.places.mockImplementation(async (_token: string, names: string[]) => ({ found: names.map((name) => ({ id: "urn:li:geo:1", name: `${name}, United States` })), missed: [] }));
  m.choices.mockResolvedValue({
    accounts: [
      { id: walletA, platform: "linkedin", provider_account_id: "900", funding_source: "wallet", currency: "USD", disabled: false },
      { id: walletB, platform: "linkedin", provider_account_id: "901", funding_source: "wallet", currency: "USD", disabled: false },
    ],
    managed: [],
    selected_id: null,
  });
  m.binding.mockImplementation(async (_t: string, id: string) => ({ id }));
  m.resolve.mockImplementation(async (_t: string, b: { id: string }) => {
    if (b.id === walletA) throw new ExpectedToolError("ads_credentials_unavailable", "The managed LinkedIn connection needs attention from Zavi.");
    return { token: "managed", account: { id: "901", name: "Zavi managed", currency: "USD", status: "ACTIVE" } };
  });
  m.accounts.mockResolvedValue([{ id: "11", name: "Acme Ads", currency: "USD", status: "ACTIVE" }]);
});

describe("review LinkedIn reads", () => {
  it("resolves place names with the account it already read, without reading the accounts again", async () => {
    m.locations = ["Austin"];
    m.resolve.mockResolvedValue({ token: "managed", account: { id: "901", name: "Zavi managed", currency: "USD", status: "ACTIVE" } });
    const r = await reviewLinkedInCampaignAction("tenant", actionId);
    expect(r.suggested.locations).toEqual([{ id: "urn:li:geo:1", name: "Austin, United States" }]);
    expect(m.resolve).toHaveBeenCalledTimes(2);
    expect(m.binding).toHaveBeenCalledTimes(2);
    expect(m.accounts).toHaveBeenCalledTimes(1);
    expect(m.places.mock.calls.map((c) => c[0])).toEqual(["managed", "managed"]);
  });

  it("uses the founder's own token for place names when their account comes first, listing accounts once", async () => {
    m.locations = ["Austin"];
    m.choices.mockResolvedValue({ accounts: [], managed: [], selected_id: null });
    await reviewLinkedInCampaignAction("tenant", actionId);
    expect(m.accounts).toHaveBeenCalledTimes(1);
    expect(m.resolve).not.toHaveBeenCalled();
    expect(m.places.mock.calls.map((c) => c[0])).toEqual(["token", "token"]);
  });
});

describe("review with a Zavi-managed account that cannot be read", () => {
  it("still offers the founder's own account and the managed accounts that can be read", async () => {
    const r = await reviewLinkedInCampaignAction("tenant", actionId);
    expect(r.accounts.map((a) => [a.id, a.funding_source])).toEqual([["901", "wallet"], ["11", "provider"]]);
  });

  it("says what is wrong with the managed account when nothing else can be offered", async () => {
    m.resolve.mockRejectedValue(new ExpectedToolError("ads_credentials_unavailable", "The managed LinkedIn connection needs attention from Zavi."));
    m.accounts.mockRejectedValue(new ExpectedToolError("linkedin_ads_not_connected", "LinkedIn Ads is not connected."));
    await expect(reviewLinkedInCampaignAction("tenant", actionId)).rejects.toMatchObject({ code: "ads_credentials_unavailable" });
    m.accounts.mockResolvedValue([]);
    await expect(reviewLinkedInCampaignAction("tenant", actionId)).rejects.toMatchObject({ code: "ads_credentials_unavailable" });
  });
});

describe("review after the shared wallet permission is withdrawn", () => {
  it("does not offer or pre-select the Zavi account, and puts the founder's own account first", async () => {
    m.consent.mockResolvedValue(false);
    m.choices.mockResolvedValue({
      accounts: [
        { id: walletB, platform: "linkedin", provider_account_id: "901", funding_source: "wallet", currency: "USD", disabled: false },
      ],
      managed: [],
      selected_id: walletB,
    });
    const r = await reviewLinkedInCampaignAction("tenant", actionId);
    expect(r.accounts.map((a) => [a.id, a.funding_source])).toEqual([["11", "provider"]]);
    expect(m.resolve).not.toHaveBeenCalled();
  });

  it("does not offer the Zavi account when the permission cannot be read either", async () => {
    m.consent.mockRejectedValue(new ExpectedToolError("ads_consent_unavailable", "Shared wallet permission could not be checked."));
    const r = await reviewLinkedInCampaignAction("tenant", actionId);
    expect(r.accounts.map((a) => a.funding_source)).toEqual(["provider"]);
  });

  it.each([
    ["the founder has no LinkedIn login of their own", () => m.accounts.mockRejectedValue(new ExpectedToolError("linkedin_ads_not_connected", "LinkedIn Ads is not connected."))],
    ["the founder's login has no ad account", () => m.accounts.mockResolvedValue([])],
  ])("says the permission is withdrawn, not that the login has no account, when %s", async (_label, setup) => {
    m.consent.mockResolvedValue(false);
    setup();
    await expect(reviewLinkedInCampaignAction("tenant", actionId)).rejects.toMatchObject({
      code: "linkedin_ads_conflict",
      message: expect.stringMatching(/shared wallet permission is withdrawn.*Authorize the shared wallet again/),
    });
    expect(m.resolve).not.toHaveBeenCalled();
  });

  it("never reads the permission when no Zavi account is on", async () => {
    m.choices.mockResolvedValue({ accounts: [], managed: [], selected_id: null });
    await reviewLinkedInCampaignAction("tenant", actionId);
    expect(m.consent).not.toHaveBeenCalled();
  });
});

describe("review on the shared wallet when the founder's own LinkedIn login is not usable", () => {
  const walletOnly = () => m.choices.mockResolvedValue({
    accounts: [{ id: walletB, platform: "linkedin", provider_account_id: "901", funding_source: "wallet", currency: "USD", disabled: false }],
    managed: [],
    selected_id: walletB,
  });
  it.each([
    ["expired or revoked", new ExpectedToolError("linkedin_ads_token_revoked", "Reconnect LinkedIn Ads in Connectors.")],
    ["at LinkedIn's daily limit", new ExpectedToolError("linkedin_ads_http_error", "LinkedIn is busy for this login today.", { status: 429, http_status: 429 })],
    ["refused by LinkedIn", new ExpectedToolError("linkedin_ads_forbidden", "LinkedIn refused this login.")],
  ])("opens the draft on the managed account when the own login is %s, and says the own account is unavailable", async (_label, err) => {
    walletOnly();
    m.accounts.mockRejectedValue(err);
    const r = await reviewLinkedInCampaignAction("tenant", actionId);
    expect(r.accounts.map((a) => [a.id, a.account_binding_id, a.funding_source])).toEqual([["901", walletB, "wallet"]]);
    expect(r.own_account_unavailable).toBe(err.message);
    expect(m.accounts).toHaveBeenCalledTimes(1);
    expect(m.managedIds).not.toHaveBeenCalled();
  });

  it("still refuses when the founder's saved choice is their own account, rather than swapping it for the wallet", async () => {
    const own = "10000000-0000-4000-8000-0000000000c3";
    m.choices.mockResolvedValue({
      accounts: [
        { id: own, platform: "linkedin", provider_account_id: "11", funding_source: "provider", currency: "USD", disabled: false },
        { id: walletB, platform: "linkedin", provider_account_id: "901", funding_source: "wallet", currency: "USD", disabled: false },
      ],
      managed: [],
      selected_id: own,
    });
    m.accounts.mockRejectedValue(new ExpectedToolError("linkedin_ads_token_revoked", "Reconnect LinkedIn Ads in Connectors."));
    await expect(reviewLinkedInCampaignAction("tenant", actionId)).rejects.toMatchObject({ code: "linkedin_ads_token_revoked" });
  });
});

describe("review when Zavi's managed account read fails for a moment", () => {
  const walletOnlyChoice = (selected: string | null) => m.choices.mockResolvedValue({
    accounts: [{ id: walletA, platform: "linkedin", provider_account_id: "900", funding_source: "wallet", currency: "USD", disabled: false }],
    managed: [],
    selected_id: selected,
  });
  it.each([
    ["LinkedIn's rate limit", new ExpectedToolError("linkedin_ads_http_error", "LinkedIn is busy.", { status: 429, http_status: 429 })],
    ["a LinkedIn outage", new ExpectedToolError("linkedin_ads_http_error", "LinkedIn is unavailable.", { status: 503, http_status: 503 })],
    ["a network error", new Error("fetch failed")],
  ])("never pre-selects the founder's own billing after %s on the wallet account", async (_label, err) => {
    walletOnlyChoice(walletA);
    m.resolve.mockRejectedValue(err);
    await expect(reviewLinkedInCampaignAction("tenant", actionId)).rejects.toMatchObject({ code: "linkedin_ads_conflict", message: LINKEDIN_WALLET_READ_FAILED });
  });

  it("does not pre-select own billing either when no account was saved yet", async () => {
    walletOnlyChoice(null);
    m.resolve.mockRejectedValue(new ExpectedToolError("linkedin_ads_http_error", "LinkedIn is busy.", { status: 429, http_status: 429 }));
    await expect(reviewLinkedInCampaignAction("tenant", actionId)).rejects.toMatchObject({ message: LINKEDIN_WALLET_READ_FAILED });
  });

  it("opens on own billing when the founder chose their own account themselves", async () => {
    const own = "10000000-0000-4000-8000-0000000000c3";
    m.choices.mockResolvedValue({
      accounts: [
        { id: walletA, platform: "linkedin", provider_account_id: "900", funding_source: "wallet", currency: "USD", disabled: false },
        { id: own, platform: "linkedin", provider_account_id: "11", funding_source: "provider", currency: "USD", disabled: false },
      ],
      managed: [],
      selected_id: own,
    });
    m.resolve.mockRejectedValue(new ExpectedToolError("linkedin_ads_http_error", "LinkedIn is busy.", { status: 429, http_status: 429 }));
    const r = await reviewLinkedInCampaignAction("tenant", actionId);
    expect(r.accounts.map((a) => [a.account_binding_id, a.funding_source])).toEqual([[own, "provider"]]);
  });
});

describe("review across Zavi workspaces sharing one LinkedIn ad account", () => {
  const tenantA = "aaaaaaaa-0000-4000-8000-000000000001";
  const tenantB = "bbbbbbbb-0000-4000-8000-000000000002";
  beforeEach(() => {
    m.choices.mockResolvedValue({ accounts: [], managed: [], selected_id: null });
    m.accounts.mockResolvedValue([
      { id: "11", name: "Acme Ads", currency: "USD", status: "ACTIVE" },
      { id: "12", name: "Second Ads", currency: "USD", status: "ACTIVE" },
    ]);
    m.claims = [{ provider_account_id: "11", credential_source: "tenant_connector", credential_tenant_id: tenantA, claim_released_at: null }];
  });

  it("leaves another workspace's account out of workspace B's picker and keeps it in workspace A's", async () => {
    const b = await reviewLinkedInCampaignAction(tenantB, actionId);
    expect(b.accounts.map((a) => a.id)).toEqual(["12"]);
    const a = await reviewLinkedInCampaignAction(tenantA, actionId);
    expect(a.accounts.map((x) => x.id)).toEqual(["11", "12"]);
    expect(m.claimReads).toEqual([["11", "12"], ["11", "12"]]);
    expect(m.accounts).toHaveBeenCalledTimes(2);
  });

  it("offers an account whose old workspace let it go, and never one Zavi manages", async () => {
    m.claims = [
      { provider_account_id: "11", credential_source: "tenant_connector", credential_tenant_id: tenantA, claim_released_at: "2026-11-01T00:00:00Z" },
      { provider_account_id: "12", credential_source: "platform", credential_tenant_id: null, claim_released_at: null },
    ];
    const b = await reviewLinkedInCampaignAction(tenantB, actionId);
    expect(b.accounts.map((a) => a.id)).toEqual(["11"]);
  });

  it("says the accounts belong to another workspace when that is why none is left", async () => {
    m.claims.push({ provider_account_id: "12", credential_source: "tenant_connector", credential_tenant_id: tenantA, claim_released_at: null });
    await expect(reviewLinkedInCampaignAction(tenantB, actionId)).rejects.toMatchObject({ message: LINKEDIN_ALL_OWNED_ELSEWHERE });
  });

  const turnedOffSecond = () =>
    m.choices.mockResolvedValue({
      accounts: [{ id: "10000000-0000-4000-8000-0000000000d4", platform: "linkedin", provider_account_id: "12", funding_source: "provider", currency: "USD", disabled: true }],
      managed: [],
      selected_id: null,
    });
  const refusal = async () => {
    const e = await reviewLinkedInCampaignAction(tenantB, actionId).then(() => null, (x: Error) => x);
    expect(e).not.toBeNull();
    return e!.message;
  };

  it("names both reasons when one account is turned off here and the other is connected to another workspace", async () => {
    turnedOffSecond();
    expect(await refusal()).toBe(
      "Zavi cannot create this campaign on any ad account on this LinkedIn login. Second Ads is turned off for new campaigns in this workspace. Turn it back on with Use this account again in Ad account and shared wallet. Acme Ads is connected to another Zavi workspace. Nothing was created.",
    );
    expect(m.claimReads).toEqual([["11"]]);
  });

  it("never calls Zavi's managed account another workspace's, and names the account turned off here", async () => {
    turnedOffSecond();
    m.claims = [{ provider_account_id: "11", credential_source: "platform", credential_tenant_id: null, claim_released_at: null }];
    const message = await refusal();
    expect(message).not.toContain("another Zavi workspace");
    expect(message).not.toBe(LINKEDIN_ALL_OWNED_ELSEWHERE);
    expect(message).toBe(
      "Zavi cannot create this campaign on any ad account on this LinkedIn login. Second Ads is turned off for new campaigns in this workspace. Turn it back on with Use this account again in Ad account and shared wallet. Acme Ads is Zavi's managed account, not your own. Use it under Use a Zavi account in Ad account and shared wallet. Nothing was created.",
    );
  });

  it("keeps Zavi's managed account out of the own-billing picker even when nothing else is left", async () => {
    m.claims = [
      { provider_account_id: "11", credential_source: "platform", credential_tenant_id: null, claim_released_at: null },
      { provider_account_id: "12", credential_source: "platform", credential_tenant_id: null, claim_released_at: null },
    ];
    const message = await refusal();
    expect(message).not.toContain("another Zavi workspace");
    expect(message).toContain("Acme Ads and Second Ads are Zavi's managed accounts, not your own. Use them under Use a Zavi account");
  });

  it("still says only turned off when every account was turned off here", async () => {
    m.choices.mockResolvedValue({
      accounts: ["11", "12"].map((id, i) => ({ id: `10000000-0000-4000-8000-0000000000e${i}`, platform: "linkedin", provider_account_id: id, funding_source: "provider", currency: "USD", disabled: true })),
      managed: [],
      selected_id: null,
    });
    expect(await refusal()).toBe(LINKEDIN_ALL_TURNED_OFF);
  });
});
