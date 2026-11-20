import { describe, it, expect } from "vitest";
import {
  computeDeliveryReport,
  type SchedRunRow,
} from "../scheduled-delivery-eval";

function rows(agent: string, status: string, n: number): SchedRunRow[] {
  return Array.from({ length: n }, () => ({ agent_slug: agent, status }));
}

describe("computeDeliveryReport", () => {
  it("the 2026-06-12 incident: 2 delivered / 16 missed → global alarm fires", () => {
    const r = computeDeliveryReport([
      ...rows("pm", "success", 1),
      ...rows("pm", "failed", 11),
      ...rows("chief-of-staff", "success", 1),
      ...rows("chief-of-staff", "failed", 3),
      ...rows("growth-lead", "failed", 2),
    ]);
    expect(r.global.terminal).toBe(18);
    expect(r.global.delivered).toBe(2);
    expect(r.global.rate).toBeCloseTo(2 / 18, 5);
    expect(r.globalAlarmed).toBe(true);
    const pm = r.perAgent.find((a) => a.agent_slug === "pm")!;
    expect(pm.terminal).toBe(12);
    expect(pm.delivered).toBe(1);
    expect(r.alarmedAgents.map((a) => a.agent_slug)).toContain("pm");
  });

  it("healthy morning: all delivered → no alarm", () => {
    const r = computeDeliveryReport([
      ...rows("pm", "success", 13),
      ...rows("chief-of-staff", "success", 13),
      ...rows("growth-lead", "success", 10),
    ]);
    expect(r.global.rate).toBe(1);
    expect(r.globalAlarmed).toBe(false);
    expect(r.alarmedAgents).toHaveLength(0);
  });

  it("min-sample floor: a single missed run on a tiny sample does NOT page", () => {
    const r = computeDeliveryReport([
      ...rows("pm", "success", 1),
      ...rows("pm", "failed", 1),
    ]);
    expect(r.global.rate).toBe(0.5);
    expect(r.globalAlarmed).toBe(false);
    expect(r.alarmedAgents).toHaveLength(0);
  });

  it("non-terminal + cancelled excluded from the denominator", () => {
    const r = computeDeliveryReport([
      ...rows("pm", "success", 10),
      ...rows("pm", "running", 5),
      ...rows("pm", "queued", 5),
      ...rows("pm", "cancelled", 3),
    ]);
    expect(r.global.terminal).toBe(10);
    expect(r.global.rate).toBe(1);
    expect(r.globalAlarmed).toBe(false);
  });

  it("per-agent alarm isolates the offender; healthy agents stay clear", () => {
    const r = computeDeliveryReport([
      ...rows("pm", "failed", 6),
      ...rows("growth-lead", "success", 8),
    ]);
    const alarmed = r.alarmedAgents.map((a) => a.agent_slug);
    expect(alarmed).toContain("pm");
    expect(alarmed).not.toContain("growth-lead");
    expect(r.perAgent[0].agent_slug).toBe("pm");
  });

  it("empty input is vacuously healthy (rate 1, no alarm)", () => {
    const r = computeDeliveryReport([]);
    expect(r.global.terminal).toBe(0);
    expect(r.global.rate).toBe(1);
    expect(r.globalAlarmed).toBe(false);
  });
});
