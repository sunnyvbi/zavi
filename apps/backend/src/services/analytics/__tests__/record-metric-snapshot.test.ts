
import { describe, it, expect, vi, beforeEach } from "vitest";

const upsertMock = vi.fn();
const fromMock = vi.fn();

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: fromMock }),
}));

import {
  recordMetricSnapshot,
  readMetricHistory,
} from "../record-metric-snapshot";

const TENANT = "11111111-1111-1111-1111-111111111111";

function baseArgs() {
  return {
    tenant_id: TENANT,
    metric_key: "weekly_signups",
    value: 42,
    source: "operator_db",
    window_kind: "rolling_7d" as const,
    window_end: "2026-07-04T00:00:00.000Z",
  };
}

describe("recordMetricSnapshot", () => {
  beforeEach(() => {
    upsertMock.mockReset();
    fromMock.mockReset();
    fromMock.mockReturnValue({ upsert: upsertMock });
    upsertMock.mockResolvedValue({ error: null });
  });

  it("upserts on the (tenant_id, metric_key, window_kind, window_end) grain", async () => {
    const res = await recordMetricSnapshot(baseArgs());
    expect(res).toEqual({ ok: true });
    expect(fromMock).toHaveBeenCalledWith("tenant_metric_snapshots");
    const [row, opts] = upsertMock.mock.calls[0];
    expect(opts).toEqual({ onConflict: "tenant_id,metric_key,window_kind,window_end" });
    expect(row).toMatchObject({
      tenant_id: TENANT,
      metric_key: "weekly_signups",
      value: 42,
      status: "measured",
      source: "operator_db",
      window_kind: "rolling_7d",
      window_start: null,
      window_end: "2026-07-04T00:00:00.000Z",
      meta: {},
    });
    expect(typeof row.created_at).toBe("string");
  });

  it("passes through explicit status/window_start/meta and null value", async () => {
    await recordMetricSnapshot({
      ...baseArgs(),
      value: null,
      status: "unavailable",
      window_start: "2026-06-27T00:00:00.000Z",
      meta: { reason: "connector_down" },
    });
    const [row] = upsertMock.mock.calls[0];
    expect(row).toMatchObject({
      value: null,
      status: "unavailable",
      window_start: "2026-06-27T00:00:00.000Z",
      meta: { reason: "connector_down" },
    });
  });

  it("returns {ok:false} (never throws) when supabase returns an error value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    upsertMock.mockResolvedValue({ error: { message: "duplicate key boom" } });
    await expect(recordMetricSnapshot(baseArgs())).resolves.toEqual({ ok: false });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("returns {ok:false} (never throws) when the client throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fromMock.mockImplementation(() => {
      throw new Error("network down");
    });
    await expect(recordMetricSnapshot(baseArgs())).resolves.toEqual({ ok: false });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("readMetricHistory", () => {
  function makeQuery(result: { data: unknown[] | null; error: { message: string } | null }) {
    const calls: Array<[string, unknown[]]> = [];
    const q: any = {
      calls,
      select: (...a: unknown[]) => (calls.push(["select", a]), q),
      eq: (...a: unknown[]) => (calls.push(["eq", a]), q),
      order: (...a: unknown[]) => (calls.push(["order", a]), q),
      limit: (...a: unknown[]) => (calls.push(["limit", a]), q),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    return q;
  }

  beforeEach(() => {
    fromMock.mockReset();
  });

  it("reads newest-first by window_end with tenant+metric filters and default limit", async () => {
    const rows = [{ id: "b", window_end: "2026-07-04" }, { id: "a", window_end: "2026-06-27" }];
    const q = makeQuery({ data: rows, error: null });
    fromMock.mockReturnValue(q);

    const out = await readMetricHistory(TENANT, "weekly_signups");
    expect(out).toEqual(rows);
    expect(fromMock).toHaveBeenCalledWith("tenant_metric_snapshots");
    expect(q.calls).toContainEqual(["eq", ["tenant_id", TENANT]]);
    expect(q.calls).toContainEqual(["eq", ["metric_key", "weekly_signups"]]);
    expect(q.calls).toContainEqual(["order", ["window_end", { ascending: false }]]);
    expect(q.calls).toContainEqual(["limit", [30]]);
    expect(q.calls.filter(([m, a]: [string, unknown[]]) => m === "eq" && a[0] === "window_kind")).toHaveLength(0);
  });

  it("applies window_kind + custom limit when provided", async () => {
    const q = makeQuery({ data: [], error: null });
    fromMock.mockReturnValue(q);

    await readMetricHistory(TENANT, "stripe_mrr", { window_kind: "point", limit: 5 });
    expect(q.calls).toContainEqual(["eq", ["window_kind", "point"]]);
    expect(q.calls).toContainEqual(["limit", [5]]);
  });

  it("throws on a DB error (readers surface failures)", async () => {
    const q = makeQuery({ data: null, error: { message: "relation missing" } });
    fromMock.mockReturnValue(q);
    await expect(readMetricHistory(TENANT, "stripe_mrr")).rejects.toThrow(/relation missing/);
  });
});
