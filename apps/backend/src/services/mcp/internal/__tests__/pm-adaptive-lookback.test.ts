
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeRecencyWeight,
  applyDecayAndSuppression,
  isThinCorpus,
  THIN_CORPUS_THRESHOLD,
  EXTENDED_LOOKBACK_DAYS,
  RECENCY_FLOOR,
  type AdaptiveRunRow,
} from "../pm-adaptive-lookback";

const mocks = vi.hoisted(() => ({
  serviceClientMock: vi.fn(),
  flagMock: vi.fn(),
}));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("@/agents/pm/roadmap-flag", () => ({ isPmRoadmapEnabled: mocks.flagMock }));

const DAY = 86400 * 1000;
const NOW = Date.parse("2026-06-11T00:00:00.000Z");

function row(overrides: Partial<AdaptiveRunRow> & { ageDays: number }): AdaptiveRunRow {
  const { ageDays, ...rest } = overrides;
  return {
    id: rest.id ?? `run-${ageDays}`,
    agent_slug: rest.agent_slug ?? "engineer",
    status: rest.status ?? "parse_failed",
    started_at: rest.started_at ?? null,
    enqueued_at: new Date(NOW - ageDays * DAY).toISOString(),
    output_text: rest.output_text ?? "",
    parsed: rest.parsed ?? null,
    error: rest.error ?? "TypeError: x is undefined",
  };
}

describe("computeRecencyWeight", () => {
  it("is 1.0 for items inside the requested window", () => {
    expect(computeRecencyWeight(0, 14)).toBe(1.0);
    expect(computeRecencyWeight(14, 14)).toBe(1.0);
    expect(computeRecencyWeight(10, 14)).toBe(1.0);
  });

  it("decays older items (half-life = requested window)", () => {
    expect(computeRecencyWeight(28, 14)).toBeCloseTo(0.5, 2);
    expect(computeRecencyWeight(42, 14)).toBeCloseTo(0.25, 2);
  });

  it("monotonically decreases with age beyond the window", () => {
    const w20 = computeRecencyWeight(20, 14);
    const w30 = computeRecencyWeight(30, 14);
    const w45 = computeRecencyWeight(45, 14);
    expect(w20).toBeGreaterThan(w30);
    expect(w30).toBeGreaterThan(w45);
    expect(w20).toBeLessThan(1.0);
  });

  it("never drops below RECENCY_FLOOR", () => {
    expect(computeRecencyWeight(365, 14)).toBe(RECENCY_FLOOR);
  });
});

describe("isThinCorpus", () => {
  it("flags below the threshold and not at/above it", () => {
    expect(isThinCorpus(THIN_CORPUS_THRESHOLD - 1)).toBe(true);
    expect(isThinCorpus(0)).toBe(true);
    expect(isThinCorpus(THIN_CORPUS_THRESHOLD)).toBe(false);
    expect(isThinCorpus(THIN_CORPUS_THRESHOLD + 50)).toBe(false);
  });
});

describe("applyDecayAndSuppression", () => {
  it("weighs window-internal rows 1.0 and extended-tail rows less", () => {
    const rows = [
      row({ id: "fresh", ageDays: 3 }),
      row({ id: "old", ageDays: 30 }),
    ];
    const { rows: out } = applyDecayAndSuppression(rows, 14, new Set(), NOW);
    const fresh = out.find((r) => r.id === "fresh")!;
    const old = out.find((r) => r.id === "old")!;
    expect(fresh.recency_weight).toBe(1.0);
    expect(old.recency_weight).toBeLessThan(1.0);
    expect(old.recency_weight).toBeGreaterThanOrEqual(RECENCY_FLOOR);
  });

  it("suppresses a resolved (measured/won) signature from the EXTENDED TAIL", () => {
    const resolvedSig = "typeerror x is undefined";
    const rows = [
      row({ id: "tail-fixed", ageDays: 30, error: "TypeError: x is undefined" }),
      row({ id: "tail-live", ageDays: 30, error: "ReferenceError: y is not defined" }),
    ];
    const { rows: out, suppressed } = applyDecayAndSuppression(
      rows,
      14,
      new Set([resolvedSig]),
      NOW,
    );
    expect(suppressed).toBe(1);
    expect(out.map((r) => r.id)).toEqual(["tail-live"]);
  });

  it("does NOT suppress the same resolved signature INSIDE the requested window", () => {
    const resolvedSig = "typeerror x is undefined";
    const rows = [
      row({ id: "recent-recur", ageDays: 5, error: "TypeError: x is undefined" }),
    ];
    const { rows: out, suppressed } = applyDecayAndSuppression(
      rows,
      14,
      new Set([resolvedSig]),
      NOW,
    );
    expect(suppressed).toBe(0);
    expect(out.map((r) => r.id)).toEqual(["recent-recur"]);
    expect(out[0].recency_weight).toBe(1.0);
  });

  it("no suppression when the resolved-signature set is empty", () => {
    const rows = [row({ id: "old", ageDays: 30 })];
    const { suppressed } = applyDecayAndSuppression(rows, 14, new Set(), NOW);
    expect(suppressed).toBe(0);
  });
});

import { callPraxisCorpusTool } from "../praxis-corpus";

type QResult = { data: unknown; count: number; error: unknown };

function mkRunsBuilder(resultByWindow: (sinceMs: number) => QResult, gteSpy: number[]) {
  const b: any = {};
  b.select = vi.fn(() => b);
  b.eq = vi.fn(() => b);
  b.neq = vi.fn(() => b);
  b.gte = vi.fn((_col: string, iso: string) => {
    gteSpy.push(Date.parse(iso));
    return b;
  });
  b.order = vi.fn(() => b);
  b.limit = vi.fn(async () => {
    const sinceMs = gteSpy[gteSpy.length - 1];
    return resultByWindow(sinceMs);
  });
  return b;
}

function mkRoadmapBuilder(rows: Array<{ baseline_signature: string }>) {
  const b: any = {};
  b.select = vi.fn(() => b);
  b.eq = vi.fn(() => b);
  b.not = vi.fn(() => b);
  b.limit = vi.fn(async () => ({ data: rows, error: null }));
  return b;
}

describe("runQueryRecentRuns adaptive widen (integration)", () => {
  beforeEach(() => {
    mocks.serviceClientMock.mockReset();
    mocks.flagMock.mockReset();
    mocks.flagMock.mockResolvedValue(true);
  });

  function runRow(ageDays: number, error: string | null = "TypeError: x is undefined", id?: string) {
    return {
      id: id ?? `r${ageDays}`,
      agent_slug: "engineer",
      status: "parse_failed",
      started_at: null,
      enqueued_at: new Date(Date.now() - ageDays * DAY).toISOString(),
      output_text: "",
      parsed: null,
      error,
    };
  }

  it("widens to ~45d when the 14d window is thin and 45d has more", async () => {
    const gteSpy: number[] = [];
    const fourteenCutoff = Date.now() - 14 * DAY;
    const runsB = mkRunsBuilder((sinceMs) => {
      if (sinceMs >= fourteenCutoff - DAY) {
        return { data: [runRow(2), runRow(5)], count: 2, error: null };
      }
      return {
        data: [runRow(2), runRow(5), ...Array.from({ length: 7 }, (_, i) => runRow(20 + i))],
        count: 9,
        error: null,
      };
    }, gteSpy);
    const roadmapB = mkRoadmapBuilder([]);
    mocks.serviceClientMock.mockReturnValue({
      from: (t: string) => (t === "agent_runs" ? runsB : roadmapB),
    });

    const res = await callPraxisCorpusTool("tenant-A", "query_recent_runs", { days: 14, top_n: 50 });
    expect(res.ok).toBe(true);
    const payload = JSON.parse((res as any).content) as any;
    expect(payload.lookback.extended).toBe(true);
    expect(payload.lookback.effective_days).toBe(EXTENDED_LOOKBACK_DAYS);
    expect(payload.lookback.requested_days).toBe(14);
    expect(payload.total_runs_seen).toBe(9);
    const weights = payload.rows.map((r: any) => r.recency_weight);
    expect(weights).toContain(1);
    expect(weights.some((w: number) => w < 1)).toBe(true);
  });

  it("does NOT widen a healthy 14d window (behavior unchanged)", async () => {
    const gteSpy: number[] = [];
    const runsB = mkRunsBuilder(() => ({
      data: Array.from({ length: 12 }, (_, i) => runRow(i + 1)),
      count: 12,
      error: null,
    }), gteSpy);
    mocks.serviceClientMock.mockReturnValue({
      from: (t: string) => (t === "agent_runs" ? runsB : mkRoadmapBuilder([])),
    });

    const res = await callPraxisCorpusTool("tenant-A", "query_recent_runs", { days: 14, top_n: 50 });
    const payload = JSON.parse((res as any).content) as any;
    expect(payload.lookback.extended).toBe(false);
    expect(payload.lookback.effective_days).toBe(14);
    expect(gteSpy.length).toBe(1);
    expect(payload.rows.every((r: any) => r.recency_weight === 1)).toBe(true);
  });

  it("suppresses a measured/won signature from the widened tail", async () => {
    const gteSpy: number[] = [];
    const fourteenCutoff = Date.now() - 14 * DAY;
    const runsB = mkRunsBuilder((sinceMs) => {
      if (sinceMs >= fourteenCutoff - DAY) {
        return { data: [runRow(2)], count: 1, error: null };
      }
      return {
        data: [
          runRow(2, "TypeError: x is undefined", "win-fresh"),
          runRow(30, "TypeError: x is undefined", "tail-fixed"),
          ...Array.from({ length: 7 }, (_, i) =>
            runRow(25 + i, "ReferenceError: live", `tail-live-${i}`),
          ),
        ],
        count: 9,
        error: null,
      };
    }, gteSpy);
    const roadmapB = mkRoadmapBuilder([{ baseline_signature: "typeerror x is undefined" }]);
    mocks.serviceClientMock.mockReturnValue({
      from: (t: string) => (t === "agent_runs" ? runsB : roadmapB),
    });

    const res = await callPraxisCorpusTool("tenant-A", "query_recent_runs", { days: 14, top_n: 50 });
    const payload = JSON.parse((res as any).content) as any;
    expect(payload.lookback.extended).toBe(true);
    expect(payload.lookback.suppressed_resolved).toBe(1);
    expect(payload.rows.find((r: any) => r.agent_run_id === "tail-fixed")).toBeUndefined();
    expect(payload.rows.find((r: any) => r.agent_run_id === "tail-live-0")).toBeDefined();
    expect(payload.rows.find((r: any) => r.agent_run_id === "win-fresh")?.recency_weight).toBe(1);
  });
});
