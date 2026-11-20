import { beforeEach, describe, expect, it, vi } from "vitest";

const T = "44444444-4444-4444-4444-444444444444";
const m = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  lists: {} as Record<string, unknown[]>,
  failing: null as string | null,
  runRead: { data: { trigger: "scheduled" } as unknown, error: null as unknown },
  budget: vi.fn(),
  autopilot: vi.fn(),
  approve: vi.fn(),
  send: vi.fn(),
  advice: vi.fn(),
  autorun: vi.fn(),
  binding: vi.fn(),
  inUse: vi.fn(),
  writeOn: vi.fn(),
  tier: vi.fn(),
  locked: vi.fn(),
  live: vi.fn(),
  ask: vi.fn(),
  hold: vi.fn(),
  control: vi.fn(),
  consent: vi.fn(),
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const k of ["select", "eq", "neq", "in", "or", "not", "is", "order", "limit", "gte", "lte"]) q[k] = () => q;
      q.maybeSingle = async () => (table === "channel_actions" ? { data: m.row, error: null } : table === "agent_runs" ? m.runRead : { data: null, error: null });
      q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(m.failing === table ? { data: null, error: { message: `${table} down` } } : { data: m.lists[table] ?? [], error: null }).then(res, rej);
      return q;
    },
  }),
}));
vi.mock("@/services/decisions/ad-budget", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/services/decisions/ad-budget")>()), readActiveAdBudget: m.budget }));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: m.autopilot }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("../cgo-test-end", async (importOriginal) => ({ ...(await importOriginal<typeof import("../cgo-test-end")>()), cgoTestEndForRun: async () => null }));
vi.mock("../test-stops", async (importOriginal) => ({ ...(await importOriginal<typeof import("../test-stops")>()), testStopGateReason: async () => null }));
vi.mock("../business-control-runtime", () => ({ checkBusinessControl: m.control }));
vi.mock("../cgo-auto-run", () => ({ tenantOwnerId: async () => "owner-1", approveDecisionAsCgo: vi.fn() }));
vi.mock("../open-advice", async (importOriginal) => ({ ...(await importOriginal<typeof import("../open-advice")>()), findContradictingOpenAdvice: m.advice, adObjectFor: async () => null }));
vi.mock("../channel-autorun", async (importOriginal) => ({ ...(await importOriginal<typeof import("../channel-autorun")>()), readEffectiveAutorun: m.autorun }));
vi.mock("@/services/channels/exec-actions", () => ({ approveChannelAction: m.approve }));
vi.mock("@/../workers/client", () => ({ inngest: { send: m.send } }));
vi.mock("@/services/ads-wallet/bindings", () => ({ findCampaignBinding: m.binding }));
vi.mock("@/services/connectors/linkedin-ads/own-accounts", () => ({ linkedinAccountInUse: m.inUse }));
vi.mock("@/services/ads-wallet/consent", () => ({ sharedWalletConsent: m.consent }));
vi.mock("@/services/tools/linkedin-ads/write/_flag-check", () => ({ isLinkedInAdsWriteEnabled: m.writeOn }));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: m.tier }));
vi.mock("@/services/channels/lock", () => ({ isChannelLockedStrict: m.locked }));
vi.mock("@/services/connectors/linkedin-ads/write", () => ({ readLinkedInRawCampaign: m.live }));
vi.mock("../unattended-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../unattended-policy")>()),
  askFounderAboutHeld: m.ask,
  recordCardHold: m.hold,
}));

import { cgoApproveChannelAction } from "../cgo-ads";

const PAUSED_AT = "2026-11-05T10:00:00.000Z";
const resume = { campaign_id: "22", account_id: "11", name: "Spring", origin: "agent", rationale: "r", expected_status: "PAUSED", run_start_at: null, run_end_at: null, budget: { kind: "daily", amount: "40", currency: "USD" } };
const raise = { campaign_id: "22", account_id: "11", name: "Spring", kind: "daily", expected_current: { amount: "40.00", currency: "USD" }, proposed: { amount: "60.00", currency: "USD" }, origin: "agent", rationale: "r" };
const create = { account_id: "11", group_id: "33", group_name: "G", expected_group_status: "ACTIVE", name: "New", daily_budget: { amount: "20.00", currency: "USD" }, unit_cost: { amount: "5.00", currency: "USD" }, geo_urns: ["urn:li:geo:103644278"], country: "US", language: "en", associated_entity: "urn:li:organization:1", objective_type: null, post_urn: null, places: ["United States"], origin: "agent", rationale: "r" };
const pauseBy = (approved_by_source: string | null, approved_by: string | null = null) => ({ id: "p1", exec_payload: { campaign_id: "22", account_id: "11", status: "PAUSED" }, executed_at: PAUSED_AT, approved_by_source, approved_by });
const card = (exec_class: string, exec_payload: unknown) => {
  m.row = { channel_slug: "linkedin_ads", run_id: "run-1", title: "t", exec_class, exec_payload, exec_status: null, status: "pending", approved_by_source: null, edited_body: null, body: {} };
};
const clean = () => {
  m.lists = { channel_actions: [pauseBy("cgo")] };
  m.failing = null;
  m.runRead = { data: { trigger: "scheduled" }, error: null };
  m.advice.mockResolvedValue({ status: "clear" });
  m.autorun.mockResolvedValue(true);
  m.binding.mockResolvedValue({ id: "bind-1", funding_source: "provider" });
  m.inUse.mockResolvedValue(true);
  m.consent.mockResolvedValue(true);
  m.tier.mockResolvedValue({ enforced: true, allowed: true });
  m.live.mockResolvedValue({ changeAuditStamps: { created: { time: Date.parse("2026-10-01T00:00:00Z") }, lastModified: { time: Date.parse(PAUSED_AT) + 5_000 } } });
};

beforeEach(() => {
  for (const f of Object.values(m)) if (typeof f === "function") (f as ReturnType<typeof vi.fn>).mockReset();
  m.budget.mockResolvedValue({ id: "budget-1" });
  m.autopilot.mockResolvedValue(true);
  m.approve.mockResolvedValue({ ok: true, attempt: 1, alreadyQueued: false, replayed: false });
  m.send.mockResolvedValue(undefined);
  m.writeOn.mockResolvedValue(true);
  m.locked.mockResolvedValue(false);
  m.ask.mockResolvedValue(true);
  m.hold.mockResolvedValue(true);
  m.control.mockResolvedValue({});
  clean();
});

const approvedAndSent = () => {
  expect(m.approve).toHaveBeenCalledTimes(1);
  expect(m.approve).toHaveBeenCalledWith(T, expect.objectContaining({ actionId: "ca-1", source: "cgo", eventKey: "cgo:ca-1" }));
  expect(m.send).toHaveBeenCalledTimes(1);
  expect(m.send).toHaveBeenCalledWith({ id: "approve:ca-1:1", name: "channel-action.approved", data: { action_id: "ca-1" } });
};
const leftForFounder = () => {
  expect(m.approve).not.toHaveBeenCalled();
  expect(m.send).not.toHaveBeenCalled();
};

describe("the cgo door approves a LinkedIn card on Autopilot with an ad budget, through the real gate", () => {
  it("a resume of a campaign cgo paused, untouched in LinkedIn since: approved and the approve event sent", async () => {
    card("linkedin_ads.resume_campaign", resume);
    expect(await cgoApproveChannelAction(T, "ca-1")).toBe(true);
    approvedAndSent();
    expect(m.live).toHaveBeenCalledWith(T, "11", "22");
  });

  it("a resume of a campaign the founder paused in Zavi is held for the founder, with the reason", async () => {
    m.lists = { channel_actions: [pauseBy(null, "owner-1")] };
    card("linkedin_ads.resume_campaign", resume);
    expect(await cgoApproveChannelAction(T, "ca-1")).toBe(false);
    leftForFounder();
    expect(m.ask).toHaveBeenCalledWith(T, expect.anything(), expect.objectContaining({ reasons: expect.arrayContaining(["founder_paused_it"]) }));
  });

  it("a resume of a campaign the founder paused in LinkedIn (seen on the bound ledger id) is held", async () => {
    m.lists = { channel_actions: [pauseBy("cgo")], ad_object_changes: [{ after_status: "PAUSED", occurred_at: "2026-11-05T12:00:00.000Z" }] };
    card("linkedin_ads.resume_campaign", resume);
    expect(await cgoApproveChannelAction(T, "ca-1")).toBe(false);
    leftForFounder();
  });

  it("a daily raise within the step: approved, with the founder-set read covering the bound ledger id", async () => {
    card("linkedin_ads.update_campaign_budget", raise);
    expect(await cgoApproveChannelAction(T, "ca-1")).toBe(true);
    approvedAndSent();
  });

  it("a raise right after the founder changed the budget in LinkedIn is held", async () => {
    m.lists = { channel_actions: [], ad_object_changes: [{ id: "o1", occurred_at: "2026-11-05T12:00:00.000Z" }] };
    card("linkedin_ads.update_campaign_budget", raise);
    expect(await cgoApproveChannelAction(T, "ca-1")).toBe(false);
    leftForFounder();
  });

  it("a second raise within a day is held", async () => {
    m.lists = { channel_actions: [{ id: "earlier", exec_payload: raise, edited_body: null, exec_status: "executed", exec_result: null }] };
    card("linkedin_ads.update_campaign_budget", raise);
    expect(await cgoApproveChannelAction(T, "ca-1")).toBe(false);
    leftForFounder();
  });

  it("a new paused campaign: approved", async () => {
    card("linkedin_ads.create_campaign", create);
    expect(await cgoApproveChannelAction(T, "ca-1")).toBe(true);
    approvedAndSent();
  });
});

describe("the door leaves the card for the founder: no approval, no event", () => {
  it("(a) Autopilot off", async () => {
    card("linkedin_ads.update_campaign_budget", raise);
    m.autopilot.mockResolvedValue(false);
    expect(await cgoApproveChannelAction(T, "ca-1")).toBe(false);
    leftForFounder();
  });

  it("F1: Autopilot and an ad budget are on but the founder never gave paid permission, so a restart, a raise and a new campaign are all held with the reason", async () => {
    for (const [cls, body] of [["linkedin_ads.resume_campaign", resume], ["linkedin_ads.update_campaign_budget", raise], ["linkedin_ads.create_campaign", create]] as const) {
      m.approve.mockClear();
      m.send.mockClear();
      m.ask.mockClear();
      clean();
      m.consent.mockResolvedValue(false);
      card(cls, body);
      expect([cls, await cgoApproveChannelAction(T, "ca-1")]).toEqual([cls, false]);
      expect([cls, m.approve.mock.calls.length, m.send.mock.calls.length]).toEqual([cls, 0, 0]);
      expect(JSON.stringify(m.ask.mock.calls)).toContain("linkedin_paid_consent_required");
    }
  });

  it("F2: a bid raise on a campaign is held for the founder because the executor cannot hold it against the budget", async () => {
    card("linkedin_ads.update_campaign", { campaign_id: "22", account_id: "11", name: "Spring", rationale: "r", last_modified_at: null, changes: { unit_cost: { before: { amount: "5.00", currency: "USD" }, after: { amount: "6.00", currency: "USD" } } }, origin: "agent" });
    expect(await cgoApproveChannelAction(T, "ca-1")).toBe(false);
    leftForFounder();
    expect(JSON.stringify(m.ask.mock.calls)).toContain("linkedin_change_not_held");
  });

  it("(b) no ad budget", async () => {
    card("linkedin_ads.update_campaign_budget", raise);
    m.budget.mockResolvedValue(null);
    expect(await cgoApproveChannelAction(T, "ca-1")).toBe(false);
    leftForFounder();
  });

  it("(c) a card the founder edited", async () => {
    card("linkedin_ads.update_campaign_budget", raise);
    m.row.edited_body = { proposed: { amount: "70.00", currency: "USD" } };
    expect(await cgoApproveChannelAction(T, "ca-1")).toBe(false);
    leftForFounder();
  });

  it("(c) a change the founder ordered in chat, and one with no origin at all", async () => {
    card("linkedin_ads.update_campaign_budget", { ...raise, origin: "user_initiated_chat" });
    expect(await cgoApproveChannelAction(T, "ca-1")).toBe(false);
    const { origin: _drop, ...noOrigin } = raise;
    card("linkedin_ads.update_campaign_budget", noOrigin);
    expect(await cgoApproveChannelAction(T, "ca-1")).toBe(false);
    leftForFounder();
    expect(m.ask).not.toHaveBeenCalled();
  });

  it("(d) a raise over the step asks the founder with the reason", async () => {
    card("linkedin_ads.update_campaign_budget", { ...raise, proposed: { amount: "90.00", currency: "USD" } });
    expect(await cgoApproveChannelAction(T, "ca-1")).toBe(false);
    leftForFounder();
    expect(m.ask).toHaveBeenCalledWith(T, expect.objectContaining({ exec_class: "linkedin_ads.update_campaign_budget" }), expect.objectContaining({ verdict: "ask_founder", reasons: expect.arrayContaining(["raise_over_cgo_step"]) }));
  });

  it("(e) each fact read that throws leaves it for the founder", async () => {
    const breakers: Array<[string, () => void]> = [
      ["binding", () => m.binding.mockRejectedValue(new Error("binding down"))],
      ["accounts", () => m.inUse.mockRejectedValue(new Error("accounts down"))],
      ["consent", () => m.consent.mockRejectedValue(new Error("consent down"))],
      ["tier", () => m.tier.mockRejectedValue(new Error("tier down"))],
      ["autorun", () => m.autorun.mockRejectedValue(new Error("settings down"))],
      ["advice", () => m.advice.mockRejectedValue(new Error("advice down"))],
      ["run", () => (m.runRead = { data: null, error: { message: "runs down" } })],
      ["history", () => (m.failing = "decisions")],
      ["linkedin", () => m.live.mockRejectedValue(new Error("linkedin down"))],
      ["stamp", () => m.live.mockResolvedValue({ changeAuditStamps: {} })],
    ];
    for (const [name, breakIt] of breakers) {
      m.approve.mockClear();
      m.send.mockClear();
      clean();
      breakIt();
      card("linkedin_ads.resume_campaign", resume);
      expect([name, await cgoApproveChannelAction(T, "ca-1")]).toEqual([name, false]);
      expect([name, m.approve.mock.calls.length, m.send.mock.calls.length]).toEqual([name, 0, 0]);
    }
  });

  it("(e) a resume whose campaign LinkedIn shows edited after cgo paused it", async () => {
    m.live.mockResolvedValue({ changeAuditStamps: { lastModified: { time: Date.parse(PAUSED_AT) + 3_600_000 } } });
    card("linkedin_ads.resume_campaign", resume);
    expect(await cgoApproveChannelAction(T, "ca-1")).toBe(false);
    leftForFounder();
  });

  it("(f) open advice on the same campaign", async () => {
    m.advice.mockResolvedValue({ status: "conflict" });
    card("linkedin_ads.update_campaign_budget", raise);
    expect(await cgoApproveChannelAction(T, "ca-1")).toBe(false);
    leftForFounder();
  });

  it("(g) a campaign on Zavi's wallet billing, and an account this workspace does not manage", async () => {
    m.binding.mockResolvedValue({ id: "bind-1", funding_source: "wallet" });
    card("linkedin_ads.resume_campaign", resume);
    expect(await cgoApproveChannelAction(T, "ca-1")).toBe(false);
    m.binding.mockResolvedValue(null);
    m.inUse.mockResolvedValue(false);
    card("linkedin_ads.create_campaign", create);
    expect(await cgoApproveChannelAction(T, "ca-1")).toBe(false);
    leftForFounder();
  });

  it("an owner's saved business controls keep every LinkedIn spend-up with the founder", async () => {
    m.control.mockResolvedValue({ hold: "business_controls_no_linkedin" });
    card("linkedin_ads.update_campaign_budget", raise);
    expect(await cgoApproveChannelAction(T, "ca-1")).toBe(false);
    leftForFounder();
  });
});
