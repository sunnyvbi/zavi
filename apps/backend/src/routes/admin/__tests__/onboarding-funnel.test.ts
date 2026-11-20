import { describe, it, expect } from "vitest";
import { aggregateOnboardingFunnel } from "../onboarding-funnel";
import type { StepEventInput } from "../onboarding-funnel";

describe("aggregateOnboardingFunnel (GAP #52)", () => {
  it("returns an empty array for no events", () => {
    expect(aggregateOnboardingFunnel([])).toEqual([]);
  });

  it("aggregates drop-off by step, worst-drop first", () => {
    const events: StepEventInput[] = [
      { tenant_id: null, user_id: "1", step: "industry", status: "entered" },
      { tenant_id: null, user_id: "2", step: "industry", status: "entered" },
      { tenant_id: null, user_id: "1", step: "industry", status: "completed" },
      { tenant_id: null, user_id: "1", step: "goals", status: "entered" },
      { tenant_id: null, user_id: "2", step: "goals", status: "entered" },
      { tenant_id: null, user_id: "3", step: "goals", status: "entered" },
      { tenant_id: null, user_id: "1", step: "goals", status: "completed" },
    ];
    const steps = aggregateOnboardingFunnel(events);

    expect(steps[0].step).toBe("goals");
    expect(steps[0].uniqueEntered).toBe(3);
    expect(steps[0].uniqueCompleted).toBe(1);
    expect(steps[0].droppedAtStep).toBe(2);
    expect(steps[0].completionRate).toBeCloseTo(1 / 3);

    const industry = steps.find((s) => s.step === "industry")!;
    expect(industry.uniqueEntered).toBe(2);
    expect(industry.droppedAtStep).toBe(1);
    expect(industry.completionRate).toBeCloseTo(0.5);
  });

  it("does not double-count an actor re-entering a step", () => {
    const events: StepEventInput[] = [
      { tenant_id: null, user_id: "1", step: "industry", status: "entered" },
      { tenant_id: null, user_id: "1", step: "industry", status: "entered" },
      { tenant_id: null, user_id: "1", step: "industry", status: "completed" },
    ];
    const [industry] = aggregateOnboardingFunnel(events);
    expect(industry.entered).toBe(2);
    expect(industry.uniqueEntered).toBe(1);
    expect(industry.uniqueCompleted).toBe(1);
    expect(industry.droppedAtStep).toBe(0);
  });

  it("counts skipped and abandoned without inflating entered/completed actors", () => {
    const events: StepEventInput[] = [
      { tenant_id: null, user_id: "1", step: "connect", status: "entered" },
      { tenant_id: null, user_id: "1", step: "connect", status: "skipped" },
      { tenant_id: null, user_id: "2", step: "connect", status: "abandoned" },
    ];
    const [connect] = aggregateOnboardingFunnel(events);
    expect(connect.entered).toBe(1);
    expect(connect.skipped).toBe(1);
    expect(connect.abandoned).toBe(1);
    expect(connect.uniqueEntered).toBe(1);
    expect(connect.uniqueCompleted).toBe(0);
    expect(connect.droppedAtStep).toBe(1);
  });

  it("falls back to tenant_id as the actor key when user_id is null", () => {
    const events: StepEventInput[] = [
      { tenant_id: "t1", user_id: null, step: "activate", status: "entered" },
      { tenant_id: "t1", user_id: null, step: "activate", status: "completed" },
      { tenant_id: "t2", user_id: null, step: "activate", status: "entered" },
    ];
    const [activate] = aggregateOnboardingFunnel(events);
    expect(activate.uniqueEntered).toBe(2);
    expect(activate.uniqueCompleted).toBe(1);
    expect(activate.droppedAtStep).toBe(1);
  });

  it("reports completionRate null when nobody entered (only abandoned)", () => {
    const events: StepEventInput[] = [
      { tenant_id: null, user_id: "1", step: "ghost", status: "abandoned" },
    ];
    const [ghost] = aggregateOnboardingFunnel(events);
    expect(ghost.uniqueEntered).toBe(0);
    expect(ghost.completionRate).toBeNull();
  });
});
