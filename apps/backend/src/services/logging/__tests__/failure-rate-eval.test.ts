import { describe, it, expect } from "vitest";
import {
  computeFailureRateReport,
  FAILURE_STATUSES,
  TERMINAL_STATUSES,
  type RunRow,
} from "../failure-rate-eval";

function rows(spec: Array<[string | null, string | null, number]>): RunRow[] {
  const out: RunRow[] = [];
  for (const [tenant_id, status, n] of spec) {
    for (let i = 0; i < n; i++) out.push({ tenant_id, status });
  }
  return out;
}

describe("computeFailureRateReport — status taxonomy", () => {
  it("counts failed/parse_failed/dispatch_error as failures; success/done as healthy", () => {
    expect([...FAILURE_STATUSES].sort()).toEqual(
      ["dispatch_error", "failed", "parse_failed"].sort(),
    );
    expect(TERMINAL_STATUSES.has("success")).toBe(true);
    expect(TERMINAL_STATUSES.has("done")).toBe(true);
    expect(TERMINAL_STATUSES.has("cancelled")).toBe(false);
  });

  it("excludes non-terminal + cancelled statuses from the denominator", () => {
    const report = computeFailureRateReport(
      rows([
        ["t1", "failed", 5],
        ["t1", "running", 100],
        ["t1", "queued", 100],
        ["t1", "cancelled", 100],
        ["t1", "blocked", 100],
      ]),
      { minTerminalPerTenant: 1, minTerminalGlobal: 1 },
    );
    expect(report.global.terminal).toBe(5);
    expect(report.global.failed).toBe(5);
    expect(report.global.rate).toBe(1);
  });

  it("ignores unknown/garbage statuses and null statuses", () => {
    const report = computeFailureRateReport(
      rows([
        ["t1", "success", 4],
        ["t1", "wat", 50],
        ["t1", null, 50],
        ["t1", "", 50],
      ]),
      { minTerminalPerTenant: 1, minTerminalGlobal: 1 },
    );
    expect(report.global.terminal).toBe(4);
    expect(report.global.failed).toBe(0);
  });
});

describe("computeFailureRateReport — thresholding", () => {
  it("does NOT alarm a tenant below the min-sample floor even at 100% failure", () => {
    const report = computeFailureRateReport(
      rows([["t1", "failed", 3]]),
      { rateThreshold: 0.5, minTerminalPerTenant: 5, minTerminalGlobal: 20 },
    );
    expect(report.perTenant[0].rate).toBe(1);
    expect(report.alarmedTenants).toHaveLength(0);
    expect(report.globalAlarmed).toBe(false);
  });

  it("alarms a tenant over threshold on a large-enough sample", () => {
    const report = computeFailureRateReport(
      rows([
        ["t1", "failed", 6],
        ["t1", "success", 2],
        ["t2", "success", 10],
      ]),
      { rateThreshold: 0.5, minTerminalPerTenant: 5, minTerminalGlobal: 100 },
    );
    expect(report.alarmedTenants).toHaveLength(1);
    expect(report.alarmedTenants[0].tenant_id).toBe("t1");
    expect(report.alarmedTenants[0].rate).toBeCloseTo(0.75, 5);
  });

  it("does NOT alarm a tenant under threshold even on a large sample", () => {
    const report = computeFailureRateReport(
      rows([
        ["t1", "failed", 4],
        ["t1", "success", 16],
      ]),
      { rateThreshold: 0.5, minTerminalPerTenant: 5, minTerminalGlobal: 100 },
    );
    expect(report.alarmedTenants).toHaveLength(0);
  });

  it("alarms globally when the aggregate is over bar even if no single tenant trips its floor", () => {
    const spec: Array<[string, string, number]> = [];
    for (let i = 0; i < 12; i++) {
      spec.push([`t${i}`, "failed", 2]);
    }
    const report = computeFailureRateReport(rows(spec), {
      rateThreshold: 0.5,
      minTerminalPerTenant: 5,
      minTerminalGlobal: 20,
    });
    expect(report.alarmedTenants).toHaveLength(0);
    expect(report.global.terminal).toBe(24);
    expect(report.global.rate).toBe(1);
    expect(report.globalAlarmed).toBe(true);
  });

  it("does NOT alarm globally below the global min-sample floor", () => {
    const report = computeFailureRateReport(
      rows([["t1", "failed", 10]]),
      { rateThreshold: 0.5, minTerminalPerTenant: 50, minTerminalGlobal: 20 },
    );
    expect(report.global.terminal).toBe(10);
    expect(report.globalAlarmed).toBe(false);
  });

  it("tracks parse_failed separately within the failure count", () => {
    const report = computeFailureRateReport(
      rows([
        ["t1", "parse_failed", 4],
        ["t1", "failed", 2],
        ["t1", "success", 4],
      ]),
      { rateThreshold: 0.5, minTerminalPerTenant: 5, minTerminalGlobal: 1 },
    );
    expect(report.global.failed).toBe(6);
    expect(report.global.parse_failed).toBe(4);
    expect(report.perTenant[0].parse_failed).toBe(4);
  });

  it("returns zeroed report (no alarm) for an empty window", () => {
    const report = computeFailureRateReport([]);
    expect(report.global.terminal).toBe(0);
    expect(report.global.rate).toBe(0);
    expect(report.alarmedTenants).toHaveLength(0);
    expect(report.globalAlarmed).toBe(false);
  });

  it("sorts perTenant by rate desc then failed desc", () => {
    const report = computeFailureRateReport(
      rows([
        ["lowrate", "failed", 2],
        ["lowrate", "success", 8],
        ["highrate", "failed", 9],
        ["highrate", "success", 1],
      ]),
      { minTerminalPerTenant: 1, minTerminalGlobal: 1 },
    );
    expect(report.perTenant[0].tenant_id).toBe("highrate");
    expect(report.perTenant[1].tenant_id).toBe("lowrate");
  });
});
