import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const state = vi.hoisted(() => ({
  staffThrows: false,
  rpcError: null as { message: string } | null,
  rpcResult: true as boolean,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));

class FakeStaffError extends Error {
  status = 403;
  constructor() {
    super("not_staff");
  }
}

vi.mock("@/services/auth/staff-middleware", () => ({
  assertStaff: () => {
    if (state.staffThrows) throw new FakeStaffError();
    return { user_id: "staff-1", email: "ravi@upcar.ai" };
  },
}));

vi.mock("@/services/tenant-client", () => ({
  staffCrossTenantClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      if (state.rpcError) return { data: null, error: state.rpcError };
      return { data: state.rpcResult, error: null };
    },
  }),
}));

import { staffCreditUnlimitedSet } from "../credit-grant";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

function mkRes() {
  const out = { code: 200, body: null as unknown };
  const res = {
    status(c: number) {
      out.code = c;
      return this;
    },
    json(b: unknown) {
      out.body = b;
      return this;
    },
  } as unknown as Response;
  return { res, out };
}

const call = async (body: unknown) => {
  const { res, out } = mkRes();
  await staffCreditUnlimitedSet({ body } as Request, res);
  return out;
};

beforeEach(() => {
  state.staffThrows = false;
  state.rpcError = null;
  state.rpcResult = true;
  state.rpcCalls = [];
});

describe("POST /api/admin/credit-unlimited", () => {
  it("turns unlimited ON and reports the change", async () => {
    const out = await call({ tenant_id: TENANT, unlimited: true, reason: "design partner comp" });
    expect(out.code).toBe(200);
    expect(out.body).toEqual({ unlimited: true, changed: true });
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].fn).toBe("set_tenant_credits_unlimited");
    expect(state.rpcCalls[0].args).toMatchObject({
      p_tenant_id: TENANT,
      p_unlimited: true,
      p_reason: "design partner comp",
    });
  });

  it("turns unlimited OFF (the guard must be restorable through the same door)", async () => {
    const out = await call({ tenant_id: TENANT, unlimited: false, reason: "comp ended" });
    expect(out.code).toBe(200);
    expect(out.body).toEqual({ unlimited: false, changed: true });
    expect(state.rpcCalls[0].args).toMatchObject({ p_unlimited: false });
  });

  it("reports changed:false on a no-op re-set", async () => {
    state.rpcResult = false;
    const out = await call({ tenant_id: TENANT, unlimited: true, reason: "again" });
    expect(out.body).toEqual({ unlimited: true, changed: false });
  });

  it("forwards the SERVER's staff email as actor, ignoring any client-supplied one", async () => {
    await call({
      tenant_id: TENANT,
      unlimited: true,
      reason: "comp",
      actor_email: "attacker@evil.com",
      p_actor_email: "attacker@evil.com",
    });
    expect(state.rpcCalls[0].args.p_actor_email).toBe("ravi@upcar.ai");
  });

  it("is staff-gated — a non-staff caller never reaches the RPC", async () => {
    state.staffThrows = true;
    await expect(call({ tenant_id: TENANT, unlimited: true, reason: "comp" })).rejects.toThrow(
      "not_staff",
    );
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('rejects a non-boolean `unlimited` — the string "false" must not uncap a tenant', async () => {
    for (const bad of ["false", "true", 1, 0, null, undefined]) {
      state.rpcCalls = [];
      const out = await call({ tenant_id: TENANT, unlimited: bad, reason: "comp" });
      expect(out.code).toBe(400);
      expect((out.body as { error: { code: string } }).error.code).toBe("invalid_unlimited");
      expect(state.rpcCalls).toHaveLength(0);
    }
  });

  it("rejects a missing/short reason — the audit trail cannot be blank", async () => {
    for (const bad of ["", "  ", "ab", undefined]) {
      state.rpcCalls = [];
      const out = await call({ tenant_id: TENANT, unlimited: true, reason: bad });
      expect(out.code).toBe(400);
      expect((out.body as { error: { code: string } }).error.code).toBe("invalid_reason");
      expect(state.rpcCalls).toHaveLength(0);
    }
  });

  it("rejects a non-UUID tenant_id", async () => {
    for (const bad of ["", "not-a-uuid", "73db45ff", 42]) {
      state.rpcCalls = [];
      const out = await call({ tenant_id: bad, unlimited: true, reason: "comp" });
      expect(out.code).toBe(400);
      expect((out.body as { error: { code: string } }).error.code).toBe("invalid_tenant_id");
      expect(state.rpcCalls).toHaveLength(0);
    }
  });

  it("surfaces an RPC failure as 400 rather than reporting a success", async () => {
    state.rpcError = { message: "no such tenant" };
    const out = await call({ tenant_id: TENANT, unlimited: true, reason: "comp" });
    expect(out.code).toBe(400);
    expect((out.body as { error: { code: string } }).error.code).toBe("unlimited_set_failed");
  });
});

describe("migration 20260829120000 (unlimited credits)", () => {
  const sql = readFileSync(
    join(__dirname, "../../../../../../supabase/migrations/20260829120000_tenant_credits_unlimited.sql"),
    "utf8",
  );

  it("adds the flag defaulting to FALSE — no existing tenant is uncapped by the migration", () => {
    expect(sql).toMatch(/add column if not exists credits_unlimited boolean not null default false/);
  });

  it("guards the availability raise with the unlimited predicate", () => {
    expect(sql).toMatch(/if v_avail < p_estimate and not _credits_unlimited\(p_tenant_id\) then/);
    expect(sql).toMatch(/raise exception 'insufficient_credits' using errcode = 'P0001'/);
  });

  it("keeps an exempt tenant metered — the hold and the reserve ledger row still happen", () => {
    const body = sql.slice(sql.indexOf("function reserve_run_credits("));
    expect(body).toMatch(/set reserved = reserved \+ p_estimate/);
    expect(body).toMatch(/insert into tenant_credit_ledger .*kind, amount, agent_slug/s);
    expect(sql).not.toMatch(/_credits_enforced[\s\S]{0,80}_credits_unlimited/);
  });

  it("preserves reserve_run_credits' arity so both triggers keep resolving to it", () => {
    expect(sql).toMatch(/reserve_run_credits\(\s*p_tenant_id\s+uuid,\s*p_run_id\s+uuid,\s*p_agent_slug text,\s*p_estimate\s+int,\s*p_attempt\s+int/);
    expect(sql).toMatch(/grant execute on function reserve_run_credits\(uuid, uuid, text, int, int\) to service_role/);
  });

  it("the predicate fails closed for an unknown tenant", () => {
    expect(sql).toMatch(/select coalesce\(\(select credits_unlimited from tenants where id = p_tenant_id\), false\)/);
  });

  it("the setter is service_role-only and audits every change", () => {
    expect(sql).toMatch(/revoke all on function set_tenant_credits_unlimited\(uuid, boolean, text, text\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function set_tenant_credits_unlimited\(uuid, boolean, text, text\) to service_role/);
    expect(sql).toMatch(/insert into admin_action_log/);
    expect(sql).toMatch(/credits_unlimited_on/);
    expect(sql).toMatch(/credits_unlimited_off/);
  });
});
