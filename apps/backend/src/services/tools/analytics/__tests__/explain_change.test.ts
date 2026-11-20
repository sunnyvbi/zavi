
import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));

import { runExplainChange, explainChangeInputSchema, explainChangeTool, EXPLAIN_CHANGE_LEDGER_NAME } from "../explain_change";
import { figureWasRead, pullsForFigure, isSelfRecordingTool } from "@/services/agents/engine/figure-ledger";
import { listGrowthTools } from "@/services/mcp/internal/growth";
import { gapsFromUnusedTools } from "@/agents/cgo/strategy";
import type { ToolContext } from "@/services/tools/types";
import type { ExplainResult } from "@/services/analytics/explain-change";

const NOW = new Date("2026-09-28T15:00:00Z");
const ctx = (tenant_id = "tenant-a", run_id = "run-1"): ToolContext => ({ tenant_id, run_id, log: () => undefined });

const OK: ExplainResult = {
  status: "ok",
  metric_id: "sessions",
  label: "Sessions",
  unit: "count",
  direction: "up",
  window: { since: "2026-09-27", until: "2026-09-27" },
  compare_window: { since: "2026-09-20", until: "2026-09-20" },
  total: 4123,
  compare_total: 8456,
  change: -4333,
  change_pct: -51.2,
  dimensions: [],
  drivers: [{ dimension: "source_medium", segment: "google / organic", contribution: -3871, share_pct: 89.3, confidence: "high" }],
  currency: null,
  caveats: [],
};

function deps() {
  return {
    now: () => NOW,
    resolveTz: vi.fn(async () => ({ tz: "America/New_York", source: "stored" as const })),
    explain: vi.fn(async () => OK),
  };
}

describe("explain_change input", () => {
  it("is strict: a tenant_id in the arguments is rejected, not used", () => {
    expect(() => explainChangeInputSchema.parse({ metric_id: "sessions", tenant_id: "tenant-b" })).toThrow();
  });

  it("defaults compare to previous_period and accepts previous_week", () => {
    expect(explainChangeInputSchema.parse({ metric_id: "sessions" }).compare).toBe("previous_period");
    expect(explainChangeInputSchema.parse({ metric_id: "sessions", compare: "previous_week" }).compare).toBe("previous_week");
    expect(() => explainChangeInputSchema.parse({ metric_id: "not_a_metric" })).toThrow();
  });
});

describe("runExplainChange", () => {
  it("reads the tenant (and ITS time zone) from ctx only", async () => {
    const d = deps();
    const out = await runExplainChange(ctx("tenant-z"), { metric_id: "sessions", window: { preset: "yesterday" }, compare: "previous_week" }, d);
    expect(d.resolveTz).toHaveBeenCalledWith("tenant-z");
    expect(d.explain).toHaveBeenCalledWith(
      {
        tenant_id: "tenant-z",
        tz: "America/New_York",
        now: NOW,
        gateway: { tenant_id: "tenant-z", caller: expect.objectContaining({ kind: "agent", tool_name: "growth__explain_change" }) },
      },
      { metric_id: "sessions", window: { preset: "yesterday" }, compare: "previous_week" },
    );
    expect(out).toMatchObject({ status: "ok", tz: "America/New_York" });
  });

  it("writes its figures to the run's ledger under its own name", async () => {
    await runExplainChange(ctx("tenant-a", "run-explain"), { metric_id: "sessions" }, deps());
    expect(figureWasRead("run-explain", "89.3")).toBe(true);
    expect(pullsForFigure("run-explain", "4123")[0]).toEqual({ tool: EXPLAIN_CHANGE_LEDGER_NAME, nth: 1 });
    expect(isSelfRecordingTool("mcp__praxis-server__growth__explain_change")).toBe(true);
  });
});

describe("registration", () => {
  it("is a read tool on the growth facade, reachable as growth__explain_change", () => {
    expect(explainChangeTool.effect).toBe("read");
    const t = listGrowthTools().find((x) => x.tool_name === "explain_change");
    expect(t?.server_id).toBe("growth");
  });

  it("a strategy that did not call it gets no 'not read' gap line", () => {
    expect(gapsFromUnusedTools(["growth__explain_change", "growth__read_revenue"], { tools: [] }).map((g) => g.statement)).toEqual([
      "Revenue read was not read for this plan.",
    ]);
  });
});
