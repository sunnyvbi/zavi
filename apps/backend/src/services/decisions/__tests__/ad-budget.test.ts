import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";

const rpc = vi.fn();
const budgetRow = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc,
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "limit"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: budgetRow.value, error: null });
      return q;
    },
  }),
}));

import {
  budgetMargin,
  dropAdSpendHold,
  holdsOneDay,
  releaseIdleAdHolds,
  shrinkUnderdeliveringAdHolds,
  isDefinitePlatformRejection,
  noteAdSpendObject,
  noteAdSpendRef,
  beforeSend,
  parseMonthView,
  prefixAdName,
  overProjectionGate,
  readActiveAdBudget,
  reserveAdSpend,
  runAdBudgetChecks,
  settleAdSpendAfterError,
} from "../ad-budget";
import { ExpectedToolError } from "@/services/tools/types";
import { shapeCreateAdSetRequest } from "@/services/tools/meta-ads/write/_request-shapers";
import { shapeCreateCampaignOperations } from "@/services/tools/google-ads/write/_request-shapers";

const D = { id: "dec-1", tenant_id: "tenant-1" };
const RAISE = { platform: "meta" as const, op: "raise" as const, object_id: "as1", daily_delta_usd: 10 };

beforeEach(() => {
  rpc.mockReset();
  budgetRow.value = null;
  vi.spyOn(overProjectionGate, "read").mockResolvedValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a bounded resume's observed spend", () => {
  it("reserves multiple budget owners with distinct keys but the original approval link", async () => {
    rpc.mockResolvedValue({ data: { status: "held", amount_usd: 10 }, error: null });
    const d = { ...D, exec_source: "channel_actions" };
    for (const id of ["201", "202"]) await reserveAdSpend(d, { platform: "tiktok", op: "resume", object_id: id, daily_delta_usd: 30, currency: "USD", object_scope: true });
    const calls = rpc.mock.calls.filter(([name]) => name === "reserve_ad_spend");
    expect(calls.map(([,args]) => args.p_idem_key)).toEqual(["dec-1:resume:201", "dec-1:resume:202"]);
    expect(calls.every(([,args]) => args.p_channel_action_id === "dec-1")).toBe(true);
  });
  const RESUME = { platform: "linkedin" as const, op: "resume" as const, object_id: "b1", daily_delta_usd: 10, lifetime_usd: 60, ends_on: "2026-12-01" };
  it("reaches the hold, rounded up so rounding never lowers the baseline and shrinks a hold", async () => {
    rpc.mockResolvedValue({ data: { status: "held", amount_usd: 60 }, error: null });
    await reserveAdSpend(D, { ...RESUME, observed_usd: 40.001 });
    expect(rpc).toHaveBeenCalledWith("reserve_ad_spend", expect.objectContaining({ p_cap_usd: 60, p_observed_usd: 40.01 }));
  });
  it.each([[Number.NaN], [-1], [Number.POSITIVE_INFINITY]])("%s never reaches the hold", async (observed_usd) => {
    rpc.mockResolvedValue({ data: { status: "held", amount_usd: 60 }, error: null });
    expect(await reserveAdSpend(D, { ...RESUME, observed_usd })).toMatchObject({ status: "refused" });
    expect(rpc).not.toHaveBeenCalledWith("reserve_ad_spend", expect.anything());
  });
  it("is never sent for a raise, whose hold has no baseline", async () => {
    rpc.mockResolvedValue({ data: { status: "held", amount_usd: 10 }, error: null });
    await reserveAdSpend(D, { ...RAISE, observed_usd: 40 });
    expect(rpc.mock.calls.find(([name]) => name === "reserve_ad_spend")![1]).not.toHaveProperty("p_observed_usd");
  });
});

it("requires confirmed hold release when a launch needs a safe new attempt", async () => {
  const hold = { status: "held" as const, tenant_id: "tenant-1", idem_key: "launch:resume", fresh: true };
  rpc.mockResolvedValue({ data: null, error: { message: "release unavailable" } });
  await expect(dropAdSpendHold(hold, { strict: true })).rejects.toThrow("release unavailable");
  await expect(dropAdSpendHold(hold)).resolves.toBeUndefined();
  rpc.mockResolvedValue({ data: { status: "committed" }, error: null });
  await expect(dropAdSpendHold(hold, { strict: true })).rejects.toThrow("cleanup could not be confirmed");
  rpc.mockResolvedValue({ data: { status: "released" }, error: null });
  await expect(dropAdSpendHold(hold, { strict: true })).resolves.toBeUndefined();
});

describe("a platform whose spend could not be read takes no new spend", () => {
  it("a login problem (read_failure_kinds auth): the refusal names the platform and tells the founder to reconnect", async () => {
    rpc.mockResolvedValue({ data: { status: "refused", reason: "platform_unread", amount_usd: 0 }, error: null });
    budgetRow.value = { read_failure_kinds: { meta: "auth" } };
    const r = await reserveAdSpend(D, RAISE);
    expect(r).toEqual({ status: "refused", error: expect.stringMatching(/^cap_refuse: ad_budget_platform_unread: Meta Ads spend could not be read.*Reconnect it in Settings/) });
  });

  it("busy, down or unknown: still refused, worded as wait-until-it-reads, never reconnect", async () => {
    rpc.mockResolvedValue({ data: { status: "refused", reason: "platform_unread", amount_usd: 0 }, error: null });
    for (const row of [{ read_failure_kinds: { meta: "rate_limited" } }, { read_failure_kinds: {} }, null]) {
      budgetRow.value = row;
      const r = await reserveAdSpend(D, RAISE);
      expect(r.status).toBe("refused");
      const error = (r as { error: string }).error;
      expect(error).toContain("Meta Ads spend couldn't be read this hour; budget raises on Meta Ads wait until it reads again");
      expect(error).not.toMatch(/Reconnect/i);
    }
  });
});

describe("isDefinitePlatformRejection", () => {
  it("true only for a 4xx on the write, or a refusal raised before sending", () => {
    expect(isDefinitePlatformRejection(new ExpectedToolError("meta_ads_write_failed", "Meta Ads write failed: 400 x"))).toBe(true);
    expect(isDefinitePlatformRejection(new ExpectedToolError("google_ads_mutate_failed", "Google Ads googleAds:mutate failed: 403 x"))).toBe(true);
    expect(isDefinitePlatformRejection(new ExpectedToolError("meta_ads_adset_name_exists", "exists"))).toBe(true);
  });
  it("false for 5xx, timeouts, a read failing, a 200 with success:false, or a plain Error", () => {
    expect(isDefinitePlatformRejection(new ExpectedToolError("meta_ads_write_failed", "Meta Ads write failed: 502 x"))).toBe(false);
    expect(isDefinitePlatformRejection(new ExpectedToolError("meta_ads_timeout", "Meta Graph API did not respond"))).toBe(false);
    expect(isDefinitePlatformRejection(new ExpectedToolError("meta_ads_query_failed", "Meta Ads request failed: 400 x"))).toBe(false);
    expect(isDefinitePlatformRejection(new Error("Meta Ads write failed: 400 x"))).toBe(false);
  });
});

describe("a launch whose object was confirmed switched off again", () => {
  it("is definite (nothing it made can spend), so a fresh hold is given back; outcome-unknown never is", async () => {
    const off = new ExpectedToolError("meta_ads_launch_switched_off", "The copy 123 was switched off");
    const unknown = new ExpectedToolError("meta_ads_launch_outcome_unknown", "The copy 123 may be live");
    expect(isDefinitePlatformRejection(off)).toBe(true);
    expect(isDefinitePlatformRejection(unknown)).toBe(false);
    rpc.mockResolvedValue({ data: { status: "released" }, error: null });
    const hold = { status: "held" as const, tenant_id: "tenant-1", idem_key: "a:create", fresh: true };
    await settleAdSpendAfterError(hold, unknown);
    expect(rpc).not.toHaveBeenCalled();
    await settleAdSpendAfterError(hold, off);
    expect(rpc).toHaveBeenCalledWith("settle_ad_spend", expect.objectContaining({ p_idem_key: "a:create", p_outcome: "released" }));
  });
});

describe("noteAdSpendObject", () => {
  it("stamps the new object on this tenant's open hold; never throws; nothing without a hold", async () => {
    rpc.mockResolvedValue({ data: { status: "noted" }, error: null });
    await noteAdSpendObject({ status: "held", tenant_id: "tenant-1", idem_key: "a:create", fresh: true }, "120200000099");
    expect(rpc).toHaveBeenCalledWith("note_ad_spend_object", { p_tenant_id: "tenant-1", p_idem_key: "a:create", p_object_id: "120200000099" });
    rpc.mockReset();
    rpc.mockRejectedValue(new Error("down"));
    await expect(noteAdSpendObject({ status: "held", tenant_id: "tenant-1", idem_key: "a:create", fresh: true }, "1")).resolves.toBeUndefined();
    rpc.mockReset();
    await noteAdSpendObject({ status: "no_budget" }, "1");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("reserveAdSpend fails closed", () => {
  it("an RPC error refuses", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "PGRST202 function not found" } });
    const h = await reserveAdSpend(D, RAISE);
    expect(h.status).toBe("refused");
  });
  it("a thrown client refuses", async () => {
    rpc.mockImplementation(() => {
      throw new Error("socket hang up");
    });
    expect((await reserveAdSpend(D, RAISE)).status).toBe("refused");
  });
  it("an answer it does not recognise refuses", async () => {
    rpc.mockResolvedValue({ data: { status: "maybe" }, error: null });
    expect((await reserveAdSpend(D, RAISE)).status).toBe("refused");
    rpc.mockResolvedValue({ data: null, error: null });
    expect((await reserveAdSpend(D, RAISE)).status).toBe("refused");
  });
  it("a month refusal carries its reason", async () => {
    rpc.mockResolvedValue({ data: { status: "refused", reason: "over_month" }, error: null });
    expect(await reserveAdSpend(D, RAISE)).toEqual({ status: "refused", error: "cap_refuse: ad_budget_over_month" });
    rpc.mockResolvedValue({ data: { status: "refused", reason: null }, error: null });
    expect(await reserveAdSpend(D, RAISE)).toEqual({ status: "refused", error: "cap_refuse: ad_budget_over_month" });
  });
  it("object_busy says another change to the ad is still in flight", async () => {
    rpc.mockResolvedValue({ data: { status: "refused", reason: "object_busy", amount_usd: 0 }, error: null });
    expect(await reserveAdSpend(D, RAISE)).toEqual({
      status: "refused",
      error: "cap_refuse: ad_budget_object_busy: another change to this ad is still in flight; try again shortly",
    });
  });
  it("held and already_held are holds; only held is fresh", async () => {
    rpc.mockResolvedValue({ data: { status: "held", amount_usd: 10, month_cap_usd: 3000 }, error: null });
    expect(await reserveAdSpend(D, RAISE)).toEqual({ status: "held", tenant_id: "tenant-1", idem_key: "dec-1:raise", fresh: true });
    rpc.mockResolvedValue({ data: { status: "already_held", amount_usd: 10 }, error: null });
    expect(await reserveAdSpend(D, RAISE)).toMatchObject({ status: "held", fresh: false });
  });
  it("a negative or non-finite delta is refused before the RPC", async () => {
    expect((await reserveAdSpend(D, { ...RAISE, daily_delta_usd: -1 })).status).toBe("refused");
    expect((await reserveAdSpend(D, { ...RAISE, daily_delta_usd: Number.NaN })).status).toBe("refused");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("a sub-cent raise holds a cent, never 0", async () => {
    rpc.mockResolvedValue({ data: { status: "no_budget" }, error: null });
    await reserveAdSpend(D, { ...RAISE, daily_delta_usd: 10.004 - 10 });
    expect(rpc.mock.calls[0][1].p_daily_delta_usd).toBe(0.01);
  });
  it("sends the tenant it was given and whole cents, never an amount", async () => {
    rpc.mockResolvedValue({ data: { status: "no_budget" }, error: null });
    await reserveAdSpend(D, { ...RAISE, daily_delta_usd: 80.1 - 40 });
    expect(rpc).toHaveBeenCalledWith("reserve_ad_spend", {
      p_idem_key: "dec-1:raise",
      p_platform: "meta",
      p_op: "raise",
      p_object_id: "as1",
      p_daily_delta_usd: 40.1,
      p_decision_id: "dec-1",
      p_tenant_id: "tenant-1",
    });
  });

  it("links the hold to the card on the channel-action rail, never to a decision (autopilot tracking T1)", async () => {
    rpc.mockResolvedValue({ data: { status: "no_budget" }, error: null });
    await reserveAdSpend({ ...D, id: "act-1", exec_source: "channel_actions" }, RAISE);
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args.p_channel_action_id).toBe("act-1");
    expect(args).not.toHaveProperty("p_decision_id");
  });
});

describe("a hold found by a retry is never given back", () => {
  const found = { status: "held" as const, tenant_id: "tenant-1", idem_key: "dec-1:raise", fresh: false };
  it("not on a 4xx, not on a refused check", async () => {
    await settleAdSpendAfterError(found, new ExpectedToolError("meta_ads_write_failed", "Meta Ads write failed: 400 x"));
    const r = await runAdBudgetChecks(found, async () => "cbo_campaign_in_budget");
    expect(r).toBe("cap_refuse: ad_budget_cbo_campaign_in_budget");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("a fresh hold IS given back when its check throws", async () => {
    rpc.mockResolvedValue({ data: { status: "released" }, error: null });
    const r = await runAdBudgetChecks({ ...found, fresh: true }, async () => {
      throw new Error("graph down");
    });
    expect(r).toBe("cap_refuse: ad_budget_check_failed");
    expect(rpc).toHaveBeenCalledWith("settle_ad_spend", expect.objectContaining({ p_outcome: "released", p_idem_key: "dec-1:raise" }));
  });
});

describe("a create under a monthly budget: name prefix, no end date", () => {
  it("prefixes once and within the length limit", () => {
    expect(prefixAdName("Spring", 255)).toBe("Zavi · Spring");
    expect(prefixAdName("Zavi · Spring", 255)).toBe("Zavi · Spring");
    expect(prefixAdName("x".repeat(300), 255)).toHaveLength(255);
  });
  it("a Meta ad set is created with no end_time", () => {
    const base = {
      campaign_id: "c1",
      name: "n",
      daily_budget_usd: 10,
      optimization_goal: "LINK_CLICKS",
      billing_event: "IMPRESSIONS",
      targeting: { geo_locations: { countries: ["US"] } },
    };
    expect(shapeCreateAdSetRequest(base, "USD", "act_1").params).not.toHaveProperty("end_time");
  });
  it("a Google campaign is created with no endDateTime", () => {
    const body = {
      name: "n",
      channel_type: "SEARCH" as const,
      daily_budget_usd: 10,
      bidding: { strategy: "MANUAL_CPC" as const },
      location_ids: [],
      excluded_location_ids: [],
      language_ids: [],
      negative_keywords: [],
      rationale: "",
    } as unknown as Parameters<typeof shapeCreateCampaignOperations>[0];
    const create = (shapeCreateCampaignOperations(body, "123").ops[1] as { create?: unknown }).create;
    expect(create).toMatchObject({ status: "PAUSED" });
    expect(create).not.toHaveProperty("endDateTime");
  });
});

describe("this month's numbers come from ad_budget_month_view", () => {
  const VIEW = {
    id: "b-1",
    status: "active",
    monthly_usd: 3000,
    month_cap_usd: "1100.00",
    spent_usd: "400.00",
    held_usd: "600.00",
    left_usd: "100.00",
    creator_held_usd: "25.00",
    creator_spent_usd: "75.50",
    daily_limit_usd: null,
    started_on: "2026-09-20",
    created_at: "2026-09-20T10:00:00Z",
    stopped_at: null,
    month_start: "2026-09-01",
    next_month_start: "2026-10-01",
    days_left: 6,
    days_in_month: 30,
  };
  it("reads the active budget through the tenant-bound RPC, numbers as numbers", async () => {
    rpc.mockResolvedValue({ data: VIEW, error: null });
    expect(await readActiveAdBudget("tenant-1")).toEqual({
      id: "b-1",
      monthly_usd: 3000,
      month_cap_usd: 1100,
      spent_usd: 400,
      held_usd: 600,
      left_usd: 100,
      creator_held_usd: 25,
      creator_spent_usd: 75.5,
      daily_limit_usd: null,
      next_month_start: "2026-10-01",
      days_left: 6,
      days_in_month: 30,
    });
    expect(rpc).toHaveBeenCalledWith("ad_budget_month_view", { p_tenant_id: "tenant-1" });
  });
  it("a stopped budget, or none, is no active budget", async () => {
    rpc.mockResolvedValue({ data: { ...VIEW, status: "stopped" }, error: null });
    expect(await readActiveAdBudget("tenant-1")).toBeNull();
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await readActiveAdBudget("tenant-1")).toBeNull();
  });
  it("a read error or an unreadable number throws (each caller picks its safe side)", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "down" } });
    await expect(readActiveAdBudget("tenant-1")).rejects.toThrow(/down/);
    expect(() => parseMonthView({ ...VIEW, held_usd: "abc" })).toThrow(/held_usd/);
    expect(() => parseMonthView({ ...VIEW, status: "ended" })).toThrow(/unreadable budget/);
  });
});

describe("budgetMargin reads ad_budgets.margin, 1.0 when it cannot", () => {
  it("is the budget's own margin", () => {
    expect(budgetMargin({ margin: 1.25 })).toBe(1.25);
    expect(budgetMargin({ margin: 1 })).toBe(1);
  });
  it("defaults to 1.0 (never the old hardcoded 1.25) when absent or unreadable", () => {
    expect(budgetMargin({})).toBe(1);
    expect(budgetMargin(null)).toBe(1);
    expect(budgetMargin({ margin: Number.NaN })).toBe(1);
    expect(budgetMargin({ margin: 0.5 })).toBe(1);
  });
  it("the month view carries margin and the last whole read", () => {
    const v = parseMonthView({
      id: "b-1", status: "active", monthly_usd: 1, month_cap_usd: 1, spent_usd: 0, held_usd: 0, left_usd: 1,
      creator_held_usd: 0, creator_spent_usd: 0, margin: "1.00", actual_read_at: "2026-10-10T10:00:00Z",
    });
    expect(v?.margin).toBe(1);
    expect(v?.actual_read_at).toBe("2026-10-10T10:00:00Z");
    expect(budgetMargin(v)).toBe(1);
  });
});

describe("test 5: a PAUSED create approved by the CGO holds one day", () => {
  const CREATE = { platform: "meta" as const, op: "create" as const, object_id: null, daily_delta_usd: 300 };
  it("holdsOneDay: only a CGO-approved create of a class that starts paused", () => {
    expect(holdsOneDay({ decision_class: "meta_ads.create_ad_set", approved_by_source: "cgo" }, CREATE)).toBe(true);
    expect(holdsOneDay({ decision_class: "google_ads.create_campaign", approved_by_source: "cgo" }, CREATE)).toBe(true);
    expect(holdsOneDay({ decision_class: "meta_ads.create_ad_set", approved_by_source: null }, CREATE)).toBe(false);
    expect(holdsOneDay({ decision_class: "meta_ads.create_ad_set" }, CREATE)).toBe(false);
    expect(holdsOneDay({ decision_class: "meta_ads.create_ad_set", approved_by_source: "cgo" }, { ...CREATE, op: "raise" })).toBe(false);
    expect(holdsOneDay({ decision_class: "meta_ads.duplicate_ad_set", approved_by_source: "cgo" }, CREATE)).toBe(false);
    expect(holdsOneDay({ decision_class: "google_ads.create_campaign", approved_by_source: "cgo" }, { ...CREATE, paused: false })).toBe(false);
    expect(holdsOneDay({ decision_class: "x", approved_by_source: null }, { ...CREATE, paused: true })).toBe(true);
  });
  it("sends p_paused only when it holds one day, so every other write calls the RPC as before", async () => {
    rpc.mockResolvedValue({ data: { status: "held", amount_usd: 300 }, error: null });
    await reserveAdSpend({ ...D, decision_class: "meta_ads.create_ad_set", approved_by_source: "cgo" }, CREATE);
    expect((rpc.mock.calls[0][1] as Record<string, unknown>).p_paused).toBe(true);
    rpc.mockClear();
    await reserveAdSpend({ ...D, decision_class: "meta_ads.create_ad_set", approved_by_source: null }, CREATE);
    expect(rpc.mock.calls[0][1]).not.toHaveProperty("p_paused");
    rpc.mockClear();
    await reserveAdSpend(D, RAISE);
    expect(rpc.mock.calls[0][1]).not.toHaveProperty("p_paused");
  });
});

describe("hold upkeep never throws and stays on the caller's tenant", () => {
  it("passes the tenant through the tenant-bound RPC and reads the answer", async () => {
    rpc.mockResolvedValue({ data: { status: "done", released: 2, released_daily_usd: "350.00" }, error: null });
    expect(await releaseIdleAdHolds("tenant-1")).toEqual({ status: "done", released: 2, released_daily_usd: 350 });
    expect(rpc).toHaveBeenCalledWith("release_idle_ad_holds", { p_tenant_id: "tenant-1" });
    rpc.mockResolvedValue({ data: { status: "stale", shrunk: 0 }, error: null });
    expect(await shrinkUnderdeliveringAdHolds("tenant-1")).toEqual({ status: "stale", shrunk: 0 });
    expect(rpc).toHaveBeenLastCalledWith("shrink_underdelivering_ad_holds", { p_tenant_id: "tenant-1" });
  });
  it("an RPC error leaves the holds as they were", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "down" } });
    expect(await releaseIdleAdHolds("tenant-1")).toEqual({ status: "error" });
    rpc.mockImplementation(() => {
      throw new Error("socket");
    });
    expect(await shrinkUnderdeliveringAdHolds("tenant-1")).toEqual({ status: "error" });
  });
});

describe("GS01: a read before the write, and the label a create's hold carries", () => {
  const fresh = { status: "held" as const, tenant_id: "tenant-1", idem_key: "a:create", fresh: true };
  const retry = { ...fresh, fresh: false };
  const REF = { kind: "google_campaign_name" as const, name: "Zavi · Search" };

  it("a failed step before the write is a definite no-send: a fresh hold is given back, a retry's kept", async () => {
    const e = await beforeSend(async () => {
      throw new ExpectedToolError("meta_ads_query_failed", "Meta Ads request failed: 500 x");
    }).catch((x: unknown) => x);
    expect(isDefinitePlatformRejection(e)).toBe(true);
    rpc.mockResolvedValue({ data: { status: "released" }, error: null });
    await settleAdSpendAfterError(retry, e);
    expect(rpc).not.toHaveBeenCalled();
    await settleAdSpendAfterError(fresh, e);
    expect(rpc).toHaveBeenCalledWith("settle_ad_spend", expect.objectContaining({ p_outcome: "released" }));
    expect(await beforeSend(async () => 7)).toBe(7);
  });

  it("noteAdSpendRef: noted or unchanged goes ahead; an error or a hold that is not open refuses and gives a fresh hold back", async () => {
    rpc.mockResolvedValueOnce({ data: { status: "noted" }, error: null });
    expect(await noteAdSpendRef(fresh, REF)).toBeNull();
    expect(rpc).toHaveBeenCalledWith("note_ad_spend_ref", { p_tenant_id: "tenant-1", p_idem_key: "a:create", p_ref: REF });
    rpc.mockResolvedValueOnce({ data: { status: "unchanged" }, error: null });
    expect(await noteAdSpendRef(retry, REF)).toBeNull();

    rpc.mockReset();
    rpc.mockResolvedValueOnce({ data: null, error: { message: "down" } }).mockResolvedValue({ data: { status: "released" }, error: null });
    expect(await noteAdSpendRef(fresh, REF)).toContain("ad_budget_unavailable");
    expect(rpc).toHaveBeenLastCalledWith("settle_ad_spend", expect.objectContaining({ p_outcome: "released" }));

    rpc.mockReset();
    rpc.mockResolvedValue({ data: { status: "not_open" }, error: null });
    expect(await noteAdSpendRef(retry, REF)).toContain("ad_budget_unavailable");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(await noteAdSpendRef({ status: "no_budget" }, REF)).toBeNull();
  });
});

describe("a Meta hold on a non-USD (INR) ad account", () => {
  const INR_RAISE = { ...RAISE, daily_delta_usd: 4000, currency: "INR" };
  const ACTIVE_VIEW = {
    id: "b-1", status: "active", monthly_usd: 3000, month_cap_usd: "1100.00", spent_usd: "400.00",
    held_usd: "600.00", left_usd: "100.00", creator_held_usd: "0", creator_spent_usd: "0",
    daily_limit_usd: null, started_on: "2026-09-20", created_at: "2026-09-20T10:00:00Z",
    stopped_at: null, month_start: "2026-09-01", next_month_start: "2026-10-01",
  };

  it("runs without a hold when the tenant has no ad budget, and never holds rupees as dollars", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await reserveAdSpend(D, INR_RAISE)).toEqual({ status: "no_budget" });
    expect(rpc).not.toHaveBeenCalledWith("reserve_ad_spend", expect.anything());
  });

  it("is refused while an ad budget is active (the ledger counts dollars)", async () => {
    rpc.mockResolvedValue({ data: ACTIVE_VIEW, error: null });
    const h = await reserveAdSpend(D, INR_RAISE);
    expect(h.status).toBe("refused");
    expect(h.status === "refused" && h.error).toMatch(/^cap_refuse: ad_budget_non_usd_account/);
    expect(rpc).not.toHaveBeenCalledWith("reserve_ad_spend", expect.anything());
  });

  it("is refused when the budget cannot be read (fail closed)", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "down" } });
    expect((await reserveAdSpend(D, INR_RAISE)).status).toBe("refused");
  });

  it("a USD account (or no currency given) holds exactly as before", async () => {
    rpc.mockResolvedValue({ data: { status: "held" }, error: null });
    expect((await reserveAdSpend(D, { ...RAISE, currency: "USD" })).status).toBe("held");
    expect(rpc).toHaveBeenCalledWith("reserve_ad_spend", expect.objectContaining({ p_daily_delta_usd: 10 }));
  });
});

describe("decision D3: Autopilot adds no spend while the month is on track past the cap", () => {
  const over = { projection: { projected_usd: 27_186, month_cap_usd: 27_000, days_left: 10, over: true } };
  const under = { projection: { projected_usd: 26_000, month_cap_usd: 27_000, days_left: 10, over: false } };
  const tipping = { projection: { projected_usd: 26_950, month_cap_usd: 27_000, days_left: 10, over: false } };
  let read: MockInstance<Parameters<typeof overProjectionGate.read>, ReturnType<typeof overProjectionGate.read>>;
  const answer = (status: string) =>
    rpc.mockImplementation(async (name: string) =>
      name === "reserve_ad_spend" ? { data: { status, amount_usd: 50 }, error: null } : { data: { status: "released" }, error: null },
    );
  const settled = () => rpc.mock.calls.filter((c) => c[0] === "settle_ad_spend").map((c) => c[1]);

  beforeEach(() => {
    read = vi.spyOn(overProjectionGate, "read");
  });

  for (const [who, d] of [
    ["a cgo approval", { ...D, approved_by_source: "cgo" }],
    ["a null-approver auto change", D],
    ["a plan autopilot", { ...D, approved_by: "u1", approved_by_source: "plan_autopilot" }],
    ["an email source with no approver", { ...D, approved_by_source: "email" }],
  ] as const) {
    it(`${who}: refused as over_projection with the numbers, and the hold it took is given back`, async () => {
      answer("held");
      read.mockResolvedValue(over);
      const r = await reserveAdSpend(d, RAISE);
      expect(r).toEqual({
        status: "refused",
        error: "cap_refuse: ad_budget_over_projection: this month is on track for $27,186, $186 over your $27,000 cap, so Autopilot adds no spend. Approve it yourself to go ahead; nothing was sent",
      });
      expect(settled()).toEqual([expect.objectContaining({ p_idem_key: "dec-1:raise", p_outcome: "released" })]);
    });
  }

  it("the founder's own approval (a tap, or a verified email yes) goes through: the card warned them first (and nothing is read)", async () => {
    answer("held");
    read.mockResolvedValue(over);
    for (const d of [{ ...D, approved_by: "u1" }, { ...D, approved_by: "u1", approved_by_source: "email" }]) {
      expect(await reserveAdSpend(d, RAISE)).toMatchObject({ status: "held", fresh: true });
    }
    expect(read).not.toHaveBeenCalled();
    expect(settled()).toEqual([]);
  });

  it("a change the founder typed or staged themselves (server-stamped origin) goes through", async () => {
    answer("held");
    read.mockResolvedValue(over);
    for (const origin of ["user_initiated_chat", "user_initiated_ledger"]) {
      expect(await reserveAdSpend({ ...D, body: { origin } }, RAISE)).toMatchObject({ status: "held" });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("under the cap, Autopilot keeps its hold", async () => {
    answer("held");
    read.mockResolvedValue(under);
    expect(await reserveAdSpend({ ...D, approved_by_source: "cgo" }, RAISE)).toMatchObject({ status: "held", fresh: true });
    expect(settled()).toEqual([]);
  });

  it("Autopilot's change that would itself pass the cap is refused as over_projection_with_change (the dispatch turns it into the founder's card), hold given back", async () => {
    answer("held");
    read.mockResolvedValue(tipping);
    const r = await reserveAdSpend({ ...D, approved_by_source: "cgo" }, RAISE);
    expect(r).toEqual({
      status: "refused",
      error: "cap_refuse: ad_budget_over_projection_with_change: This puts you on track for $27,050 this month, $50 over your $27,000 cap, so Autopilot left it for you to approve; nothing was sent",
    });
    expect(settled()).toEqual([expect.objectContaining({ p_outcome: "released" })]);
  });

  it("must-catch (codex F1): the change is counted once; the check reads the month without this attempt's own hold", async () => {
    const near = { projection: { projected_usd: 9_500, month_cap_usd: 10_000, days_left: 10, over: false } };
    answer("held");
    read.mockResolvedValue(near);
    expect(await reserveAdSpend({ ...D, approved_by_source: "cgo" }, { ...RAISE, daily_delta_usd: 30 })).toMatchObject({ status: "held", fresh: true });
    expect(read).toHaveBeenLastCalledWith("tenant-1", "dec-1:raise");
    expect(settled()).toEqual([]);
    const r = await reserveAdSpend({ ...D, approved_by_source: "cgo" }, { ...RAISE, daily_delta_usd: 60 });
    expect(r).toEqual({ status: "refused", error: expect.stringContaining("ad_budget_over_projection_with_change: This puts you on track for $10,100 this month, $100 over your $10,000 cap") });
  });

  it("a retry that finds its own hold (already_held) also leaves that hold out of the count", async () => {
    answer("already_held");
    read.mockResolvedValue({ projection: { projected_usd: 9_500, month_cap_usd: 10_000, days_left: 10, over: false } });
    expect(await reserveAdSpend({ ...D, approved_by_source: "cgo" }, { ...RAISE, daily_delta_usd: 30 })).toMatchObject({ status: "held", fresh: false });
    expect(read).toHaveBeenLastCalledWith("tenant-1", "dec-1:raise");
  });

  it("the founder's own approval of a change that passes the cap is held as usual", async () => {
    answer("held");
    read.mockResolvedValue(tipping);
    expect(await reserveAdSpend({ ...D, approved_by: "u1", approved_by_source: "email" }, RAISE)).toMatchObject({ status: "held", fresh: true });
    expect(read).not.toHaveBeenCalled();
  });

  it("an unreadable projection refuses Autopilot (fail closed) and gives the hold back", async () => {
    answer("held");
    read.mockRejectedValue(new Error("ad_campaigns read failed"));
    const r = await reserveAdSpend({ ...D, approved_by_source: "cgo" }, RAISE);
    expect(r).toEqual({ status: "refused", error: expect.stringMatching(/^cap_refuse: ad_budget_unavailable: this month's projection could not be checked/) });
    expect(settled()).toHaveLength(1);
  });

  it("an unreadable projection on a retry never claims nothing was sent", async () => {
    answer("already_held");
    read.mockRejectedValue(new Error("your ad accounts have not been read yet"));
    const r = await reserveAdSpend({ ...D, approved_by_source: "cgo" }, RAISE);
    expect(r).toEqual({ status: "refused", error: expect.stringMatching(/an earlier attempt may have applied it, so check the ad account/) });
    expect(String((r as { error?: string }).error)).not.toMatch(/Nothing was sent/);
  });

  it("a change that adds nothing a day (a zero-delta resume) is not judged, even while over", async () => {
    answer("held");
    read.mockResolvedValue(over);
    expect(await reserveAdSpend({ ...D, approved_by_source: "cgo" }, { ...RAISE, op: "resume", daily_delta_usd: 0 })).toMatchObject({ status: "held" });
    expect(read).not.toHaveBeenCalled();
  });

  it("no budget reads nothing", async () => {
    read.mockResolvedValue(over);
    answer("no_budget");
    expect(await reserveAdSpend({ ...D, approved_by_source: "cgo" }, RAISE)).toEqual({ status: "no_budget" });
    expect(read).not.toHaveBeenCalled();
  });

  it("a retry that finds its own hold is judged again (a first refusal whose release failed must not pass) and keeps the hold", async () => {
    read.mockResolvedValue(over);
    answer("already_held");
    const r = await reserveAdSpend({ ...D, approved_by_source: "cgo" }, RAISE);
    expect(r).toEqual({ status: "refused", error: expect.stringContaining("ad_budget_over_projection") });
    expect((r as { error: string }).error).toContain("an earlier attempt may have applied it");
    expect(settled()).toEqual([]);
    read.mockResolvedValue(under);
    expect(await reserveAdSpend({ ...D, approved_by_source: "cgo" }, RAISE)).toMatchObject({ status: "held", fresh: false });
  });
});
