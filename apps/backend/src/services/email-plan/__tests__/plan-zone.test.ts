import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  resolved: { tz: "UTC", source: "default" } as { tz: string; source: string } | Error,
  schedule: { timezone: "America/Los_Angeles" } as { timezone: string } | null,
  tables: [] as string[],
  scheduleError: null as { message: string } | null,
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
  tenantClient: () => ({
    from: (table: string) => {
      h.tables.push(table);
      return {
        select: () => ({
          maybeSingle: async () =>
            h.scheduleError && table === "email_plan_schedule"
              ? { data: null, error: h.scheduleError }
              : { data: table === "email_plan_schedule" ? h.schedule : null, error: null },
        }),
      };
    },
  }),
}));

vi.mock("@/services/growth/channel-autorun", () => ({ readAutopilotState: async () => ({ enabled: false, on_at: null }) }));
vi.mock("@/services/email-cards/cards", () => ({ plannedReason: () => null, liveCardCount: async () => null }));
vi.mock("../live", () => ({ weeklyEligible: async () => null }));

import { planByFounder, readPlan } from "../api";

const T = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";

function founderPlan() {
  const rpc = vi.fn(async (_t: string, name: string, _args?: unknown) => {
    if (name === "plan_email_send") return { ok: true, id: "item-1", replayed: false } as never;
    throw new Error(`unexpected ${name}`);
  });
  const run = planByFounder(
    T,
    U,
    { route: "zavi_list", list_id: "L1", date: "2026-10-30", time: "05:00", angle: "Fall check-up", request_id: "r1" },
    { plan: { rpc, list: async () => ({ ok: true, name: "Patients" }), prior: async () => null } },
  );
  return { rpc, run };
}

describe("a founder's planned email takes the plan's zone, never the UTC fallback", () => {
  beforeEach(() => {
    h.resolved = { tz: "UTC", source: "default" };
    h.schedule = { timezone: "America/Los_Angeles" };
    h.tables = [];
    h.scheduleError = null;
  });

  it("must catch the Coming up UTC card: the reporting zone falls back to UTC while the weekly plan runs on Los Angeles", async () => {
    const { rpc, run } = founderPlan();
    const out = await run;
    const args = rpc.mock.calls.find((c) => c[1] === "plan_email_send")![2] as unknown as Record<string, unknown>;
    expect(args.p_tz).toBe("America/Los_Angeles");
    expect(args.p_planned_at).toBe("2026-10-30T12:00:00.000Z");
    expect(out).toMatchObject({ ok: true, timezone: "America/Los_Angeles", planned_at: "2026-10-30T12:00:00.000Z" });
    expect(h.tables).toEqual(["email_plan_schedule"]);
  });

  it("a failing resolver is no reason to stamp UTC either", async () => {
    h.resolved = new Error("tenants read failed");
    const { rpc, run } = founderPlan();
    await run;
    expect((rpc.mock.calls[0][2] as unknown as Record<string, unknown>).p_tz).toBe("America/Los_Angeles");
  });

  it("a real reporting zone still wins over the schedule's", async () => {
    h.resolved = { tz: "America/Chicago", source: "stored" };
    const { rpc, run } = founderPlan();
    await run;
    expect((rpc.mock.calls[0][2] as unknown as Record<string, unknown>).p_tz).toBe("America/Chicago");
    expect(h.tables).toEqual([]);
  });

  it("with no schedule and no zone the plan is in UTC", async () => {
    h.schedule = null;
    const { rpc, run } = founderPlan();
    await run;
    expect((rpc.mock.calls[0][2] as unknown as Record<string, unknown>).p_tz).toBe("UTC");
  });

  it("a failed schedule read warns once and falls back to UTC", async () => {
    h.scheduleError = { message: "permission denied for table email_plan_schedule" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { rpc, run } = founderPlan();
      const out = await run;
      expect((rpc.mock.calls[0][2] as unknown as Record<string, unknown>).p_tz).toBe("UTC");
      expect(out).toMatchObject({ ok: true, timezone: "UTC" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("email_plan_schedule");
      expect(String(warn.mock.calls[0][0])).toContain(T);
      expect(String(warn.mock.calls[0][0])).toContain("permission denied");
    } finally {
      warn.mockRestore();
    }
  });

  it("the Coming up page reads the same zone the founder's plan is saved in", async () => {
    const rpc = vi.fn(async (_t: string, name: string) => {
      if (name === "list_email_planned_sends") return { ok: true, role: "owner", next_plan_at: null, items: [], holds: [] } as never;
      throw new Error(`unexpected ${name}`);
    });
    const out = await readPlan(T, U, { rpc });
    expect(out).toMatchObject({ ok: true, timezone: "America/Los_Angeles" });
  });
});
