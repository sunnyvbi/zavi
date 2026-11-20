
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

let rpcResult: { data: unknown; error: unknown } = { data: "goal-1", error: null };
const rpcSpy = vi.fn(
  async (_name: string, _args: Record<string, unknown>) => rpcResult,
);

let goalsListResult: { data: unknown; error: unknown } = { data: [], error: null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const listChain: any = {
  select: vi.fn(() => listChain),
  eq: vi.fn(() => listChain),
  order: vi.fn(() => listChain),
  limit: vi.fn(async () => goalsListResult),
};

let svcReadResult: { data: unknown; error: unknown } = { data: { status: "active" }, error: null };
let svcMutateResult: { data: unknown; error: unknown } = { data: [{ id: "g1" }], error: null };
let svcEqCalls: Array<[string, unknown]> = [];
let svcDuplicateResult: { data: unknown; error: unknown } = { data: [], error: null };
let svcUpsertCalls: Array<Record<string, unknown>> = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svcChain: any = {
  select: vi.fn(() => svcChain),
  update: vi.fn(() => svcChain),
  delete: vi.fn(() => svcChain),
  upsert: vi.fn(async (row: Record<string, unknown>) => {
    svcUpsertCalls.push(row);
    return { error: null };
  }),
  eq: vi.fn((col: string, val: unknown) => { svcEqCalls.push([col, val]); return svcChain; }),
  not: vi.fn(() => svcChain),
  is: vi.fn((col: string, val: unknown) => { svcEqCalls.push([col, val]); return svcChain; }),
  maybeSingle: vi.fn(async () => svcReadResult),
  limit: vi.fn(async () => svcDuplicateResult),
  then: (resolve: (v: unknown) => unknown) => resolve(svcMutateResult),
};

let authResult: { user_id: string; tenant_id: string; access_token: string } | null = {
  user_id: "u-1",
  tenant_id: "t-1",
  access_token: "tok",
};

let enabled = true;

let role: string | null = "owner";
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn(async (_auth: unknown, allowed: readonly string[], res: Response) => {
    if (role && allowed.includes(role)) return true;
    res.status(403).json({ error: { code: "forbidden", message: "role" } });
    return false;
  }),
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (authResult) return authResult;
    res.status(401).json({ error: { code: "unauthenticated", message: "no auth" } });
    return null;
  }),
}));

const goalWrites: Array<Record<string, unknown>> = [];
let failNextGoalUpdate: { message: string } | null = null;
async function fakeGoalWrite(args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> {
  goalWrites.push(args);
  if (args.p_op !== "insert" && failNextGoalUpdate) {
    const error = failNextGoalUpdate;
    failNextGoalUpdate = null;
    return { data: null, error };
  }
  if (args.p_op === "insert") {
    const r = await rpcSpy("write_autopilot_goal", args);
    return r.error ? { data: null, error: r.error } : { data: { status: "written", id: r.data }, error: null };
  }
  if (args.p_op === "update") svcChain.update(args.p_values);
  else svcChain.delete();
  svcChain.eq("id", args.p_goal_id);
  svcChain.eq("tenant_id", args.p_tenant_id);
  const r = svcMutateResult;
  if (r.error) return { data: null, error: r.error };
  const rows = (r.data as Array<{ id: string }> | null) ?? [];
  return { data: rows.length > 0 ? { status: "written", id: rows[0].id } : { status: "not_matched", id: null }, error: null };
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: vi.fn(() => ({
    from: vi.fn(() => listChain),
  })),
  serviceClient: vi.fn(() => ({
    rpc: (name: string, args: Record<string, unknown>) => (name === "write_autopilot_goal" ? fakeGoalWrite(args) : rpcSpy(name, args)),
    from: vi.fn(() => svcChain),
  })),
}));

vi.mock("@/services/growth/goal-attention", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/growth/goal-attention")>();
  return { ...real, sendGoalAttention: vi.fn(real.sendGoalAttention) };
});

vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(async () => enabled),
}));

vi.mock("@/services/onboarding/enrichment/sanitize", () => ({
  sanitizeFetchedContent: (s: string) => s,
  xmlEscapeContent: (s: string) => s,
  decodeXmlEntities: (s: string) => s,
}));

import {
  getAutopilotGoals,
  postAutopilotGoals,
  createFounderGoalServiceRole,
  patchAutopilotGoal,
  deleteAutopilotGoal,
} from "../autopilot";

function mkRes(): { res: Response; status: () => number; body: () => unknown } {
  let _s = 200;
  let _b: unknown = null;
  const res = {
    status(c: number) { _s = c; return res; },
    json(b: unknown) { _b = b; return res; },
  } as unknown as Response;
  return { res, status: () => _s, body: () => _b };
}
function mkReq(body: unknown, params: Record<string, string> = {}): Request {
  return { body, params, query: {} } as unknown as Request;
}

const GOAL_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  role = "owner";
  svcDuplicateResult = { data: [], error: null };
  rpcResult = { data: "goal-1", error: null };
  goalsListResult = { data: [], error: null };
  svcReadResult = { data: { status: "active" }, error: null };
  svcMutateResult = { data: [{ id: "g1" }], error: null };
  svcEqCalls = [];
  svcUpsertCalls = [];
  rpcSpy.mockClear();
  Object.values(listChain).forEach((m) => {
    if (typeof m === "function" && "mockClear" in (m as object)) {
      (m as ReturnType<typeof vi.fn>).mockClear();
    }
  });
  Object.values(svcChain).forEach((m) => {
    if (typeof m === "function" && "mockClear" in (m as object)) {
      (m as ReturnType<typeof vi.fn>).mockClear();
    }
  });
  authResult = { user_id: "u-1", tenant_id: "t-1", access_token: "tok" };
  enabled = true;
});

describe("GET /api/workspace/autopilot/goals", () => {
  it("401 unauthed", async () => {
    authResult = null;
    const { res, status } = mkRes();
    await getAutopilotGoals(mkReq({}), res);
    expect(status()).toBe(401);
  });

  it("reads goals regardless of the old autopilot switch — the gate is gone", async () => {
    enabled = false;
    const { res, status, body } = mkRes();
    await getAutopilotGoals(mkReq({}), res);
    expect(status()).toBe(200);
    expect(body()).toMatchObject({ enabled: true });
    expect(listChain.select).toHaveBeenCalled();
  });

  it("lists goals when enabled, coercing numerics", async () => {
    goalsListResult = {
      data: [
        {
          id: "g1",
          objective: "Grow MRR",
          target_metric: "mrr",
          target_value: "50000",
          baseline_value: "10000",
          current_value: null,
          due_date: "2026-09-30",
          status: "active",
          priority: 80,
          source: "founder",
          created_at: "2026-05-31T00:00:00Z",
          updated_at: "2026-05-31T00:00:00Z",
        },
      ],
      error: null,
    };
    const { res, status, body } = mkRes();
    await getAutopilotGoals(mkReq({}), res);
    expect(status()).toBe(200);
    const b = body() as { enabled: boolean; goals: Array<{ target_value: number; baseline_value: number }> };
    expect(b.enabled).toBe(true);
    expect(b.goals[0].target_value).toBe(50000);
    expect(b.goals[0].baseline_value).toBe(10000);
  });
});

describe("POST /api/workspace/autopilot/goals", () => {
  const ok = {
    objective: "Grow MRR to 50k",
    target_metric: "mrr",
    target_value: 50000,
  };

  it("401 unauthed", async () => {
    authResult = null;
    const { res, status } = mkRes();
    await postAutopilotGoals(mkReq(ok), res);
    expect(status()).toBe(401);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("creates a goal even when autopilot is OFF (setting a target is not consent to execute)", async () => {
    enabled = false;
    const { res, status } = mkRes();
    await postAutopilotGoals(mkReq(ok), res);
    expect(status()).toBe(200);
    expect(rpcSpy).toHaveBeenCalled();
  });

  it("400 missing objective", async () => {
    const { res, status } = mkRes();
    await postAutopilotGoals(mkReq({ target_metric: "mrr", target_value: 1 }), res);
    expect(status()).toBe(400);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("400 non-numeric target_value", async () => {
    const { res, status } = mkRes();
    await postAutopilotGoals(
      mkReq({ ...ok, target_value: "lots" }),
      res,
    );
    expect(status()).toBe(400);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("400 bad due_date format", async () => {
    const { res, status } = mkRes();
    await postAutopilotGoals(mkReq({ ...ok, due_date: "next tuesday" }), res);
    expect(status()).toBe(400);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("400 priority out of range", async () => {
    const { res, status } = mkRes();
    await postAutopilotGoals(mkReq({ ...ok, priority: 500 }), res);
    expect(status()).toBe(400);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("creates a goal via the service-role RPC with server-derived tenant_id", async () => {
    const { res, status, body } = mkRes();
    await postAutopilotGoals(
      mkReq({ ...ok, baseline_value: 10000, due_date: "2026-09-30", priority: 80 }),
      res,
    );
    expect(status()).toBe(200);
    expect((body() as { ok: boolean; id: string }).id).toBe("goal-1");
    expect(rpcSpy).toHaveBeenCalledTimes(1);
    const [name, args] = rpcSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("write_autopilot_goal");
    expect(args.p_tenant_id).toBe("t-1");
    expect(args).toMatchObject({ p_op: "insert", p_goal_id: null, p_actor_source: "founder", p_actor_user_id: "u-1" });
    expect(args.p_values).toEqual({
      objective: "Grow MRR to 50k",
      target_metric: "mrr",
      target_value: 50000,
      baseline_value: 10000,
      current_value: 10000,
      due_date: "2026-09-30",
      priority: 80,
      source: "founder",
    });
  });

  it("500 when the RPC errors", async () => {
    rpcResult = { data: null, error: { message: "boom" } };
    const { res, status, body } = mkRes();
    await postAutopilotGoals(mkReq(ok), res);
    expect(status()).toBe(500);
    expect((body() as { error: { code: string } }).error.code).toBe("set_goal_failed");
  });
});

describe("PATCH /api/workspace/autopilot/goals/:id", () => {
  it("400 on a malformed UUID id (before any DB call)", async () => {
    const { res, status } = mkRes();
    await patchAutopilotGoal(mkReq({ priority: 10 }, { id: "not-a-uuid" }), res);
    expect(status()).toBe(400);
    expect(svcChain.maybeSingle).not.toHaveBeenCalled();
  });

  it("edits a goal even when autopilot is OFF (the Growth plan page's edit must work)", async () => {
    enabled = false;
    svcReadResult = { data: { status: "active" }, error: null };
    const { res, status } = mkRes();
    await patchAutopilotGoal(mkReq({ priority: 10 }, { id: GOAL_ID }), res);
    expect(status()).toBe(200);
    expect(svcChain.maybeSingle).toHaveBeenCalled();
  });

  it("400 invalid_goal_patch on an unknown/immutable key", async () => {
    const { res, status, body } = mkRes();
    await patchAutopilotGoal(mkReq({ tenant_id: "evil", objective: "x" }, { id: GOAL_ID }), res);
    expect(status()).toBe(400);
    expect((body() as { error: { code: string } }).error.code).toBe("invalid_goal_patch");
    expect(svcChain.maybeSingle).not.toHaveBeenCalled();
  });

  it("400 empty_patch when no editable fields are supplied", async () => {
    const { res, status, body } = mkRes();
    await patchAutopilotGoal(mkReq({}, { id: GOAL_ID }), res);
    expect(status()).toBe(400);
    expect((body() as { error: { code: string } }).error.code).toBe("empty_patch");
  });

  it("400 on a bad status value", async () => {
    const { res, status } = mkRes();
    await patchAutopilotGoal(mkReq({ status: "met" }, { id: GOAL_ID }), res);
    expect(status()).toBe(400);
  });

  it("404 when the goal does not exist for this tenant", async () => {
    svcReadResult = { data: null, error: null };
    const { res, status, body } = mkRes();
    await patchAutopilotGoal(mkReq({ priority: 20 }, { id: GOAL_ID }), res);
    expect(status()).toBe(404);
    expect((body() as { error: { code: string } }).error.code).toBe("goal_not_found");
  });

  it("scopes the read by tenant_id (load-bearing cross-tenant isolation)", async () => {
    const { res } = mkRes();
    await patchAutopilotGoal(mkReq({ priority: 20 }, { id: GOAL_ID }), res);
    expect(svcEqCalls).toContainEqual(["tenant_id", "t-1"]);
    expect(svcEqCalls).toContainEqual(["id", GOAL_ID]);
  });

  it("409 goal_terminal when editing a met/missed goal", async () => {
    svcReadResult = { data: { status: "met" }, error: null };
    const { res, status, body } = mkRes();
    await patchAutopilotGoal(mkReq({ objective: "new objective" }, { id: GOAL_ID }), res);
    expect(status()).toBe(409);
    expect((body() as { error: { code: string } }).error.code).toBe("goal_terminal");
  });

  it("edits fields on a PAUSED goal (pausing parks a goal, it does not freeze it)", async () => {
    svcReadResult = { data: { status: "paused" }, error: null };
    const { res, status } = mkRes();
    await patchAutopilotGoal(mkReq({ objective: "new objective" }, { id: GOAL_ID }), res);
    expect(status()).toBe(200);
    expect((svcChain.update.mock.calls[0][0] as Record<string, unknown>).objective).toBe(
      "new objective",
    );
  });

  it("applies a mixed {status+field} patch on a paused goal in one update", async () => {
    svcReadResult = { data: { status: "paused" }, error: null };
    const { res, status } = mkRes();
    await patchAutopilotGoal(
      mkReq({ status: "active", objective: "reworked objective" }, { id: GOAL_ID }),
      res,
    );
    expect(status()).toBe(200);
    const patch = svcChain.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.status).toBe("active");
    expect(patch.objective).toBe("reworked objective");
  });

  it("still 409 goal_terminal on a field edit to a met goal (a receipt stays honest)", async () => {
    svcReadResult = { data: { status: "met" }, error: null };
    const { res, status, body } = mkRes();
    await patchAutopilotGoal(mkReq({ target_value: 1 }, { id: GOAL_ID }), res);
    expect(status()).toBe(409);
    expect((body() as { error: { code: string } }).error.code).toBe("goal_terminal");
  });

  it("pauses an active goal (pure status flip) and sets updated_at", async () => {
    svcReadResult = { data: { status: "active" }, error: null };
    const { res, status, body } = mkRes();
    await patchAutopilotGoal(mkReq({ status: "paused" }, { id: GOAL_ID }), res);
    expect(status()).toBe(200);
    expect((body() as { ok: boolean }).ok).toBe(true);
    const patch = svcChain.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.status).toBe("paused");
    expect(typeof patch.updated_at).toBe("string");
  });

  it("resumes a paused goal (paused → active)", async () => {
    svcReadResult = { data: { status: "paused" }, error: null };
    const { res, status } = mkRes();
    await patchAutopilotGoal(mkReq({ status: "active" }, { id: GOAL_ID }), res);
    expect(status()).toBe(200);
    expect((svcChain.update.mock.calls[0][0] as Record<string, unknown>).status).toBe("active");
  });

  it("edits fields on an active goal (sanitized)", async () => {
    svcReadResult = { data: { status: "active" }, error: null };
    const { res, status } = mkRes();
    await patchAutopilotGoal(
      mkReq({ objective: "Grow ARR to 1M", target_value: 1000000, baseline_value: null }, { id: GOAL_ID }),
      res,
    );
    expect(status()).toBe(200);
    const patch = svcChain.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.objective).toBe("Grow ARR to 1M");
    expect(patch.target_value).toBe(1000000);
    expect(patch.baseline_value).toBeNull();
  });

  it("500 when the update errors", async () => {
    svcMutateResult = { data: null, error: { message: "boom" } };
    const { res, status, body } = mkRes();
    await patchAutopilotGoal(mkReq({ status: "paused" }, { id: GOAL_ID }), res);
    expect(status()).toBe(500);
    expect((body() as { error: { code: string } }).error.code).toBe("goal_update_failed");
  });
});

describe("DELETE /api/workspace/autopilot/goals/:id", () => {
  it("400 on a malformed UUID id", async () => {
    const { res, status } = mkRes();
    await deleteAutopilotGoal(mkReq({}, { id: "nope" }), res);
    expect(status()).toBe(400);
    expect(svcChain.delete).not.toHaveBeenCalled();
  });

  it("deletes a goal scoped by tenant_id + id", async () => {
    svcMutateResult = { data: [{ id: "g1" }], error: null };
    const { res, status, body } = mkRes();
    await deleteAutopilotGoal(mkReq({}, { id: GOAL_ID }), res);
    expect(status()).toBe(200);
    expect((body() as { ok: boolean }).ok).toBe(true);
    expect(svcEqCalls).toContainEqual(["tenant_id", "t-1"]);
    expect(svcEqCalls).toContainEqual(["id", GOAL_ID]);
  });

  it("works even when autopilot is OFF (no feature gate on delete)", async () => {
    enabled = false;
    svcMutateResult = { data: [{ id: "g1" }], error: null };
    const { res, status } = mkRes();
    await deleteAutopilotGoal(mkReq({}, { id: GOAL_ID }), res);
    expect(status()).toBe(200);
  });

  it("404 when the goal does not exist / belongs to another tenant", async () => {
    svcMutateResult = { data: [], error: null };
    const { res, status, body } = mkRes();
    await deleteAutopilotGoal(mkReq({}, { id: GOAL_ID }), res);
    expect(status()).toBe(404);
    expect((body() as { error: { code: string } }).error.code).toBe("goal_not_found");
  });

  it("500 when the delete errors", async () => {
    svcMutateResult = { data: null, error: { message: "boom" } };
    const { res, status, body } = mkRes();
    await deleteAutopilotGoal(mkReq({}, { id: GOAL_ID }), res);
    expect(status()).toBe(500);
    expect((body() as { error: { code: string } }).error.code).toBe("goal_delete_failed");
  });
});

describe("active-goal cap (MAX_ACTIVE_GOALS)", () => {
  const atCap = { data: Array.from({ length: 20 }, (_, i) => ({ id: `g${i}` })), error: null };

  it("POST 409 goal_limit_reached when already at 20 active (no RPC)", async () => {
    svcMutateResult = atCap;
    const { res, status, body } = mkRes();
    await postAutopilotGoals(
      mkReq({ objective: "Grow MRR to 50k", target_metric: "mrr", target_value: 50000 }),
      res,
    );
    expect(status()).toBe(409);
    expect((body() as { error: { code: string } }).error.code).toBe("goal_limit_reached");
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("PATCH resume 409 goal_limit_reached when already at 20 active (no update)", async () => {
    svcReadResult = { data: { status: "paused" }, error: null };
    svcMutateResult = atCap;
    const { res, status, body } = mkRes();
    await patchAutopilotGoal(mkReq({ status: "active" }, { id: GOAL_ID }), res);
    expect(status()).toBe(409);
    expect((body() as { error: { code: string } }).error.code).toBe("goal_limit_reached");
    expect(svcChain.update).not.toHaveBeenCalled();
  });

  it("PATCH pause is NOT blocked by the cap (pause doesn't grow the active set)", async () => {
    svcReadResult = { data: { status: "active" }, error: null };
    svcMutateResult = atCap;
    const { res, status } = mkRes();
    await patchAutopilotGoal(mkReq({ status: "paused" }, { id: GOAL_ID }), res);
    expect(status()).toBe(200);
    expect(svcChain.update).toHaveBeenCalled();
  });
});

describe("PATCH current_value — founder-reported measurement", () => {
  it("accepts a reported number AND records it as a dated reading", async () => {
    svcReadResult = { data: { status: "active" }, error: null };
    const { res, status } = mkRes();
    await patchAutopilotGoal(mkReq({ current_value: 612 }, { id: GOAL_ID }), res);
    expect(status()).toBe(200);
    expect(svcUpsertCalls).toHaveLength(1);
    expect(svcUpsertCalls[0]).toMatchObject({
      tenant_id: "t-1",
      metric_key: `goal:${GOAL_ID}`,
      value: 612,
      status: "measured",
      source: "founder_reported",
      window_kind: "point",
    });
  });

  it("dates a typed number (trusted 14 days, decision 8); a source's number is not stamped here", async () => {
    const updates = () => svcChain.update.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
    svcChain.update.mockClear();
    svcReadResult = { data: { status: "active", target_metric: "hosts", measurement_mode: "manual_reported" }, error: null };
    const a = mkRes();
    await patchAutopilotGoal(mkReq({ current_value: 612 }, { id: GOAL_ID }), a.res);
    expect(a.status()).toBe(200);
    expect(updates()[0]).toMatchObject({ current_value: 612, current_value_at: expect.any(String), current_value_source: "entered by the founder" });

    svcReadResult = { data: { status: "active", target_metric: "mrr", measurement_mode: "auto" }, error: null };
    const b = mkRes();
    await patchAutopilotGoal(mkReq({ current_value: 900 }, { id: GOAL_ID }), b.res);
    expect(updates()[1]).not.toHaveProperty("current_value_at");
  });

  it("accepts null — 'I no longer know' is a real answer and is not zero", async () => {
    svcReadResult = { data: { status: "active" }, error: null };
    const { res, status } = mkRes();
    await patchAutopilotGoal(mkReq({ current_value: null }, { id: GOAL_ID }), res);
    expect(status()).toBe(200);
    expect(svcUpsertCalls).toHaveLength(0);
  });

  it("400s on a non-numeric report rather than storing garbage", async () => {
    svcReadResult = { data: { status: "active" }, error: null };
    const { res, status, body } = mkRes();
    await patchAutopilotGoal(mkReq({ current_value: "lots" }, { id: GOAL_ID }), res);
    expect(status()).toBe(400);
    expect((body() as { error: { code: string } }).error.code).toBe("bad_request");
  });

  it("works when autopilot is OFF — reporting your own number is not consent to execute", async () => {
    enabled = false;
    svcReadResult = { data: { status: "active" }, error: null };
    const { res, status } = mkRes();
    await patchAutopilotGoal(mkReq({ current_value: 42 }, { id: GOAL_ID }), res);
    expect(status()).toBe(200);
    expect(svcUpsertCalls).toHaveLength(1);
    expect(svcUpsertCalls[0]).toMatchObject({ value: 42, source: "founder_reported" });
  });
});

describe("measurement_mode and current_value on create and edit", () => {
  const post = {
    objective: "Grow monthly recurring revenue",
    target_metric: "mrr",
    target_value: 100000,
    due_date: "2026-12-31",
  };
  const updates = () => svcChain.update.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);

  it("POST defaults to manual_reported, even for a metric a source could read", async () => {
    const { res, status } = mkRes();
    await postAutopilotGoals(mkReq(post), res);
    expect(status()).toBe(200);
    expect(updates()).toContainEqual({ measurement_mode: "manual_reported" });
  });

  it("POST accepts auto when a source can read the metric", async () => {
    const { res, status } = mkRes();
    await postAutopilotGoals(mkReq({ ...post, measurement_mode: "auto", current_value: 1390 }), res);
    expect(status()).toBe(200);
    expect(updates()).toContainEqual({ measurement_mode: "auto", current_value: 1390 });
    expect(svcUpsertCalls).toHaveLength(0);
  });

  it("POST rejects auto for a metric no source can read, before writing anything", async () => {
    const { res, status, body } = mkRes();
    await postAutopilotGoals(mkReq({ ...post, target_metric: "parent tours", measurement_mode: "auto" }), res);
    expect(status()).toBe(400);
    expect((body() as { error: { code: string } }).error.code).toBe("measurement_unavailable");
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("POST writes the founder's current_value and records it as a dated reading", async () => {
    const { res, status, body } = mkRes();
    await postAutopilotGoals(mkReq({ ...post, current_value: 1200 }), res);
    expect(status()).toBe(200);
    expect(updates()).toContainEqual({
      measurement_mode: "manual_reported",
      current_value: 1200,
      current_value_at: expect.any(String),
      current_value_source: "entered by the founder",
    });
    expect(svcUpsertCalls[0]).toMatchObject({ metric_key: "goal:goal-1", value: 1200, source: "founder_reported" });
    expect((body() as { warnings?: string[] }).warnings).toBeUndefined();
  });

  it("POST says so when the current value could not be written", async () => {
    failNextGoalUpdate = { message: "boom" };
    const { res, status, body } = mkRes();
    await postAutopilotGoals(mkReq({ ...post, current_value: 1200 }), res);
    expect(status()).toBe(200);
    expect((body() as { warnings: string[] }).warnings[0]).toMatch(/current value was not/);
  });

  it("POST 400s a non-numeric current_value", async () => {
    const { res, status } = mkRes();
    await postAutopilotGoals(mkReq({ ...post, current_value: "lots" }), res);
    expect(status()).toBe(400);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("PATCH keeps the stored mode when the client sends none", async () => {
    svcReadResult = { data: { status: "active", target_metric: "mrr", measurement_mode: "auto" }, error: null };
    const { res, status } = mkRes();
    await patchAutopilotGoal(mkReq({ target_value: 120000 }, { id: GOAL_ID }), res);
    expect(status()).toBe(200);
    expect(updates()[0]).not.toHaveProperty("measurement_mode");
  });

  it("PATCH no longer re-classifies a manual goal to auto when its metric changes", async () => {
    svcReadResult = { data: { status: "active", target_metric: "gmv", measurement_mode: "manual_reported" }, error: null };
    const { res, status } = mkRes();
    await patchAutopilotGoal(mkReq({ target_metric: "mrr" }, { id: GOAL_ID }), res);
    expect(status()).toBe(200);
    expect(updates()[0]).toMatchObject({ measurement_mode: "manual_reported" });
  });

  it("PATCH makes an auto goal manual when its metric changes to one that also has a source (MRR to ARR)", async () => {
    svcReadResult = { data: { status: "active", target_metric: "mrr", measurement_mode: "auto" }, error: null };
    const { res, status } = mkRes();
    await patchAutopilotGoal(mkReq({ target_metric: "arr" }, { id: GOAL_ID }), res);
    expect(status()).toBe(200);
    expect(updates()[0]).toMatchObject({ measurement_mode: "manual_reported" });
  });

  it("PATCH keeps an auto goal auto when the same metric is sent back unchanged", async () => {
    svcReadResult = { data: { status: "active", target_metric: "mrr", measurement_mode: "auto" }, error: null };
    const { res, status } = mkRes();
    await patchAutopilotGoal(mkReq({ target_metric: "mrr", target_value: 9000 }, { id: GOAL_ID }), res);
    expect(status()).toBe(200);
    expect(updates()[0]).not.toHaveProperty("measurement_mode");
  });

  it("PATCH sets the mode the client sends, checked against the goal's metric", async () => {
    svcReadResult = { data: { status: "active", target_metric: "mrr", measurement_mode: "manual_reported" }, error: null };
    const ok1 = mkRes();
    await patchAutopilotGoal(mkReq({ measurement_mode: "auto", current_value: 1390 }, { id: GOAL_ID }), ok1.res);
    expect(ok1.status()).toBe(200);
    expect(updates()[0]).toMatchObject({ measurement_mode: "auto", current_value: 1390 });

    svcReadResult = { data: { status: "active", target_metric: "conversion rate", measurement_mode: "manual_reported" }, error: null };
    const bad = mkRes();
    await patchAutopilotGoal(mkReq({ measurement_mode: "auto" }, { id: GOAL_ID }), bad.res);
    expect(bad.status()).toBe(400);
    expect((bad.body() as { error: { code: string } }).error.code).toBe("measurement_unavailable");
  });

  it("PATCH stores a money goal's picked source with auto mode; a non-money goal or an unknown source is refused", async () => {
    svcReadResult = { data: { status: "active", target_metric: "gmv", measurement_mode: "manual_reported" }, error: null };
    const ok = mkRes();
    await patchAutopilotGoal(mkReq({ measure_source: "booking_value", measurement_mode: "auto" }, { id: GOAL_ID }), ok.res);
    expect(ok.status()).toBe(200);
    expect(updates()[0]).toMatchObject({ measure_source: "booking_value", measurement_mode: "auto" });

    const bad = mkRes();
    await patchAutopilotGoal(mkReq({ measure_source: "warehouse" }, { id: GOAL_ID }), bad.res);
    expect(bad.status()).toBe(400);

    svcReadResult = { data: { status: "active", target_metric: "bookings", measurement_mode: "auto" }, error: null };
    const count = mkRes();
    await patchAutopilotGoal(mkReq({ measure_source: "booking_value" }, { id: GOAL_ID }), count.res);
    expect(count.status()).toBe(400);
  });

  it("PATCH clears the picked source when the founder switches the goal to a typed number", async () => {
    svcReadResult = { data: { status: "active", target_metric: "gmv", measurement_mode: "auto" }, error: null };
    const { res, status } = mkRes();
    await patchAutopilotGoal(mkReq({ measurement_mode: "manual_reported", current_value: 70000 }, { id: GOAL_ID }), res);
    expect(status()).toBe(200);
    expect(updates()[0]).toMatchObject({ measurement_mode: "manual_reported", measure_source: null });
  });

  it("PATCH clears the picked source when the metric changes", async () => {
    svcReadResult = { data: { status: "active", target_metric: "gmv", measurement_mode: "auto" }, error: null };
    const { res, status } = mkRes();
    await patchAutopilotGoal(mkReq({ target_metric: "booked value" }, { id: GOAL_ID }), res);
    expect(status()).toBe(200);
    expect(updates()[0]).toMatchObject({ measure_source: null, measurement_mode: "manual_reported" });
  });

  it("PATCH drops an auto goal to manual when its new metric has no source", async () => {
    svcReadResult = { data: { status: "active", target_metric: "mrr", measurement_mode: "auto" }, error: null };
    const { res, status } = mkRes();
    await patchAutopilotGoal(mkReq({ target_metric: "conversion rate" }, { id: GOAL_ID }), res);
    expect(status()).toBe(200);
    expect(updates()[0]).toMatchObject({ measurement_mode: "manual_reported" });
  });
});

describe("createFounderGoalServiceRole: measurement mode", () => {
  const input = {
    tenant_id: "t-1",
    objective: "Grow MRR",
    target_metric: "mrr",
    humanMetric: "mrr",
    target_value: 5000,
    baseline_value: null,
    due_date: null,
    priority: null,
    actor: { source: "founder" as const, user_id: "u-1" },
  };
  const updates = () => svcChain.update.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);

  it("writes the mode the Home route chose", async () => {
    svcReadResult = { data: null, error: null };
    const out = await createFounderGoalServiceRole({ ...input, measurementMode: "manual_reported" });
    expect(out.ok).toBe(true);
    expect(updates()).toContainEqual({ measurement_mode: "manual_reported" });
    expect(goalWrites.slice(-2).map((w) => [w.p_op, w.p_actor_source, w.p_actor_user_id])).toEqual([
      ["insert", "founder", "u-1"],
      ["update", "founder", "u-1"],
    ]);
  });

  it("keeps the old classification for callers that choose nothing (the strategy's own goals)", async () => {
    svcReadResult = { data: null, error: null };
    const out = await createFounderGoalServiceRole(input);
    expect(out.ok).toBe(true);
    expect(updates()).toContainEqual({ measurement_mode: "auto" });
  });
});

describe("review fixes: tenant scope, real resolver, readings", () => {
  const post = {
    objective: "Grow monthly recurring revenue",
    target_metric: "mrr",
    target_value: 100000,
    due_date: "2026-12-31",
  };

  it("the POST measurement write names the founder, not the system (autopilot tracking T1)", async () => {
    goalWrites.length = 0;
    await postAutopilotGoals(mkReq({ ...post, current_value: 1200 }), mkRes().res);
    const founderWrites = goalWrites.filter((w) => w.p_actor_source === "founder").map((w) => w.p_op);
    expect(founderWrites.slice(0, 2)).toEqual(["insert", "update"]);
  });

  it("scopes the post-insert write by the goal AND the caller's tenant", async () => {
    const { res, status } = mkRes();
    await postAutopilotGoals(mkReq({ ...post, current_value: 1200 }), res);
    expect(status()).toBe(200);
    const i = svcEqCalls.findIndex(([c, v]) => c === "id" && v === "goal-1");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(svcEqCalls[i + 1]).toEqual(["tenant_id", "t-1"]);
  });

  it("a write that matches no row for this tenant is a warning, never a silent success", async () => {
    svcMutateResult = { data: [], error: null };
    const { res, status, body } = mkRes();
    await postAutopilotGoals(mkReq({ ...post, current_value: 1200 }), res);
    expect(status()).toBe(200);
    expect((body() as { warnings: string[] }).warnings[0]).toMatch(/current value was not/);
    expect(svcUpsertCalls).toHaveLength(0);
  });

  it.each(["cac", "roas", "revenue"])("rejects auto for %s: no source reads it", async (metric) => {
    const { res, status, body } = mkRes();
    await postAutopilotGoals(mkReq({ ...post, target_metric: metric, measurement_mode: "auto" }), res);
    expect(status()).toBe(400);
    expect((body() as { error: { code: string } }).error.code).toBe("measurement_unavailable");
  });

  it("PATCH with Use it (mode auto) does not record a founder reading; a typed number does", async () => {
    svcReadResult = { data: { status: "active", target_metric: "mrr", measurement_mode: "manual_reported" }, error: null };
    const auto = mkRes();
    await patchAutopilotGoal(mkReq({ measurement_mode: "auto", current_value: 994 }, { id: GOAL_ID }), auto.res);
    expect(auto.status()).toBe(200);
    expect(svcUpsertCalls).toHaveLength(0);

    const typed = mkRes();
    await patchAutopilotGoal(mkReq({ measurement_mode: "manual_reported", current_value: 1000 }, { id: GOAL_ID }), typed.res);
    expect(typed.status()).toBe(200);
    expect(svcUpsertCalls).toHaveLength(1);
    expect(svcUpsertCalls[0]).toMatchObject({ value: 1000, source: "founder_reported" });
  });
});

describe("a goal reorder does not wake cgo", () => {
  it("a priority-only PATCH writes the order but sends no goal attention; a target edit does", async () => {
    const { sendGoalAttention } = await import("@/services/growth/goal-attention");
    const wake = vi.mocked(sendGoalAttention);
    svcReadResult = { data: { status: "active", target_metric: "mrr", measurement_mode: "manual_reported" }, error: null };

    wake.mockClear();
    goalWrites.length = 0;
    const moved = mkRes();
    await patchAutopilotGoal(mkReq({ priority: 100 }, { id: GOAL_ID }), moved.res);
    expect(moved.status()).toBe(200);
    expect(goalWrites.find((w) => w.p_actor_source === "founder")).toBeTruthy();
    expect(wake).not.toHaveBeenCalled();

    const edited = mkRes();
    await patchAutopilotGoal(mkReq({ target_value: 120000 }, { id: GOAL_ID }), edited.res);
    expect(edited.status()).toBe(200);
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({ reason: "goal_set", goal_id: GOAL_ID }));
  });
});

describe("founder goal edits record the founder (autopilot tracking T1)", () => {
  it("PATCH and DELETE go through write_autopilot_goal as the founder; PATCH never lands on a finished goal", async () => {
    goalWrites.length = 0;
    svcReadResult = { data: { status: "active", target_metric: "mrr", measurement_mode: "manual_reported" }, error: null };
    await patchAutopilotGoal(mkReq({ target_value: 120000 }, { id: GOAL_ID }), mkRes().res);
    await deleteAutopilotGoal(mkReq({}, { id: GOAL_ID }), mkRes().res);
    expect(goalWrites.filter((w) => w.p_actor_source !== "system")).toEqual([
      expect.objectContaining({ p_op: "update", p_goal_id: GOAL_ID, p_tenant_id: "t-1", p_status_not_in: ["met", "missed"], p_actor_source: "founder", p_actor_user_id: "u-1" }),
      expect.objectContaining({ p_op: "delete", p_goal_id: GOAL_ID, p_tenant_id: "t-1", p_actor_source: "founder", p_actor_user_id: "u-1" }),
    ]);
  });
});

describe("goal writes are owner/admin only", () => {
  const goal = { objective: "Grow MRR to 50k", target_metric: "mrr", target_value: 50000, due_date: "2026-12-31" };

  it("a member cannot create, edit or delete a goal, and nothing is written", async () => {
    role = "member";
    for (const call of [
      (res: Response) => postAutopilotGoals(mkReq(goal), res),
      (res: Response) => patchAutopilotGoal(mkReq({ target_value: 1 }, { id: GOAL_ID }), res),
      (res: Response) => deleteAutopilotGoal(mkReq({}, { id: GOAL_ID }), res),
    ]) {
      const { res, status } = mkRes();
      await call(res);
      expect(status()).toBe(403);
    }
    expect(rpcSpy).not.toHaveBeenCalled();
    expect(svcChain.update).not.toHaveBeenCalled();
    expect(svcChain.delete).not.toHaveBeenCalled();
  });

  it("an admin can", async () => {
    role = "admin";
    const { res, status } = mkRes();
    await deleteAutopilotGoal(mkReq({}, { id: GOAL_ID }), res);
    expect(status()).toBe(200);
  });
});

describe("POST does not create the same goal twice", () => {
  it("returns the active goal that already matches, without writing a second one", async () => {
    svcDuplicateResult = { data: [{ id: "existing-goal" }], error: null };
    const { res, status, body } = mkRes();
    await postAutopilotGoals(
      mkReq({ objective: "Grow MRR to 50k", target_metric: "mrr", target_value: 50000, due_date: "2026-12-31" }),
      res,
    );
    expect(status()).toBe(200);
    expect(body()).toMatchObject({ ok: true, id: "existing-goal", duplicate: true });
    expect(rpcSpy).not.toHaveBeenCalled();
    expect(svcEqCalls).toEqual(expect.arrayContaining([["target_value", 50000], ["due_date", "2026-12-31"]]));
  });
  it("a repeat create that now says how the number counts stores it on the existing goal while it still says nothing", async () => {
    svcDuplicateResult = { data: [{ id: "existing-goal" }], error: null };
    const { res, body } = mkRes();
    const req = { objective: "Grow GMV", target_metric: "gmv", target_value: 300000, baseline_value: 157000, due_date: "2026-10-31", value_kind: "period_total", value_period_start: "2026-10-01" };
    await postAutopilotGoals(mkReq(req), res);
    expect(body()).toMatchObject({ ok: true, id: "existing-goal", duplicate: true });
    expect(goalWrites.at(-1)).toMatchObject({ p_op: "update", p_values: { value_kind: "period_total", value_period_start: "2026-10-01" }, p_expect: { status: "active", value_kind: null } });

    svcMutateResult = { data: [], error: null };
    const again = mkRes();
    await postAutopilotGoals(mkReq(req), again.res);
    expect((again.body() as { warnings?: string[] }).warnings?.[0]).toMatch(/already says how its number counts/);
  });
  it("never stores a kind on an existing goal a connected source measures, whatever the request says", async () => {
    svcDuplicateResult = { data: [{ id: "existing-goal" }], error: null };
    svcReadResult = { data: { measurement_mode: "auto" }, error: null };
    const before = goalWrites.length;
    const { res, body } = mkRes();
    await postAutopilotGoals(mkReq({ objective: "Grow GMV", target_metric: "gmv", target_value: 300000, baseline_value: 157000, due_date: "2026-10-31", value_kind: "period_total", value_period_start: "2026-10-01" }), res);
    expect((body() as { warnings?: string[] }).warnings?.[0]).toMatch(/connected source/);
    expect(goalWrites.length).toBe(before);
  });
});

describe("POST with a period total", () => {
  it("keeps the founder's typed number as the first reading (never the baseline)", async () => {
    await postAutopilotGoals(
      mkReq({ objective: "Grow GMV", target_metric: "gmv", target_value: 300000, baseline_value: 157000, due_date: "2026-10-31", current_value: 70000, value_kind: "period_total", value_period_start: "2026-10-01" }),
      mkRes().res,
    );
    const [, args] = rpcSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.p_values).toMatchObject({ value_kind: "period_total", value_period_start: "2026-10-01", current_value: 70000, baseline_value: 157000 });
  });
  it("starts with no number when the founder typed none", async () => {
    await postAutopilotGoals(
      mkReq({ objective: "Grow GMV", target_metric: "gmv", target_value: 300000, baseline_value: 157000, due_date: "2026-10-31", value_kind: "period_total", value_period_start: "2026-10-01" }),
      mkRes().res,
    );
    const [, args] = rpcSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.p_values).toMatchObject({ current_value: null });
  });
});

describe("PATCH wakes cgo only on a real change", () => {
  const stored = {
    status: "active",
    objective: "Grow monthly recurring revenue",
    target_metric: "hosts",
    target_value: 100,
    due_date: "2026-12-31",
    baseline_value: 10,
    current_value: 40,
    measurement_mode: "manual_reported",
  };
  const editorBody = {
    objective: stored.objective,
    target_metric: stored.target_metric,
    target_value: stored.target_value,
    due_date: stored.due_date,
    baseline_value: stored.baseline_value,
    current_value: stored.current_value,
    measurement_mode: stored.measurement_mode,
  };
  const updates = () => svcChain.update.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
  async function save(body: Record<string, unknown>, row: Record<string, unknown> = stored) {
    const { sendGoalAttention } = await import("@/services/growth/goal-attention");
    const wake = vi.mocked(sendGoalAttention);
    wake.mockClear();
    svcChain.update.mockClear();
    svcUpsertCalls = [];
    svcReadResult = { data: row, error: null };
    const r = mkRes();
    await patchAutopilotGoal(mkReq(body, { id: GOAL_ID }), r.res);
    expect(r.status()).toBe(200);
    return wake;
  }

  it("a save that changes nothing sends no goal attention", async () => {
    expect(await save(editorBody)).not.toHaveBeenCalled();
    expect(await save(editorBody, { ...stored, target_value: "100" })).not.toHaveBeenCalled();
  });

  it("a baseline-only change, a typed number, a measurement choice and a reorder send none", async () => {
    expect(await save({ ...editorBody, baseline_value: 25 })).not.toHaveBeenCalled();
    expect(await save({ current_value: 612 })).not.toHaveBeenCalled();
    expect(await save({ ...editorBody, current_value: 612 })).not.toHaveBeenCalled();
    expect(await save({ priority: 90 })).not.toHaveBeenCalled();
    expect(await save({ measurement_mode: "manual_reported" })).not.toHaveBeenCalled();
  });

  it.each([
    ["one character of the objective", { objective: `${stored.objective}!` }],
    ["the metric", { target_metric: "bookings" }],
    ["the target", { target_value: 101 }],
    ["the due date", { due_date: "2027-01-31" }],
    ["a due date removed", { due_date: null }],
  ])("a change to %s sends exactly one goal_set", async (_label, change) => {
    const wake = await save({ ...editorBody, ...change });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith({ tenant_id: "t-1", reason: "goal_set", goal_id: GOAL_ID });
  });

  it("a pause and a resume send one each; sending the status the goal already has sends none", async () => {
    const paused = await save({ status: "paused" });
    expect(paused).toHaveBeenCalledTimes(1);
    const resumed = await save({ status: "active" }, { ...stored, status: "paused" });
    expect(resumed).toHaveBeenCalledTimes(1);
    expect(await save({ ...editorBody, status: "active" })).not.toHaveBeenCalled();
  });

  it("a new metric clears the old metric's number, baseline, stamp and counting rule", async () => {
    await save({ ...editorBody, target_metric: "bookings" });
    expect(updates()[0]).toMatchObject({
      target_metric: "bookings",
      current_value: null,
      current_value_at: null,
      current_value_source: null,
      baseline_value: null,
      count_rule: null,
    });
    expect(svcUpsertCalls).toHaveLength(0);

    await save({ target_metric: "bookings" });
    expect(updates()[0]).toMatchObject({ current_value: null, baseline_value: null, count_rule: null, measurement_mode: "manual_reported" });
  });

  it("a new metric keeps a NEW number and baseline sent in the same request", async () => {
    await save({ ...editorBody, target_metric: "bookings", current_value: 7, baseline_value: 2 });
    expect(updates()[0]).toMatchObject({
      target_metric: "bookings",
      current_value: 7,
      current_value_at: expect.any(String),
      current_value_source: "entered by the founder",
      baseline_value: 2,
      count_rule: null,
    });
    expect(svcUpsertCalls).toHaveLength(1);
    expect(svcUpsertCalls[0]).toMatchObject({ metric_key: `goal:${GOAL_ID}`, value: 7, source: "founder_reported" });
  });

  it("the same metric sent back keeps the number, the baseline and the counting rule", async () => {
    await save({ ...editorBody, target_value: 150 });
    expect(updates()[0]).toMatchObject({ current_value: 40, baseline_value: 10 });
    expect(updates()[0]).not.toHaveProperty("count_rule");
  });

  it("a spacing-only edit of the metric name is the same metric: nothing is reset", async () => {
    await save({ ...editorBody, target_metric: "weekly   bookings" }, { ...stored, target_metric: "weekly bookings" });
    expect(updates()[0]).toMatchObject({ current_value: 40, baseline_value: 10 });
    expect(updates()[0]).not.toHaveProperty("count_rule");
  });
});

describe("value_kind: what a typed goal number means (BUG1)", () => {
  const updates = () => svcChain.update.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
  const typedGmv = { status: "active", target_metric: "gmv", target_value: 300000, baseline_value: 157000, due_date: "2026-10-31", measurement_mode: "manual_reported", value_kind: null, value_period_start: null };

  it("PATCH stores a period total with its start day", async () => {
    svcReadResult = { data: typedGmv, error: null };
    const { res, status, body } = mkRes();
    await patchAutopilotGoal(mkReq({ value_kind: "period_total", value_period_start: "2026-10-01" }, { id: GOAL_ID }), res);
    expect(body()).toMatchObject({ ok: true });
    expect(status()).toBe(200);
    expect(updates()[0]).toMatchObject({ value_kind: "period_total", value_period_start: "2026-10-01" });
  });

  it("PATCH stores a running number and drops any start day", async () => {
    svcReadResult = { data: { ...typedGmv, value_kind: "period_total", value_period_start: "2026-10-01" }, error: null };
    const { res, status } = mkRes();
    await patchAutopilotGoal(mkReq({ value_kind: "gauge" }, { id: GOAL_ID }), res);
    expect(status()).toBe(200);
    expect(updates()[0]).toMatchObject({ value_kind: "gauge", value_period_start: null });
  });

  it("PATCH refuses a period total that cannot be one, before writing", async () => {
    for (const [data, body] of [
      [typedGmv, { value_kind: "period_total" }],
      [{ ...typedGmv, measurement_mode: "auto" }, { value_kind: "period_total", value_period_start: "2026-10-01" }],
      [{ ...typedGmv, target_metric: "ad spend" }, { value_kind: "period_total", value_period_start: "2026-10-01" }],
      [typedGmv, { value_kind: "period_total", value_period_start: "2026-02-31" }],
      [typedGmv, { value_kind: "weekly" }],
      [typedGmv, { value_period_start: "2026-10-01" }],
    ] as const) {
      svcReadResult = { data, error: null };
      svcChain.update.mockClear();
      const r = mkRes();
      await patchAutopilotGoal(mkReq(body, { id: GOAL_ID }), r.res);
      expect(r.status()).toBe(400);
      expect((r.body() as { error: { code: string } }).error.code).toBe("invalid_value_kind");
      expect(svcChain.update).not.toHaveBeenCalled();
    }
  });

  it("a new metric clears what the old number meant", async () => {
    svcReadResult = { data: { ...typedGmv, value_kind: "period_total", value_period_start: "2026-10-01" }, error: null };
    const { res, status } = mkRes();
    await patchAutopilotGoal(mkReq({ target_metric: "signups" }, { id: GOAL_ID }), res);
    expect(status()).toBe(200);
    expect(updates()[0]).toMatchObject({ value_kind: null, value_period_start: null });
  });

  it("switching to a connected source clears a stored kind the founder did not re-send", async () => {
    svcReadResult = { data: { ...typedGmv, target_metric: "mrr", value_kind: "gauge" }, error: null };
    const { res, status } = mkRes();
    await patchAutopilotGoal(mkReq({ measurement_mode: "auto", current_value: 1390 }, { id: GOAL_ID }), res);
    expect(status()).toBe(200);
    expect(updates()[0]).toMatchObject({ measurement_mode: "auto", value_kind: null, value_period_start: null });
  });

  it("a new metric drops the kind the editor re-sent unchanged, but keeps one the founder just chose", async () => {
    svcReadResult = { data: { ...typedGmv, value_kind: "period_total", value_period_start: "2026-10-01" }, error: null };
    const echo = mkRes();
    await patchAutopilotGoal(mkReq({ target_metric: "bookings", value_kind: "period_total", value_period_start: "2026-10-01" }, { id: GOAL_ID }), echo.res);
    expect(echo.status()).toBe(200);
    expect(updates()[0]).toMatchObject({ value_kind: null, value_period_start: null });

    svcChain.update.mockClear();
    const chose = mkRes();
    await patchAutopilotGoal(mkReq({ target_metric: "bookings", value_kind: "gauge" }, { id: GOAL_ID }), chose.res);
    expect(chose.status()).toBe(200);
    expect(updates()[0]).toMatchObject({ value_kind: "gauge", value_period_start: null });
  });

  it("a rename to a cost metric with the old kind echoed does not fail the save", async () => {
    svcReadResult = { data: { ...typedGmv, value_kind: "period_total", value_period_start: "2026-10-01" }, error: null };
    const r = mkRes();
    await patchAutopilotGoal(mkReq({ target_metric: "ad spend", value_kind: "period_total", value_period_start: "2026-10-01" }, { id: GOAL_ID }), r.res);
    expect(r.status()).toBe(200);
    expect(updates()[0]).toMatchObject({ value_kind: null });
  });

  it("an edit that leaves the kind alone does not touch it", async () => {
    svcReadResult = { data: { ...typedGmv, value_kind: "period_total", value_period_start: "2026-10-01" }, error: null };
    const { res, status } = mkRes();
    await patchAutopilotGoal(mkReq({ target_value: 320000 }, { id: GOAL_ID }), res);
    expect(status()).toBe(200);
    expect(updates()[0]).not.toHaveProperty("value_kind");
  });
});
