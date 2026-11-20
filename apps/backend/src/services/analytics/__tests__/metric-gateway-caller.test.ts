import { describe, it, expect, vi, beforeEach } from "vitest";
import { sentToAi } from "@/services/data-gateway/audit";

const seen = vi.hoisted(() => [] as unknown[]);
vi.mock("@/services/analytics/confirmed-operator-db", () => ({
  resolveConfirmedOperatorDb: vi.fn(async (gateway: unknown) => {
    seen.push(gateway);
    return { ok: false, reason: "needs_confirmation", message: "x" };
  }),
}));

import { runGetMetric } from "@/services/tools/analytics/get_metric";
import { findSignals } from "@/services/analytics/anomaly-watch";
import { catalogEntry } from "@/services/analytics/metric-catalog";

beforeEach(() => {
  seen.length = 0;
});

describe("metric reads carry their true caller", () => {
  it("get_metric -> agent caller with the run and agent; sent_to_ai true when allowed", async () => {
    await runGetMetric(
      { tenant_id: "t1", agent_slug: "pm", run_id: "run-1", log: () => undefined } as never,
      { metric_id: "signups", window: { preset: "last_7d" } },
      { now: () => new Date("2026-10-10T12:00:00Z"), resolveTz: async () => ({ tz: "UTC", source: "default" }) as never, readDataNotes: async () => [] },
    );
    expect(seen[0]).toEqual({ tenant_id: "t1", caller: { kind: "agent", agent_slug: "pm", run_id: "run-1", tool_name: "get_metric" } });
    expect(sentToAi(seen[0] as never, "allowed")).toBe(true);
  });
  it("anomaly watch -> background caller; sent_to_ai false", async () => {
    await findSignals("t1", new Set(["operator_db"]), "UTC", new Date("2026-10-10T12:00:00Z"), {
      fetch: (id, ctx, w) => catalogEntry(id)!.impl.fetch(ctx, w),
    });
    const bg = seen.find((g) => (g as { caller: { kind: string } }).caller.kind === "background");
    expect(bg).toEqual({ tenant_id: "t1", caller: { kind: "background", feature: "Anomaly watch" } });
    expect(sentToAi(bg as never, "allowed")).toBe(false);
  });
});
