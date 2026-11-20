import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

type Filters = Array<[string, unknown]>;
type Query = { table: string; filters: Filters };

const m = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  queries: [] as Query[],
  goal: null as Record<string, unknown> | null,
  snapshots: [] as Array<Record<string, unknown>>,
  failSnapshots: false,
  changes: [] as Array<Record<string, unknown>>,
  failChanges: false,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.requireAuth }));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from(table: string) {
      const q: Query = { table, filters: [] };
      m.queries.push(q);
      let changedKey: string | null = null;
      const rows = () =>
        table === "autopilot_goals"
          ? m.goal
            ? [m.goal]
            : []
          : table === "autopilot_goal_changes"
            ? m.changes
                .filter((r) => q.filters.every(([k, v]) => r[k] === v))
                .filter((r) => !changedKey || (r.changed_fields as Record<string, unknown>)[changedKey] != null)
                .sort((a, b2) => String(b2.created_at).localeCompare(String(a.created_at)))
            : m.snapshots.filter((r) => q.filters.every(([k, v]) => k === "tenant_id" || r[k] === v));
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (k: string, v: unknown) => {
          q.filters.push([k, v]);
          return b;
        },
        not: (col: string) => {
          changedKey = col.split("->")[1] ?? null;
          return b;
        },
        order: () => b,
        limit: () =>
          Promise.resolve(
            (m.failSnapshots && table === "tenant_metric_snapshots") || (m.failChanges && table === "autopilot_goal_changes")
              ? { data: null, error: { message: "boom" } }
              : { data: rows(), error: null },
          ),
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      };
      return b;
    },
  }),
}));

import { getConnectorSyncStatus, getGoalHistory } from "../metric-history";

function res() {
  const r = { statusCode: 200, body: undefined as unknown } as { statusCode: number; body: unknown } & Partial<Response>;
  r.status = vi.fn((c: number) => {
    r.statusCode = c;
    return r as Response;
  }) as unknown as Response["status"];
  r.json = vi.fn((b: unknown) => {
    r.body = b;
    return r as Response;
  }) as unknown as Response["json"];
  return r;
}

const GOAL = "3c5c26db-583e-4dc1-bdf4-820d7bb4172d";

beforeEach(() => {
  vi.clearAllMocks();
  m.queries = [];
  m.goal = null;
  m.snapshots = [];
  m.failSnapshots = false;
  m.changes = [];
  m.failChanges = false;
  m.requireAuth.mockResolvedValue({ tenant_id: "tenant-auth", user_id: "u1", access_token: "tok" });
});

describe("GET /api/workspace/autopilot/goals/:id/history", () => {
  it("scopes every read to the AUTHED tenant", async () => {
    m.goal = { id: GOAL, target_metric: "mrr", measurement_mode: "auto" };
    const r = res();
    await getGoalHistory({ params: { id: GOAL }, query: { tenant_id: "other" } } as unknown as Request, r as Response);
    expect(m.queries.length).toBeGreaterThan(0);
    for (const q of m.queries) expect(q.filters).toContainEqual(["tenant_id", "tenant-auth"]);
  });

  it("returns the metric's measured history oldest first for an auto goal", async () => {
    m.goal = { id: GOAL, target_metric: "mrr", measurement_mode: "auto" };
    m.snapshots = [
      { metric_key: "stripe_mrr", window_kind: "point", status: "measured", value: 1290, window_end: "2026-09-28T00:00:00Z", created_at: "2026-09-28T05:41:00Z", source: "stripe" },
      { metric_key: "stripe_mrr", window_kind: "point", status: "measured", value: 1389, window_end: "2026-09-26T00:00:00Z", created_at: "2026-09-26T05:41:00Z", source: "stripe" },
      { metric_key: `goal:${GOAL}`, window_kind: "point", status: "measured", value: 7, window_end: "2026-09-27T00:00:00Z", created_at: "2026-09-27T00:00:00Z", source: "founder_reported" },
    ];
    const r = res();
    await getGoalHistory({ params: { id: GOAL } } as unknown as Request, r as Response);
    const body = r.body as { metric_key: string; source: string; points: Array<{ value: number }>; last_measured_at: string };
    expect(body.metric_key).toBe("stripe_mrr");
    expect(body.source).toBe("stripe");
    expect(body.points.map((p) => p.value)).toEqual([1389, 1290]);
    expect(body.last_measured_at).toBe("2026-09-28T05:41:00Z");
  });

  it("shows the founder's own readings for a manual goal, never mixed with the metric", async () => {
    m.goal = { id: GOAL, target_metric: "mrr", measurement_mode: "manual_reported" };
    m.snapshots = [
      { metric_key: "stripe_mrr", window_kind: "point", status: "measured", value: 1290, window_end: "2026-09-28T00:00:00Z", created_at: "2026-09-28T05:41:00Z", source: "stripe" },
      { metric_key: `goal:${GOAL}`, status: "measured", value: 1500, window_end: "2026-09-27T00:00:00Z", created_at: "2026-09-27T00:00:00Z", source: "founder_reported" },
    ];
    const r = res();
    await getGoalHistory({ params: { id: GOAL } } as unknown as Request, r as Response);
    const body = r.body as { source: string; points: Array<{ value: number }> };
    expect(body.source).toBe("founder_reported");
    expect(body.points.map((p) => p.value)).toEqual([1500]);
  });

  describe("after the goal's metric changed", () => {
    const reading = (value: number, at: string) => ({ metric_key: `goal:${GOAL}`, status: "measured", value, window_end: at, created_at: at, source: "founder_reported" });
    const change = (over: Record<string, unknown>) => ({ tenant_id: "tenant-auth", goal_id: GOAL, op: "update", changed_fields: { target_metric: { from: "hosts", to: "bookings" } }, created_at: "2026-09-25T12:00:00Z", ...over });
    const points = async () => {
      const r = res();
      await getGoalHistory({ params: { id: GOAL } } as unknown as Request, r as Response);
      return { status: r.statusCode, values: ((r.body as { points?: Array<{ value: number }> }).points ?? []).map((p) => p.value) };
    };
    beforeEach(() => {
      m.goal = { id: GOAL, target_metric: "bookings", measurement_mode: "manual_reported" };
      m.snapshots = [reading(9, "2026-09-27T00:00:00Z"), reading(7, "2026-09-26T00:00:00Z"), reading(410, "2026-09-24T00:00:00Z"), reading(400, "2026-09-20T00:00:00Z")];
    });

    it("the old metric's readings are not the new metric's history", async () => {
      m.changes = [change({})];
      expect(await points()).toEqual({ status: 200, values: [7, 9] });
    });

    it("only this goal's own metric change counts: another goal's, another tenant's, a target edit or the goal's creation do not cut it", async () => {
      m.changes = [
        change({ goal_id: "another-goal", created_at: "2026-09-26T12:00:00Z" }),
        change({ tenant_id: "other-tenant", created_at: "2026-09-26T12:00:00Z" }),
        change({ changed_fields: { target_value: { from: 10, to: 20 } }, created_at: "2026-09-26T12:00:00Z" }),
        change({ op: "insert", created_at: "2026-09-26T12:00:00Z" }),
      ];
      expect(await points()).toEqual({ status: 200, values: [400, 410, 7, 9] });
    });

    it("the newest metric change is the cut; with no reading since, there is no history yet", async () => {
      m.changes = [change({}), change({ created_at: "2026-09-26T12:00:00Z" })];
      expect(await points()).toEqual({ status: 200, values: [9] });
      m.changes = [change({ created_at: "2026-09-28T00:00:00Z" })];
      expect(await points()).toEqual({ status: 200, values: [] });
    });

    it("a change log that cannot be read is a 500, never the old metric's points", async () => {
      m.failChanges = true;
      expect((await points()).status).toBe(500);
    });
  });

  it("an unmapped goal with no readings returns no points, not a guess", async () => {
    m.goal = { id: GOAL, target_metric: "activation_rate", measurement_mode: "auto" };
    const r = res();
    await getGoalHistory({ params: { id: GOAL } } as unknown as Request, r as Response);
    expect(r.body).toMatchObject({ points: [], last_measured_at: null });
  });

  it("404s a goal the caller's tenant does not have, 400s a non-uuid", async () => {
    const r = res();
    await getGoalHistory({ params: { id: GOAL } } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(404);
    const r2 = res();
    await getGoalHistory({ params: { id: "not-a-uuid" } } as unknown as Request, r2 as Response);
    expect(r2.statusCode).toBe(400);
  });

  it("a failed snapshot read is a 500, never an empty history", async () => {
    m.goal = { id: GOAL, target_metric: "mrr", measurement_mode: "auto" };
    m.failSnapshots = true;
    const r = res();
    await getGoalHistory({ params: { id: GOAL } } as unknown as Request, r as Response);
    expect(r.statusCode).toBe(500);
  });
});

describe("GET /api/connectors/sync-status", () => {
  it("reports the newest measured snapshot per connector, scoped to the authed tenant", async () => {
    m.snapshots = [
      { metric_key: "ads_spend_7d", status: "measured", source: "meta_ads", created_at: "2026-09-28T05:41:21Z" },
      { metric_key: "stripe_mrr", status: "measured", source: "stripe", created_at: "2026-09-28T05:41:25Z" },
      { metric_key: "weekly_signups", status: "unavailable", source: "operator_db", created_at: "2026-09-28T05:41:10Z" },
    ];
    const r = res();
    await getConnectorSyncStatus({ query: {} } as unknown as Request, r as Response);
    const body = r.body as { sources: Record<string, { last_synced_at: string }> };
    expect(body.sources.meta_ads.last_synced_at).toBe("2026-09-28T05:41:21Z");
    expect(body.sources.stripe.last_synced_at).toBe("2026-09-28T05:41:25Z");
    expect(body.sources.operator_db).toBeUndefined();
    for (const q of m.queries) expect(q.filters).toContainEqual(["tenant_id", "tenant-auth"]);
  });
});
