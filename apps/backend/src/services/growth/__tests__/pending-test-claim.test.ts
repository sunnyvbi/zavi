import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  reserve: vi.fn(),
  prepared: vi.fn(),
  anchor: vi.fn(),
  tiktokEmit: vi.fn(),
  tiktokExecute: vi.fn(),
  filed: null as null | Record<string, unknown>,
}));
vi.mock("@/services/tenant-client", () => {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = () => q;
  q.maybeSingle = async () => ({ data: m.filed, error: null });
  return { asTenantId: (t: string) => t, tenantClient: () => ({ from: () => q }), tenantRpc: async () => ({ data: null, error: null }) };
});
vi.mock("@/services/decisions/ad-budget", async (orig) => ({
  ...(await orig<typeof import("@/services/decisions/ad-budget")>()),
  reserveAdSpend: (...a: unknown[]) => m.reserve(...a),
}));
vi.mock("@/services/connectors/reddit-ads/lifecycle", () => ({ preparedCampaign: (...a: unknown[]) => m.prepared(...a) }));
vi.mock("../cgo-ad-orders", () => ({ ensureCgoOrderRun: (...a: unknown[]) => m.anchor(...a) }));
vi.mock("@/services/tools/tiktok-ads/_exec-action", () => ({ resolveTiktokAdsEmit: async () => m.tiktokEmit }));
vi.mock("@/services/tools/tiktok-ads/launch", () => ({ tiktokAdsProposeLaunchTool: { name: "tiktok_ads_propose_launch", execute: (...a: unknown[]) => m.tiktokExecute(...a) } }));

import { ExpectedToolError } from "@/services/tools/types";
import type { ActiveAdBudget, AdSpendHold } from "@/services/decisions/ad-budget";
import type { PendingTestRow } from "../pending-tests";
import { assertNoWaitingTest, cardIsOver, claimIdemKey, claimedVerdict, defaultClaimDeps, filedByReplay, runPendingTestsForTenant, type CardState, type ClaimDeps, type RefileResult } from "../pending-test-claim";

const T = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-11T12:00:00Z");
const DAY = 86_400_000;
const CARD = "6f2c4d1e-9a8b-4c7d-8e6f-0a1b2c3d4e5f";

const row = (over: Partial<PendingTestRow> = {}): PendingTestRow => ({
  id: "p1",
  tenant_id: T,
  channel_slug: "tiktok_ads",
  status: "pending",
  daily_budget_usd: 25,
  hold_usd: 525,
  proposal: { name: "Spring test", daily_budget_usd: 25 },
  action_id: null,
  hold_idem_key: null,
  closed_reason: null,
  revision: 1,
  created_at: NOW.toISOString(),
  expires_at: new Date(NOW.getTime() + 3 * DAY).toISOString(),
  updated_at: NOW.toISOString(),
  ...over,
});

const budget = (left_usd: number): ActiveAdBudget => ({
  id: "b1",
  monthly_usd: 25000,
  month_cap_usd: 25000,
  spent_usd: 7000,
  held_usd: 25000 - 7000 - left_usd,
  creator_held_usd: 0,
  creator_spent_usd: 0,
  left_usd,
  daily_limit_usd: null,
  next_month_start: "2026-11-01",
  days_left: 21,
  days_in_month: 31,
  margin: 1,
});

function world(rows: PendingTestRow[], left: number) {
  const holds = new Map<string, string>();
  const cards = new Map<string, CardState | null>();
  const calls: string[] = [];
  let refileAnswer: RefileResult = { kind: "filed", action_id: CARD };
  let reserveAnswer: "held" | "refused" = "held";
  let releaseAnswer: string | null = null;
  const deps: ClaimDeps = {
    readTests: async () => rows.map((r) => ({ ...r })),
    readBudget: async () => budget(left),
    refile: async (r) => (calls.push(`refile ${r.channel_slug}`), refileAnswer),
    reserve: async (r, action_id): Promise<AdSpendHold> => {
      calls.push(`reserve ${action_id}`);
      if (reserveAnswer === "refused") return { status: "refused", error: "cap_refuse: ad_budget_over_month" };
      const key = claimIdemKey(r.channel_slug, action_id);
      const fresh = !holds.has(key);
      holds.set(key, "reserved");
      return { status: "held", tenant_id: T, idem_key: key, fresh };
    },
    readCard: async (_t, id) => cards.get(id) ?? null,
    release: async (_t, key) => {
      calls.push(`release ${key}`);
      if (releaseAnswer) return releaseAnswer;
      holds.set(key, "released");
      return "released";
    },
    update: async (r, patch) => {
      calls.push(`update ${JSON.stringify(patch)}`);
      const hit = rows.find((x) => x.id === r.id);
      if (!hit || hit.revision !== r.revision) return false;
      Object.assign(hit, patch, { revision: hit.revision + 1 });
      return true;
    },
    log: () => undefined,
  };
  return {
    deps,
    holds,
    cards,
    calls,
    set refile(a: RefileResult) { refileAnswer = a; },
    set reserve(a: "held" | "refused") { reserveAnswer = a; },
    set release(a: string | null) { releaseAnswer = a; },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("B4: claim only when left_usd covers the hold, then file the card and hold at once", () => {
  it("Upcar-shaped: the cap full of Zavi holds ($500 left) does not cover a $525 hold: nothing is filed or held", async () => {
    const rows = [row()];
    const w = world(rows, 500);
    const out = await runPendingTestsForTenant(T, NOW, {}, w.deps);
    expect(out).toMatchObject({ claimed: 0, waiting: 1 });
    expect(w.calls).toEqual([]);
    expect(rows[0].status).toBe("pending");
  });

  it("room freed to $700: the card files, its id is saved BEFORE the hold, the hold is taken under the executor's key, and the test is claimed", async () => {
    const rows = [row()];
    const w = world(rows, 700);
    const out = await runPendingTestsForTenant(T, NOW, {}, w.deps);
    expect(out).toMatchObject({ claimed: 1, filed: 1 });
    expect(w.calls).toEqual([
      "refile tiktok_ads",
      `update ${JSON.stringify({ action_id: CARD })}`,
      `reserve ${CARD}`,
      `update ${JSON.stringify({ status: "claimed", hold_idem_key: `${CARD}:create` })}`,
    ]);
    expect(rows[0]).toMatchObject({ status: "claimed", action_id: CARD, hold_idem_key: `${CARD}:create` });
  });

  it("SaaS Google-only: two tests waiting, room for one; the older claims and the newer keeps waiting this hour", async () => {
    const rows = [row({ id: "p-reddit", channel_slug: "reddit_ads", daily_budget_usd: 20, created_at: new Date(NOW.getTime() - DAY).toISOString() }), row()];
    const w = world(rows, 700);
    const out = await runPendingTestsForTenant(T, NOW, {}, w.deps);
    expect(out).toMatchObject({ claimed: 1, waiting: 1 });
    expect(w.calls.filter((c) => c.startsWith("refile"))).toEqual(["refile reddit_ads"]);
  });

  it("the proposal is still short (or a read failed) when replayed: keep waiting, nothing held", async () => {
    const rows = [row()];
    const w = world(rows, 700);
    w.refile = { kind: "wait", why: "tiktok_ads_budget_short" };
    await runPendingTestsForTenant(T, NOW, {}, w.deps);
    expect(w.calls).toEqual(["refile tiktok_ads"]);
    expect(rows[0].status).toBe("pending");
  });

  it("the proposal can no longer pass (a check that will not change): the test is given up, nothing held", async () => {
    const rows = [row()];
    const w = world(rows, 700);
    w.refile = { kind: "gone", why: "tiktok_ads_video_ratio: not 9:16" };
    await runPendingTestsForTenant(T, NOW, {}, w.deps);
    expect(rows[0]).toMatchObject({ status: "closed", closed_reason: "tiktok_ads_video_ratio: not 9:16" });
    expect(w.calls.some((c) => c.startsWith("reserve"))).toBe(false);
  });

  it("card filed but the hold refused (the room went): pending with its card; next hour retries the hold without filing again", async () => {
    const rows = [row()];
    const w = world(rows, 700);
    w.reserve = "refused";
    await runPendingTestsForTenant(T, NOW, {}, w.deps);
    expect(rows[0]).toMatchObject({ status: "pending", action_id: CARD });
    w.reserve = "held";
    w.calls.length = 0;
    await runPendingTestsForTenant(T, NOW, {}, w.deps);
    expect(w.calls).toEqual([`reserve ${CARD}`, `update ${JSON.stringify({ status: "claimed", hold_idem_key: `${CARD}:create` })}`]);
  });

  it("this hour's spend read was not whole: no claim (releases still run)", async () => {
    const rows = [row(), row({ id: "p2", channel_slug: "reddit_ads", status: "claimed", action_id: CARD, hold_idem_key: `${CARD}:resume` })];
    const w = world(rows, 5000);
    w.cards.set(CARD, { status: "rejected", exec_status: null, code: null });
    const out = await runPendingTestsForTenant(T, NOW, { allowClaim: false }, w.deps);
    expect(w.calls.some((c) => c.startsWith("refile"))).toBe(false);
    expect(w.calls).toContain(`release ${CARD}:resume`);
    expect(out.released).toBe(1);
  });

  it("Autopilot off: the claim and release never read Autopilot (the protection is the hold itself)", async () => {
    const rows = [row()];
    const w = world(rows, 700);
    expect(Object.keys(w.deps)).not.toContain("cgoAdBudget");
    expect((await runPendingTestsForTenant(T, NOW, {}, w.deps)).claimed).toBe(1);
  });
});

describe("B4: the claimed hold is given back on every exit, and only then", () => {
  const claimed = (over: Partial<PendingTestRow> = {}) => row({ status: "claimed", action_id: CARD, hold_idem_key: `${CARD}:create`, ...over });

  it.each([
    ["rejected by the founder", { status: "rejected", exec_status: null, code: null }, "card_closed"],
    ["the launch failed cleanly", { status: "acted", exec_status: "failed", code: "tiktok_ads_budget_refused" }, "card_closed"],
    ["the card is gone", null, "card_closed"],
  ] as const)("%s: released and closed", async (_n, card, reason) => {
    const rows = [claimed()];
    const w = world(rows, 0);
    w.holds.set(`${CARD}:create`, "reserved");
    w.cards.set(CARD, card as CardState | null);
    const out = await runPendingTestsForTenant(T, NOW, {}, w.deps);
    expect(w.holds.get(`${CARD}:create`)).toBe("released");
    expect(rows[0]).toMatchObject({ status: "closed", closed_reason: reason });
    expect(out.released).toBe(1);
  });

  it("expired with its card still unapproved: released and closed", async () => {
    const rows = [claimed({ expires_at: new Date(NOW.getTime() - 1).toISOString() })];
    const w = world(rows, 0);
    w.cards.set(CARD, { status: "pending", exec_status: null, code: null });
    await runPendingTestsForTenant(T, NOW, {}, w.deps);
    expect(w.calls).toContain(`release ${CARD}:create`);
    expect(rows[0]).toMatchObject({ status: "closed", closed_reason: "expired" });
  });

  it("an expired pending test (never claimed) closes and holds nothing", async () => {
    const rows = [row({ expires_at: new Date(NOW.getTime() - 1).toISOString() })];
    const w = world(rows, 99999);
    await runPendingTestsForTenant(T, NOW, {}, w.deps);
    expect(rows[0]).toMatchObject({ status: "closed", closed_reason: "expired" });
    expect(w.calls.some((c) => c.startsWith("refile") || c.startsWith("reserve"))).toBe(false);
  });

  it.each([
    ["waiting for approval, not expired", { status: "pending", exec_status: null, code: null }],
    ["approved, about to queue", { status: "acted", exec_status: null, code: null }],
    ["queued", { status: "acted", exec_status: "queued", code: null }],
    ["running", { status: "acted", exec_status: "dispatching", code: null }],
  ] as const)("%s: kept", async (_n, card) => {
    const rows = [claimed()];
    const w = world(rows, 0);
    w.cards.set(CARD, card);
    await runPendingTestsForTenant(T, NOW, {}, w.deps);
    expect(w.calls).toEqual([]);
    expect(rows[0].status).toBe("claimed");
  });

  it("executed: the executor committed the same hold; closed as launched, never released", async () => {
    const rows = [claimed()];
    const w = world(rows, 0);
    w.cards.set(CARD, { status: "acted", exec_status: "executed", code: null });
    await runPendingTestsForTenant(T, NOW, {}, w.deps);
    expect(w.calls.some((c) => c.startsWith("release"))).toBe(false);
    expect(rows[0]).toMatchObject({ status: "closed", closed_reason: "launched" });
  });

  it("failed in a way that may have created something: the hold stays (the unknown-hold resolver owns it now)", async () => {
    const rows = [claimed()];
    const w = world(rows, 0);
    w.cards.set(CARD, { status: "acted", exec_status: "failed", code: "exec_outcome_unknown" });
    await runPendingTestsForTenant(T, NOW, {}, w.deps);
    expect(w.calls.some((c) => c.startsWith("release"))).toBe(false);
    expect(rows[0]).toMatchObject({ status: "closed", closed_reason: "launch_outcome_unknown" });
  });

  it("the release finds an approval that started after the card read ('busy'): kept claimed, decided next hour", async () => {
    const rows = [claimed()];
    const w = world(rows, 0);
    w.cards.set(CARD, { status: "rejected", exec_status: null, code: null });
    w.release = "busy";
    await runPendingTestsForTenant(T, NOW, {}, w.deps);
    expect(rows[0].status).toBe("claimed");
  });
});

describe("the claim's hold is the executor's hold (no double count on approval)", () => {
  it("TikTok: reserves op create, not paused, the card's daily budget, on the card, under `${card}:create`", async () => {
    m.reserve.mockResolvedValue({ status: "held", tenant_id: T, idem_key: `${CARD}:create`, fresh: true });
    await defaultClaimDeps.reserve(row(), CARD);
    const [d, a] = m.reserve.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(d).toMatchObject({ id: CARD, tenant_id: T, exec_source: "channel_actions", decision_class: "tiktok_ads.create_launch" });
    expect(a).toEqual({ platform: "tiktok", op: "create", object_id: null, daily_delta_usd: 25, delivery_factor: 1.25, currency: "USD", paused: false });
    expect(`${d.id}:${a.op}`).toBe(claimIdemKey("tiktok_ads", CARD));
  });

  it("Reddit: reserves op resume on the prepared ad group at the plan's daily budget, under `${card}:resume`", async () => {
    m.prepared.mockResolvedValue({ plan: { daily_budget_usd: 30 }, manifest: { group: { id: "g-77" } } });
    m.reserve.mockResolvedValue({ status: "held", tenant_id: T, idem_key: `${CARD}:resume`, fresh: true });
    await defaultClaimDeps.reserve(row({ channel_slug: "reddit_ads", proposal: { operation_key: "op_12345678", ad_account_id: "a2" } }), CARD);
    expect(m.prepared).toHaveBeenCalledWith(T, "op_12345678", CARD);
    const [d, a] = m.reserve.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(d).toMatchObject({ id: CARD, decision_class: "reddit_ads.launch_campaign" });
    expect(a).toEqual({ platform: "reddit", op: "resume", object_id: "g-77", daily_delta_usd: 30, currency: "USD" });
    expect(`${d.id}:${a.op}`).toBe(claimIdemKey("reddit_ads", CARD));
  });
});

describe("the replay files the card from the stored proposal, on the channel's own rail", () => {
  beforeEach(() => {
    m.anchor.mockResolvedValue("run-anchor");
    m.filed = { run_id: "run-anchor", exec_class: "tiktok_ads.create_launch", exec_payload: { daily_budget_usd: 25 }, proposed_at: new Date().toISOString() };
  });

  it("runs the proposal tool with the stored input, on the tiktok_ads anchor run, marked as a replay", async () => {
    m.tiktokExecute.mockResolvedValue({ action_id: CARD, status: "waiting_for_approval" });
    const r = await defaultClaimDeps.refile(row(), NOW);
    expect(r).toEqual({ kind: "filed", action_id: CARD });
    expect(m.anchor).toHaveBeenCalledWith(T, "tiktok_ads", NOW);
    const [ctx, input] = m.tiktokExecute.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(ctx).toMatchObject({ tenant_id: T, run_id: "run-anchor", emit_decision: m.tiktokEmit, pending_test_replay: true });
    expect(input).toEqual(row().proposal);
  });

  it("still short or unreadable: wait; a refusal that will not change: gone", async () => {
    m.tiktokExecute.mockRejectedValueOnce(new ExpectedToolError("tiktok_ads_budget_short", "short"));
    expect((await defaultClaimDeps.refile(row(), NOW)).kind).toBe("wait");
    m.tiktokExecute.mockRejectedValueOnce(new Error("network"));
    expect((await defaultClaimDeps.refile(row(), NOW)).kind).toBe("wait");
    m.tiktokExecute.mockRejectedValueOnce(new ExpectedToolError("tiktok_ads_location_not_allowed", "no"));
    expect((await defaultClaimDeps.refile(row(), NOW)).kind).toBe("gone");
  });
});

describe("review fixes", () => {
  it("C-F1: a newer refusal replaces the row while its card is being filed: the row takes the card back (with the filed amounts), it is held, and no second card is ever filed", async () => {
    const rows = [row()];
    const w = world(rows, 700);
    const refile = w.deps.refile;
    w.deps.refile = async (r, now) => {
      const out = await refile(r, now);
      Object.assign(rows[0], { daily_budget_usd: 60, hold_usd: 1260, proposal: { name: "Bigger" }, revision: rows[0].revision + 1 });
      return out;
    };
    const out = await runPendingTestsForTenant(T, NOW, {}, w.deps);
    expect(out.claimed).toBe(1);
    expect(rows[0]).toMatchObject({ status: "claimed", action_id: CARD, daily_budget_usd: 25, hold_usd: 525, proposal: { name: "Spring test" } });
    await runPendingTestsForTenant(T, NOW, {}, w.deps);
    expect(w.calls.filter((c) => c.startsWith("refile"))).toHaveLength(1);
  });

  it("C-F2: a TikTok launch that stopped with exec_partial (TikTok confirmed it off) releases the claim; Reddit's exec_partial and any exec_outcome_unknown keep it", () => {
    expect(claimedVerdict({ status: "acted", exec_status: "failed", code: "exec_partial", exec_class: "tiktok_ads.create_launch" }, false)).toBe("release");
    expect(claimedVerdict({ status: "acted", exec_status: "failed", code: "exec_partial", exec_class: "reddit_ads.launch_campaign" }, false)).toBe("close_kept");
    expect(claimedVerdict({ status: "acted", exec_status: "failed", code: "exec_outcome_unknown", exec_class: "tiktok_ads.create_launch" }, false)).toBe("close_kept");
  });

  it("G-F1: a launch of a channel whose test waits (pending or claimed) is refused; an expired one, another channel, or the server's replay passes; unreadable refuses", async () => {
    const ctx = { tenant_id: T } as never;
    await expect(assertNoWaitingTest(ctx, "tiktok_ads", NOW, async () => [row()])).rejects.toMatchObject({ code: "tiktok_ads_test_waiting" });
    await expect(assertNoWaitingTest(ctx, "tiktok_ads", NOW, async () => [row({ status: "claimed", action_id: CARD, hold_idem_key: `${CARD}:create`, expires_at: new Date(NOW.getTime() - 1).toISOString() })])).rejects.toMatchObject({ code: "tiktok_ads_test_waiting" });
    await expect(assertNoWaitingTest(ctx, "tiktok_ads", NOW, async () => [row({ expires_at: new Date(NOW.getTime() - 1).toISOString() }), row({ channel_slug: "reddit_ads" }), row({ status: "closed" })])).resolves.toBeUndefined();
    await expect(assertNoWaitingTest({ tenant_id: T, pending_test_replay: true } as never, "tiktok_ads", NOW, async () => [row()])).resolves.toBeUndefined();
    await expect(assertNoWaitingTest(ctx, "reddit_ads", NOW, async () => { throw new Error("down"); })).rejects.toMatchObject({ code: "reddit_ads_pending_test_unreadable" });
  });
});

describe("re-review fixes", () => {
  const ctx = { tenant_id: T } as never;
  const expired = new Date(NOW.getTime() - 1).toISOString();

  it("1: the card writer returns an OLDER kept card (other run, earlier, other budget): the replay waits, nothing adopted or held", async () => {
    m.anchor.mockResolvedValue("run-anchor");
    m.tiktokExecute.mockResolvedValue({ action_id: CARD, status: "waiting_for_approval" });
    const fresh = new Date().toISOString();
    for (const filed of [
      { run_id: "run-older", exec_class: "tiktok_ads.create_launch", exec_payload: { daily_budget_usd: 25 }, proposed_at: fresh },
      { run_id: "run-anchor", exec_class: "tiktok_ads.create_launch", exec_payload: { daily_budget_usd: 60 }, proposed_at: fresh },
      { run_id: "run-anchor", exec_class: "tiktok_ads.create_launch", exec_payload: { daily_budget_usd: 25 }, proposed_at: "2026-01-01T00:00:00Z" },
      null,
    ]) {
      m.filed = filed;
      expect((await defaultClaimDeps.refile(row(), NOW)).kind).toBe("wait");
    }
    m.filed = { run_id: "run-anchor", exec_class: "tiktok_ads.create_launch", exec_payload: { daily_budget_usd: 25 }, proposed_at: fresh };
    expect(await defaultClaimDeps.refile(row(), NOW)).toEqual({ kind: "filed", action_id: CARD });
  });

  it("1: Reddit counts the card only when it launches the test's own prepared operation", () => {
    const r = { run_id: "run-a", started: 0, row: row({ channel_slug: "reddit_ads", proposal: { operation_key: "op_12345678" } }) };
    const card = (k: string) => ({ run_id: "run-a", exec_class: "reddit_ads.launch_campaign", exec_payload: { operation_key: k }, proposed_at: new Date().toISOString() });
    expect(filedByReplay(card("op_12345678"), r)).toBe(true);
    expect(filedByReplay(card("op_other_99"), r)).toBe(false);
  });

  it("2: an expired or closed test whose card can still launch blocks a second card; a card proven over, or none, does not", async () => {
    const stuck = row({ expires_at: expired, action_id: CARD });
    const closed = row({ status: "closed", action_id: CARD });
    const waitCard = (c: CardState) => async () => c;
    await expect(assertNoWaitingTest(ctx, "tiktok_ads", NOW, async () => [stuck], waitCard({ status: "pending", exec_status: null, code: null }))).rejects.toMatchObject({ code: "tiktok_ads_test_waiting" });
    await expect(assertNoWaitingTest(ctx, "tiktok_ads", NOW, async () => [closed], waitCard({ status: "acted", exec_status: "queued", code: null }))).rejects.toMatchObject({ code: "tiktok_ads_test_waiting" });
    await expect(assertNoWaitingTest(ctx, "tiktok_ads", NOW, async () => [closed], waitCard({ status: "acted", exec_status: "failed", code: "exec_outcome_unknown" }))).rejects.toMatchObject({ code: "tiktok_ads_test_waiting" });
    for (const over of [{ status: "rejected", exec_status: null, code: null }, { status: "acted", exec_status: "executed", code: null }, { status: "acted", exec_status: "failed", code: "tiktok_ads_budget_refused" }]) {
      await expect(assertNoWaitingTest(ctx, "tiktok_ads", NOW, async () => [closed], waitCard(over))).resolves.toBeUndefined();
    }
    await expect(assertNoWaitingTest(ctx, "tiktok_ads", NOW, async () => [closed], async () => null)).resolves.toBeUndefined();
    await expect(assertNoWaitingTest(ctx, "tiktok_ads", NOW, async () => [closed], async () => { throw new Error("down"); })).rejects.toMatchObject({ code: "tiktok_ads_pending_test_unreadable" });
    expect(cardIsOver({ status: "acted", exec_status: "failed", code: "exec_partial", exec_class: "reddit_ads.launch_campaign" })).toBe(false);
  });
});
