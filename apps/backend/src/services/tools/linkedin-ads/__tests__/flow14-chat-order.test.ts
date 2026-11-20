import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  summary: vi.fn(),
  spent: vi.fn(),
  filing: vi.fn(),
  emit: vi.fn(),
  asked: vi.fn(),
  words: vi.fn(),
  attach: vi.fn(),
  tell: vi.fn(),
  rows: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/services/ads-wallet/linkedin-launch", async (orig) => ({
  ...((await orig()) as object),
  linkedinLaunchSummary: m.summary,
  linkedinLaunchFilingRefusal: m.filing,
  linkedinRelaunchSpentCents: m.spent,
}));
vi.mock("@/services/ads-wallet/fx", () => ({ adsUsd: (n: number) => n }));
vi.mock("@/services/approvals/approval-envelope", () => ({ founderAskFor: m.asked, founderOrderWordsFor: m.words }));
vi.mock("@/services/approvals/chat-card-attach", () => ({ attachCardToChat: m.attach }));
vi.mock("@/services/approvals/chat-card-delivery", () => ({ tellFounderAboutCard: m.tell }));
vi.mock("@/services/tools/linkedin-ads/_exec-action", async (orig) => ({
  ...((await orig()) as object),
  resolveLinkedInAdsEmit: async () => m.emit,
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantRpc: async () => ({ data: null, error: null }),
  tenantClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const k of ["select", "eq", "order", "range", "in"]) q[k] = () => q;
      const rows = m.rows as Array<{ account_binding_id: string; funding_source: string }>;
      const accounts = [...new Set(rows.map((r) => r.account_binding_id))].map((id) => ({ id, tenant_id: "t", platform: "linkedin", provider_account_id: "900", funding_source: rows.find((r) => r.account_binding_id === id)!.funding_source }));
      const data = table === "ads_account_binding_details" ? accounts : table === "ads_account_binding_status" ? [] : m.rows;
      q.then = (ok: (v: unknown) => void) => ok({ data, error: null });
      const chosen = accounts.find((a) => a.funding_source === "provider") ?? accounts[0];
      q.maybeSingle = async () => ({ data: table === "ads_account_selections" && chosen ? { account_binding_id: chosen.id, tenant_id: "t" } : null, error: null });
      return q;
    },
  }),
}));

import { callLinkedinAdsTool } from "@/services/mcp/internal/linkedin-ads";
import { whichCampaignQuestion } from "../propose_launch_campaign";
import { parseDirectAdAsk } from "@/services/growth/direct-ad-ask";

const CHOSEN = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const INPUT = { campaign_binding_id: CHOSEN, total_budget_cents: 99_900, end_time: Date.now() + 300 * 86_400_000, rationale: "The model's own numbers." };
const PLAN = { total_usd: 200, days: 14, budget_type: "lifetime" };
const paused = (over: Record<string, unknown> = {}) => ({ snapshot: "s", name: "LinkedIn campaign - 2026-10-30", currency: "USD", fx: null, status: "PAUSED", launch_blocker: null, daily_budget_cents: 1500, funding_source: "wallet", ...over });
const order = (over: Record<string, unknown> = {}) => ({ text: "spend $200 on LinkedIn for 14 days", plan: PLAN, asked_daily_usd: null, line: "This launch is a card waiting for your approval.", refuse: null, ...over });
const call = (ctx: Record<string, unknown> = {}, input: Record<string, unknown> = INPUT) =>
  callLinkedinAdsTool({ tenant_id: "t", run_id: "r", run_trigger: "handoff", founder_chat_order: true, ...ctx }, "propose_launch_campaign", input);

beforeEach(() => {
  vi.resetAllMocks();
  m.rows = [];
  m.summary.mockResolvedValue(paused());
  m.spent.mockResolvedValue(null);
  m.filing.mockResolvedValue(null);
  m.emit.mockResolvedValue("act-1");
  m.asked.mockResolvedValue(null);
  m.words.mockResolvedValue(order());
  m.attach.mockResolvedValue({ shown: true });
});

describe("Flow 14: the founder's sentence with no ad word", () => {
  it("the exact sentence is no direct ask, so no no-card door opens, but it still reads as an order", () => {
    expect(parseDirectAdAsk("spend $200 on LinkedIn for 14 days")).toBeNull();
    expect(parseDirectAdAsk("spend $200 on LinkedIn for 14 days", { adWordOptional: true })).toMatchObject({ channel_slug: "linkedin_ads", total_usd: 200, days: 14 });
    expect(parseDirectAdAsk("should we spend $200 on LinkedIn for 14 days", { adWordOptional: true })).toBeNull();
  });

  it("the card carries the founder's total and a 14 x 24h end, never the model's $999 and 300 days", async () => {
    const before = Date.now();
    const r = await call();
    expect(r.ok).toBe(true);
    const body = m.emit.mock.calls[0][1];
    expect(body.total_budget_cents).toBe(20_000);
    expect(body.end_time).toBeGreaterThanOrEqual(before + 14 * 86_400_000 - 1000);
    expect(body.end_time).toBeLessThanOrEqual(Date.now() + 14 * 86_400_000 + 1000);
    expect(body.origin).toBe("user_initiated_chat");
    expect(JSON.parse(r.content as string).say_to_founder).toContain("card waiting for your approval. It stops");
  });

  it("a member's order keeps the amounts but stays a card", async () => {
    m.asked.mockResolvedValue({ plan: null, line: "An owner or admin needs to approve this.", source: "ask" });
    const r = await call();
    expect(r.ok).toBe(true);
    expect(m.emit.mock.calls[0][1].total_budget_cents).toBe(20_000);
    expect(JSON.parse(r.content as string).say_to_founder).toContain("An owner or admin");
  });

  it("an ask that cannot run files no card and says why", async () => {
    m.asked.mockResolvedValue({ plan: null, line: "LinkedIn's minimum is $10 for a campaign, so nothing ran.", source: "ask", refuse: true });
    m.words.mockResolvedValue(order({ plan: null }));
    const r = await call();
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("minimum is $10");
    expect(m.emit).not.toHaveBeenCalled();
  });
});

describe("Flow 14: which campaign", () => {
  const twins = () => {
    m.rows = [
      { id: CHOSEN, provider_campaign_id: "906039044", account_binding_id: "a", funding_source: "wallet" },
      { id: OTHER, provider_campaign_id: "905998344", account_binding_id: "b", funding_source: "provider" },
    ];
  };

  it("two paused campaigns with the same name and no choice: asks, files nothing, shows the IDs", async () => {
    twins();
    const r = await call();
    expect(r.ok).toBe(false);
    const text = JSON.stringify(r);
    expect(text).toContain("Which campaign should run this?");
    expect(text).toContain("906039044");
    expect(text).toContain("905998344");
    expect(text).toContain("billed by LinkedIn directly");
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("the founder naming the ID settles it", async () => {
    twins();
    m.words.mockResolvedValue(order({ text: "spend $200 on LinkedIn for 14 days on 906039044" }));
    expect((await call()).ok).toBe(true);
  });

  it("the agent picking a different campaign than the one the founder named is refused", async () => {
    twins();
    m.words.mockResolvedValue(order({ text: "spend $200 on LinkedIn for 14 days on 905998344" }));
    expect((await call()).ok).toBe(false);
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("a launchable campaign past the read limit still stops the order: nothing is filed, it is listed by ID, and naming it settles it", async () => {
    m.rows = Array.from({ length: 40 }, (_, i) => ({ id: i === 39 ? CHOSEN : `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, provider_campaign_id: String(7000 + i), account_binding_id: "a", funding_source: "wallet" }));
    m.summary.mockImplementation(async (_t: string, id: string) => (id === CHOSEN ? paused() : { ...paused(), status: "ARCHIVED" }));
    const r = await call();
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("Which campaign should run this?");
    expect(JSON.stringify(r)).toContain("7039");
    expect(m.emit).not.toHaveBeenCalled();
    expect(m.summary.mock.calls.length).toBeLessThanOrEqual(25);
    m.words.mockResolvedValue(order({ text: "spend $200 on LinkedIn for 14 days on 7039" }));
    expect((await call()).ok).toBe(true);
    expect(m.emit).toHaveBeenCalledTimes(1);
  });

  it("a Not finished twin is not a candidate, an unreadable one still is", () => {
    const c = (over: Partial<Parameters<typeof whichCampaignQuestion>[1][number]>): Parameters<typeof whichCampaignQuestion>[1][number] => ({ id: "x", provider_campaign_id: "1", funding_source: "wallet", name: "N", status: "PAUSED", launch_blocker: null, daily_budget_cents: null, currency: null, unread: false, delivery: "no_ads" as const, delivery_note: "", ...over });
    expect(whichCampaignQuestion("go", [c({ id: CHOSEN }), c({ id: OTHER, provider_campaign_id: "2", status: null, name: null, launch_blocker: "not finished" })], CHOSEN)).toBeNull();
    expect(whichCampaignQuestion("go", [c({ id: CHOSEN }), c({ id: OTHER, provider_campaign_id: "2", status: null, name: null, unread: true })], CHOSEN)).toContain("Which campaign");
  });
});

describe("Flow 14: a named daily rate", () => {
  it("$20 a day against a $50 campaign is refused, never silently dropped", async () => {
    m.asked.mockResolvedValue({ plan: { total_usd: 280, days: 14, budget_type: "lifetime" }, line: "Running.", source: "ask", asked_daily_usd: 20 });
    m.summary.mockResolvedValue(paused({ daily_budget_cents: 5000 }));
    const r = await call();
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("cannot change its daily budget");
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("no daily budget on the campaign is refused too", async () => {
    m.asked.mockResolvedValue({ plan: { total_usd: 280, days: 14, budget_type: "lifetime" }, line: "Running.", source: "ask", asked_daily_usd: 20 });
    m.summary.mockResolvedValue(paused({ daily_budget_cents: null }));
    expect((await call()).ok).toBe(false);
  });

  it("a lower campaign daily runs and says so", async () => {
    m.words.mockResolvedValue(order({ asked_daily_usd: 20, plan: { total_usd: 280, days: 14, budget_type: "lifetime" } }));
    const r = await call();
    expect(JSON.parse(r.content as string).say_to_founder).toContain("keeps its own $15.00 daily budget");
  });
});

describe("Flow 14: the go gate and founder powers", () => {
  it("a founder-rooted run with no order is held to the go verdict", async () => {
    m.words.mockResolvedValue(order({ text: "what do you think about LinkedIn", plan: null }));
    const r = await call({}, { ...INPUT, fit_verdict: "not_here" });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("only on a go verdict");
  });

  it("an unverified founder order loses the lifted gate but keeps the founder's origin", async () => {
    expect((await call({ founder_order_unverified: true })).ok).toBe(false);
    m.emit.mockClear();
    expect((await call({ founder_order_unverified: true }, { ...INPUT, fit_verdict: "here" })).ok).toBe(true);
    expect(m.emit.mock.calls[0][1].origin).toBe("user_initiated_chat");
    expect(m.emit.mock.calls[0][1]).not.toHaveProperty("explicit_order");
  });

  it("an explicit order is stamped so a not-yet verdict cannot close it", async () => {
    await call();
    expect(m.emit.mock.calls[0][1].explicit_order).toBe(true);
  });
});

describe("Flow 14: what reaches the founder", () => {
  it("the card is put in the chat, and a run with no chat tells the founder it waits", async () => {
    await call();
    expect(m.attach).toHaveBeenCalledWith(expect.objectContaining({ card_id: "act-1", table: "channel_actions" }));
    expect(m.tell).not.toHaveBeenCalled();
    m.attach.mockResolvedValue({ shown: false, reason: "not_chat" });
    await call();
    expect(m.tell).toHaveBeenCalledWith("t", "act-1", "channel_actions");
  });

  it("an Autopilot proposal never touches the chat", async () => {
    await call({ run_trigger: "manual", founder_chat_order: false }, { ...INPUT, fit_verdict: "here" });
    expect(m.attach).not.toHaveBeenCalled();
    expect(m.emit.mock.calls[0][1].origin).toBe("agent");
  });

  it("a relaunch's spend reaches the filing check and the card", async () => {
    m.spent.mockResolvedValue(4_000);
    await call();
    expect(m.filing.mock.calls[0][2]).toMatchObject({ spent_cents: 4_000 });
    expect(m.emit.mock.calls[0][1].spent_so_far_cents).toBe(4_000);
  });
});

describe("Flow 14: $200 for 14 days against the campaign's own daily budget", () => {
  const said = async () => JSON.parse((await call()).content as string).say_to_founder as string;
  it("a daily budget that spends the total early says it can stop before the 14 days end, and the card keeps the founder's total and end", async () => {
    m.summary.mockResolvedValue(paused({ daily_budget_cents: 5000 }));
    const line = await said();
    expect(line).toContain("can use up the $200.00 in about 4 days and stop before the 14 days are over");
    expect(m.emit.mock.calls[0][1]).toMatchObject({ total_budget_cents: 20_000, daily_budget_cents: 5000 });
  });
  it("a daily budget too small to reach the total says how much it can spend at most", async () => {
    m.summary.mockResolvedValue(paused({ daily_budget_cents: 1000 }));
    expect(await said()).toContain("over 14 days it can spend about $140.00 at most, not the full $200.00");
  });
  it("the founder's exact case, $15 a day, says it can run out a day early", async () => {
    expect(await said()).toContain("in about 13 days and stop before the 14 days are over");
  });
  it("a daily budget that fits the total adds nothing, and a campaign with no daily budget adds nothing", async () => {
    m.summary.mockResolvedValue(paused({ daily_budget_cents: 1500 }));
    m.words.mockResolvedValue(order({ plan: { total_usd: 210, days: 14, budget_type: "lifetime" } }));
    expect(await said()).not.toContain("daily budget");
    m.summary.mockResolvedValue(paused({ daily_budget_cents: null }));
    expect(await said()).not.toContain("daily budget");
  });
});

describe("Flow 14: which campaign, when some campaigns cannot be read", () => {
  const c = (over: Record<string, unknown>) => ({ id: "x", provider_campaign_id: "1", funding_source: "wallet", name: "N", status: "PAUSED", launch_blocker: null, daily_budget_cents: 150_000, currency: "INR", unread: false, delivery: "no_ads" as const, delivery_note: "", ...over });
  const unread = (id: string, pid: string) => c({ id, provider_campaign_id: pid, name: null, status: null, daily_budget_cents: null, currency: null, unread: true });
  it("lists only readable paused campaigns, never an unread one as a paused 'Campaign', and says how many could not be read", () => {
    const q = whichCampaignQuestion("go", [c({ id: CHOSEN, name: "Webinar" }), unread(OTHER, "2"), unread("33333333-3333-4333-8333-333333333333", "3")], CHOSEN) as string;
    expect(q).toContain("You have 1 paused LinkedIn campaign Zavi could launch: \"Webinar\" (ID 1,");
    expect(q).toContain("Zavi could not read 2 other LinkedIn campaigns just now");
    expect(q).toContain("IDs 2, 3");
    expect(q).not.toMatch(/"Campaign"/);
    expect(q).not.toContain("3 paused");
  });
  it("active, ended and archived campaigns that were read are never listed", () => {
    const q = whichCampaignQuestion("go", [c({ id: CHOSEN, name: "Webinar" }), c({ id: OTHER, provider_campaign_id: "2", name: "Live", status: "ACTIVE" }), c({ id: "y", provider_campaign_id: "3", name: "Old", status: "ARCHIVED" }), c({ id: "z", provider_campaign_id: "4", name: "Done", status: "COMPLETED" })], CHOSEN);
    expect(q).toBeNull();
  });
  it("a non-USD account's daily budget shows in its own currency, not dollars", () => {
    const q = whichCampaignQuestion("go", [c({ id: CHOSEN, name: "A" }), c({ id: OTHER, provider_campaign_id: "2", name: "B" })], CHOSEN) as string;
    expect(q).toContain("₹1,500.00 a day");
    expect(q).not.toContain("$1500.00");
    expect(q).not.toContain("$");
  });
});
