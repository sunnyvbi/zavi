
import { describe, it, expect } from "vitest";
import {
  MONITOR_THRESHOLDS,
  classifyRun,
  computeVerdict,
  rollbackHint,
  parseMonitorArgs,
  type MonitoredRun,
} from "../../../scripts/post-switch-monitor";

const TID = "73db45ff-457e-4541-bc8f-bdb625390204";

function run(partial: Partial<MonitoredRun>): MonitoredRun {
  return {
    run_id: "r-0",
    status: "success",
    parse_ok: true,
    cost_usd: 0.01,
    latency_ms: 1000,
    decisions: 1,
    tools_completed: 1,
    tools_errored: 0,
    ...partial,
  };
}

describe("classifyRun", () => {
  it("a healthy run (parsed + fired a decision + tool, no errors) is NOT flagged", () => {
    const c = classifyRun(run({ run_id: "ok", decisions: 1, tools_completed: 2 }));
    expect(c).toMatchObject({ parsed: true, tool_errored: false, silent_noop: false, flagged: false });
  });

  it("a run that PARSED but never fired its tool (no decision, no completed tool) is flagged as silent_noop", () => {
    const c = classifyRun(
      run({ run_id: "noop", parse_ok: true, decisions: 0, tools_completed: 0, tools_errored: 0 }),
    );
    expect(c.parsed).toBe(true);
    expect(c.silent_noop).toBe(true);
    expect(c.flagged).toBe(true);
  });

  it("a run that fired a decision but NO tool is NOT a silent no-op (decision counts as a side-effect)", () => {
    const c = classifyRun(run({ run_id: "dec", decisions: 1, tools_completed: 0 }));
    expect(c.silent_noop).toBe(false);
    expect(c.flagged).toBe(false);
  });

  it("a parse failure is flagged but NOT double-counted as a silent no-op", () => {
    const c = classifyRun(
      run({ run_id: "pf", parse_ok: false, decisions: 0, tools_completed: 0 }),
    );
    expect(c.parsed).toBe(false);
    expect(c.silent_noop).toBe(false);
    expect(c.flagged).toBe(true);
  });

  it("a tool error flags the row even if it otherwise fired side-effects", () => {
    const c = classifyRun(run({ run_id: "te", tools_errored: 1, tools_completed: 1, decisions: 1 }));
    expect(c.tool_errored).toBe(true);
    expect(c.flagged).toBe(true);
  });
});

describe("computeVerdict", () => {
  it("PASS when every run is healthy", () => {
    const v = computeVerdict([
      run({ run_id: "a" }),
      run({ run_id: "b" }),
      run({ run_id: "c" }),
    ]);
    expect(v.verdict).toBe("PASS");
    expect(v.total).toBe(3);
    expect(v.parse_rate).toBe(1);
    expect(v.flagged_rate).toBe(0);
    expect(v.parse_failed_ids).toEqual([]);
    expect(v.silent_noop_ids).toEqual([]);
    expect(v.tool_errored_ids).toEqual([]);
  });

  it("WATCH on a single straggler below the rollback share", () => {
    const v = computeVerdict([
      run({ run_id: "a" }),
      run({ run_id: "b" }),
      run({ run_id: "c" }),
      run({ run_id: "noop1", decisions: 0, tools_completed: 0 }),
      run({ run_id: "noop2", decisions: 0, tools_completed: 0 }),
    ]);
    expect(v.verdict).toBe("WATCH");
    expect(v.silent_noop_ids).toEqual(["noop1", "noop2"]);
    expect(v.flagged_rate).toBeCloseTo(0.4);
  });

  it("ROLLBACK when a majority of runs are flagged", () => {
    const v = computeVerdict([
      run({ run_id: "pf1", parse_ok: false, decisions: 0, tools_completed: 0 }),
      run({ run_id: "noop1", decisions: 0, tools_completed: 0 }),
      run({ run_id: "te1", tools_errored: 1 }),
      run({ run_id: "ok" }),
    ]);
    expect(v.verdict).toBe("ROLLBACK");
    expect(v.flagged_rate).toBeCloseTo(0.75);
    expect(v.parse_failed_ids).toEqual(["pf1"]);
    expect(v.silent_noop_ids).toEqual(["noop1"]);
    expect(v.tool_errored_ids).toEqual(["te1"]);
    expect(v.reasons[0]).toMatch(/flagged-rate/);
  });

  it("WATCH on zero live runs (nothing to judge yet)", () => {
    const v = computeVerdict([]);
    expect(v.verdict).toBe("WATCH");
    expect(v.total).toBe(0);
    expect(v.avg_latency_ms).toBeNull();
    expect(v.reasons.join(" ")).toMatch(/no live runs/);
  });

  it("WATCH when parse-rate dips below the floor (but not a majority flagged)", () => {
    const runs = [run({ run_id: "pf1", parse_ok: false }), run({ run_id: "pf2", parse_ok: false })];
    for (let i = 0; i < 8; i++) runs.push(run({ run_id: `ok${i}` }));
    const v = computeVerdict(runs);
    expect(v.parse_rate).toBeCloseTo(0.8);
    expect(v.verdict).toBe("WATCH");
    expect(v.reasons.join(" ")).toMatch(/parse-rate/);
  });

  it("computes avg cost and avg latency over the inspected runs", () => {
    const v = computeVerdict([
      run({ run_id: "a", cost_usd: 0.02, latency_ms: 1000 }),
      run({ run_id: "b", cost_usd: 0.04, latency_ms: 3000 }),
    ]);
    expect(v.avg_cost_usd).toBeCloseTo(0.03);
    expect(v.avg_latency_ms).toBe(2000);
  });

  it("ignores null latencies when averaging (still finished-only)", () => {
    const v = computeVerdict([
      run({ run_id: "a", latency_ms: 1000 }),
      run({ run_id: "b", latency_ms: null }),
    ]);
    expect(v.avg_latency_ms).toBe(1000);
  });

  it("respects custom thresholds", () => {
    const runs = [
      run({ run_id: "noop", decisions: 0, tools_completed: 0 }),
      run({ run_id: "a" }),
      run({ run_id: "b" }),
      run({ run_id: "c" }),
    ];
    const v = computeVerdict(runs, { ...MONITOR_THRESHOLDS, rollbackFlaggedRate: 0.2 });
    expect(v.verdict).toBe("ROLLBACK");
  });
});

describe("parseMonitorArgs", () => {
  it("parses agent + tenant + limit + provider", () => {
    const a = parseMonitorArgs(["--agent", "research", "--tenant", TID, "--limit", "5", "--provider", "bedrock"]);
    expect(a).toEqual({ agent: "research", tenant: TID, limit: 5, provider: "bedrock" });
  });

  it("defaults tenant to dogfood and limit to 10", () => {
    const a = parseMonitorArgs(["--agent", "growth-lead"]);
    expect(a.tenant).toBe(TID);
    expect(a.limit).toBe(10);
    expect(a.provider).toBeUndefined();
  });

  it("throws when --agent is missing", () => {
    expect(() => parseMonitorArgs([])).toThrow(/--agent/);
  });

  it("clamps a bad --limit to a sane minimum of 1", () => {
    expect(parseMonitorArgs(["--agent", "x", "--limit", "-5"]).limit).toBe(1);
    expect(parseMonitorArgs(["--agent", "x", "--limit", "0"]).limit).toBe(1);
  });
});

describe("rollbackHint", () => {
  it("contains both rollback levers with the tenant + agent interpolated", () => {
    const s = rollbackHint(TID, "research");
    expect(s).toMatch(/ROLLBACK HINT/);
    expect(s).toContain(`"tenant_id":"${TID}","agent_slug":"research"`);
    expect(s).toMatch(/master-kill/);
    expect(s).toMatch(/provider_overrides_disabled/);
  });
});
