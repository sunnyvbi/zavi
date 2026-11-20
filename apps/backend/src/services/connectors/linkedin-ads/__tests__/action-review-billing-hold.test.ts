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

import { reviewLinkedInCampaignAction } from "../action-review";
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

const ownHeld = "10000000-0000-4000-8000-0000000000c3";
const ownOk = "10000000-0000-4000-8000-0000000000d4";
const own = (id: string, provider: string) => ({ id, platform: "linkedin", provider_account_id: provider, funding_source: "provider", currency: "USD", disabled: false });

describe("an ad account on LinkedIn billing hold in the draft's account picker", () => {
  it("money: the founder's saved account on billing hold is flagged, listed after a usable one, and never pre-selected; LinkedIn is read once", async () => {
    m.choices.mockResolvedValue({ accounts: [own(ownHeld, "11"), own(ownOk, "12")], managed: [], selected_id: ownHeld });
    m.accounts.mockResolvedValue([
      { id: "11", name: "Held Ads", currency: "USD", status: "ACTIVE", billing_hold: true },
      { id: "12", name: "Good Ads", currency: "USD", status: "ACTIVE" },
    ]);
    const r = await reviewLinkedInCampaignAction("tenant", actionId);
    expect(r.accounts.map((a) => [a.id, a.billing_hold ?? false])).toEqual([["12", false], ["11", true]]);
    expect(r.selected_account_binding_id).toBeNull();
    expect(m.accounts).toHaveBeenCalledTimes(1);
    expect(m.resolve).not.toHaveBeenCalled();
  });

  it("flags Zavi's managed account when LinkedIn holds it for billing, from the account read it already made", async () => {
    m.choices.mockResolvedValue({ accounts: [{ id: walletB, platform: "linkedin", provider_account_id: "901", funding_source: "wallet", currency: "USD", disabled: false }], managed: [], selected_id: walletB });
    m.resolve.mockResolvedValue({ token: "managed", account: { id: "901", name: "Zavi managed", currency: "USD", status: "ACTIVE", servingStatuses: ["BILLING_HOLD"] } });
    m.accounts.mockResolvedValue([{ id: "12", name: "Good Ads", currency: "USD", status: "ACTIVE" }]);
    const r = await reviewLinkedInCampaignAction("tenant", actionId);
    expect(r.accounts.map((a) => [a.id, a.billing_hold ?? false])).toEqual([["12", false], ["901", true]]);
    expect(r.selected_account_binding_id).toBeNull();
    expect(m.resolve).toHaveBeenCalledTimes(1);
  });

  it("pre-selects only the saved account when it is usable, and nothing when no account is saved", async () => {
    m.choices.mockResolvedValue({ accounts: [own(ownHeld, "11"), own(ownOk, "12")], managed: [], selected_id: ownOk });
    m.accounts.mockResolvedValue([
      { id: "11", name: "Other Ads", currency: "USD", status: "ACTIVE" },
      { id: "12", name: "Good Ads", currency: "USD", status: "ACTIVE" },
    ]);
    const saved = await reviewLinkedInCampaignAction("tenant", actionId);
    expect(saved.selected_account_binding_id).toBe(ownOk);
    expect(saved.accounts[0]!.id).toBe("12");
    m.choices.mockResolvedValue({ accounts: [own(ownHeld, "11"), own(ownOk, "12")], managed: [], selected_id: null });
    expect((await reviewLinkedInCampaignAction("tenant", actionId)).selected_account_binding_id).toBeNull();
  });
});
