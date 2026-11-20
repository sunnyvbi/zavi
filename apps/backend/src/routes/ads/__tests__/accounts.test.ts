import { beforeEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const m = vi.hoisted(() => ({
  auth: vi.fn(),
  role: vi.fn(),
  tier: vi.fn(),
  lock: vi.fn(),
  key: vi.fn(),
  customer: vi.fn(),
  managed: vi.fn(),
  select: vi.fn(),
  rpc: vi.fn(),
  consent: vi.fn(),
  pause: vi.fn(),
  choices: vi.fn(),
  stops: [] as Record<string, unknown>[] | null,
  stopFilters: [] as [string, unknown][],
  autopilot: vi.fn(),
  ended: [] as string[],
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.auth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: m.role }));
vi.mock("@/services/ads-wallet/providers", () => ({
  refillEligibility: async () => "allowed",
}));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: m.tier }));
vi.mock("@/services/channels/lock", () => ({ isChannelLockedStrict: m.lock }));
vi.mock("@/services/ads-wallet/accounts", async (original) => ({
  ...(await original<typeof import("@/services/ads-wallet/accounts")>()),
  connectChatgptCustomerKey: m.key,
  connectCustomerAccount: m.customer,
  connectManagedAccount: m.managed,
  chooseAccount: m.select,
  accountChoices: m.choices,
}));
vi.mock("@/services/ads-wallet/consent", () => ({
  SHARED_WALLET_CONSENT_VERSION: "shared_ads_wallet_v1",
  SHARED_WALLET_CONSENT_TEXT: "Shared consent",
  sharedWalletConsent: m.consent,
  autopilotLaunchedOwnBillingCampaigns: m.autopilot,
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantRpc: m.rpc,
  tenantClient: () => ({
    from: (table: string) => {
      const filters: [string, unknown][] = [];
      const q: any = {
        select: () => q,
        eq: (col: string, v: unknown) => {
          filters.push([col, v]);
          return q;
        },
        not: () => q,
        range: async () => {
          if (table === "ads_campaign_spend_stability")
            return { data: m.ended.map((campaign_binding_id) => ({ campaign_binding_id })), error: null };
          m.stopFilters = filters;
          if (table !== "ads_campaign_pending_stops" || m.stops === null)
            return { data: null, error: { message: "unavailable" } };
          return {
            data: m.stops.filter((r) => filters.every(([c, v]) => r[c] === v)),
            error: null,
          };
        },
      };
      return q;
    },
  }),
}));
vi.mock("@/services/ads-wallet/adapters/linkedin", () => ({
  pauseLinkedinBoundCampaign: m.pause,
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
import {
  adsAccounts,
  adsConnectAccount,
  adsDisableAccount,
  adsEnableAccount,
  adsSelectAccount,
  adsWalletConsent,
} from "../accounts";
const req = (body: unknown, platform = "chatgpt") =>
  ({ body, params: { platform }, method: "POST" }) as unknown as Request;
const res = () => {
  const r = { status: vi.fn(), json: vi.fn() };
  r.status.mockReturnValue(r);
  return r as unknown as Response;
};
beforeEach(() => {
  vi.resetAllMocks();
  m.autopilot.mockResolvedValue([]);
  m.auth.mockResolvedValue({ tenant_id: "verified", user_id: "owner" });
  m.role.mockResolvedValue(true);
  m.tier.mockResolvedValue({ allowed: true, enforced: true });
  m.lock.mockResolvedValue(false);
  m.rpc.mockResolvedValue({ error: null });
  m.key.mockResolvedValue("binding");
  m.stops = [];
  m.stopFilters = [];
  m.ended = [];
});
it("passes a customer key only to verification for the authenticated workspace and never echoes it", async () => {
  const r = res();
  await adsConnectAccount(
    req({ mode: "customer_key", api_key: "synthetic-key" }),
    r,
  );
  expect(m.key).toHaveBeenCalledWith("verified", "synthetic-key");
  expect(r.json).toHaveBeenCalledWith({ account_binding_id: "binding" });
});
it.each(["member", "override", "unknown-tier", "locked"])(
  "refuses account mutation for %s",
  async (condition) => {
    if (condition === "member") m.role.mockResolvedValue(false);
    if (condition === "override")
      m.auth.mockResolvedValue({ tenant_id: "other", tenant_overridden: true });
    if (condition === "unknown-tier")
      m.tier.mockResolvedValue({ allowed: true, enforced: false });
    if (condition === "locked") m.lock.mockResolvedValue(true);
    await adsConnectAccount(
      req({ mode: "customer_key", api_key: "synthetic-key" }),
      res(),
    );
    expect(m.key).not.toHaveBeenCalled();
  },
);
it("refuses API-key injection into another provider", async () => {
  const r = res();
  await adsConnectAccount(
    req({ mode: "customer_key", api_key: "synthetic-key" }, "linkedin"),
    r,
  );
  expect(r.status).toHaveBeenCalledWith(400);
  expect(m.key).not.toHaveBeenCalled();
});
it.each([
  { tenant_id: "foreign" },
  { credential_ref: "platform-secret" },
  { funding_source: "wallet" },
])("refuses caller account-routing fields %o", async (extra) => {
  const r = res();
  await adsConnectAccount(
    req({ mode: "customer", account_id: "123", ...extra }, "linkedin"),
    r,
  );
  expect(r.status).toHaveBeenCalledWith(400);
  expect(m.customer).not.toHaveBeenCalled();
});
it("changes only the verified tenant's selected binding", async () => {
  const id = "10000000-0000-4000-8000-000000000001";
  await adsSelectAccount(req({ account_binding_id: id }, "linkedin"), res());
  expect(m.select).toHaveBeenCalledWith("verified", "linkedin", id);
});
it("allows consent withdrawal after a tier downgrade without accepting a caller-supplied actor", async () => {
  m.tier.mockResolvedValue({ allowed: false, enforced: true });
  await adsWalletConsent(
    req({ version: "shared_ads_wallet_v1", accept: false }),
    res(),
  );
  expect(m.rpc).toHaveBeenCalledWith("verified", "ads_set_wallet_consent", {
    p_actor_user_id: "owner",
    p_version: "shared_ads_wallet_v1",
    p_accept: false,
  });
  const r = res();
  m.rpc.mockClear();
  await adsWalletConsent(
    req({
      version: "shared_ads_wallet_v1",
      accept: true,
      actor_user_id: "other",
    }),
    r,
  );
  expect(r.status).toHaveBeenCalledWith(400);
  expect(m.rpc).not.toHaveBeenCalled();
});
it("withdrawing shared-wallet consent pauses only the LinkedIn campaigns Zavi pays for, never the founder's own-billing ones", async () => {
  m.stops = [
    { campaign_binding_id: "wallet-1", funding_source: "wallet" },
    { campaign_binding_id: "own-1", funding_source: "provider" },
    { campaign_binding_id: "wallet-2", funding_source: "wallet" },
  ];
  m.pause.mockResolvedValue("paused");
  const r = res();
  await adsWalletConsent(req({ version: "shared_ads_wallet_v1", accept: false }), r);
  expect(m.stopFilters).toEqual([["funding_source", "wallet"]]);
  expect(m.pause.mock.calls).toEqual([
    ["verified", "wallet-1", false],
    ["verified", "wallet-2", false],
  ]);
  expect(r.status).not.toHaveBeenCalled();
  expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ version: "shared_ads_wallet_v1" }));
});
it("withdrawing shared-wallet consent also pauses, through the recorded-intent pause path, the own-billing campaigns Autopilot launched under it", async () => {
  m.stops = [{ campaign_binding_id: "wallet-1", funding_source: "wallet" }];
  m.autopilot.mockResolvedValue(["own-autopilot-1", "own-autopilot-2"]);
  m.pause.mockResolvedValue("paused");
  const r = res();
  await adsWalletConsent(req({ version: "shared_ads_wallet_v1", accept: false }), r);
  expect(m.autopilot).toHaveBeenCalledWith("verified");
  expect(m.pause.mock.calls).toEqual(expect.arrayContaining([
    ["verified", "own-autopilot-1", true],
    ["verified", "own-autopilot-2", true],
    ["verified", "wallet-1", false],
  ]));
  expect(m.pause).toHaveBeenCalledTimes(3);
  expect(r.status).not.toHaveBeenCalled();
});
it("money: withdrawing pauses at most five live wallet campaigns, one at a time, skips finished ones, and leaves the rest to the background sweep", async () => {
  m.stops = Array.from({ length: 40 }, (_, i) => ({ campaign_binding_id: `wallet-${i}`, funding_source: "wallet" }));
  m.ended = Array.from({ length: 30 }, (_, i) => `wallet-${i}`);
  let inFlight = 0;
  let most = 0;
  m.pause.mockImplementation(async () => {
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return "paused";
  });
  const r = res();
  await adsWalletConsent(req({ version: "shared_ads_wallet_v1", accept: false }), r);
  expect(m.pause.mock.calls).toEqual(["30", "31", "32", "33", "34"].map((n) => ["verified", `wallet-${n}`, false]));
  expect(most).toBe(1);
  expect(r.status).toHaveBeenCalledWith(409);
  expect((r.json as any).mock.calls[0][0].error.message).toBe("Your consent is withdrawn. Some LinkedIn campaigns Zavi pays for are not confirmed paused yet. Zavi will keep trying in the background.");
});
it("withdrawing with only finished wallet campaigns calls LinkedIn for none of them and reports nothing pending", async () => {
  m.stops = [{ campaign_binding_id: "wallet-done", funding_source: "wallet" }];
  m.ended = ["wallet-done"];
  const r = res();
  await adsWalletConsent(req({ version: "shared_ads_wallet_v1", accept: false }), r);
  expect(m.pause).not.toHaveBeenCalled();
  expect(r.status).not.toHaveBeenCalled();
});
it("accepting shared-wallet consent pauses nothing", async () => {
  m.autopilot.mockResolvedValue(["own-autopilot-1"]);
  const r = res();
  await adsWalletConsent(req({ version: "shared_ads_wallet_v1", accept: true }), r);
  expect(m.autopilot).not.toHaveBeenCalled();
  expect(m.pause).not.toHaveBeenCalled();
});
it.each([
  ["the Autopilot launches cannot be read", () => { m.autopilot.mockRejectedValue(new Error("down")); }, /Autopilot cannot launch LinkedIn campaigns any more.*may still be running/],
  ["an Autopilot-launched pause is not confirmed", () => {
    m.autopilot.mockResolvedValue(["own-autopilot-1"]);
    m.pause.mockImplementation(async (_t: string, id: string) => { if (id === "own-autopilot-1") throw new Error("LinkedIn pause could not be confirmed"); return "paused"; });
  }, /Autopilot launched with it are not confirmed paused yet/],
])("a withdrawal where %s is saved and says so, still pausing the wallet campaigns", async (_label, arrange, message) => {
  m.stops = [{ campaign_binding_id: "wallet-1", funding_source: "wallet" }];
  m.pause.mockResolvedValue("paused");
  arrange();
  const r = res();
  await adsWalletConsent(req({ version: "shared_ads_wallet_v1", accept: false }), r);
  expect(m.pause).toHaveBeenCalledWith("verified", "wallet-1", false);
  expect(r.status).toHaveBeenCalledWith(409);
  const body = (r.json as any).mock.calls[0][0];
  expect(body.error.code).toBe("ads_stops_pending");
  expect(body.error.message).toMatch(message);
});
it.each([
  ["the wallet pause is unconfirmed", () => { m.stops = [{ campaign_binding_id: "wallet-1", funding_source: "wallet" }]; m.pause.mockRejectedValue(new Error("no")); }],
  ["the wallet stops cannot be read", () => { m.stops = null; }],
])("must catch: when %s too, the founder is still told Autopilot's own-billing campaigns could not be checked", async (_label, arrange) => {
  arrange();
  m.autopilot.mockRejectedValue(new Error("down"));
  const r = res();
  await adsWalletConsent(req({ version: "shared_ads_wallet_v1", accept: false }), r);
  expect(r.status).toHaveBeenCalledWith(409);
  const { message } = (r.json as any).mock.calls[0][0].error;
  expect(message).toMatch(/^Your consent is withdrawn\./);
  expect(message).toMatch(/LinkedIn campaigns (it|Zavi) pays? for/);
  expect(message).toMatch(/Autopilot already launched.*may still be running/);
});
it("must catch: a failed Autopilot read never tells the founder to withdraw again, which the page no longer offers once withdrawn", async () => {
  m.autopilot.mockRejectedValue(new Error("down"));
  const r = res();
  await adsWalletConsent(req({ version: "shared_ads_wallet_v1", accept: false }), r);
  const { message } = (r.json as any).mock.calls[0][0].error;
  expect(message).not.toMatch(/withdraw again/i);
  expect(message).toMatch(/Pause them from your LinkedIn campaign list/);
  expect(r.json).not.toHaveBeenCalledWith(expect.objectContaining({ accepted: expect.anything() }));
});
it.each([
  ["a pause LinkedIn will not confirm", () => {
    m.stops = [{ campaign_binding_id: "wallet-1", funding_source: "wallet" }];
    m.pause.mockRejectedValue(new Error("LinkedIn pause could not be confirmed"));
  }],
  ["the pending stops cannot be read", () => {
    m.stops = null;
  }],
])("a withdrawal with %s is saved and answered as a 409 the page can explain, not a LinkedIn failure", async (_label, arrange) => {
  arrange();
  const r = res();
  await adsWalletConsent(req({ version: "shared_ads_wallet_v1", accept: false }), r);
  expect(m.rpc).toHaveBeenCalledWith("verified", "ads_set_wallet_consent", expect.objectContaining({ p_accept: false }));
  expect(r.status).toHaveBeenCalledWith(409);
  const body = (r.json as any).mock.calls[0][0];
  expect(body.error.code).toBe("ads_stops_pending");
  expect(body.error.message).toMatch(/^Your consent is withdrawn\./);
  expect(body.error.message).not.toMatch(/worker|retried|ads_/);
});
it("lets a member read the account setup and wallet consent without an owner or admin check", async () => {
  m.role.mockResolvedValue(false);
  m.choices.mockResolvedValue({ accounts: [], selected_id: null });
  m.consent.mockResolvedValue(true);
  const accounts = res();
  await adsAccounts(
    { params: { platform: "linkedin" }, method: "GET" } as unknown as Request,
    accounts,
  );
  expect(accounts.status).not.toHaveBeenCalled();
  expect(accounts.json).toHaveBeenCalledWith(expect.objectContaining({ accounts: [], selected_id: null }));
  expect(m.choices).toHaveBeenCalledWith("verified", "linkedin");
  const consent = res();
  await adsWalletConsent(
    { params: {}, method: "GET" } as unknown as Request,
    consent,
  );
  expect(consent.status).not.toHaveBeenCalled();
  expect(consent.json).toHaveBeenCalledWith(
    expect.objectContaining({ accepted: true }),
  );
  expect(m.role).not.toHaveBeenCalled();
});
it.each([
  ["consent", () => adsWalletConsent(req({ version: "shared_ads_wallet_v1", accept: false }), res())],
  ["disable", () => adsDisableAccount(req({ account_binding_id: "10000000-0000-4000-8000-000000000001" }, "linkedin"), res())],
  ["enable", () => adsEnableAccount(req({ account_binding_id: "10000000-0000-4000-8000-000000000001" }, "linkedin"), res())],
])("still refuses a member's %s change", async (_name, call) => {
  m.role.mockResolvedValue(false);
  await call();
  expect(m.role).toHaveBeenCalledWith(
    expect.anything(),
    ["owner", "admin"],
    expect.anything(),
  );
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.pause).not.toHaveBeenCalled();
});
