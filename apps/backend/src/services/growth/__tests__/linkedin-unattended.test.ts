import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  consent: vi.fn(),
  budget: vi.fn(),
  autorun: vi.fn(),
  advice: vi.fn(),
  summary: vi.fn(),
  tier: vi.fn(),
  lock: vi.fn(),
  flag: vi.fn(),
  observed: vi.fn(),
  life: vi.fn(),
  lifeQuery: vi.fn(),
}));
vi.mock("../unattended-policy", () => ({
  readChannelAutorun: m.autorun,
  loadOpenAdviceForAd: m.advice,
}));
vi.mock("../cgo-ads", () => ({ cgoAdBudget: m.budget }));
vi.mock("@/services/ads-wallet/consent", () => ({
  sharedWalletConsent: m.consent,
}));
vi.mock("@/services/ads-wallet/linkedin-launch", async (original) => ({
  ...(await original<typeof import("@/services/ads-wallet/linkedin-launch")>()),
  linkedinLaunchSummary: m.summary,
  linkedinLaunchObservedCents: m.observed,
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (id: string) => id,
  tenantClient: () => ({
    from: (table: string) => ({
      select: (cols: string) => ({
        eq: (col: string, val: string) => ({
          maybeSingle: () => {
            m.lifeQuery(table, cols, col, val);
            return m.life();
          },
        }),
      }),
    }),
  }),
}));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: m.tier }));
vi.mock("@/services/channels/lock", () => ({ isChannelLockedStrict: m.lock }));
vi.mock("@/services/tools/linkedin-ads/write/_flag-check", () => ({
  isLinkedInAdsWriteEnabled: m.flag,
}));
import {
  loadLinkedinUnattended,
  evaluateLinkedinUnattended,
} from "../linkedin-unattended";
const now = new Date();
const usd = { currency: "USD", units_per_usd: 1, as_of: null, source: "USD" };
const action = () => ({
  kind: "ad" as const,
  exec_class: "linkedin_ads.launch_campaign",
  source: { id: "request", table: "channel_actions" as const, run_id: "run" },
  payload: {
    campaign_binding_id: "22222222-2222-4222-8222-222222222222",
    name: "Pilot",
    rationale: "Test the verified campaign",
    snapshot: "a".repeat(64),
    total_budget_cents: 600000,
    total_budget_usd: 6000,
    currency: "USD",
    end_time: now.getTime() + 86400000,
    origin: "agent",
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  m.consent.mockResolvedValue(true);
  m.autorun.mockResolvedValue(true);
  m.budget.mockResolvedValue({ id: "budget" });
  m.advice.mockResolvedValue({ refsResolved: true, openAdvice: "clear" });
  m.tier.mockResolvedValue({ allowed: true, enforced: true });
  m.lock.mockResolvedValue(false);
  m.flag.mockResolvedValue(true);
  m.observed.mockResolvedValue(0);
  m.life.mockResolvedValue({
    data: { created_paused: true, activation_attempted_at: null },
    error: null,
  });
  m.summary.mockResolvedValue({
    funding_source: "wallet",
    currency: "USD",
    fx: usd,
    snapshot: "a".repeat(64),
    status: "PAUSED",
    stop_requested_at: null,
  });
});
it("allows the paid, budgeted, freshly reviewed Autopilot launch", async () => {
  expect(
    evaluateLinkedinUnattended(
      await loadLinkedinUnattended("tenant", action(), now),
    ).verdict,
  ).toBe("allow");
});
it.each([
  "consent",
  "autorun",
  "budget",
  "advice",
  "tier",
  "lock",
  "flag",
  "pause",
  "provider",
])("asks the founder when %s blocks delegated spending", async (gate) => {
  if (["consent", "autorun", "flag"].includes(gate))
    m[gate as "consent"].mockResolvedValue(false);
  if (gate === "budget") m.budget.mockResolvedValue(null);
  if (gate === "advice") m.advice.mockResolvedValue({ refsResolved: false });
  if (gate === "tier")
    m.tier.mockResolvedValue({ allowed: false, enforced: true });
  if (gate === "lock") m.lock.mockResolvedValue(true);
  if (gate === "pause")
    m.summary.mockResolvedValue({
      currency: "USD",
      snapshot: "a".repeat(64),
      status: "PAUSED",
      fx: usd,
      stop_requested_at: "yesterday",
    });
  if (gate === "provider") m.summary.mockRejectedValue(new Error("offline"));
  expect(
    evaluateLinkedinUnattended(
      await loadLinkedinUnattended("tenant", action(), now),
    ).verdict,
  ).toBe("ask_founder");
});
it("never self-approves a human launch request", async () => {
  const a = action();
  a.payload.origin = "user_initiated_chat";
  expect((await loadLinkedinUnattended("tenant", a, now)).reasons).toContain(
    "founder_requested_change",
  );
});
const inrLaunch = (units_per_usd: number, total_budget_usd = 6000) => {
  const a = action();
  Object.assign(a.payload, {
    currency: "INR",
    total_budget_cents: 50000000,
    total_budget_usd,
  });
  m.summary.mockResolvedValue({
    currency: "INR",
    fx: {
      currency: "INR",
      units_per_usd,
      as_of: now.toISOString(),
      source: "ExchangeRate-API",
    },
    snapshot: "a".repeat(64),
    status: "PAUSED",
    stop_requested_at: null,
  });
  return a;
};
it("sends an INR launch back to the founder when the rate moved 3% since approval", async () => {
  const facts = await loadLinkedinUnattended("tenant", inrLaunch(80.9), now);
  expect(facts.reasons).toEqual(["campaign_changed"]);
  expect(evaluateLinkedinUnattended(facts).verdict).toBe("ask_founder");
});
it.each([
  ["a 1% rate move", 82.6],
  ["a rate that made it cheaper", 83.4],
])("still allows an INR launch after %s", async (_name, rate) => {
  const facts = await loadLinkedinUnattended("tenant", inrLaunch(rate), now);
  expect(facts.reasons).toEqual([]);
  expect(evaluateLinkedinUnattended(facts).verdict).toBe("allow");
});
it("asks the founder when a USD launch no longer matches the approved dollars", async () => {
  const a = action();
  a.payload.total_budget_usd = 5999.99;
  const facts = await loadLinkedinUnattended("tenant", a, now);
  expect(facts.reasons).toEqual(["campaign_changed"]);
  expect(evaluateLinkedinUnattended(facts).verdict).toBe("ask_founder");
});
it("allows a USD launch whose dollars are unchanged", async () => {
  expect((await loadLinkedinUnattended("tenant", action(), now)).reasons).toEqual([]);
});
it("reads the launch history of the very campaign being launched", async () => {
  await loadLinkedinUnattended("tenant", action(), now);
  expect(m.lifeQuery).toHaveBeenCalledWith(
    "ads_campaign_lifecycle",
    "created_paused,activation_attempted_at",
    "campaign_binding_id",
    "22222222-2222-4222-8222-222222222222",
  );
  expect(m.observed).toHaveBeenCalledWith(
    "tenant",
    "22222222-2222-4222-8222-222222222222",
    "wallet",
  );
});
it("never switches back on a campaign that went live through Zavi and was then paused by hand in Campaign Manager", async () => {
  m.life.mockResolvedValue({
    data: { created_paused: true, activation_attempted_at: "2026-10-20T10:00:00Z" },
    error: null,
  });
  m.observed.mockResolvedValue(0);
  const facts = await loadLinkedinUnattended("tenant", action(), now);
  expect(facts.reasons).toEqual(["founder_pause_or_unknown"]);
  expect(evaluateLinkedinUnattended(facts).verdict).toBe("ask_founder");
});
it("never switches back on a campaign the founder ran and paused in Campaign Manager without Zavi", async () => {
  m.observed.mockResolvedValue(4200);
  const facts = await loadLinkedinUnattended("tenant", action(), now);
  expect(facts.reasons).toEqual(["founder_pause_or_unknown"]);
  expect(evaluateLinkedinUnattended(facts).verdict).toBe("ask_founder");
});
it.each([
  ["its spend cannot be read", () => m.observed.mockResolvedValue(null)],
  ["Zavi did not create it paused", () => m.life.mockResolvedValue({ data: { created_paused: false, activation_attempted_at: null }, error: null })],
])("asks the founder when %s, because a hand pause cannot be ruled out", async (_n, arrange) => {
  arrange();
  expect((await loadLinkedinUnattended("tenant", action(), now)).reasons).toEqual(["founder_pause_or_unknown"]);
});
it.each([
  ["errors", { data: null, error: { message: "boom" } }],
  ["is missing", { data: null, error: null }],
])("asks the founder when the launch history %s", async (_n, row) => {
  m.life.mockResolvedValue(row);
  const facts = await loadLinkedinUnattended("tenant", action(), now);
  expect(facts.reasons).toContain("linkedin_facts_unavailable");
  expect(evaluateLinkedinUnattended(facts).verdict).toBe("ask_founder");
});
