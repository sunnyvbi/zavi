import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  checks: [] as Array<{ name: string; status: string; detail: string; fix?: string }>,
  alert: vi.fn(),
  handler: null as null | ((ctx: unknown) => Promise<unknown>),
}));

vi.mock("../../client", () => ({
  inngest: {
    createFunction: (_cfg: unknown, _trigger: unknown, fn: (ctx: unknown) => Promise<unknown>) => {
      mocks.handler = fn;
      return {};
    },
  },
}));
vi.mock("@/services/doctor/run", () => ({ runDoctorChecks: async () => mocks.checks }));
vi.mock("@/services/doctor/log-to-praxis-logs", () => ({ logDoctorChecks: async () => undefined }));
vi.mock("@/services/logging/alert", () => ({ alert: mocks.alert }));

import "../praxis-doctor-cron";

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

describe("praxis-doctor-cron paging", () => {
  beforeEach(() => mocks.alert.mockReset());

  it("pages once with the failing check names and a daily dedupe key", async () => {
    mocks.checks = [
      { name: "uptime", status: "ok", detail: "up" },
      { name: "secrets", status: "fail", detail: "check threw AccessDeniedException" },
      { name: "inngest", status: "fail", detail: "no pong", fix: "restart worker" },
    ];
    await mocks.handler!({ logger });
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    const arg = mocks.alert.mock.calls[0][0];
    expect(arg.code).toBe("doctor.check_failed");
    expect(arg.msg).toContain("inngest,secrets");
    expect(arg.email.dedupeKey).toMatch(/^doctor-failed:inngest,secrets:\d{4}-\d{2}-\d{2}$/);
  });

  it("does not page when every check is ok or warn", async () => {
    mocks.checks = [
      { name: "uptime", status: "ok", detail: "up" },
      { name: "secrets", status: "warn", detail: "drift" },
    ];
    await mocks.handler!({ logger });
    expect(mocks.alert).not.toHaveBeenCalled();
  });
});
