import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  resolved: { tz: "UTC", source: "default" } as { tz: string; source: string } | Error,
  tenant: { timezone: "America/Los_Angeles", reporting_timezone: null } as Record<string, unknown> | null,
  schedule: null as { timezone: string } | null,
  tenantError: null as { message: string } | null,
  reads: [] as Array<{ tenant: string; table: string; cols: string }>,
}));

vi.mock("@/services/analytics/tenant-timezone", () => ({
  resolveReportingTimezone: vi.fn(async () => {
    if (h.resolved instanceof Error) throw h.resolved;
    return h.resolved;
  }),
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: vi.fn(async () => {
    throw new Error("unexpected live rpc");
  }),
  staffCrossTenantClient: () => {
    throw new Error("unexpected cross-tenant read");
  },
  tenantClient: (tenant: string) => ({
    from: (table: string) => ({
      select: (cols: string) => ({
        maybeSingle: async () => {
          h.reads.push({ tenant, table, cols });
          if (table === "tenants") {
            if (h.tenantError) return { data: null, error: h.tenantError };
            if (!h.tenant) return { data: null, error: null };
            return { data: Object.fromEntries(cols.split(",").map((c) => [c.trim(), h.tenant![c.trim()]])), error: null };
          }
          if (table === "email_plan_schedule") return { data: h.schedule, error: null };
          return { data: null, error: null };
        },
      }),
    }),
  }),
}));

vi.mock("@/services/growth/channel-autorun", () => ({ readAutopilotState: async () => ({ enabled: false, on_at: null }) }));
vi.mock("@/services/email-cards/cards", () => ({ plannedReason: () => null, liveCardCount: async () => null }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => undefined }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn(async () => undefined) } }));

import { planByFounder, readPlan } from "../api";
import { livePlanPassDeps } from "../live";
import { runEmailPlanPass, type PassDeps, type ScheduleRow } from "../pass";
import { planEmail } from "../plan";

const T = "7c70da58-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";

function founderPlan() {
  const rpc = vi.fn(async (_t: string, name: string, _args?: unknown) => {
    if (name === "plan_email_send") return { ok: true, id: "item-1", replayed: false } as never;
    throw new Error(`unexpected ${name}`);
  });
  const run = planByFounder(
    T,
    U,
    { route: "zavi_list", list_id: "L1", date: "2026-10-30", time: "09:00", angle: "Fall check-up", request_id: "r1" },
    { plan: { rpc, list: async () => ({ ok: true, name: "QA tiny list" }), prior: async () => null } },
  );
  return { rpc, run };
}

const sent = (rpc: ReturnType<typeof founderPlan>["rpc"]) =>
  rpc.mock.calls.find((c) => c[1] === "plan_email_send")![2] as unknown as Record<string, unknown>;

beforeEach(() => {
  h.resolved = { tz: "UTC", source: "default" };
  h.tenant = { timezone: "America/Los_Angeles", reporting_timezone: null };
  h.schedule = null;
  h.tenantError = null;
  h.reads = [];
});

describe("a workspace with only tenants.timezone set plans on that clock, not UTC", () => {
  it("the founder's 9:00 AM on Oct 30 is saved as 9:00 Los Angeles (16:00Z), stamped America/Los_Angeles", async () => {
    const { rpc, run } = founderPlan();
    const out = await run;
    const args = sent(rpc);
    expect(args.p_tz).toBe("America/Los_Angeles");
    expect(args.p_planned_at).toBe("2026-10-30T16:00:00.000Z");
    expect(out).toMatchObject({ ok: true, timezone: "America/Los_Angeles", planned_at: "2026-10-30T16:00:00.000Z", label: "Fri, Oct 30, 09:00" });
    expect(h.reads).toEqual([
      { tenant: T, table: "email_plan_schedule", cols: "timezone" },
      { tenant: T, table: "tenants", cols: "timezone" },
    ]);
  });

  it("the agent's tool path (planEmail with live zone) stamps the same zone", async () => {
    const rpc = vi.fn(async (_t: string, _n: string, _a: Record<string, unknown>) => ({ ok: true, id: "i2", replayed: false }) as never);
    const out = await planEmail(
      T,
      { route: "zavi_list", list_id: "L1", date: "2026-11-02", time: "09:00", angle: "a", why: null, source: "email_agent", actor: null, request_key: "k2" },
      { rpc, list: async () => ({ ok: true, name: "QA tiny list" }), prior: async () => null },
    );
    expect(rpc.mock.calls[0][2]).toMatchObject({ p_tz: "America/Los_Angeles", p_planned_at: "2026-11-02T17:00:00.000Z" });
    expect(out).toMatchObject({ ok: true, timezone: "America/Los_Angeles", planned_at: "2026-11-02T17:00:00.000Z" });
  });

  it("the Coming up page and the New campaign dialog read America/Los_Angeles with timezone_unread false", async () => {
    const rpc = vi.fn(async (_t: string, name: string) => {
      if (name === "list_email_planned_sends")
        return { ok: true, role: "owner", next_plan_at: "2026-11-02T16:00:00.000Z", items: [], holds: [] } as never;
      throw new Error(`unexpected ${name}`);
    });
    const out = await readPlan(T, U, { rpc });
    expect(out).toMatchObject({ ok: true, timezone: "America/Los_Angeles", timezone_unread: false, next_plan_label: "Mon, Nov 2, 08:00" });
  });

  it.each([
    ["Pacific Standard Time"],
    ["PST"],
    ["EST5EDT"],
    ["America/Not_A_Zone"],
    ["../../etc/passwd"],
    ["America/Los_Angeles; drop table tenants"],
    [""],
    [42],
  ])("a garbage tenants.timezone (%j) is never used: the plan stays UTC", async (bad) => {
    h.tenant = { timezone: bad, reporting_timezone: null };
    const { rpc, run } = founderPlan();
    const out = await run;
    expect(sent(rpc).p_tz).toBe("UTC");
    expect(sent(rpc).p_planned_at).toBe("2026-10-30T09:00:00.000Z");
    expect(out).toMatchObject({ ok: true, timezone: "UTC" });
  });

  it("a failed tenants read warns with the tenant and falls back to UTC rather than refusing the plan", async () => {
    h.tenantError = { message: "permission denied for table tenants" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { rpc, run } = founderPlan();
      await run;
      expect(sent(rpc).p_tz).toBe("UTC");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(T);
      expect(String(warn.mock.calls[0][0])).toContain("permission denied for table tenants");
    } finally {
      warn.mockRestore();
    }
  });

  it("a real reporting zone still wins over tenants.timezone and the schedule, with no fallback read", async () => {
    h.resolved = { tz: "America/Chicago", source: "stored" };
    h.schedule = { timezone: "America/Denver" };
    const { rpc, run } = founderPlan();
    await run;
    expect(sent(rpc).p_tz).toBe("America/Chicago");
    expect(h.reads).toEqual([]);
  });

  it("a schedule row still wins over tenants.timezone when the reporting zone is the default", async () => {
    h.schedule = { timezone: "America/Denver" };
    const { rpc, run } = founderPlan();
    await run;
    expect(sent(rpc).p_tz).toBe("America/Denver");
    expect(h.reads.map((r) => r.table)).toEqual(["email_plan_schedule"]);
  });

  it("a throwing reporting resolver still reaches tenants.timezone", async () => {
    h.resolved = new Error("settings down");
    const { rpc, run } = founderPlan();
    await run;
    expect(sent(rpc).p_tz).toBe("America/Los_Angeles");
  });
});

describe("the weekly pass keeps the schedule on tenants.timezone, so a UTC schedule row never wins later", () => {
  const NOW = new Date("2026-10-27T03:00:00Z");

  async function pass(over: Partial<PassDeps>) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const live = await livePlanPassDeps();
    const deps: PassDeps = {
      ...live,
      now: () => NOW,
      repair: async () => 0,
      alertStuckHolds: async () => 0,
      outboxPending: async () => [],
      claimJobs: async () => [],
      schedulesMissing: async () => [],
      claimSchedules: async () => [],
      claimZoneChecks: async () => [],
      weeklyEligible: async () => false,
      startRun: vi.fn(async () => ({ ok: true })),
      rpc: (async (_t: string, name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return 1;
      }) as PassDeps["rpc"],
      ...over,
    };
    const report = await runEmailPlanPass(deps);
    return { calls, report };
  }

  const scheduleWrites = (calls: Array<{ name: string; args: Record<string, unknown> }>) =>
    calls.filter((c) => c.name === "set_email_plan_schedule").map((c) => ({ tz: c.args.p_tz, next: c.args.p_next }));

  it("a new workspace gets its first Monday at 08:00 Los Angeles, not 08:00 UTC", async () => {
    const { calls, report } = await pass({ schedulesMissing: async () => [T] });
    expect(scheduleWrites(calls)).toEqual([{ tz: "America/Los_Angeles", next: "2026-11-02T16:00:00.000Z" }]);
    expect(report.scheduled).toBe(1);
    expect(h.reads).toContainEqual({ tenant: T, table: "tenants", cols: "timezone" });
  });

  it("a schedule already stamped UTC is moved to Los Angeles", async () => {
    const UTC_ROW: ScheduleRow = { tenant_id: T, lease_token: "", timezone: "UTC" };
    const { calls, report } = await pass({ claimZoneChecks: async () => [UTC_ROW] });
    expect(scheduleWrites(calls).map((w) => w.tz)).toEqual(["America/Los_Angeles"]);
    expect(report.rezoned).toBe(1);
  });

  it("a failed tenants read writes no UTC schedule and counts an error", async () => {
    h.tenantError = { message: "connection reset" };
    const { calls, report } = await pass({ schedulesMissing: async () => [T] });
    expect(scheduleWrites(calls)).toEqual([]);
    expect(report.errors).toBe(1);
  });

  it("a garbage tenants.timezone leaves a new workspace on a UTC Monday", async () => {
    h.tenant = { timezone: "Pacific Standard Time", reporting_timezone: null };
    const { calls } = await pass({ schedulesMissing: async () => [T] });
    expect(scheduleWrites(calls).map((w) => w.tz)).toEqual(["UTC"]);
  });

  it("a real reporting zone still drives the schedule over tenants.timezone", async () => {
    h.resolved = { tz: "America/Chicago", source: "stored" };
    const LA_ROW: ScheduleRow = { tenant_id: T, lease_token: "", timezone: "America/Los_Angeles" };
    const { calls } = await pass({ claimZoneChecks: async () => [LA_ROW] });
    expect(scheduleWrites(calls).map((w) => w.tz)).toEqual(["America/Chicago"]);
    expect(h.reads.filter((r) => r.table === "tenants")).toEqual([]);
  });
});
