
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
let nextId = 1;

function pick(row: Row, col: string): unknown {
  const m = col.match(/^(\w+)->>(\w+)$/);
  if (m) return (row[m[1]!] as Row | null | undefined)?.[m[2]!];
  return row[col];
}

function query(table: string, tenant: string) {
  const filters: Array<(r: Row) => boolean> = [(r) => r.tenant_id === tenant];
  let lim = Infinity;
  const q = {
    eq(col: string, v: unknown) {
      filters.push((r) => pick(r, col) === v);
      return q;
    },
    order() {
      return q;
    },
    limit(n: number) {
      lim = n;
      return q;
    },
    then(res: (v: { data: Row[]; error: null }) => unknown) {
      const data = (tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, lim);
      return Promise.resolve({ data, error: null }).then(res);
    },
  };
  return q;
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tenant: string) => ({
    from: (table: string) => ({
      select: () => query(table, tenant),
      insert: (row: Row) => {
        const run = () => {
          tables[table] ??= [];
          if (table === "agent_runs" && tables[table]!.some((r) => r.cron_dedupe_key === row.cron_dedupe_key)) {
            return { data: null, error: { code: "23505", message: "duplicate key" } };
          }
          const id = `run-${nextId++}`;
          tables[table]!.push({ ...row, id, tenant_id: tenant });
          return { data: [{ id }], error: null };
        };
        const chain = { select: () => chain, limit: () => chain, then: (res: (v: unknown) => unknown) => Promise.resolve(run()).then(res) };
        return chain;
      },
    }),
  }),
}));

const cgoAdBudget = vi.fn();
const cgoApproveChannelAction = vi.fn();
vi.mock("../cgo-ads", () => ({
  cgoAdBudget: (...a: unknown[]) => cgoAdBudget(...a),
  cgoApproveChannelAction: (...a: unknown[]) => cgoApproveChannelAction(...a),
}));
const authorizeUnattended = vi.fn();
const askFounderAboutHeld = vi.fn().mockResolvedValue(true);
vi.mock("../unattended-policy", () => ({ authorizeUnattended: (...a: unknown[]) => authorizeUnattended(...a), askFounderAboutHeld: (...a: unknown[]) => askFounderAboutHeld(...a) }));
const tellQuietHold = vi.fn().mockResolvedValue(false);
vi.mock("../ad-holds", () => ({ tellQuietHold: (...a: unknown[]) => tellQuietHold(...a) }));

let approveAtDoor = true;
const recordChannelExecAction = vi.fn(async (input: { tenantId: string; runId: string; channelSlug: string; execClass: string; execPayload: Row; body: Row; title: string }, _rpc?: unknown, deps?: { enabled?: () => boolean }) => {
  expect(deps?.enabled?.()).toBe(false);
  tables.channel_actions ??= [];
  const id = `ca-${nextId++}`;
  tables.channel_actions.push({
    id,
    tenant_id: input.tenantId,
    run_id: input.runId,
    channel_slug: input.channelSlug,
    exec_class: input.execClass,
    exec_payload: input.execPayload,
    body: input.body,
    title: input.title,
    status: "pending",
    exec_status: approveAtDoor ? "queued" : null,
    approved_by_source: approveAtDoor ? "cgo" : null,
  });
  return { id, replayed: false };
});
vi.mock("@/services/channels/exec-actions", () => ({ recordChannelExecAction: (...a: unknown[]) => recordChannelExecAction(...(a as Parameters<typeof recordChannelExecAction>)) }));

const resolveCreateAdSetBid = vi.fn();
vi.mock("@/services/tools/meta-ads/write/_ad-set-bid", () => ({ resolveCreateAdSetBid: (...a: unknown[]) => resolveCreateAdSetBid(...a) }));

import { submitCgoAdAction, ensureCgoOrderRun, orderActionType, CGO_ORDER_KEY, plannedAmount, plannerProblem, plannerEvidence } from "../cgo-ad-orders";

const T = "22222222-2222-2222-2222-222222222222";
const NOW = new Date("2026-10-02T15:41:00Z");
const raise = {
  tenant_id: T,
  channel_slug: "meta_ads" as const,
  exec_class: "meta_ads.update_ad_set_budget",
  body: { ad_set_id: "123", daily_budget_usd: 200, expected_current_daily_budget_usd: 100, rationale: "behind pace", over_cap: false },
  reason: "Autopilot budget is behind pace.",
  idempotency_key: `${T}:obj:meta:123:2026-10-02T15`,
  dwell_key: "obj:meta:123",
  now: NOW,
  planner: { kind: "raise" as const, required_usd: 900, capacity_usd: 500, gap_usd: 400, room_usd: 400, from_usd: 100, step: 1 },
};

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  approveAtDoor = true;
  recordChannelExecAction.mockClear();
  cgoApproveChannelAction.mockReset();
  cgoAdBudget.mockReset().mockResolvedValue({ id: "budget" });
  authorizeUnattended.mockReset().mockResolvedValue({ verdict: "allow", reasons: [] });
  resolveCreateAdSetBid.mockReset();
});

describe("submitCgoAdAction", () => {
  const createOrder = {
    ...raise,
    exec_class: "meta_ads.create_ad_set",
    body: {
      campaign_id: "120000000000000001",
      name: "Retargeting: website visitors 30 days",
      daily_budget_usd: 20,
      optimization_goal: "OFFSITE_CONVERSIONS",
      billing_event: "IMPRESSIONS",
      targeting: { geo_locations: { countries: ["US"] }, custom_audiences: [{ id: "555" }] },
      promoted_object: { pixel_id: "777", custom_event_type: "PURCHASE" },
      rationale: "win back visitors",
    },
    idempotency_key: `${T}:rt:create:2026-10-02T15`,
    dwell_key: "rt:create",
    planner: { kind: "retarget_create" as const, required_usd: 900, capacity_usd: 500, gap_usd: 400, cap_usd: 20 },
  };

  it("a new ad set's bid is settled before anything is filed: the filed body and the gate carry the stamped bid", async () => {
    resolveCreateAdSetBid.mockImplementation(async (_t: string, b: Row) => ({ ...b, campaign_bid_strategy: "COST_CAP", bid_amount_usd: 32, bid_copied_from: { ad_sets: 2, result: "Purchase" } }));
    const r = await submitCgoAdAction(createOrder);
    expect(r.ok).toBe(true);
    const row = tables.channel_actions![0]!;
    expect(row.exec_payload).toMatchObject({ campaign_bid_strategy: "COST_CAP", bid_amount_usd: 32 });
    expect(authorizeUnattended).toHaveBeenCalledWith(T, expect.objectContaining({ payload: expect.objectContaining({ bid_amount_usd: 32 }) }), expect.anything());
  });

  it("a bid that cannot be settled files nothing", async () => {
    resolveCreateAdSetBid.mockRejectedValue(Object.assign(new Error("no ad set buying Purchase has a bid"), { code: "meta_ads_bid_unavailable" }));
    const r = await submitCgoAdAction(createOrder);
    expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/^bid:meta_ads_bid_unavailable:/) });
    expect(recordChannelExecAction).not.toHaveBeenCalled();
  });

  it("records through the channel_actions writer with the CGO approval, keyed and anchored", async () => {
    const r = await submitCgoAdAction(raise);
    expect(r).toEqual({ ok: true, action_id: expect.stringMatching(/^ca-/) });
    expect(recordChannelExecAction).toHaveBeenCalledTimes(1);
    const row = tables.channel_actions![0]!;
    expect(row.exec_payload).toEqual(raise.body);
    expect((row.body as Row)[CGO_ORDER_KEY]).toBe(raise.idempotency_key);
    expect((row.body as Row).cgo_dwell_key).toBe("obj:meta:123");
    const run = tables.agent_runs![0]!;
    expect(row.run_id).toBe(run.id);
    expect(run).toMatchObject({ agent_slug: "meta_ads", channel_slug: "meta_ads", status: "success", cost_usd: 0, cron_dedupe_key: `${T}:cgo_ad_orders:meta_ads:2026-10-02T15` });
    expect(authorizeUnattended).toHaveBeenCalledWith(T, expect.objectContaining({ kind: "ad", exec_class: raise.exec_class, payload: raise.body }), expect.anything());
  });

  it("the same key again (a re-run in the same hour) writes nothing new", async () => {
    const a = await submitCgoAdAction(raise);
    const b = await submitCgoAdAction({ ...raise, now: new Date(NOW.getTime() + 15 * 60_000) });
    expect(b).toEqual({ ok: true, action_id: (a as { action_id: string }).action_id, replayed: true });
    expect(recordChannelExecAction).toHaveBeenCalledTimes(1);
    expect(tables.channel_actions).toHaveLength(1);
    expect(cgoApproveChannelAction).toHaveBeenCalledWith(T, (a as { action_id: string }).action_id);
  });

  it("not on Autopilot with a budget: nothing is written", async () => {
    cgoAdBudget.mockResolvedValue(null);
    expect(await submitCgoAdAction(raise)).toEqual({ ok: false, why: "not_running_ads" });
    expect(recordChannelExecAction).not.toHaveBeenCalled();
    expect(tables.agent_runs).toBeUndefined();
  });

  it("held by the unattended gate: no card is filed, but the founder gets ONE deduped question (GS02)", async () => {
    authorizeUnattended.mockResolvedValue({ verdict: "ask_founder", reasons: ["founder_paused_it"] });
    expect(await submitCgoAdAction(raise)).toEqual({ ok: false, why: "held:founder_paused_it" });
    expect(recordChannelExecAction).not.toHaveBeenCalled();
    expect(askFounderAboutHeld).toHaveBeenCalledTimes(1);
    expect(askFounderAboutHeld.mock.calls[0][1]).toMatchObject({ kind: "ad", exec_class: raise.exec_class });
  });

  it("decision (i): a raise held only for the founder's own budget is shown on the Growth page and NOT asked", async () => {
    askFounderAboutHeld.mockClear();
    tellQuietHold.mockResolvedValueOnce(true);
    const reasons = ["founder_set_budget|outside|2026-10-12|meta|up"];
    authorizeUnattended.mockResolvedValue({ verdict: "ask_founder", reasons });
    expect(await submitCgoAdAction(raise)).toEqual({ ok: false, why: `held:${reasons[0]}` });
    expect(tellQuietHold.mock.calls.at(-1)?.[3]).toEqual(reasons);
    expect(askFounderAboutHeld).not.toHaveBeenCalled();
    expect(recordChannelExecAction).not.toHaveBeenCalled();
  });

  it("must-not: when the Growth-page line could not be written, the held raise is still asked (never invisible)", async () => {
    askFounderAboutHeld.mockClear();
    tellQuietHold.mockResolvedValueOnce(false);
    authorizeUnattended.mockResolvedValue({ verdict: "ask_founder", reasons: ["budget_test_running|2026-10-28"] });
    await submitCgoAdAction(raise);
    expect(askFounderAboutHeld).toHaveBeenCalledTimes(1);
  });

  it("a deny hold files nothing and asks nothing: policy says never, there is nothing to resolve", async () => {
    askFounderAboutHeld.mockClear();
    authorizeUnattended.mockResolvedValue({ verdict: "deny", reasons: ["class_not_on_unattended_list"] });
    expect(await submitCgoAdAction(raise)).toEqual({ ok: false, why: "held:class_not_on_unattended_list" });
    expect(askFounderAboutHeld).not.toHaveBeenCalled();
  });

  it("recorded but not approved at the door: reported as not approved", async () => {
    approveAtDoor = false;
    expect(await submitCgoAdAction(raise)).toEqual({ ok: false, why: "not_approved" });
  });

  it("a class of the other channel is refused", async () => {
    expect(await submitCgoAdAction({ ...raise, channel_slug: "google_ads" })).toEqual({ ok: false, why: "class_not_of_channel" });
  });

  it("one anchor run per tenant, channel and hour; a race on the key reuses the winner", async () => {
    const a = await ensureCgoOrderRun(T, "google_ads", NOW);
    const b = await ensureCgoOrderRun(T, "google_ads", new Date(NOW.getTime() + 60_000));
    const c = await ensureCgoOrderRun(T, "google_ads", new Date(NOW.getTime() + 3_600_000));
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it("files duplicates and creates as create_ad, an audience as setup, a switch-on as update_ad", () => {
    expect(orderActionType("meta_ads.duplicate_ad_set", {})).toBe("create_ad");
    expect(orderActionType("meta_ads.create_ad", {})).toBe("create_ad");
    expect(orderActionType("meta_ads.create_custom_audience", {})).toBe("setup");
    expect(orderActionType("meta_ads.set_status", { status: "ACTIVE" })).toBe("update_ad");
    expect(orderActionType("google_ads.update_campaign_budget", {})).toBe("update_ad");
  });
});

describe("planner numbers on every controller order (gaps E)", () => {
  it("must catch: an amount the planner's numbers do not give is refused before anything is written", async () => {
    const r = await submitCgoAdAction({ ...raise, body: { ...raise.body, daily_budget_usd: 260 } });
    expect(r).toEqual({ ok: false, why: "planner_mismatch: body 260, planned 200" });
    expect(recordChannelExecAction).not.toHaveBeenCalled();
  });

  it("must catch: a budget-bearing order with no planner numbers is refused", async () => {
    const { planner: _drop, ...bare } = raise;
    const r = await submitCgoAdAction(bare);
    expect(r).toEqual({ ok: false, why: "no_planner_numbers" });
  });

  it("must not catch: a rounding cent, or an order with no amount (a switch-on)", () => {
    expect(plannerProblem("meta_ads.update_ad_set_budget", { ...raise.body, daily_budget_usd: 200.01 }, raise.planner)).toBeNull();
    expect(plannerProblem("meta_ads.set_status", { object_id: "1", status: "ACTIVE" }, undefined)).toBeNull();
  });

  it("the planner's numbers go on the card as evidence and as stored numbers", async () => {
    await submitCgoAdAction(raise);
    const card = recordChannelExecAction.mock.calls[0]![0].body as Record<string, any>;
    expect(card.cgo_planner).toMatchObject({ kind: "raise", from_usd: 100 });
    expect(card.step.evidence.join(" ")).toContain("$100.00 to $200.00 a day");
  });

  it("a cut's card says the surplus it comes out of, not an open gap", () => {
    const lines = plannerEvidence({ kind: "cut", required_usd: 650, capacity_usd: 700, gap_usd: 0, surplus_usd: 50, from_usd: 400, step: 0.2 });
    expect(lines[0]).toContain("$50.00/day above what is needed");
    expect(lines.join(" ")).not.toContain("still open");
  });

  it("must not catch: the controller's own rounding of a $33.33 raise by 20% ($40.00) passes the check", () => {
    const planner = { kind: "raise" as const, required_usd: 500, capacity_usd: 100, gap_usd: 400, room_usd: 400, from_usd: 33.33, step: 0.2 };
    expect(plannedAmount(planner)).toBe(40);
    expect(plannerProblem("meta_ads.update_ad_set_budget", { ad_set_id: "1", daily_budget_usd: 40, expected_current_daily_budget_usd: 33.33 }, planner)).toBeNull();
  });

  it("each kind recomputes its amount", () => {
    const base = { required_usd: 0, capacity_usd: 0, gap_usd: 0 };
    expect(plannedAmount({ ...base, kind: "raise", from_usd: 80, step: 0.2, room_usd: 10 })).toBe(90);
    expect(plannedAmount({ ...base, kind: "cut", from_usd: 333, step: 0.2 })).toBe(266.4);
    expect(plannedAmount({ ...base, kind: "copy", cap_usd: 50, floor_usd: 5, share_usd: 2 })).toBe(5);
    expect(plannedAmount({ ...base, kind: "retarget_raise", from_usd: 10, step: 1, cap_usd: 15 })).toBe(15);
    expect(plannedAmount({ ...base, kind: "switch_on", from_usd: 10 })).toBeNull();
  });
});
