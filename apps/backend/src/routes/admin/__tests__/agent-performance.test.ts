
import { describe, it, expect } from "vitest";
import {
  bucketDecisionStatus,
  rollupDecisions,
  attributeParentRuns,
  rollupLiveness,
  rollupCost,
  rollupFailure,
  computeQueueWait,
  percentile,
  parseDays,
  fetchAllPaged,
  isFailedRun,
  isCancelledRun,
  DECISION_BUCKETS,
  type PerfRunRow,
  type PerfDecisionRow,
} from "../agent-performance";

const run = (o: Partial<PerfRunRow> = {}): PerfRunRow => ({
  id: o.id ?? "r1",
  tenant_id: o.tenant_id ?? "t1",
  agent_slug: o.agent_slug ?? "operator",
  trigger: o.trigger ?? "cron",
  status: o.status ?? "success",
  enqueued_at: o.enqueued_at ?? "2026-07-01T00:00:00.000Z",
  started_at: o.started_at === undefined ? "2026-07-01T00:00:01.000Z" : o.started_at,
  cost_usd: o.cost_usd ?? 0,
  error: o.error ?? null,
  liveness_tier: o.liveness_tier === undefined ? "answered" : o.liveness_tier,
  failure_class: o.failure_class === undefined ? "none" : o.failure_class,
});

const dec = (status: string | null, agent_run_id: string | null = "r1"): PerfDecisionRow => ({
  id: `d-${Math.random()}`,
  tenant_id: "t1",
  agent_run_id,
  status,
});

const sumCounts = (c: Record<string, number>): number =>
  Object.values(c).reduce((a, b) => a + b, 0);

describe("bucketDecisionStatus — total function, no silent drops", () => {
  it("maps every known status to its own bucket", () => {
    expect(bucketDecisionStatus("acted")).toBe("acted");
    expect(bucketDecisionStatus("approved")).toBe("approved");
    expect(bucketDecisionStatus("rejected")).toBe("rejected");
    expect(bucketDecisionStatus("expired")).toBe("expired");
    expect(bucketDecisionStatus("dispatch_failed")).toBe("dispatch_failed");
    expect(bucketDecisionStatus("proposed")).toBe("open");
    expect(bucketDecisionStatus("superseded")).toBe("superseded");
    expect(bucketDecisionStatus("dispatching")).toBe("dispatching");
  });

  it("routes unknown / null / future statuses to 'other', never nowhere", () => {
    expect(bucketDecisionStatus("a_status_invented_next_week")).toBe("other");
    expect(bucketDecisionStatus(null)).toBe("other");
    expect(bucketDecisionStatus(undefined)).toBe("other");
    expect(bucketDecisionStatus("")).toBe("other");
  });
});

describe("rollupDecisions", () => {
  it("counts sum to total even with unknown statuses present", () => {
    const rows = [
      dec("acted"), dec("expired"), dec("rejected"),
      dec("dispatch_failed"), dec("superseded"), dec("proposed"),
      dec("brand_new_status"), dec(null),
    ];
    const f = rollupDecisions(rows, new Map([["r1", "operator"]]));
    expect(f.total).toBe(8);
    expect(sumCounts(f.counts)).toBe(8);
    expect(f.counts.other).toBe(2);
    expect(f.counts.expired).toBe(1);
    expect(f.counts.dispatch_failed).toBe(1);
  });

  it("keeps approved and acted separate, derives accepted as their sum", () => {
    const f = rollupDecisions([dec("acted"), dec("acted"), dec("approved")], new Map([["r1", "op"]]));
    expect(f.counts.acted).toBe(2);
    expect(f.counts.approved).toBe(1);
    expect(f.accepted).toBe(3);
  });

  it("counts decisions with no parent run as unattributed, NOT as missing", () => {
    const rows = [dec("acted", "r1"), dec("expired", null), dec("rejected", "unknown-run")];
    const f = rollupDecisions(rows, new Map([["r1", "operator"]]));
    expect(f.total).toBe(3);
    expect(sumCounts(f.counts)).toBe(3);
    expect(f.unattributed).toBe(2);
    expect(f.by_agent).toHaveLength(1);
    expect(f.by_agent[0]).toMatchObject({ agent_slug: "operator", total: 1 });
  });

  it("does not attribute a decision to a parent run owned by another tenant", () => {
    const decisions = [
      { id: "d1", tenant_id: "t1", agent_run_id: "r-own", status: "acted" },
      { id: "d2", tenant_id: "t1", agent_run_id: "r-foreign", status: "acted" },
    ];
    const parents = [
      { id: "r-own", tenant_id: "t1", agent_slug: "operator" },
      { id: "r-foreign", tenant_id: "t2", agent_slug: "engineer" },
    ];

    const map = attributeParentRuns(decisions, parents, new Map());
    expect(map.get("r-own")).toBe("operator");
    expect(map.has("r-foreign")).toBe(false);

    const f = rollupDecisions(decisions, map);
    expect(f.total).toBe(2);
    expect(f.unattributed).toBe(1);
    expect(f.by_agent.map((a) => a.agent_slug)).toEqual(["operator"]);
  });

  it("empty input is all zeroes, not NaN", () => {
    const f = rollupDecisions([], new Map());
    expect(f.total).toBe(0);
    expect(f.accepted).toBe(0);
    expect(f.unattributed).toBe(0);
    for (const b of DECISION_BUCKETS) expect(f.counts[b]).toBe(0);
  });
});

describe("rollupLiveness", () => {
  it("computes shipped_rate over CLASSIFIED runs, not total runs", () => {
    const runs = [
      run({ liveness_tier: "shipped" }),
      run({ liveness_tier: "answered" }),
      run({ liveness_tier: null }),
      run({ liveness_tier: null }),
    ];
    const l = rollupLiveness(runs);
    expect(l.overall.runs_total).toBe(4);
    expect(l.overall.runs_classified).toBe(2);
    expect(l.overall.shipped_rate).toBe(0.5);
    expect(l.overall.coverage).toBe(0.5);
  });

  it("surfaces coverage so a rate can never be read without its denominator", () => {
    const l = rollupLiveness([run({ liveness_tier: null }), run({ liveness_tier: null })]);
    expect(l.overall.runs_total).toBe(2);
    expect(l.overall.runs_classified).toBe(0);
    expect(l.overall.shipped_rate).toBeNull();
    expect(l.overall.coverage).toBe(0);
  });

  it("cuts by trigger so a good population cannot mask a dead one", () => {
    const runs = [
      run({ trigger: "a2a", liveness_tier: "shipped" }),
      run({ trigger: "a2a", liveness_tier: "shipped" }),
      ...Array.from({ length: 8 }, () => run({ trigger: "cron", liveness_tier: "answered" })),
    ];
    const l = rollupLiveness(runs);
    expect(l.overall.shipped_rate).toBeCloseTo(0.2);
    const a2a = l.by_trigger.find((t) => t.trigger === "a2a")!;
    const cron = l.by_trigger.find((t) => t.trigger === "cron")!;
    expect(a2a.shipped_rate).toBe(1);
    expect(cron.shipped_rate).toBe(0);
  });

  it("routes an unrecognized liveness tier to 'other' and keeps the sum intact", () => {
    const l = rollupLiveness([run({ liveness_tier: "some_new_tier" })]);
    const c = l.overall;
    expect(c.other).toBe(1);
    expect(c.shipped + c.answered + c.plan_only + c.empty + c.other).toBe(c.runs_classified);
  });

  it("treats empty-string tier as unclassified, not as a category", () => {
    const l = rollupLiveness([run({ liveness_tier: "" })]);
    expect(l.overall.runs_classified).toBe(0);
    expect(l.overall.runs_total).toBe(1);
  });
});

describe("rollupCost", () => {
  it("divides by shipped runs, not by all runs", () => {
    const runs = [
      run({ agent_slug: "ops", cost_usd: 10, liveness_tier: "shipped" }),
      run({ agent_slug: "ops", cost_usd: 10, liveness_tier: "answered" }),
    ];
    const { by_agent, total_usd } = rollupCost(runs);
    expect(total_usd).toBe(20);
    expect(by_agent[0].cost_per_shipped).toBe(20);
  });

  it("returns null (never Infinity/NaN) when nothing shipped", () => {
    const { by_agent } = rollupCost([run({ cost_usd: 5, liveness_tier: "answered" })]);
    expect(by_agent[0].cost_per_shipped).toBeNull();
    expect(Number.isFinite(by_agent[0].cost_usd)).toBe(true);
  });

  it("tolerates null cost_usd without producing NaN", () => {
    const { by_agent, total_usd } = rollupCost([
      run({ cost_usd: null, liveness_tier: "shipped" }),
      run({ cost_usd: 3, liveness_tier: "shipped" }),
    ]);
    expect(total_usd).toBe(3);
    expect(by_agent[0].cost_per_shipped).toBe(1.5);
  });

  it("reports coverage so the upward bias of the ratio is visible", () => {
    const { by_agent } = rollupCost([
      run({ cost_usd: 1, liveness_tier: "shipped" }),
      run({ cost_usd: 1, liveness_tier: null }),
    ]);
    expect(by_agent[0].coverage).toBe(0.5);
  });
});

describe("rollupFailure", () => {
  it("counts a run as failed from the structured class or the status fallback", () => {
    expect(isFailedRun(run({ failure_class: "infra" }))).toBe(true);
    expect(isFailedRun(run({ failure_class: "none" }))).toBe(false);
    expect(isFailedRun(run({ failure_class: null, status: "parse_failed" }))).toBe(true);
    expect(isFailedRun(run({ failure_class: null, status: "success" }))).toBe(false);
  });

  it("treats cancellation consistently across the outcome rollout", () => {
    const postRollout = run({ failure_class: "cancelled", status: "cancelled" });
    const preRollout = run({ failure_class: null, status: "cancelled" });
    expect(isCancelledRun(postRollout)).toBe(true);
    expect(isCancelledRun(preRollout)).toBe(true);
    expect(isFailedRun(postRollout)).toBe(false);
    expect(isFailedRun(preRollout)).toBe(false);

    const f = rollupFailure([postRollout, preRollout, run({ failure_class: "infra" })]);
    expect(f.cancelled_total).toBe(2);
    expect(f.failed_total).toBe(1);
    expect(f.by_class.cancelled).toBeUndefined();
  });

  it("labels a failed run with no structured class as 'unknown', not as clean", () => {
    const f = rollupFailure([run({ failure_class: null, status: "failed" })]);
    expect(f.failed_total).toBe(1);
    expect(f.by_class.unknown).toBe(1);
  });

  it("clusters distinct causes that share one coarse class", () => {
    const f = rollupFailure([
      run({ failure_class: "model_error", error: "usage limit reached for run 1234" }),
      run({ failure_class: "model_error", error: "usage limit reached for run 9999" }),
      run({ failure_class: "model_error", error: "e2b team is blocked: missing payment" }),
    ]);
    expect(f.by_class.model_error).toBe(3);
    expect(f.top_signatures[0].count).toBe(2);
    expect(f.top_signatures).toHaveLength(2);
  });

  it("ignores clean runs entirely", () => {
    const f = rollupFailure([run(), run()]);
    expect(f.failed_total).toBe(0);
    expect(f.top_signatures).toEqual([]);
    expect(f.runs_total).toBe(2);
  });
});

describe("percentile", () => {
  it("returns null on an empty sample rather than NaN", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([], 0.95)).toBeNull();
  });

  it("handles n=1 and n=2", () => {
    expect(percentile([7], 0.5)).toBe(7);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([0, 10], 0.5)).toBe(5);
  });

  it("interpolates continuously and hits the exact endpoints", () => {
    const xs = [1, 2, 3, 4, 5];
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile(xs, 1)).toBe(5);
    expect(percentile(xs, 0.5)).toBe(3);
  });

  it("clamps out-of-range q instead of indexing out of bounds", () => {
    expect(percentile([1, 2, 3], -5)).toBe(1);
    expect(percentile([1, 2, 3], 99)).toBe(3);
  });
});

describe("computeQueueWait", () => {
  const NOW = Date.parse("2026-07-01T01:00:00.000Z");

  it("measures enqueue→start only", () => {
    const q = computeQueueWait(
      [
        run({ enqueued_at: "2026-07-01T00:00:00.000Z", started_at: "2026-07-01T00:00:02.000Z" }),
        run({ enqueued_at: "2026-07-01T00:00:00.000Z", started_at: "2026-07-01T00:00:04.000Z" }),
      ],
      NOW,
    );
    expect(q.sample).toBe(2);
    expect(q.p50_ms).toBe(3000);
  });

  it("excludes pending runs from percentiles but reports them explicitly", () => {
    const q = computeQueueWait(
      [
        run({ enqueued_at: "2026-07-01T00:59:00.000Z", started_at: "2026-07-01T00:59:01.000Z" }),
        run({ enqueued_at: "2026-07-01T00:00:00.000Z", started_at: null, status: "queued" }),
        run({ enqueued_at: "2026-07-01T00:30:00.000Z", started_at: null, status: "queued" }),
      ],
      NOW,
    );
    expect(q.sample).toBe(1);
    expect(q.p95_ms).toBe(1000);
    expect(q.still_waiting).toBe(2);
    expect(q.oldest_waiting_ms).toBe(3_600_000);
  });

  it("does NOT count terminal never-started runs as queue backlog", () => {
    const q = computeQueueWait(
      [
        run({ enqueued_at: "2026-07-01T00:00:00.000Z", started_at: null, status: "cancelled" }),
        run({ enqueued_at: "2026-07-01T00:00:00.000Z", started_at: null, status: "dispatch_error" }),
        run({ enqueued_at: "2026-07-01T00:00:00.000Z", started_at: null, status: "failed" }),
      ],
      NOW,
    );
    expect(q.still_waiting).toBe(0);
    expect(q.never_started).toBe(3);
    expect(q.oldest_waiting_ms).toBeNull();
  });

  it("separates genuine backlog from terminal never-started in one sample", () => {
    const q = computeQueueWait(
      [
        run({ enqueued_at: "2026-07-01T00:00:00.000Z", started_at: null, status: "cancelled" }),
        run({ enqueued_at: "2026-07-01T00:30:00.000Z", started_at: null, status: "queued" }),
      ],
      NOW,
    );
    expect(q.never_started).toBe(1);
    expect(q.still_waiting).toBe(1);
    expect(q.oldest_waiting_ms).toBe(1_800_000);
  });

  it("drops negative waits (clock skew) into their own counter, not into p50", () => {
    const q = computeQueueWait(
      [
        run({ enqueued_at: "2026-07-01T00:00:05.000Z", started_at: "2026-07-01T00:00:00.000Z" }),
        run({ enqueued_at: "2026-07-01T00:00:00.000Z", started_at: "2026-07-01T00:00:02.000Z" }),
      ],
      NOW,
    );
    expect(q.negative_waits).toBe(1);
    expect(q.sample).toBe(1);
    expect(q.p50_ms).toBe(2000);
  });

  it("empty input yields nulls, not NaN", () => {
    const q = computeQueueWait([], NOW);
    expect(q.p50_ms).toBeNull();
    expect(q.p95_ms).toBeNull();
    expect(q.oldest_waiting_ms).toBeNull();
    expect(q.sample).toBe(0);
  });
});

describe("fetchAllPaged", () => {
  it("keeps paging past the 1000-row cap until a short page", async () => {
    const TOTAL = 2431;
    const all = Array.from({ length: TOTAL }, (_, i) => ({ id: `r${i}` }));
    const seen: Array<[number, number]> = [];
    const { rows, truncated } = await fetchAllPaged<{ id: string }>(async (from, to) => {
      seen.push([from, to]);
      return { data: all.slice(from, to + 1), error: null };
    });
    expect(rows).toHaveLength(TOTAL);
    expect(truncated).toBe(false);
    expect(seen).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("stops immediately when the first page is short", async () => {
    let calls = 0;
    const { rows } = await fetchAllPaged<{ id: string }>(async () => {
      calls += 1;
      return { data: [{ id: "a" }], error: null };
    });
    expect(rows).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it("flags truncation instead of silently returning a partial answer", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ id: `x${i}` }));
    const { truncated } = await fetchAllPaged<{ id: string }>(async () => ({ data: full, error: null }));
    expect(truncated).toBe(true);
  });

  it("propagates a query error rather than returning a short result", async () => {
    await expect(
      fetchAllPaged(async () => ({ data: null, error: { message: "boom" } })),
    ).rejects.toThrow("boom");
  });
});

describe("parseDays", () => {
  it("defaults to 30 and never lets a non-numeric reach Date arithmetic", () => {
    expect(parseDays(undefined)).toBe(30);
    expect(parseDays("abc")).toBe(30);
    expect(parseDays(NaN)).toBe(30);
  });

  it("clamps to [1, 90]", () => {
    expect(parseDays("0")).toBe(1);
    expect(parseDays("-7")).toBe(1);
    expect(parseDays("100000")).toBe(90);
    expect(parseDays("7")).toBe(7);
  });
});
