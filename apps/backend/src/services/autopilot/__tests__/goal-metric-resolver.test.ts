
import { describe, it, expect } from "vitest";
import {
  classifyTargetMetric,
  measureGoalMetric,
  computeWindowDays,
  isGoalOffTrack,
  SIGNUP_DB_WINDOW_DAYS,
  type MeasureDeps,
} from "../goal-metric-resolver";

const NOW = new Date("2026-07-02T12:00:00Z");

describe("classifyTargetMetric — v1 mapping", () => {
  it("maps booking-shaped metrics to the operator funnel", () => {
    expect(classifyTargetMetric("bookings")).toEqual({ kind: "operator_funnel" });
    expect(classifyTargetMetric("weekly_bookings")).toEqual({ kind: "operator_funnel" });
    expect(classifyTargetMetric("Bookings per week")).toEqual({ kind: "operator_funnel" });
  });

  it("maps native funnel steps (signup/activation/purchase/key_action)", () => {
    expect(classifyTargetMetric("signups")).toEqual({
      kind: "native_funnel",
      step: "signup",
    });
    expect(classifyTargetMetric("weekly sign-ups")).toEqual({
      kind: "native_funnel",
      step: "signup",
    });
    expect(classifyTargetMetric("activations")).toEqual({
      kind: "native_funnel",
      step: "activation",
    });
    expect(classifyTargetMetric("purchases")).toEqual({
      kind: "native_funnel",
      step: "purchase",
    });
    expect(classifyTargetMetric("orders_per_month")).toEqual({
      kind: "native_funnel",
      step: "purchase",
    });
    expect(classifyTargetMetric("key_action_count")).toEqual({
      kind: "native_funnel",
      step: "key_action",
    });
  });

  it("bookings win over other keywords (operator funnel is booking ground truth)", () => {
    expect(classifyTargetMetric("booked_orders")).toEqual({ kind: "operator_funnel" });
  });

  it("a RATE goal never resolves to a count (B8): no rate metric exists, so unresolved", () => {
    for (const m of ["activation_rate", "Activation rate", "conversion_rate", "signup rate", "booking conversion %", "CTR", "average booking value"]) {
      expect(classifyTargetMetric(m)).toEqual({ kind: "unresolved" });
    }
  });

  it("returns unresolved for anything it can't read (never guess)", () => {
    expect(classifyTargetMetric("nps")).toEqual({ kind: "unresolved" });
    expect(classifyTargetMetric("")).toEqual({ kind: "unresolved" });
  });

  describe("revenue metrics", () => {
    it("resolves mrr on a MONTHLY basis", () => {
      expect(classifyTargetMetric("mrr")).toEqual({ kind: "stripe_mrr", basis: "mrr" });
      expect(classifyTargetMetric("Grow MRR to $50k")).toEqual({
        kind: "stripe_mrr",
        basis: "mrr",
      });
    });

    it("resolves arr on an ANNUAL basis", () => {
      expect(classifyTargetMetric("ARR")).toEqual({ kind: "stripe_mrr", basis: "arr" });
    });

    it("matches across separators — 'arr_usd' must not fall through", () => {
      expect(classifyTargetMetric("arr_usd")).toEqual({ kind: "stripe_mrr", basis: "arr" });
      expect(classifyTargetMetric("mrr-target")).toEqual({
        kind: "stripe_mrr",
        basis: "mrr",
      });
    });

    it("does NOT resolve other revenue-family metrics — none of them is Stripe MRR", () => {
      for (const m of ["arpu", "aov", "ltv"]) {
        expect(classifyTargetMetric(m)).toEqual({ kind: "unresolved" });
      }
    });

    it("NEVER resolves GMV to Stripe MRR: it is booking value (money-goal measurer, 2026-10-11)", () => {
      expect(classifyTargetMetric("GMV")).toEqual({ kind: "booking_value" });
      expect(classifyTargetMetric("10x GMV")).toEqual({ kind: "booking_value" });
    });
  });

  it("resolves booking synonyms that /book/ misses", () => {
    expect(classifyTargetMetric("rentals")).toEqual({ kind: "operator_funnel" });
    expect(classifyTargetMetric("reservations")).toEqual({ kind: "operator_funnel" });
    expect(classifyTargetMetric("trips")).toEqual({ kind: "operator_funnel" });
  });
});

describe("measureGoalMetric — injected deps, never fabricates", () => {
  const deps = (over: Partial<MeasureDeps> = {}): MeasureDeps => ({
    readNativeStep: async () => null,
    readOperatorFunnelBookings: async () => null,
    readOperatorNewUsers: async () => null,
    readStripeMrr: async () => null,
    ...over,
  });

  describe("revenue basis conversion", () => {
    it("returns raw monthly MRR for an mrr-basis goal", async () => {
      const out = await measureGoalMetric({
        tenant_id: "t-1",
        target_metric: "mrr",
        goal_created_at: "2026-06-22T12:00:00Z",
        now: NOW,
        deps: deps({ readStripeMrr: async () => 5000 }),
      });
      expect(out).toEqual({
        measured: true,
        value: 5000,
        source: "stripe_mrr",
        unit: "usd",
        basis: "mrr",
      });
    });

    it("ANNUALIZES for an arr-basis goal so it can be compared to an annual target", async () => {
      const out = await measureGoalMetric({
        tenant_id: "t-1",
        target_metric: "ARR",
        goal_created_at: "2026-06-22T12:00:00Z",
        now: NOW,
        deps: deps({ readStripeMrr: async () => 5000 }),
      });
      expect(out).toEqual({
        measured: true,
        value: 60000,
        source: "stripe_mrr",
        unit: "usd",
        basis: "arr",
      });
    });

    it("an MRR target and an ARR target are NOT satisfied by the same value", async () => {
      const read = async () => 5000;
      const asMrr = await measureGoalMetric({
        tenant_id: "t-1",
        target_metric: "mrr",
        goal_created_at: null,
        now: NOW,
        deps: deps({ readStripeMrr: read }),
      });
      const asArr = await measureGoalMetric({
        tenant_id: "t-1",
        target_metric: "arr",
        goal_created_at: null,
        now: NOW,
        deps: deps({ readStripeMrr: read }),
      });
      expect(asMrr.measured && asMrr.value).toBe(5000);
      expect(asArr.measured && asArr.value).toBe(60000);
    });

    it("Stripe unavailable → unmeasured, never a fabricated zero", async () => {
      const out = await measureGoalMetric({
        tenant_id: "t-1",
        target_metric: "mrr",
        goal_created_at: null,
        now: NOW,
        deps: deps({ readStripeMrr: async () => null }),
      });
      expect(out).toEqual({ measured: false, reason: "stripe_mrr_unavailable" });
    });
  });

  it("measures a native-funnel metric through readNativeStep (DB signup source unavailable)", async () => {
    const calls: Array<[string, string, number]> = [];
    const out = await measureGoalMetric({
      tenant_id: "t-1",
      target_metric: "signups",
      goal_created_at: "2026-06-22T12:00:00Z",
      now: NOW,
      deps: deps({
        readNativeStep: async (tid, step, windowDays) => {
          calls.push([tid, step, windowDays]);
          return 42;
        },
      }),
    });
    expect(out).toEqual({ measured: true, value: 42, source: "native_funnel", unit: "count" });
    expect(calls).toEqual([["t-1", "signup", SIGNUP_DB_WINDOW_DAYS]]);
  });

  it("measures a booking metric through readOperatorFunnelBookings", async () => {
    const out = await measureGoalMetric({
      tenant_id: "t-1",
      target_metric: "weekly_bookings",
      goal_created_at: "2026-06-22T12:00:00Z",
      now: NOW,
      deps: deps({ readOperatorFunnelBookings: async () => 7 }),
    });
    expect(out).toEqual({ measured: true, value: 7, source: "operator_funnel", unit: "count" });
  });

  it("skips (measured:false) on unresolved metric — no reader is even called", async () => {
    let touched = false;
    const out = await measureGoalMetric({
      tenant_id: "t-1",
      target_metric: "nps",
      goal_created_at: null,
      now: NOW,
      deps: deps({
        readNativeStep: async () => {
          touched = true;
          return 1;
        },
        readOperatorFunnelBookings: async () => {
          touched = true;
          return 1;
        },
        readStripeMrr: async () => {
          touched = true;
          return 1;
        },
      }),
    });
    expect(out).toEqual({ measured: false, reason: "unresolved_metric" });
    expect(touched).toBe(false);
  });

  it("skips when the native substrate has no data (null) — non-signup step", async () => {
    const out = await measureGoalMetric({
      tenant_id: "t-1",
      target_metric: "activations",
      goal_created_at: null,
      now: NOW,
      deps: deps(),
    });
    expect(out).toEqual({ measured: false, reason: "native_funnel_no_data" });
  });

  it("skips when the operator DB is unavailable (null)", async () => {
    const out = await measureGoalMetric({
      tenant_id: "t-1",
      target_metric: "bookings",
      goal_created_at: null,
      now: NOW,
      deps: deps(),
    });
    expect(out).toEqual({ measured: false, reason: "operator_funnel_unavailable" });
  });
});

describe("measureGoalMetric — signup goals read the operator DB FIRST", () => {
  const deps = (over: Partial<MeasureDeps> = {}): MeasureDeps => ({
    readNativeStep: async () => null,
    readOperatorFunnelBookings: async () => null,
    readOperatorNewUsers: async () => null,
    readStripeMrr: async () => null,
    ...over,
  });

  it("DB source wins when available — fixed rolling 7d window, native never touched", async () => {
    const dbCalls: Array<[string, number]> = [];
    let nativeTouched = false;
    const out = await measureGoalMetric({
      tenant_id: "t-1",
      target_metric: "Grow Upcar weekly guest signups",
      goal_created_at: "2026-05-01T00:00:00Z",
      now: NOW,
      deps: deps({
        readOperatorNewUsers: async (tid, windowDays) => {
          dbCalls.push([tid, windowDays]);
          return 12;
        },
        readNativeStep: async () => {
          nativeTouched = true;
          return 999;
        },
      }),
    });
    expect(out).toEqual({ measured: true, value: 12, source: "operator_db_signups", unit: "count" });
    expect(dbCalls).toEqual([["t-1", SIGNUP_DB_WINDOW_DAYS]]);
    expect(dbCalls[0][1]).toBe(7);
    expect(nativeTouched).toBe(false);
  });

  it("DB honest-zero is still a measurement (0 ≠ unavailable)", async () => {
    const out = await measureGoalMetric({
      tenant_id: "t-1",
      target_metric: "signups",
      goal_created_at: null,
      now: NOW,
      deps: deps({ readOperatorNewUsers: async () => 0 }),
    });
    expect(out).toEqual({ measured: true, value: 0, source: "operator_db_signups", unit: "count" });
  });

  it("DB unavailable (null) → falls back to the native funnel", async () => {
    const out = await measureGoalMetric({
      tenant_id: "t-1",
      target_metric: "signups",
      goal_created_at: "2026-06-22T12:00:00Z",
      now: NOW,
      deps: deps({ readNativeStep: async () => 42 }),
    });
    expect(out).toEqual({ measured: true, value: 42, source: "native_funnel", unit: "count" });
  });

  it("both sources unavailable → measured:false with reason signup_no_source", async () => {
    const out = await measureGoalMetric({
      tenant_id: "t-1",
      target_metric: "signups",
      goal_created_at: null,
      now: NOW,
      deps: deps(),
    });
    expect(out).toEqual({ measured: false, reason: "signup_no_source" });
  });

  it("non-signup native steps NEVER touch the DB signup source", async () => {
    let dbTouched = false;
    const out = await measureGoalMetric({
      tenant_id: "t-1",
      target_metric: "activations",
      goal_created_at: null,
      now: NOW,
      deps: deps({
        readOperatorNewUsers: async () => {
          dbTouched = true;
          return 5;
        },
        readNativeStep: async () => 3,
      }),
    });
    expect(out).toEqual({ measured: true, value: 3, source: "native_funnel", unit: "count" });
    expect(dbTouched).toBe(false);
  });
});

describe("computeWindowDays", () => {
  it("measures since goal creation, clamped 1..90, default 30", () => {
    expect(computeWindowDays("2026-06-22T12:00:00Z", NOW)).toBe(10);
    expect(computeWindowDays("2026-07-02T11:00:00Z", NOW)).toBe(1);
    expect(computeWindowDays("2025-01-01T00:00:00Z", NOW)).toBe(90);
    expect(computeWindowDays(null, NOW)).toBe(30);
    expect(computeWindowDays("not-a-date", NOW)).toBe(30);
  });
});

describe("isGoalOffTrack — the wake predicate", () => {
  const base = {
    goal_created_at: "2026-06-02T12:00:00Z",
    due_date: "2026-08-01",
    now: NOW,
  };

  it("never off-track at/over target", () => {
    expect(
      isGoalOffTrack({ ...base, measured_value: 100, target_value: 100, baseline_value: 0 }),
    ).toBe(false);
    expect(
      isGoalOffTrack({ ...base, measured_value: 150, target_value: 100, baseline_value: 0 }),
    ).toBe(false);
  });

  it("linear pace: behind 50% of expected progress → off-track", () => {
    expect(
      isGoalOffTrack({ ...base, measured_value: 20, target_value: 100, baseline_value: 0 }),
    ).toBe(true);
    expect(
      isGoalOffTrack({ ...base, measured_value: 30, target_value: 100, baseline_value: 0 }),
    ).toBe(false);
  });

  it("degenerate pace (target <= baseline) is never off-track", () => {
    expect(
      isGoalOffTrack({ ...base, measured_value: 5, target_value: 10, baseline_value: 20 }),
    ).toBe(false);
  });

  it("baseline unset: far below target (<50%) → off-track", () => {
    const noPace = { goal_created_at: null, due_date: null, now: NOW };
    expect(
      isGoalOffTrack({ ...noPace, measured_value: 40, target_value: 100, baseline_value: null }),
    ).toBe(true);
    expect(
      isGoalOffTrack({ ...noPace, measured_value: 60, target_value: 100, baseline_value: null }),
    ).toBe(false);
  });

  it("no due_date falls back to the far-below-target check even with a baseline", () => {
    expect(
      isGoalOffTrack({
        goal_created_at: "2026-06-02T12:00:00Z",
        due_date: null,
        now: NOW,
        measured_value: 10,
        target_value: 100,
        baseline_value: 5,
      }),
    ).toBe(true);
  });
});

describe("measureGoalMetric — the native signup fallback uses a WEEKLY window", () => {
  const deps = (over: Partial<MeasureDeps> = {}): MeasureDeps => ({
    readNativeStep: async () => null,
    readOperatorFunnelBookings: async () => null,
    readOperatorNewUsers: async () => null,
    readStripeMrr: async () => null,
    ...over,
  });
  const base = {
    tenant_id: "t-1",
    target_metric: "weekly signups",
    now: NOW,
  };

  it("a 90-day-old goal still measures 7 days, not 90", async () => {
    const calls: number[] = [];
    await measureGoalMetric({
      ...base,
      goal_created_at: "2026-01-01T00:00:00Z",
      deps: deps({
        readNativeStep: async (_t, _s, windowDays) => {
          calls.push(windowDays);
          return 400;
        },
      }),
    });
    expect(calls).toEqual([SIGNUP_DB_WINDOW_DAYS]);
    expect(calls[0]).toBe(7);
  });

  it("the window does not grow as the goal ages — 10d and 60d goals agree", async () => {
    const seen: number[] = [];
    const spy = deps({
      readNativeStep: async (_t, _s, windowDays) => {
        seen.push(windowDays);
        return 1;
      },
    });
    await measureGoalMetric({ ...base, goal_created_at: "2026-06-22T12:00:00Z", deps: spy });
    await measureGoalMetric({ ...base, goal_created_at: "2026-05-03T12:00:00Z", deps: spy });
    expect(seen).toEqual([7, 7]);
  });

  it("both signup sources use the SAME window, so the fallback can't inflate", async () => {
    const dbWindows: number[] = [];
    const nativeWindows: number[] = [];
    await measureGoalMetric({
      ...base,
      goal_created_at: "2026-04-01T00:00:00Z",
      deps: deps({
        readOperatorNewUsers: async (_t, w) => {
          dbWindows.push(w);
          return null;
        },
        readNativeStep: async (_t, _s, w) => {
          nativeWindows.push(w);
          return 12;
        },
      }),
    });
    expect(dbWindows).toEqual(nativeWindows);
  });

  it("a NON-signup native step still uses the since-created window (unchanged)", async () => {
    const calls: number[] = [];
    await measureGoalMetric({
      tenant_id: "t-1",
      target_metric: "activations",
      goal_created_at: "2026-06-22T12:00:00Z",
      now: NOW,
      deps: deps({
        readNativeStep: async (_t, _s, w) => {
          calls.push(w);
          return 5;
        },
      }),
    });
    expect(calls).toEqual([10]);
  });
});
