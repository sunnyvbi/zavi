import { describe, it, expect, vi, beforeEach } from "vitest";

describe("onboarding step status constants", () => {
  it("exposes exactly the four wizard statuses", async () => {
    const { ONBOARDING_STEP_STATUSES } = await import("../step-events");
    expect([...ONBOARDING_STEP_STATUSES].sort()).toEqual(
      ["abandoned", "completed", "entered", "skipped"],
    );
  });
});

describe("logOnboardingStep (best-effort contract)", () => {
  async function load(insertImpl: () => Promise<{ error: unknown }>) {
    vi.resetModules();
    const insert = vi.fn(insertImpl);
    vi.doMock("@/services/supabase", () => ({
      serviceClient: () => ({ from: () => ({ insert }) }),
    }));
    const mod = await import("../step-events");
    return { logOnboardingStep: mod.logOnboardingStep, insert };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("inserts the event with server-supplied ids and defaults status to 'entered'", async () => {
    const { logOnboardingStep, insert } = await load(async () => ({ error: null }));
    await logOnboardingStep({ tenantId: "t1", userId: "u1", step: "goals" });
    expect(insert).toHaveBeenCalledWith({
      tenant_id: "t1",
      user_id: "u1",
      step: "goals",
      status: "entered",
      meta: {},
    });
  });

  it("passes through an explicit status + meta", async () => {
    const { logOnboardingStep, insert } = await load(async () => ({ error: null }));
    await logOnboardingStep({
      tenantId: null,
      userId: "u1",
      step: "industry",
      status: "completed",
      meta: { from: "start" },
    });
    expect(insert).toHaveBeenCalledWith({
      tenant_id: null,
      user_id: "u1",
      step: "industry",
      status: "completed",
      meta: { from: "start" },
    });
  });

  it("does NOT throw when the insert returns an error (best-effort)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { logOnboardingStep } = await load(async () => ({ error: { message: "db down" } }));
    await expect(
      logOnboardingStep({ tenantId: "t1", userId: "u1", step: "goals" }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("does NOT throw when the insert itself throws (best-effort)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { logOnboardingStep } = await load(async () => {
      throw new Error("boom");
    });
    await expect(
      logOnboardingStep({ tenantId: "t1", userId: "u1", step: "goals" }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe("POST /api/onboarding/step validation", () => {
  it("returns a readable message on a bad body, not the raw zod issue dump", async () => {
    vi.resetModules();
    const { onboardingStep } = await import("../step");
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    await onboardingStep({ body: { step: "" } } as never, { status } as never);
    expect(status).toHaveBeenCalledWith(400);
    const message = json.mock.calls[0][0].error.message as string;
    expect(message).toContain("step");
    expect(message.trim().startsWith("[")).toBe(false);
  });
});
