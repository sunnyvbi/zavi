
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CampaignBrief, WindowAgg } from "@/services/growth/perf-brief/brief";

vi.mock("../_flag-check", () => ({ isMetaAdsWriteEnabled: vi.fn(async () => true) }));
vi.mock("../_user-initiated-flag-check", () => ({ isUserInitiatedSpendApplyEnabled: vi.fn(async () => false) }));
vi.mock("../cap-reader", () => ({ readTenantCapRowAndToday: vi.fn(async () => ({ cap: { enabled: true } })) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("../../daily_series", () => ({
  fetchMetaDailySeries: vi.fn(async () => ({ truncated: false, rows: [{ ad_set_id: "238000000001", spend_usd: 20 }, { ad_set_id: "238000000001", spend_usd: 22.5 }, { ad_set_id: "other", spend_usd: 99 }] })),
}));

function agg(o: Partial<WindowAgg> = {}): WindowAgg {
  return {
    days: 3, spend_usd: 40, impressions: 3000, clicks: 30, conversions: 0,
    purchases: 0, sign_ups: 0, leads: 0, purchase_value_usd: 0,
    ctr_percent: 1, cvr_percent: 0, signup_cvr_percent: 0, cpa_usd: null,
    cost_per_signup_usd: null, cost_per_purchase_usd: null, roas: null, ...o,
  } as WindowAgg;
}
const LEARNING: CampaignBrief = {
  campaign_id: "c1", campaign_name: "Conversions", ad_set_id: "238000000001", ad_set_name: "Set A",
  window_days: 30, settled_cutoff: "2026-10-28", settled: agg(), prior: agg(),
  maturing_days: 3, confidence: "inadequate", funnel_label: "maturing_insufficient",
  posture: "HOLD", judged_on: "conversions", notes: [],
} as CampaignBrief;
vi.mock("../_cut-guard", async (orig) => ({
  ...(await orig<typeof import("../_cut-guard")>()),
  briefForAdSet: vi.fn(async () => LEARNING),
  briefForCampaign: vi.fn(async () => LEARNING),
  isCgoOriginatedRun: vi.fn(async () => false),
}));
const filed = vi.hoisted(() => ({ today: false, inserts: [] as unknown[] }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: vi.fn(),
  tenantClient: () => {
    const q: Record<string, unknown> = {};
    for (const k of ["select", "eq", "is"]) q[k] = () => q;
    q.maybeSingle = async () => ({ data: filed.today ? { card_id: "card-0", created_at: new Date().toISOString(), token: "t" } : { object_id: "238000000001" }, error: null });
    q.update = () => q;
    q.limit = async () => ({ data: [], error: null });
    q.insert = async (row: unknown) => {
      filed.inserts.push(row);
      return filed.today ? { error: { code: "23505", message: "duplicate key" } } : { error: null };
    };
    return { from: () => q };
  },
}));

import { metaProposeStatusChangeTool } from "../propose_status_change";
import {
  CLAIM_ORPHAN_MS,
  PAUSE_PAST_GUARD_CLASS,
  claimPausePastGuard,
  fileFounderPauseCard,
  type ClaimStore,
  founderGuardReason,
  pausePastGuardBody,
  pausePastGuardBodySchema,
} from "../_pause-past-guard";
import { metaChangeRows } from "../_change-rows";
import { metaActionRaisesSpend } from "../_decision-bodies";
import { metaExecActionType } from "../_exec-action";
import { reachesCgoAdDoor, approveChannelAction } from "@/services/channels/exec-actions";
import { isPersonOnlyOrigin } from "@/services/growth/person-only";
import { isExecutableAdClass } from "@/services/growth/unattended-policy";
import type { ToolContext } from "@/services/tools/types";

const T0 = Date.parse("2026-11-01T10:00:00Z");
const KEY = "238000000001|2026-11-01";
const BODY = () => pausePastGuardBody({ ad_set_id: "238000000001", at: new Date(T0), verdict: { reason: "cut_blocked_brief_contradicts" }, brief: null, spend_7d_usd: null });
type Row = { card_id: string | null; created_at: string; token: string };
function memStore(o: { card?: string; cardThrows?: boolean; insertError?: boolean } = {}): ClaimStore & { rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
  const k = (a: string, d: string) => `${a}|${d}`;
  return {
    rows,
    insert: async (_t, a, d, token) => (o.insertError ? "error" : rows.has(k(a, d)) ? "exists" : (rows.set(k(a, d), { card_id: null, created_at: new Date(T0).toISOString(), token }), "ok")),
    read: async (_t, a, d) => rows.get(k(a, d)) ?? null,
    takeOver: async (_t, a, d, old, next, olderThan) => {
      const r = rows.get(k(a, d));
      if (!r || r.card_id || r.token !== old || !(Date.parse(r.created_at) < Date.parse(olderThan))) return false;
      rows.set(k(a, d), { card_id: null, created_at: new Date(T0 + CLAIM_ORPHAN_MS + 1).toISOString(), token: next });
      return true;
    },
    stillMine: async (_t, a, d, token) => { const r = rows.get(k(a, d)); return !!r && r.token === token && !r.card_id; },
    link: async (_t, a, d, token, id) => { const r = rows.get(k(a, d)); if (r && r.token === token && !r.card_id) { r.card_id = id; return true; } return false; },
    release: async (_t, a, d, token) => { const r = rows.get(k(a, d)); if (r && r.token === token && !r.card_id) rows.delete(k(a, d)); },
    cardToday: async () => { if (o.cardThrows) throw new Error("db down"); return o.card ?? null; },
  };
}
let tokens = 0;
const tok = () => `tok-${++tokens}`;

const PAUSE = { object_id: "238000000001", level: "adset" as const, status: "PAUSED" as const, rationale: "no sales yet", name: "Set A" };

function ctx(over: Partial<ToolContext> = {}) {
  const emit = vi.fn(async (_c: string, _b: unknown) => "card-1");
  const c: ToolContext = { tenant_id: "tenant-1", run_id: "run-1", run_trigger: "scheduled", log: () => {}, emit_decision: emit, ...over } as ToolContext;
  return { c, emit };
}

beforeEach(() => {
  filed.today = false;
  filed.inserts = [];
});

describe("a pause the cut guard refuses", () => {
  it("is still refused for Zavi, and files exactly one founder card that can only pause", async () => {
    const { c, emit } = ctx();
    const out = (await metaProposeStatusChangeTool.execute(c, PAUSE)) as Record<string, unknown>;
    expect(out.blocked).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toBe(PAUSE_PAST_GUARD_CLASS);
    const body = pausePastGuardBodySchema.parse(emit.mock.calls[0][1]);
    expect(body).toMatchObject({ object_id: "238000000001", level: "adset", status: "PAUSED", origin: "cut_guard_override", spend_7d_usd: 42.5 });
    expect(body.guard_reason).toMatch(/^Still learning: 3 settled days, \$40 spent and 30 clicks/);
    expect(String(out.founder_card)).toMatch(/Do not propose this pause again/);
  });

  it("files nothing when the founder already has today's card for that ad set", async () => {
    filed.today = true;
    const { c, emit } = ctx();
    const out = (await metaProposeStatusChangeTool.execute(c, PAUSE)) as Record<string, unknown>;
    expect(out.blocked).toBe(true);
    expect(emit).not.toHaveBeenCalled();
    expect(String(out.founder_card)).toMatch(/already has a card/);
  });

  it("files nothing for a campaign-level pause", async () => {
    const { c, emit } = ctx();
    const out = (await metaProposeStatusChangeTool.execute(c, { ...PAUSE, level: "campaign" })) as Record<string, unknown>;
    expect(out.blocked).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it("claims (tenant, ad set, day) before filing, so two runs on different rails file one card", async () => {
    const { c } = ctx();
    await metaProposeStatusChangeTool.execute(c, PAUSE);
    expect(filed.inserts).toEqual([{ object_id: "238000000001", day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), token: expect.any(String), created_at: expect.any(String) }]);
  });

  it("a filed card is linked to its claim", async () => {
    const store = memStore();
    const r = await fileFounderPauseCard(async () => "card-9", "tenant-1", BODY(), { store });
    expect(r).toEqual({ filed: true, id: "card-9" });
    expect(store.rows.get(KEY)?.card_id).toBe("card-9");
  });

  it("an emit that errors keeps the claim and says the write may still land", async () => {
    const store = memStore();
    const r = await fileFounderPauseCard(async () => { throw new Error("rpc down"); }, "tenant-1", BODY(), { store, token: tok });
    expect(r).toEqual({ filed: false, why: "uncertain" });
    expect(store.rows.has(KEY)).toBe(true);
  });

  it("a typed refusal that certainly wrote nothing gives the day back; the stale run cannot release a new owner's claim", async () => {
    const { ExpectedToolError } = await import("@/services/tools/types");
    const store = memStore();
    const r = await fileFounderPauseCard(async () => { throw new ExpectedToolError("channel_card_already_rejected", "Not filed"); }, "tenant-1", BODY(), { store, token: tok });
    expect(r).toEqual({ filed: false, why: "not_filed" });
    expect(store.rows.has(KEY)).toBe(false);
    store.rows.set(KEY, { card_id: null, created_at: new Date(T0).toISOString(), token: "owner" });
    await store.release("tenant-1", "238000000001", "2026-11-01", "stale");
    expect(store.rows.get(KEY)?.token).toBe("owner");
  });

  it("a fresh claim that finds a card already on a rail links it and files nothing", async () => {
    const store = memStore({ card: "card-landed-earlier" });
    const emit = vi.fn(async () => "dup");
    expect(await fileFounderPauseCard(emit, "tenant-1", BODY(), { store, token: tok })).toEqual({ filed: false, why: "already_today" });
    expect(emit).not.toHaveBeenCalled();
    expect(store.rows.get(KEY)?.card_id).toBe("card-landed-earlier");
  });

  it("an unreadable fence keeps the claim and files nothing", async () => {
    const store = memStore();
    const emit = vi.fn(async () => "id");
    const r = await fileFounderPauseCard(emit, "tenant-1", BODY(), { store: { ...store, stillMine: async () => { throw new Error("db"); } }, token: tok });
    expect(r).toEqual({ filed: false, why: "not_filed" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("a lost fence whose new holder already filed says already today", async () => {
    const store = memStore({ card: "c-new" });
    const lost = { ...store, insert: async () => "ok" as const, stillMine: async () => false };
    const r = await fileFounderPauseCard(async () => "dup", "tenant-1", BODY(), { store: { ...lost, cardToday: (() => { let n = 0; return async () => (n++ === 0 ? null : "c-new"); })() }, token: tok });
    expect(r).toEqual({ filed: false, why: "already_today" });
  });

  it("a lost fence with no claim and no card left says none filed, not in progress", async () => {
    const store = memStore();
    const emit = vi.fn(async () => "id");
    const gone = { ...store, stillMine: async () => { store.rows.delete(KEY); return false; } };
    expect(await fileFounderPauseCard(emit, "tenant-1", BODY(), { store: gone, token: tok })).toEqual({ filed: false, why: "not_filed" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("a lost takeover whose holder let go (no claim, no card) is not called in progress", async () => {
    const store = memStore();
    store.rows.set(KEY, { card_id: null, created_at: new Date(T0).toISOString(), token: "stale" });
    const gone = { ...store, takeOver: async () => { store.rows.delete(KEY); return false; } };
    expect(await claimPausePastGuard("tenant-1", "238000000001", "2026-11-01", gone, () => T0 + CLAIM_ORPHAN_MS + 1, tok)).toEqual({ state: "unreadable" });
  });

  it("a lost takeover whose winner already filed says taken, not in progress", async () => {
    const store = memStore();
    store.rows.set(KEY, { card_id: null, created_at: new Date(T0).toISOString(), token: "stale" });
    const raced = { ...store, takeOver: async () => { store.rows.set(KEY, { card_id: "c-winner", created_at: new Date(T0).toISOString(), token: "w" }); return false; } };
    expect(await claimPausePastGuard("tenant-1", "238000000001", "2026-11-01", raced, () => T0 + CLAIM_ORPHAN_MS + 1, tok)).toEqual({ state: "taken" });
  });

  it("an emit whose answer was lost but whose card landed keeps the claim and reports the card", async () => {
    const store = memStore();
    let reads = 0;
    const landedLater = { ...store, cardToday: async () => (reads++ === 0 ? null : "card-landed") };
    const r = await fileFounderPauseCard(async () => { throw new Error("socket hang up"); }, "tenant-1", BODY(), { store: landedLater, token: tok });
    expect(r).toEqual({ filed: true, id: "card-landed" });
    expect(store.rows.get(KEY)?.card_id).toBe("card-landed");
  });

  it("an unreadable card check right after claiming files nothing and keeps the claim, to be taken over once orphaned", async () => {
    const store = memStore({ cardThrows: true });
    const r = await fileFounderPauseCard(async () => { throw new Error("x"); }, "tenant-1", BODY(), { store });
    expect(r).toEqual({ filed: false, why: "not_filed" });
    expect(store.rows.has(KEY)).toBe(true);
  });

  it("a young claim with no card is another run filing now: in progress, and the model is told so", async () => {
    const store = memStore();
    store.rows.set(KEY, { card_id: null, created_at: new Date(T0).toISOString(), token: "other" });
    expect(await claimPausePastGuard("tenant-1", "238000000001", "2026-11-01", store, () => T0 + 60_000, tok)).toEqual({ state: "in_progress" });
    expect(await fileFounderPauseCard(async () => "x", "tenant-1", BODY(), { store, now: () => T0 + 60_000, token: tok })).toEqual({ filed: false, why: "in_progress" });
  });

  it("an orphaned claim is taken over once, and the run it replaced can no longer file or link", async () => {
    const store = memStore();
    store.rows.set(KEY, { card_id: null, created_at: new Date(T0).toISOString(), token: "stale" });
    const won = await claimPausePastGuard("tenant-1", "238000000001", "2026-11-01", store, () => T0 + CLAIM_ORPHAN_MS + 1, tok);
    expect(won.state).toBe("claimed");
    expect((await claimPausePastGuard("tenant-1", "238000000001", "2026-11-01", store, () => T0 + CLAIM_ORPHAN_MS + 2, tok)).state).toBe("in_progress");
    expect(await store.stillMine("tenant-1", "238000000001", "2026-11-01", "stale")).toBe(false);
    await store.link("tenant-1", "238000000001", "2026-11-01", "stale", "dup");
    expect(store.rows.get(KEY)).toMatchObject({ card_id: null, token: (won as { token: string }).token });
  });

  it("a claim whose card exists is taken, whatever its age", async () => {
    const store = memStore();
    store.rows.set(KEY, { card_id: "c1", created_at: new Date(T0).toISOString(), token: "t" });
    expect(await claimPausePastGuard("tenant-1", "238000000001", "2026-11-01", store, () => T0 + 10 * CLAIM_ORPHAN_MS, tok)).toEqual({ state: "taken" });
  });

  it("a claim lost before filing files nothing", async () => {
    const store = memStore();
    const emit = vi.fn(async () => "id");
    const fenced = { ...store, stillMine: async () => false };
    expect(await fileFounderPauseCard(emit, "tenant-1", BODY(), { store: fenced, token: tok })).toEqual({ filed: false, why: "in_progress" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("an unreadable claim files nothing", async () => {
    const emit = vi.fn(async () => "id");
    const r = await fileFounderPauseCard(emit, "tenant-1", BODY(), { store: memStore({ insertError: true }) });
    expect(r).toEqual({ filed: false, why: "not_filed" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("a founder's run never stamps founder marks on it (the strict payload survives emission)", async () => {
    const { serverFounderMarks } = await import("@/services/growth/founder-marks");
    const body = pausePastGuardBody({ ad_set_id: "238000000001", at: new Date(), verdict: { reason: null }, brief: null, spend_7d_usd: 1 });
    const out = serverFounderMarks(PAUSE_PAST_GUARD_CLASS, body, { group: "g", unverified: true });
    expect(pausePastGuardBodySchema.safeParse(out).success).toBe(true);
    expect(out).toBe(body);
  });

  it("a forged mark or server-only key on it is still stripped", async () => {
    const { serverFounderMarks } = await import("@/services/growth/founder-marks");
    const body = pausePastGuardBody({ ad_set_id: "238000000001", at: new Date(), verdict: { reason: null }, brief: null, spend_7d_usd: 1 });
    const forged = { ...body, founder_chat_order: true, founder_order_unverified: true, move_group: "g", move_after: ["x"], budget_choice: "raise", retry_of: "r" };
    for (const founder of [null, { group: "g", unverified: false }]) {
      const out = serverFounderMarks(PAUSE_PAST_GUARD_CLASS, forged, founder) as Record<string, unknown>;
      for (const k of ["founder_chat_order", "founder_order_unverified", "move_group", "move_after", "budget_choice", "retry_of"]) expect(k in out).toBe(false);
      expect(out.origin).toBe("cut_guard_override");
      expect(pausePastGuardBodySchema.safeParse(out).success).toBe(true);
    }
  });
});

describe("the card's payload", () => {
  const base = pausePastGuardBody({ ad_set_id: "238000000001", at: new Date("2026-11-01T23:59:00Z"), verdict: { reason: "cut_blocked_top_funnel_working" }, brief: null, spend_7d_usd: 10.004 });

  it("carries the UTC day and rounds the spend", () => {
    expect(base.day).toBe("2026-11-01");
    expect(base.spend_7d_usd).toBe(10);
  });

  it.each([
    ["a resume", { status: "ACTIVE" }],
    ["a campaign", { level: "campaign" }],
    ["a budget", { daily_budget_usd: 100 }],
    ["an expected status", { expected_current_status: "ACTIVE" }],
    ["another origin", { origin: "user_initiated_ledger" }],
  ])("refuses %s", (_l, extra) => {
    expect(pausePastGuardBodySchema.safeParse({ ...base, ...extra }).success).toBe(false);
  });

  it("never carries the agent's guidance text", () => {
    for (const reason of ["cut_blocked_no_brief_autopilot", "cut_blocked_objective_not_conversions", "cut_blocked_top_funnel_working", "cut_blocked_insufficient_settled_signal", "cut_blocked_brief_contradicts", "x"]) {
      expect(founderGuardReason({ reason }, null)).not.toMatch(/Do NOT|Hold —|agent/);
    }
  });
});

describe("the confirm and who may approve", () => {
  const body = pausePastGuardBody({ ad_set_id: "238000000001", at: new Date(), verdict: { reason: "cut_blocked_insufficient_settled_signal" }, brief: LEARNING, spend_7d_usd: 42.5, name: "Set A" });

  it("shows the ad set, its 7-day spend, why the guard held, and the learning reset", () => {
    const c = metaChangeRows(PAUSE_PAST_GUARD_CLASS, body)!;
    expect(c.title).toBe("Pause “Set A” anyway?");
    expect(c.change_sentence).toContain("Pausing now resets Meta's learning when you turn it back on.");
    expect(c.rows).toEqual([
      { item: "“Set A”", before: "Active", after: "Paused" },
      { item: "Spent in the last 7 days", before: "$42.50", after: "Stops" },
      { item: "Why Zavi held it", before: body.guard_reason, after: "Your call" },
    ]);
  });

  it("any member may approve it (a pause), and it files as a pause", () => {
    expect(metaActionRaisesSpend(PAUSE_PAST_GUARD_CLASS, body)).toBe(false);
    expect(metaExecActionType(PAUSE_PAST_GUARD_CLASS, body)).toBe("pause_ad");
  });

  it("the CGO never approves it", async () => {
    expect(reachesCgoAdDoor(PAUSE_PAST_GUARD_CLASS)).toBe(false);
    expect(isPersonOnlyOrigin("cut_guard_override")).toBe(true);
    expect(isExecutableAdClass(PAUSE_PAST_GUARD_CLASS)).toBe(true);
    const rpc = vi.fn();
    const r = await approveChannelAction("tenant-1", { actionId: "a1", eventKey: "k", actorUserId: "cgo", source: "cgo" }, rpc as never, async () => body);
    expect(r).toEqual({ ok: false, code: "founder_order" });
    expect(rpc).not.toHaveBeenCalled();
  });
});
