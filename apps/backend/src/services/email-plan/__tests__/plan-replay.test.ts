import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; column?: string; value?: unknown }>,
  row: null as { planned_at: string; planned_tz: string; list_name: string } | null,
  error: null as { message: string } | null,
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: vi.fn(async () => {
    throw new Error("unexpected live rpc");
  }),
  tenantClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: (column: string, value: unknown) => {
          h.calls.push({ table, column, value });
          return { maybeSingle: async () => ({ data: h.error ? null : h.row, error: h.error }) };
        },
      }),
    }),
  }),
}));

import { livePlanPrior, planEmail, type PlanDeps, type PlanInput } from "../plan";

const T = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";
const STORED_AT = "2026-11-03T17:00:00.000Z";

const input: PlanInput = {
  route: "sendgrid",
  list_id: "LIST1",
  date: "2026-11-03",
  time: "09:00",
  angle: "November offer",
  why: null,
  source: "founder",
  actor: U,
  request_key: "founder:req-1",
};

function deps(prior: PlanDeps["prior"], list: PlanDeps["list"] = async () => ({ ok: false, code: "list_not_consented" })) {
  const rpc = vi.fn(async (_t: string, name: string, _args: Record<string, unknown>) => {
    if (name === "plan_email_send") return { ok: true, id: "item-1", replayed: true } as never;
    if (name === "email_planned_send_row") return { planned_at: STORED_AT, timezone: "America/Los_Angeles", list_name: "Patients" } as never;
    throw new Error(`unexpected ${name}`);
  });
  const zone = vi.fn(async () => "Europe/Berlin");
  const listFn = vi.fn(list);
  return { rpc, zone, list: listFn, prior: vi.fn(prior), d: { rpc: rpc as PlanDeps["rpc"], zone, list: listFn, prior: vi.fn(prior) } };
}

describe("planEmail: a retry of a plan that was already saved", () => {
  it("is the saved plan even when the list changed since, never a refusal", async () => {
    const t = deps(async () => ({ planned_at: STORED_AT, timezone: "America/Los_Angeles", list_name: "Patients" }));
    const out = await planEmail(T, input, t.d);
    expect(out).toEqual({
      ok: true,
      id: "item-1",
      replayed: true,
      planned_at: STORED_AT,
      label: expect.any(String),
      timezone: "America/Los_Angeles",
      list_name: "Patients",
    });
    expect(t.list).not.toHaveBeenCalled();
    expect(t.zone).not.toHaveBeenCalled();
    const call = t.rpc.mock.calls.find((c) => c[1] === "plan_email_send")!;
    expect(call[2]).toMatchObject({ p_request_key: "founder:req-1", p_planned_at: STORED_AT, p_tz: "America/Los_Angeles", p_list_name: "Patients", p_actor: U, p_source: "founder" });
  });

  it("is the saved plan even when the workspace zone no longer reads", async () => {
    const t = deps(async () => ({ planned_at: STORED_AT, timezone: "America/Los_Angeles", list_name: "Patients" }));
    t.d.zone = vi.fn(async () => "Not/AZone");
    const out = await planEmail(T, input, t.d);
    expect(out.ok).toBe(true);
  });

  it("a first request still checks the list live", async () => {
    const t = deps(async () => null);
    const out = await planEmail(T, input, t.d);
    expect(out).toEqual({ ok: false, code: "list_not_consented" });
    expect(t.list).toHaveBeenCalledTimes(1);
    expect(t.rpc).not.toHaveBeenCalled();
  });

  it("a failed prior read falls back to the live checks", async () => {
    const t = deps(async () => {
      throw new Error("down");
    });
    const out = await planEmail(T, input, t.d);
    expect(out).toEqual({ ok: false, code: "list_not_consented" });
  });
});

describe("livePlanPrior", () => {
  it("reads the saved plan by its request key", async () => {
    h.calls.length = 0;
    h.error = null;
    h.row = { planned_at: STORED_AT, planned_tz: "America/Los_Angeles", list_name: "Patients" };
    expect(await livePlanPrior(T, "founder:req-1")).toEqual({ planned_at: STORED_AT, timezone: "America/Los_Angeles", list_name: "Patients" });
    expect(h.calls).toEqual([{ table: "email_planned_sends", column: "request_key", value: "founder:req-1" }]);
  });

  it("is null when the read fails", async () => {
    h.error = { message: "down" };
    expect(await livePlanPrior(T, "founder:req-1")).toBeNull();
  });
});
