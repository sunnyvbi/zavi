vi.mock("@/services/ads-wallet/chatgpt-account-preview", () => ({
  previewChatgptAccount: async () => ({
    key: "key",
    fundingSource: "wallet",
    account: { currency_code: "USD" },
  }),
}));
import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  consent: vi.fn(),
  budget: vi.fn(),
  advice: vi.fn(),
  owner: vi.fn(),
  founder: vi.fn(),
  raised: vi.fn(),
  tree: vi.fn(),
  wallet: vi.fn(),
  launchSummary: vi.fn(),
  tier: vi.fn(),
  locked: vi.fn(),
  budgetTest: vi.fn(),
}));
vi.mock("../budget-tests", () => ({ loadBudgetTestFact: m.budgetTest }));
vi.mock("../unattended-policy", () => ({
  readChannelAutorun: m.consent,
  loadOpenAdviceForAd: m.advice,
  loadPausedByFounder: m.owner,
  loadFounderSetBudget: m.founder,
  loadZaviRaisedRecently: m.raised,
}));
vi.mock("../cgo-ads", () => ({ cgoAdBudget: m.budget }));
vi.mock("@/services/connectors/chatgpt-ads/workspace", async (original) => ({
  ...(await original<
    typeof import("@/services/connectors/chatgpt-ads/workspace")
  >()),
  readCampaignTree: m.tree,
  ownedCampaign: async () => ({
    key: "own-key",
    binding: { funding_source: "provider" },
  }),
}));
vi.mock("@/services/connectors/chatgpt-ads/serving", () => ({
  assertServingReady: vi.fn(),
}));
vi.mock("@/services/connectors/chatgpt-ads/key-provider", () => ({
  getChatgptAdsApiKey: async () => "key",
}));
vi.mock("@/services/channels/chatgpt-ads/funding-context", () => ({
  readChatgptFundingContext: m.wallet,
}));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: m.tier }));
vi.mock("@/services/channels/lock", () => ({
  isChannelLockedStrict: m.locked,
}));
vi.mock("@/services/connectors/chatgpt-ads/launch", async (original) => ({
  ...(await original<
    typeof import("@/services/connectors/chatgpt-ads/launch")
  >()),
  readLaunchSummary: m.launchSummary,
}));
import {
  loadChatgptUnattended,
  evaluateChatgptUnattended,
} from "../chatgpt-unattended";
import { launchSnapshot } from "@/services/connectors/chatgpt-ads/launch";
const now = new Date("2026-10-08T12:00:00Z");
const tree = {
  campaign: {
    id: "cmpn_test",
    name: "test",
    status: "active",
    created_at: 100,
    updated_at: 101,
    end_time: now.getTime() / 1000 + 86400,
    budget: { daily_spend_limit_micros: 25e6 },
  },
  groups: [{ id: "ag", status: "active" }],
  ads: [{ id: "ad", status: "active" }],
};
const budget = () => ({
  kind: "ad" as const,
  exec_class: "chatgpt_ads.update_campaign_budget",
  source: { table: "channel_actions" as const, id: "action", run_id: "run" },
  payload: {
    campaign_id: "cmpn_test",
    name: "Test",
    origin: "agent",
    expected_updated_at: 101,
    expected_current_daily_budget_usd: 25,
    daily_budget_usd: 30,
    summary: "Test a budget raise",
    rationale: "The bounded experiment needs more observations",
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  m.consent.mockResolvedValue(true);
  m.budget.mockResolvedValue({ id: "b" });
  m.advice.mockResolvedValue({ refsResolved: true, openAdvice: "clear" });
  m.owner.mockResolvedValue({ pausedByFounder: false, firstOwnEnable: false });
  m.founder.mockResolvedValue(false);
  m.raised.mockResolvedValue(false);
  m.tree.mockResolvedValue(tree);
  m.launchSummary.mockImplementation(async () => ({
    snapshot: launchSnapshot(await m.tree()),
    wallet: { funding_enabled: true },
    shortfall_cents: 0,
  }));
  m.wallet.mockResolvedValue({ status: "read", available_cents: 100000 });
  m.tier.mockResolvedValue({ allowed: true });
  m.locked.mockResolvedValue(false);
  m.budgetTest.mockResolvedValue({ running: null, baselineMissing: false });
});
it("allows only a freshly verified bounded raise under delegation", async () => {
  expect(
    evaluateChatgptUnattended(await loadChatgptUnattended("t", budget(), now))
      .verdict,
  ).toBe("allow");
});
it.each(["consent", "budget", "advice", "founder", "raised", "tier", "locked", "test"])(
  "refuses a failed %s condition",
  async (gate) => {
    if (gate === "consent") m.consent.mockResolvedValue(false);
    if (gate === "budget") m.budget.mockResolvedValue(null);
    if (gate === "advice")
      m.advice.mockResolvedValue({
        refsResolved: true,
        openAdvice: "conflict",
      });
    if (gate === "founder") m.founder.mockResolvedValue(true);
    if (gate === "raised") m.raised.mockResolvedValue(true);
    if (gate === "tier") m.tier.mockResolvedValue({ allowed: false });
    if (gate === "locked") m.locked.mockResolvedValue(true);
    if (gate === "test") m.budgetTest.mockResolvedValue({ running: { decision_id: "d", ends_on: "2026-10-12" }, baselineMissing: false });
    expect(
      evaluateChatgptUnattended(await loadChatgptUnattended("t", budget(), now))
        .verdict,
    ).toBe("ask_founder");
  },
);
it.each([20, 51])(
  "does not automatically cut or more than double a daily budget (%s)",
  async (amount) => {
    const a = budget();
    a.payload.daily_budget_usd = amount === 20 ? 25 : amount;
    a.payload.expected_current_daily_budget_usd = amount === 20 ? 30 : 25;
    expect(
      evaluateChatgptUnattended(await loadChatgptUnattended("t", a, now))
        .verdict,
    ).toBe("ask_founder");
  },
);
it("refuses stale campaign versions", async () => {
  m.tree.mockResolvedValue({
    ...tree,
    campaign: { ...tree.campaign, updated_at: 102 },
  });
  expect((await loadChatgptUnattended("t", budget(), now)).reasons).toContain(
    "campaign_changed",
  );
});
it("founder commands are never self-approved", async () => {
  const a = budget();
  a.payload.origin = "user_initiated_chat";
  expect((await loadChatgptUnattended("t", a, now)).reasons).toContain(
    "founder_requested_change",
  );
});
it("a founder pause cannot be undone by paid delegation", async () => {
  const paused = { ...tree, campaign: { ...tree.campaign, status: "paused" } };
  m.tree.mockResolvedValue(paused);
  m.owner.mockResolvedValue({ pausedByFounder: true, firstOwnEnable: false });
  const a = {
    ...budget(),
    exec_class: "chatgpt_ads.set_status",
    payload: {
      campaign_id: "cmpn_test",
      name: "Test",
      origin: "agent",
      expected_updated_at: 101,
      status: "ACTIVE",
      snapshot: launchSnapshot(paused),
      summary: "Resume this campaign",
      rationale: "Resume the previous experiment",
    },
  };
  expect((await loadChatgptUnattended("t", a, now)).reasons).toContain(
    "founder_pause_or_unknown",
  );
});
const resume = (t: typeof tree) => ({
  ...budget(),
  exec_class: "chatgpt_ads.set_status",
  payload: {
    campaign_id: "cmpn_test",
    name: "Test",
    origin: "agent",
    expected_updated_at: 101,
    status: "ACTIVE",
    snapshot: launchSnapshot(t),
    summary: "Resume this campaign",
    rationale: "Resume the previous experiment",
  },
});
it("an off ad under an active campaign is never switched on unattended", async () => {
  const t = { ...tree, ads: [{ id: "ad", status: "paused" }] };
  m.tree.mockResolvedValue(t);
  expect((await loadChatgptUnattended("t", resume(t), now)).reasons).toContain(
    "founder_pause_or_unknown",
  );
});
it("resuming a Zavi-paused campaign asks when a child is off, not when all children are on", async () => {
  const off = {
    ...tree,
    campaign: { ...tree.campaign, status: "paused" },
    groups: [{ id: "ag", status: "paused" }],
  };
  m.tree.mockResolvedValue(off);
  expect(
    (await loadChatgptUnattended("t", resume(off), now)).reasons,
  ).toContain("founder_pause_or_unknown");
  const on = { ...tree, campaign: { ...tree.campaign, status: "paused" } };
  m.tree.mockResolvedValue(on);
  expect(
    (await loadChatgptUnattended("t", resume(on), now)).reasons,
  ).not.toContain("founder_pause_or_unknown");
});
it("Zavi's own untouched paused create may switch its whole tree on", async () => {
  const t = {
    ...tree,
    campaign: { ...tree.campaign, status: "paused", updated_at: 120 },
    groups: [{ id: "ag", status: "paused", created_at: 100, updated_at: 100 }],
    ads: [{ id: "ad", status: "paused", created_at: 100, updated_at: 110 }],
  };
  m.tree.mockResolvedValue(t);
  m.owner.mockResolvedValue({ pausedByFounder: false, firstOwnEnable: true });
  const a = resume(t);
  a.payload.expected_updated_at = 120;
  expect((await loadChatgptUnattended("t", a, now)).reasons).not.toContain(
    "founder_pause_or_unknown",
  );
});
it("a child edited after Zavi's paused create is not switched on unattended", async () => {
  const t = {
    ...tree,
    campaign: { ...tree.campaign, status: "paused", updated_at: 120 },
    groups: [{ id: "ag", status: "paused", created_at: 100, updated_at: 5000 }],
    ads: [{ id: "ad", status: "paused", created_at: 100, updated_at: 100 }],
  };
  m.tree.mockResolvedValue(t);
  m.owner.mockResolvedValue({ pausedByFounder: false, firstOwnEnable: true });
  const a = resume(t);
  a.payload.expected_updated_at = 120;
  expect((await loadChatgptUnattended("t", a, now)).reasons).toContain(
    "founder_pause_or_unknown",
  );
});

it("unattended resumes ask for funding before reserving a shared budget", async () => {
  m.launchSummary.mockResolvedValue({
    snapshot: launchSnapshot(tree),
    wallet: { funding_enabled: true },
    shortfall_cents: 1,
  });
  const a = {
    ...budget(),
    exec_class: "chatgpt_ads.set_status",
    payload: {
      campaign_id: "cmpn_test",
      name: "Test",
      origin: "agent",
      expected_updated_at: 101,
      snapshot: launchSnapshot(tree),
      status: "ACTIVE",
      summary: "Resume campaign",
      rationale: "Resume the approved campaign",
    },
  };
  expect((await loadChatgptUnattended("t", a, now)).reasons).toContain(
    "chatgpt_wallet_insufficient",
  );
});
