import { beforeEach, describe, expect, it, vi } from "vitest";
const armStop = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => (_a[2] ? { ok: true as boolean, line: "Runs $48/day until Nov 3, planned about $480. Zavi pauses it if spend gets there." as string | null, why: "" } : { ok: true as boolean, line: null as string | null, why: "" })));
vi.mock("@/services/growth/test-stops", async (orig) => ({ ...(await orig<typeof import("@/services/growth/test-stops")>()), armCreatedTestStop: async (...a: unknown[]) => (await armStop(...a)) ?? (a[2] ? { ok: true, line: "Runs $48/day until Nov 3, planned about $480. Zavi pauses it if spend gets there." } : { ok: true, line: null }) }));
const m = vi.hoisted(() => ({
  source: "wallet" as "wallet" | "provider",
  create: vi.fn(),
  group: vi.fn(),
  ad: vi.fn(),
  tree: vi.fn(),
  update: vi.fn(),
  launch: vi.fn(),
  reserve: vi.fn(),
  commit: vi.fn(),
  drop: vi.fn(),
  note: vi.fn(),
  label: vi.fn(),
  consent: vi.fn(),
  budget: vi.fn(),
  tier: vi.fn(),
  locked: vi.fn(),
  wallet: vi.fn(),
  fund: vi.fn(),
  serving: vi.fn(),
  checkImage: vi.fn(),
  checkUpload: vi.fn(),
  flag: false,
  row: { id: "11111111-1111-4111-8111-999999999999" } as Record<string, unknown>,
}));
vi.mock("@/services/growth/ads-no-friction-flag", () => ({ adsNoFrictionEnabled: async () => m.flag }));
const testEndMock = vi.hoisted(() => ({ end: null as null | { decision_id: string; channel: string | null; ends_on: string }, fail: false }));
vi.mock("@/services/growth/cgo-test-end", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/cgo-test-end")>()),
  cgoTestEndForRun: async () => {
    if (testEndMock.fail) throw new Error("db down");
    return testEndMock.end;
  },
}));
vi.mock("@/services/ads-wallet/plan-funding", async original => ({
  ...await original<typeof import("@/services/ads-wallet/plan-funding")>(), fundApprovedPlan: m.fund,
}));
vi.mock("../workspace", async (original) => ({
  ...(await original<typeof import("../workspace")>()),
  createCampaign: m.create,
  createAdGroup: m.group,
  saveAdCreative: m.ad,
  readCampaignTree: async (...args: any[]) => ({
    binding: { account_binding_id: "account", funding_source: m.source },
    providerCurrency: "USD",
    ...(await m.tree(...args)),
  }),
  readServerMadeTree: async (...args: any[]) => ({
    binding: { account_binding_id: "account", funding_source: m.source },
    providerCurrency: "USD",
    missing: [],
    ...(await m.tree(...args)),
  }),
  updateCampaign: m.update,
}));
vi.mock("../launch", async (original) => ({
  ...(await original<typeof import("../launch")>()),
  launchCampaign: m.launch,
  launchServerMadeCampaign: (t: string, id: string, _manifest: unknown, guard: unknown) => m.launch(t, id, { server_made: true }, guard),
}));
vi.mock("../generated-image", () => ({ checkGeneratedAdImage: m.checkImage }));
vi.mock("@/services/chat-images/sign-own-image", async original => ({ ...await original<typeof import("@/services/chat-images/sign-own-image")>(), checkOwnImageForVendor: m.checkUpload }));
vi.mock("../serving", () => ({ assertServingReady: m.serving }));
vi.mock("../key-provider", () => ({ getChatgptAdsApiKey: async () => "key" }));
vi.mock("../tenant-scope", async (original) => ({
  ...(await original<typeof import("../tenant-scope")>()),
  resolveTenantCampaignPrefix: async () => "zv-acme--",
}));
vi.mock("@/services/channels/chatgpt-ads/funding-context", () => ({
  readChatgptFundingContext: m.wallet,
}));
vi.mock("@/services/channels/chatgpt-ads/wallet", () => ({
  fundingEnabled: () => true,
}));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: m.tier }));
vi.mock("@/services/channels/lock", () => ({
  isChannelLockedStrict: m.locked,
}));
vi.mock("@/services/growth/unattended-policy", () => ({
  readChannelAutorun: m.consent,
}));
vi.mock("@/services/growth/cgo-ads", () => ({ cgoAdBudget: m.budget }));
vi.mock("@/services/decisions/ad-changes", () => ({
  recordZaviAdChange: vi.fn(),
}));
vi.mock("@/services/decisions/ad-budget", async (original) => ({
  ...(await original<typeof import("@/services/decisions/ad-budget")>()),
  reserveAdSpend: m.reserve,
  commitAdSpend: m.commit,
  dropAdSpendHold: m.drop,
  noteAdSpendObject: m.note,
  noteAdSpendRef: m.label,
  releaseAdSpendForObject: vi.fn(),
}));
vi.mock("@/services/ads-wallet/bindings", () => ({
  claimCampaignAccount: async () => ({
    id: "account",
    funding_source: m.source,
  }),
  getCampaignBinding: async () => ({
    id: "11111111-1111-4111-8111-999999999999",
    account_binding_id: "account",
    provider_campaign_id: "cmpn_test",
    funding_source: m.source,
  }),
  getAccountBinding: async () => ({ id: "account", funding_source: m.source }),
  bindCampaign: async (_t: any, _a: any, id: string) => ({
    id: "11111111-1111-4111-8111-999999999999",
    account_binding_id: "account",
    provider_campaign_id: id,
    funding_source: m.source,
  }),
}));
vi.mock("@/services/ads-wallet/accounts", () => ({
  assertAccountAvailableForNewCampaign: async () => {},
}));
vi.mock("../account-binding", () => ({
  resolveChatgptAccount: async () => ({
    key: m.source === "provider" ? "own-key" : "shared-key",
    account: { currency_code: "USD" },
  }),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantClient: () => ({
    from: () => {
      const q: any = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data: m.row,
          error: null,
        }),
      };
      return q;
    },
  }),
}));
import { launchSnapshot } from "../launch";
import { noteChatgptWriteAttempt } from "../write-tracking";
import { executeChatgptGrowthAction } from "../growth-execution";
import { launchTiming } from "../launch";

let clock = 0;
beforeEach(() => {
  clock = Date.now();
  launchTiming.now = () => clock;
  launchTiming.sleep = async (ms: number) => { clock += ms; };
});
import {
  growthBundle,
  CHATGPT_CREATE,
  CHATGPT_BUDGET,
  CHATGPT_STATUS,
} from "../growth-actions";
const id = "11111111-1111-4111-8111-111111111111";
function decision() {
  const start = Math.floor(Date.now() / 1000);
  return {
    id,
    tenant_id: "acme",
    decision_class: CHATGPT_CREATE,
    approved_by_source: "cgo",
    exec_source: "channel_actions",
    body: {
      name: "Launch test",
      origin: "agent",
      bundle: {
        summary: "Test a new buyer intent",
        rationale: "Run one bounded test of the verified offer",
        campaign: {
          name: "Launch test",
          daily_budget_micros: 25e6,
          bidding_type: "clicks",
          start_time: start,
          end_time: start + 86400,
          targeting: { locations: { countries: ["US"] } },
        },
        group: {
          name: "Intent group",
          context_hints: ["Find a car"],
          strategy: "maximize_clicks",
        },
        ads: [
          {
            name: "Test ad",
            title: "Find a car",
            body: "Compare your options",
            target_url: "https://example.com",
            image_url: "https://example.com/car.png",
          },
        ],
      },
    },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  testEndMock.end = null;
  testEndMock.fail = false;
  m.flag = false;
  m.row = { id: "11111111-1111-4111-8111-999999999999" };
  m.source = "wallet";
  m.tier.mockResolvedValue({ allowed: true });
  m.locked.mockResolvedValue(false);
  m.consent.mockResolvedValue(true);
  m.budget.mockResolvedValue({ id: "budget" });
  m.wallet.mockResolvedValue({ status: "read", available_cents: 1000000 });
  m.reserve.mockResolvedValue({
    status: "held",
    tenant_id: "acme",
    idem_key: "a:create",
    fresh: true,
  });
  m.label.mockResolvedValue(null);
  m.create.mockImplementation(async () => {
    noteChatgptWriteAttempt();
    return { id: "cmpn_test" };
  });
  m.group.mockResolvedValue({ id: "ag1" });
  m.ad.mockResolvedValue({ id: "ad1" });
  m.launch.mockResolvedValue({ ok: true });
  m.tree.mockResolvedValue({
    campaign: { id: "cmpn_test", status: "active", updated_at: 1 },
    groups: [{ id: "ag1", status: "active" }],
    ads: [{ id: "ad1", status: "active" }],
  });
});
describe("ChatGPT approved execution", () => {
  it("creates through the specialist rail, reserves before the provider and verifies launch", async () => {
    const result = await executeChatgptGrowthAction(decision());
    expect(result).toMatchObject({
      ok: true,
      created: { platform: "chatgpt", id: "cmpn_test", status: "ACTIVE" },
    });
    expect(m.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      m.create.mock.invocationCallOrder[0],
    );
    expect(m.note.mock.invocationCallOrder[0]).toBeLessThan(
      m.group.mock.invocationCallOrder[0],
    );
    expect(m.create).toHaveBeenCalledWith(
      "acme",
      expect.objectContaining({ name: expect.stringContaining(id) }),
      expect.any(String),
    );
    expect(m.commit).toHaveBeenCalled();
    expect(m.launch.mock.calls[0][3]).toBeTypeOf("function");
  });
  it.each(["consent", "budget", "tier", "wallet", "serving"])(
    "refuses failed %s before a create",
    async (gate) => {
      if (gate === "consent") m.consent.mockResolvedValue(false);
      if (gate === "budget") m.budget.mockResolvedValue(null);
      if (gate === "tier") m.tier.mockResolvedValue({ allowed: false });
      if (gate === "wallet")
        m.wallet.mockResolvedValue({ status: "read", available_cents: 1000 });
      if (gate === "serving") m.serving.mockRejectedValue(new Error("setup"));
      expect((await executeChatgptGrowthAction(decision())).ok).toBe(false);
      expect(m.create).not.toHaveBeenCalled();
    },
  );
  it("does not fall through when the Growth budget stops during reserve", async () => {
    m.reserve.mockResolvedValue({ status: "no_budget" });
    expect((await executeChatgptGrowthAction(decision())).ok).toBe(false);
    expect(m.create).not.toHaveBeenCalled();
  });
  it("keeps the hold after an unknown create, with no launch or blind retry", async () => {
    m.create.mockImplementation(async () => {
      noteChatgptWriteAttempt();
      throw new Error("timeout");
    });
    expect(await executeChatgptGrowthAction(decision())).toMatchObject({
      ok: false,
      code: "exec_outcome_unknown",
    });
    expect(m.drop).not.toHaveBeenCalled();
    expect(m.launch).not.toHaveBeenCalled();
  });
  it("records the parent before a partial child failure and keeps coverage", async () => {
    m.group.mockRejectedValue(new Error("timeout"));
    expect(await executeChatgptGrowthAction(decision())).toMatchObject({
      ok: false,
      code: "exec_partial",
    });
    expect(m.note).toHaveBeenCalled();
    expect(m.drop).not.toHaveBeenCalled();
    expect(m.commit).toHaveBeenCalledTimes(1);
  });
  it("refuses permission revoked between creation and child writes", async () => {
    m.consent
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    expect(await executeChatgptGrowthAction(decision())).toMatchObject({
      ok: false,
      code: "exec_partial",
    });
    expect(m.group).not.toHaveBeenCalled();
  });
  it("does not report launch when the provider readback is paused", async () => {
    m.tree.mockResolvedValue({
      campaign: { id: "cmpn_test", status: "paused", updated_at: 1 },
      groups: [{ id: "ag1", status: "active" }],
      ads: [{ id: "ad1", status: "active" }],
    });
    expect((await executeChatgptGrowthAction(decision())).ok).toBe(false);
    expect(m.commit).toHaveBeenCalledTimes(1);
  });
  it("rejects lifetime or unbounded bundles before execution", () => {
    const bundle = decision().body.bundle;
    expect(
      growthBundle.safeParse({
        ...bundle,
        campaign: { ...bundle.campaign, end_time: null },
      }).success,
    ).toBe(false);
    expect(
      growthBundle.safeParse({
        ...bundle,
        campaign: { ...bundle.campaign, lifetime_budget_micros: 100e6 },
      }).success,
    ).toBe(false);
  });
});

it("a raise reserves what it adds, not the new total (20261022140000)", async () => {
  m.tree.mockResolvedValue({
    campaign: {
      id: "cmpn_test",
      name: "Existing",
      status: "active",
      updated_at: 1,
      budget: { daily_spend_limit_micros: 25e6 },
    },
    groups: [],
    ads: [],
  });
  m.update.mockResolvedValue({
    id: "cmpn_test",
    status: "active",
    budget: { daily_spend_limit_micros: 30e6 },
  });
  const result = await executeChatgptGrowthAction({
    ...decision(),
    decision_class: CHATGPT_BUDGET,
    body: {
      name: "Raise test",
      origin: "agent",
      campaign_id: "cmpn_test",
      summary: "Raise daily budget",
      rationale: "Increase this verified campaign",
      expected_updated_at: 1,
      expected_current_daily_budget_usd: 25,
      daily_budget_usd: 30,
    },
  });
  expect(result.ok).toBe(true);
  expect(m.reserve).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      platform: "chatgpt",
      op: "raise",
      daily_delta_usd: 5,
    }),
  );
});

it.each([false, true])(
  "resume refusal releases only before a provider write (sent=%s)",
  async (sent) => {
    const tree = {
      campaign: {
        id: "cmpn_test",
        status: "paused",
        updated_at: 1,
        budget: { daily_spend_limit_micros: 25e6 },
      },
      groups: [{ id: "g", status: "paused" }],
      ads: [{ id: "a", status: "paused" }],
    };
    m.tree.mockResolvedValue(tree);
    m.launch.mockImplementation(async () => {
      if (sent) noteChatgptWriteAttempt();
      return { ok: false, message: "Wallet shortfall or uncertain write" };
    });
    const result = await executeChatgptGrowthAction({
      ...decision(),
      decision_class: CHATGPT_STATUS,
      body: {
        campaign_id: "cmpn_test",
        name: "Resume",
        origin: "agent",
        status: "ACTIVE",
        summary: "Resume campaign",
        rationale: "Resume the approved campaign",
        expected_updated_at: 1,
        snapshot: launchSnapshot(tree),
      },
    });
    expect(result.code).toBe(
      sent ? "exec_partial" : "chatgpt_ads_preflight_refused",
    );
    expect(m.drop).toHaveBeenCalledTimes(sent ? 0 : 1);
  },
);

it("creates through the selected customer binding without shared-key or wallet coverage", async () => {
  m.source = "provider";
  m.wallet.mockRejectedValue(new Error("No wallet"));
  const result = await executeChatgptGrowthAction(decision());
  expect(result).toMatchObject({
    ok: true,
    created: { id: "11111111-1111-4111-8111-999999999999" },
  });
  expect(m.wallet).not.toHaveBeenCalled();
  expect(m.serving).toHaveBeenCalledWith("own-key", "provider");
  expect(m.reserve).toHaveBeenCalled();
});

it("translates a customer ledger UUID for stop execution and keeps the hold identity internal", async () => {
  m.source = "provider";
  const tree = {
    campaign: {
      id: "cmpn_test",
      status: "active",
      updated_at: 1,
      budget: { daily_spend_limit_micros: 25e6 },
    },
    groups: [],
    ads: [],
  };
  m.tree.mockResolvedValue(tree);
  const internal = "11111111-1111-4111-8111-999999999999";
  const result = await executeChatgptGrowthAction({
    ...decision(),
    decision_class: CHATGPT_STATUS,
    body: {
      campaign_id: internal,
      name: "Stop test",
      origin: "agent",
      status: "PAUSED",
      summary: "Stop campaign",
      rationale: "Stop this bounded experiment",
      expected_updated_at: 1,
      snapshot: launchSnapshot(tree),
    },
  });
  expect(result.ok).toBe(true);
  expect(m.tree).toHaveBeenCalledWith("acme", "cmpn_test");
  expect(m.update).toHaveBeenCalledWith(
    "acme",
    "cmpn_test",
    expect.objectContaining({ status: "paused" }),
  );
  const { releaseAdSpendForObject } =
    await import("@/services/decisions/ad-budget");
  expect(releaseAdSpendForObject).toHaveBeenCalledWith(
    "acme",
    "chatgpt",
    internal,
  );
});

it("rechecks a generated artifact before spend reservation and carries the ID into approved execution", async () => {
  const d = decision();
  const { image_url: _url, ...ad } = d.body.bundle.ads[0];
  const artifact = "a51bf6d9-cb5b-4959-97ab-42bb8480319a";
  const result = await executeChatgptGrowthAction({ ...d, body: { ...d.body, bundle: { ...d.body.bundle, ads: [{ ...ad, image_artifact_id: artifact }] } } });
  expect(result.ok).toBe(true);
  expect(m.checkImage).toHaveBeenCalledWith("acme", artifact);
  expect(m.checkImage.mock.invocationCallOrder[0]).toBeLessThan(m.reserve.mock.invocationCallOrder[0]);
  expect(m.checkImage.mock.invocationCallOrder[0]).toBeLessThan(m.create.mock.invocationCallOrder[0]);
  expect(m.ad).toHaveBeenCalledWith("acme", "cmpn_test", expect.objectContaining({ image_artifact_id: artifact }), undefined, expect.any(String), "ag1");
});
it("a deleted generated image stops an approved action before any spend hold or campaign write", async () => {
  const { ExpectedToolError } = await import("@/services/tools/types");
  m.checkImage.mockRejectedValue(new ExpectedToolError("image_not_owned", "Image unavailable"));
  const d = decision();
  const { image_url: _url, ...ad } = d.body.bundle.ads[0];
  const result = await executeChatgptGrowthAction({ ...d, body: { ...d.body, bundle: { ...d.body.bundle, ads: [{ ...ad, image_artifact_id: "a51bf6d9-cb5b-4959-97ab-42bb8480319a" }] } } });
  expect(result.ok).toBe(false);
  expect(m.reserve).not.toHaveBeenCalled();
  expect(m.create).not.toHaveBeenCalled();
  expect(m.group).not.toHaveBeenCalled();
  expect(m.ad).not.toHaveBeenCalled();
  expect(m.launch).not.toHaveBeenCalled();
});

it("a deleted uploaded photo stops approved execution before spend reservation or creation", async () => {
  const { ExpectedToolError } = await import("@/services/tools/types");
  m.checkUpload.mockRejectedValue(new ExpectedToolError("image_unavailable", "Saved image missing"));
  const d = decision();
  const { image_url: _url, ...ad } = d.body.bundle.ads[0];
  const imagePath = "11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333.jpg";
  const result = await executeChatgptGrowthAction({ ...d, tenant_id: imagePath.slice(0, 36), body: { ...d.body, bundle: { ...d.body.bundle, ads: [{ ...ad, image_path: imagePath }] } } });
  expect(result.ok).toBe(false);
  expect(m.checkUpload).toHaveBeenCalledWith(imagePath.slice(0, 36), imagePath);
  expect(m.reserve).not.toHaveBeenCalled();
  expect(m.create).not.toHaveBeenCalled();
  expect(m.group).not.toHaveBeenCalled();
  expect(m.ad).not.toHaveBeenCalled();
  expect(m.launch).not.toHaveBeenCalled();
});

describe("a founder's lifetime ask ChatGPT refused as too small", () => {
  const lifetimeDecision = (total: number) => {
    const d = decision();
    const start = Math.floor(Date.now() / 1000) + 600;
    const c = d.body.bundle.campaign as Record<string, unknown>;
    delete c.daily_budget_micros;
    Object.assign(c, { lifetime_budget_micros: total * 1e6, start_time: start, end_time: start + 3 * 86400 });
    d.body.bundle.group = { name: "Intent group", context_hints: ["Find a car"], strategy: "fixed_bid", max_bid_micros: 2_000_000 } as never;
    return { ...d, approved_by_source: null, approved_by: "owner-1" };
  };
  const envelope = (total: number) => {
    const today = new Date().toISOString().slice(0, 10);
    const end = new Date(Date.now() + 4 * 86400_000).toISOString().slice(0, 10);
    return { v: 1, envelope_id: "ask:r1", tenant_id: "acme", actor_user_id: "owner-1", actor_role: "owner", surface: "chat", channel: "chatgpt_ads", max_total_usd: total, max_daily_usd: null, starts_on: today, ends_on: end };
  };
  const refuse = async () => {
    const { ExpectedToolError } = await import("@/services/tools/types");
    noteChatgptWriteAttempt();
    throw new ExpectedToolError("chatgpt_ads_lifetime_too_small", "ChatGPT refused this lifetime total as too small. Nothing was created.");
  };
  it.each(["channel_actions", "decisions"])("refuses a one-cent wallet-only shortfall on %s without payment or provider writes, including retries", async exec_source => {
    m.flag = true;
    m.row = { id: "x", approval_envelope: envelope(100) };
    m.wallet.mockResolvedValue({ status: "read", available_cents: 7999 });
    const d = lifetimeDecision(80);
    const walletOnly = { ...d, exec_source, body: { ...d.body, top_up_authorized: false } };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await executeChatgptGrowthAction(walletOnly as never);
      expect(result).toMatchObject({ ok: false, code: "chatgpt_ads_preflight_refused" });
      expect(result.error).toContain("wallet-only");
    }
    expect(m.fund).not.toHaveBeenCalled();
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
    expect(m.launch).not.toHaveBeenCalled();
  });
  it("still launches a fully covered wallet-only campaign without funding a top-up", async () => {
    m.flag = true;
    m.wallet.mockResolvedValue({ status: "read", available_cents: 8000 });
    const d = lifetimeDecision(80);
    const result = await executeChatgptGrowthAction({ ...d, body: { ...d.body, top_up_authorized: false } } as never);
    expect(result.ok).toBe(true);
    expect(m.create).toHaveBeenCalledOnce();
    expect(m.launch).toHaveBeenCalledOnce();
    expect(m.fund).not.toHaveBeenCalled();
  });
  it("preserves the existing envelope funding path for an unmarked campaign", async () => {
    m.flag = true;
    m.row = { id: "x", approval_envelope: envelope(100) };
    m.wallet.mockResolvedValue({ status: "read", available_cents: 7999 });
    m.fund.mockResolvedValue({ line: "Waiting for the authorized payment" });
    const result = await executeChatgptGrowthAction(lifetimeDecision(80) as never);
    expect(result.ok).toBe(false);
    expect(m.fund).toHaveBeenCalledWith("acme", expect.objectContaining({ shortfall_cents: 1, action_id: id }));
    expect(m.create).not.toHaveBeenCalled();
  });
  it("$30 refused -> runs $25 as one total for 1 day, never more, and says so", async () => {
    m.flag = true;
    m.row = { id: "x", approval_envelope: envelope(30) };
    m.create.mockImplementationOnce(refuse).mockImplementationOnce(async () => (noteChatgptWriteAttempt(), { id: "cmpn_small" }));
    m.tree.mockResolvedValue({ campaign: { id: "cmpn_small", status: "active", updated_at: 1 }, groups: [{ id: "ag1", status: "active" }], ads: [{ id: "ad1", status: "active" }] });
    const r = await executeChatgptGrowthAction(lifetimeDecision(30) as never);
    expect(r).toMatchObject({ ok: true, notice: expect.stringContaining("ChatGPT refused $30.00 as one total, so I ran $25.00 as one total for 1 day instead. It can never spend more.") });
    expect((r as { notice: string }).notice).toContain("It can spend at most $25.00 in total");
    const second = m.create.mock.calls[1][1] as { lifetime_budget_micros: number; start_time: number; end_time: number };
    expect(second.lifetime_budget_micros).toBe(25_000_000);
    expect(second.end_time - second.start_time).toBeLessThanOrEqual(86_400);
  });
  it("no founder envelope (or the switch off): the refusal stands and the hold is given back", async () => {
    m.flag = true;
    m.create.mockImplementationOnce(refuse);
    const r = await executeChatgptGrowthAction(lifetimeDecision(30) as never);
    expect(r).toMatchObject({ ok: false, code: "chatgpt_ads_lifetime_too_small" });
    expect(m.create).toHaveBeenCalledTimes(1);
    expect(m.drop).toHaveBeenCalled();
  });
  it("$20 refused: no smaller total fits the $25 minimum, nothing runs", async () => {
    m.flag = true;
    m.row = { id: "x", approval_envelope: envelope(20) };
    m.create.mockImplementationOnce(refuse);
    const r = await executeChatgptGrowthAction(lifetimeDecision(20) as never);
    expect(r).toMatchObject({ ok: false, code: "chatgpt_ads_lifetime_too_small" });
    expect(m.create).toHaveBeenCalledTimes(1);
  });
});

describe("lifetimeTooSmall", () => {
  it("reads OpenAI's refusal and its stated minimum", async () => {
    const { lifetimeTooSmall } = await import("../http");
    expect(lifetimeTooSmall(400, '{"error":{"message":"lifetime budget must be at least 50000000 micros"}}')?.meta).toEqual({ min_usd: 50 });
    expect(lifetimeTooSmall(400, '{"error":{"message":"Lifetime budget is too low"}}')?.code).toBe("chatgpt_ads_lifetime_too_small");
    expect(lifetimeTooSmall(400, '{"error":{"message":"bad targeting"}}')).toBeNull();
    expect(lifetimeTooSmall(500, "lifetime minimum")).toBeNull();
  });
});

describe("a late approval's daily-limit share counts from now (re-review F2)", () => {
  it("$100 over a 4-day flight approved 2 days late counts $100/day (2x over the 2 days left), so a $60 limit refuses it", async () => {
    const d = decision();
    const now = Math.floor(Date.now() / 1000);
    const c = d.body.bundle.campaign as Record<string, unknown>;
    delete c.daily_budget_micros;
    Object.assign(c, { lifetime_budget_micros: 100e6, start_time: now - 2 * 86400, end_time: now + 2 * 86400 });
    d.body.bundle.group = { name: "Intent group", context_hints: ["Find a car"], strategy: "fixed_bid", max_bid_micros: 2_000_000 } as never;
    m.flag = true;
    await executeChatgptGrowthAction(d as never);
    const ask = m.reserve.mock.calls[0]![1] as { daily_delta_usd: number; lifetime_usd: number };
    expect(ask).toMatchObject({ daily_delta_usd: 100, lifetime_usd: 100 });
    expect(ask.daily_delta_usd).toBeGreaterThan(60);
  });
});

describe("a cgo test's ChatGPT campaign carries the test's end", () => {
  const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const endUnix = (day: string) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
  const testRow = () => ({ ...decision(), agent_run_id: "run-1" });
  beforeEach(() => {
    testEndMock.end = { decision_id: "order-1", channel: "chatgpt_ads", ends_on: tomorrow() };
    m.create.mockImplementation(async (_t: string, c: { end_time: number }) => {
      noteChatgptWriteAttempt();
      return { id: "cmpn_test", end_time: c.end_time };
    });
  });

  it("the campaign is created ending at the test's end (sooner than the card's) and launches", async () => {
    const r = await executeChatgptGrowthAction(testRow());
    expect(r).toMatchObject({ ok: true });
    expect(m.create.mock.calls[0][1]).toMatchObject({ end_time: endUnix(tomorrow()) });
    expect(m.launch).toHaveBeenCalled();
  });

  it("ChatGPT does not keep the end: it is never launched", async () => {
    m.create.mockImplementation(async (_t: string, c: { end_time: number }) => {
      noteChatgptWriteAttempt();
      return { id: "cmpn_test", end_time: c.end_time + 7 * 86_400 };
    });
    const r = await executeChatgptGrowthAction(testRow());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/not by the test's end/);
    expect(m.launch).not.toHaveBeenCalled();
  });

  it("the test's end cannot be read: nothing is created", async () => {
    testEndMock.fail = true;
    const r = await executeChatgptGrowthAction(testRow());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/could not read this test's end date/);
    expect(m.create).not.toHaveBeenCalled();
  });
});
