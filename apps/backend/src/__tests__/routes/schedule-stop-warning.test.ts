
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/services/auth/require-auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/services/agents/schedules", () => ({
  getSchedule: vi.fn(),
  upsertSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  ScheduleValidationError: class extends Error {},
  ScheduleForbiddenError: class extends Error {},
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: vi.fn() }),
  serverClientFromBearer: () => ({ rpc: vi.fn() }),
}));

import { scheduleWarningFor } from "@/routes/agents/schedule";
import { SCHEDULED_AGENTS_ALLOWED } from "@/services/agents/cron-stopped";

afterEach(() => {
  delete process.env.PRAXIS_DISABLE_CRON_STOP;
});

describe("scheduleWarningFor", () => {
  it("warns for every slug, because the allowlist is empty", () => {
    for (const slug of ["pm", "chief-of-staff", "operator", "research", "onboarding-discovery"]) {
      const w = scheduleWarningFor(slug, true);
      expect(w, slug).toBeTruthy();
      expect(w).toContain("stopped fleet-wide");
      expect(w).toContain("Manual and chat runs still work");
    }
  });

  it("goes quiet for any slug the allowlist names", () => {
    for (const slug of SCHEDULED_AGENTS_ALLOWED) {
      expect(scheduleWarningFor(slug, true), slug).toBeUndefined();
    }
  });

  it("says nothing when the row is disabled, even for a stopped slug", () => {
    expect(scheduleWarningFor("pm", false)).toBeUndefined();
  });

  it("goes quiet when the escape hatch lifts the stop", () => {
    process.env.PRAXIS_DISABLE_CRON_STOP = "1";
    expect(scheduleWarningFor("pm", true)).toBeUndefined();
  });
});
