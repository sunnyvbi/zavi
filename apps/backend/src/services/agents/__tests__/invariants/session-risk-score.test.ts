
import { describe, it, expect } from "vitest";
import {
  accrueRisk,
  wouldEscalate,
  RISK_POINTS,
  DEFAULT_RISK_THRESHOLD,
} from "../../../mcp/session-risk-score";

describe("invariant: session-risk scorer only escalates E3 writes past threshold", () => {
  it("accrues points by class; reads are free", () => {
    expect(accrueRisk(0, "read")).toBe(0);
    expect(accrueRisk(0, "write_low")).toBe(RISK_POINTS.write_low);
    expect(accrueRisk(3, "write_money")).toBe(3 + RISK_POINTS.write_money);
  });

  it("NEVER escalates a read or an internal write_low, even at a huge score", () => {
    expect(wouldEscalate(9999, "read")).toBe(false);
    expect(wouldEscalate(9999, "write_low")).toBe(false);
  });

  it("escalates an E3 write only AT/ABOVE the threshold", () => {
    const t = DEFAULT_RISK_THRESHOLD;
    for (const cls of ["write_money", "write_code", "write_external"] as const) {
      expect(wouldEscalate(t - 1, cls)).toBe(false);
      expect(wouldEscalate(t, cls)).toBe(true);
      expect(wouldEscalate(t + 5, cls)).toBe(true);
    }
  });

  it("a cold session (score 0) never escalates even an E3 write", () => {
    expect(wouldEscalate(0, "write_money")).toBe(false);
  });
});
