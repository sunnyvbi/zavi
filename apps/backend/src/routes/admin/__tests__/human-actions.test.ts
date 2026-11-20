
import { describe, it, expect, vi, beforeEach } from "vitest";

const { assertStaffMock } = vi.hoisted(() => ({
  assertStaffMock: vi.fn(() => ({ user_id: "u-staff", email: "ravi@upcar.ai" })),
}));
vi.mock("@/services/auth/staff-middleware", () => ({ assertStaff: assertStaffMock }));

const { serviceClientMock, calls, state, reset } = vi.hoisted(() => {
  type Op = { op: string; args: unknown[] };
  type TableCall = { table: string; ops: Op[] };
  type Result = { data: unknown; error: { message: string } | null };
  const c = {
    rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
    tables: [] as TableCall[],
  };
  const s = { queues: {} as Record<string, Result[]> };
  const CHAIN_OPS = ["select", "eq", "in", "neq", "is", "gte", "order", "limit", "insert", "update"];
  const client = {
    from: (table: string) => {
      const call: TableCall = { table, ops: [] };
      c.tables.push(call);
      const result = (): Result => {
        const q = s.queues[table];
        if (q && q.length > 0) return q.length > 1 ? q.shift()! : q[0];
        return { data: null, error: null };
      };
      const b: Record<string, unknown> = {};
      for (const op of CHAIN_OPS) {
        b[op] = (...args: unknown[]) => {
          call.ops.push({ op, args });
          return b;
        };
      }
      b.maybeSingle = () => Promise.resolve(result());
      b.single = () => Promise.resolve(result());
      b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(onF, onR);
      return b;
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      c.rpc.push({ name, args });
      if (name === "write_autopilot_goal") {
        return Promise.resolve({ data: { status: "written", id: (args.p_goal_id as string | null) ?? "g-new" }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
  return {
    serviceClientMock: vi.fn(() => client),
    calls: c,
    state: s,
    reset: () => {
      c.rpc = [];
      c.tables = [];
      s.queues = {};
      assertStaffMock.mockClear();
    },
  };
});
vi.mock("@/services/supabase", () => ({ serviceClient: serviceClientMock }));

import {
  staffHumanActionsList,
  staffHumanActionsCreate,
  staffHumanActionsStatus,
  staffHumanActionsSetGoal,
} from "../human-actions";

const TENANT_ID = "5f05d826-7793-45d1-88f9-c5c5bb3f0347";
const ITEM_ID = "11111111-2222-3333-4444-555555555555";

type Handler = typeof staffHumanActionsList;

function makeReqRes(
  body: unknown = {},
  params: Record<string, string> = {},
  query: Record<string, unknown> = {},
) {
  const req = { params, body, query } as unknown as Parameters<Handler>[0];
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(p: unknown) {
      this.payload = p;
      return this;
    },
  };
  return { req, res: res as unknown as Parameters<Handler>[1] & typeof res };
}

function opsFor(table: string, op: string) {
  return calls.tables.filter((t) => t.table === table).flatMap((t) => t.ops.filter((o) => o.op === op));
}

beforeEach(() => reset());

describe("staffHumanActionsList", () => {
  it("400s on a missing/invalid tenant_id, never queries", async () => {
    const { req, res } = makeReqRes({}, {}, {});
    await staffHumanActionsList(req, res);
    expect(res.statusCode).toBe(400);
    expect((res.payload as { error: { code: string } }).error.code).toBe("invalid_tenant_id");

    const bad = makeReqRes({}, {}, { tenant_id: "not-a-uuid" });
    await staffHumanActionsList(bad.req, bad.res);
    expect(bad.res.statusCode).toBe(400);
    expect(calls.tables).toHaveLength(0);
  });

  it("returns goal + items + pending_decisions + done_today for the tenant", async () => {
    const goal = {
      id: "g-1",
      objective: "5 real tutors signed up",
      target_metric: "tutor_signups",
      target_value: 5,
      current_value: 2,
      due_date: "2026-06-11",
      status: "active",
    };
    const items = [
      { id: ITEM_ID, title: "Connect operator DB", priority: "P0", status: "open" },
    ];
    const done = [{ id: "d-1", title: "Connect GitHub repo", status: "done" }];
    const decisions = [
      { id: "98f6bd66-0000-0000-0000-000000000000", decision_class: "dispatch_specialist", body: {}, emitted_at: "2026-06-10T09:06:00Z" },
    ];
    state.queues["autopilot_goals"] = [{ data: goal, error: null }];
    state.queues["human_action_items"] = [
      { data: items, error: null },
      { data: done, error: null },
    ];
    state.queues["decisions"] = [{ data: decisions, error: null }];

    const { req, res } = makeReqRes({}, {}, { tenant_id: TENANT_ID });
    await staffHumanActionsList(req, res);
    expect(assertStaffMock).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    const p = res.payload as {
      goal: typeof goal | null;
      items: unknown[];
      pending_decisions: Array<{ id: string }>;
      done_today: unknown[];
    };
    expect(p.goal).toEqual(goal);
    expect(p.items).toEqual(items);
    expect(p.pending_decisions).toEqual(decisions);
    expect(p.done_today).toEqual(done);
    const decEqs = opsFor("decisions", "eq").map((o) => o.args);
    expect(decEqs).toContainEqual(["tenant_id", TENANT_ID]);
    expect(decEqs).toContainEqual(["status", "proposed"]);
  });
});

describe("staffHumanActionsCreate", () => {
  it("inserts with created_by from the staff email and audits", async () => {
    state.queues["human_action_items"] = [
      { data: { id: ITEM_ID, tenant_id: TENANT_ID, title: "Send 20 DMs" }, error: null },
    ];
    const { req, res } = makeReqRes({ tenant_id: TENANT_ID, title: "Send 20 DMs", priority: "P0" });
    await staffHumanActionsCreate(req, res);
    expect(assertStaffMock).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    const inserts = opsFor("human_action_items", "insert");
    expect(inserts).toHaveLength(1);
    const payload = inserts[0].args[0] as Record<string, unknown>;
    expect(payload.created_by).toBe("ravi@upcar.ai");
    expect(payload.tenant_id).toBe(TENANT_ID);
    expect(payload.title).toBe("Send 20 DMs");
    expect(payload.priority).toBe("P0");
    const audit = calls.rpc.find((r) => r.name === "admin_action_log_append");
    expect(audit).toBeDefined();
    expect(audit!.args.p_action).toBe("human_action_create");
    expect(audit!.args.p_staff_email).toBe("ravi@upcar.ai");
  });

  it("400s on missing title or tenant_id, never inserts", async () => {
    const noTitle = makeReqRes({ tenant_id: TENANT_ID });
    await staffHumanActionsCreate(noTitle.req, noTitle.res);
    expect(noTitle.res.statusCode).toBe(400);

    const noTenant = makeReqRes({ title: "x" });
    await staffHumanActionsCreate(noTenant.req, noTenant.res);
    expect(noTenant.res.statusCode).toBe(400);
    expect(opsFor("human_action_items", "insert")).toHaveLength(0);
    expect(calls.rpc).toHaveLength(0);
  });
});

describe("staffHumanActionsStatus", () => {
  it("done sets done_at and audits", async () => {
    state.queues["human_action_items"] = [
      { data: { id: ITEM_ID, tenant_id: TENANT_ID, status: "done" }, error: null },
    ];
    const { req, res } = makeReqRes({ status: "done" }, { id: ITEM_ID });
    await staffHumanActionsStatus(req, res);
    expect(assertStaffMock).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    const updates = opsFor("human_action_items", "update");
    expect(updates).toHaveLength(1);
    const payload = updates[0].args[0] as Record<string, unknown>;
    expect(payload.status).toBe("done");
    expect(payload.done_at).toBeTruthy();
    const audit = calls.rpc.find((r) => r.name === "admin_action_log_append");
    expect(audit!.args.p_action).toBe("human_action_status");
  });

  it("snoozed requires snooze_until", async () => {
    const { req, res } = makeReqRes({ status: "snoozed" }, { id: ITEM_ID });
    await staffHumanActionsStatus(req, res);
    expect(res.statusCode).toBe(400);
    expect(opsFor("human_action_items", "update")).toHaveLength(0);

    state.queues["human_action_items"] = [
      { data: { id: ITEM_ID, tenant_id: TENANT_ID, status: "snoozed" }, error: null },
    ];
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const ok = makeReqRes({ status: "snoozed", snooze_until: until }, { id: ITEM_ID });
    await staffHumanActionsStatus(ok.req, ok.res);
    expect(ok.res.statusCode).toBe(200);
    const payload = opsFor("human_action_items", "update")[0].args[0] as Record<string, unknown>;
    expect(payload.snooze_until).toBe(until);
  });

  it("400s on an invalid status; 404s on a missing item", async () => {
    const bad = makeReqRes({ status: "deleted" }, { id: ITEM_ID });
    await staffHumanActionsStatus(bad.req, bad.res);
    expect(bad.res.statusCode).toBe(400);

    state.queues["human_action_items"] = [{ data: null, error: null }];
    const missing = makeReqRes({ status: "done" }, { id: ITEM_ID });
    await staffHumanActionsStatus(missing.req, missing.res);
    expect(missing.res.statusCode).toBe(404);
    expect(calls.rpc).toHaveLength(0);
  });
});

describe("staffHumanActionsSetGoal", () => {
  const body = {
    objective: "5 real tutors signed up",
    target_metric: "tutor_signups",
    target_value: 5,
    due_date: "2026-06-11",
  };

  it("updates the existing active same-metric goal instead of inserting a duplicate", async () => {
    state.queues["autopilot_goals"] = [
      { data: { id: "g-1" }, error: null },
    ];
    const { req, res } = makeReqRes(body, { tenant_id: TENANT_ID });
    await staffHumanActionsSetGoal(req, res);
    expect(assertStaffMock).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    const writes = calls.rpc.filter((r) => r.name === "write_autopilot_goal");
    expect(writes).toHaveLength(1);
    expect(writes[0].args).toMatchObject({ p_op: "update", p_goal_id: "g-1", p_tenant_id: TENANT_ID, p_actor_source: "staff", p_actor_user_id: "u-staff" });
    const audit = calls.rpc.find((r) => r.name === "admin_action_log_append");
    expect(audit!.args.p_action).toBe("goal_set");
  });

  it("inserts a founder goal when no active same-metric goal exists", async () => {
    state.queues["autopilot_goals"] = [
      { data: null, error: null },
    ];
    const { req, res } = makeReqRes(body, { tenant_id: TENANT_ID });
    await staffHumanActionsSetGoal(req, res);
    expect(res.statusCode).toBe(200);
    const writes = calls.rpc.filter((r) => r.name === "write_autopilot_goal");
    expect(writes).toHaveLength(1);
    expect(writes[0].args).toMatchObject({ p_op: "insert", p_tenant_id: TENANT_ID, p_actor_source: "staff", p_actor_user_id: "u-staff" });
    const payload = writes[0].args.p_values as Record<string, unknown>;
    expect(payload.source).toBe("founder");
    expect(payload.status).toBe("active");
    expect(payload.target_metric).toBe("tutor_signups");
  });

  it("400s on a missing objective/target_metric/target_value", async () => {
    const { req, res } = makeReqRes({ objective: "x" }, { tenant_id: TENANT_ID });
    await staffHumanActionsSetGoal(req, res);
    expect(res.statusCode).toBe(400);
    expect(calls.tables).toHaveLength(0);
  });
});
