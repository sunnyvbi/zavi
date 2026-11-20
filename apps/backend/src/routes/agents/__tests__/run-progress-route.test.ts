
import { describe, it, expect, vi, beforeEach } from "vitest";

const { requireAuthMock, state } = vi.hoisted(() => {
  const s = {
    auth: { user_id: "u-1", tenant_id: "t-1", access_token: "tok" } as
      | { user_id: string; tenant_id: string; access_token: string }
      | null,
  };
  return { requireAuthMock: vi.fn(async () => s.auth), state: s };
});
vi.mock("@/services/auth/middleware", () => ({ requireAuth: requireAuthMock }));

const { tenantClientMock, db } = vi.hoisted(() => {
  const d = {
    tenantIds: [] as string[],
    filters: [] as Array<{ table: string; col: string; val: unknown }>,
    ins: [] as Array<{ table: string; col: string; vals: unknown }>,
    orders: [] as Array<{ table: string; col: string; ascending: unknown }>,
    runRows: [] as unknown[],
    eventRows: [] as unknown[],
    runError: null as { message: string } | null,
    eventError: null as { message: string } | null,
  };
  const makeTable = (table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = self;
    chain.order = (col: string, opts?: { ascending?: boolean }) => {
      d.orders.push({ table, col, ascending: opts?.ascending });
      return chain;
    };
    chain.eq = (col: string, val: unknown) => {
      d.filters.push({ table, col, val });
      return chain;
    };
    chain.in = (col: string, vals: unknown) => {
      d.ins.push({ table, col, vals });
      return chain;
    };
    chain.limit = async () =>
      table === "agent_runs"
        ? { data: d.runRows, error: d.runError }
        : { data: d.eventRows, error: d.eventError };
    return chain;
  };
  return {
    tenantClientMock: vi.fn((tid: string) => {
      d.tenantIds.push(tid);
      return { from: (table: string) => makeTable(table) };
    }),
    db: d,
  };
});
vi.mock("@/services/tenant-client", () => ({
  tenantClient: tenantClientMock,
  asTenantId: (s: string) => s,
}));

import { agentRunProgress } from "../run-progress";

const RUN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function res() {
  const r: { code: number | null; body: unknown; status: (c: number) => typeof r; json: (b: unknown) => void } = {
    code: null,
    body: null,
    status(c) {
      r.code = c;
      return r;
    },
    json(b) {
      r.body = b;
    },
  };
  return r;
}

beforeEach(() => {
  state.auth = { user_id: "u-1", tenant_id: "t-1", access_token: "tok" };
  db.tenantIds = [];
  db.filters = [];
  db.ins = [];
  db.orders = [];
  db.runRows = [{ id: RUN, status: "running", actor_user_id: "u-1" }];
  db.eventRows = [];
  db.runError = null;
  db.eventError = null;
});

describe("run progress — isolation", () => {
  it("reads through the tenant facade, scoped to the JWT's tenant", async () => {
    const r = res();
    await agentRunProgress({ params: { run_id: RUN } } as never, r as never);
    expect(db.tenantIds).toEqual(["t-1"]);
    expect(r.code).toBe(200);
    expect(db.filters).toEqual([
      { table: "agent_runs", col: "id", val: RUN },
      { table: "thread_event", col: "agent_run_id", val: RUN },
    ]);
    expect(db.ins).toEqual([
      {
        table: "thread_event",
        col: "kind",
        vals: ["plan", "reasoning", "tool_call", "file_read", "file_edit", "file_create"],
      },
    ]);
  });

  it("reads the newest events first, so a long turn shows its current tool", async () => {
    const r = res();
    await agentRunProgress({ params: { run_id: RUN } } as never, r as never);
    expect(db.orders).toEqual([{ table: "thread_event", col: "id", ascending: false }]);
    expect(r.code).toBe(200);
  });

  it("reads the events of the run it checked, not another", async () => {
    const r = res();
    await agentRunProgress({ params: { run_id: RUN } } as never, r as never);
    const ids = new Set(db.filters.map((f) => f.val));
    expect([...ids]).toEqual([RUN]);
  });

  it("404s a run started by someone ELSE in the same tenant", async () => {
    db.runRows = [{ id: RUN, status: "running", actor_user_id: "u-2" }];
    const r = res();
    await agentRunProgress({ params: { run_id: RUN } } as never, r as never);
    expect(r.code).toBe(404);
  });

  it("gives an absent run the SAME answer as one that is not yours", async () => {
    db.runRows = [{ id: RUN, status: "running", actor_user_id: "u-2" }];
    const mine = res();
    await agentRunProgress({ params: { run_id: RUN } } as never, mine as never);

    db.runRows = [];
    const missing = res();
    await agentRunProgress({ params: { run_id: RUN } } as never, missing as never);

    expect(mine.code).toBe(missing.code);
    expect(JSON.stringify(mine.body)).toBe(JSON.stringify(missing.body));
  });

  it("400s a malformed run_id before it reaches the database", async () => {
    const r = res();
    await agentRunProgress({ params: { run_id: "not-a-uuid" } } as never, r as never);
    expect(r.code).toBe(400);
    expect(db.tenantIds).toEqual([]);
  });

  it("refuses an unauthenticated caller (requireAuth owns the response)", async () => {
    state.auth = null;
    const r = res();
    await agentRunProgress({ params: { run_id: RUN } } as never, r as never);
    expect(r.code).toBeNull();
    expect(db.tenantIds).toEqual([]);
  });
});

describe("run progress — behaviour", () => {
  it("returns the story in the order the work happened", async () => {
    db.eventRows = [
      { id: 4, kind: "tool_call", body: { tool_name: "mcp__server__slack__read_thread", target: '{"channel":"#growth"}', ms: 0, code: "ok", output_preview: "", call_id: "c2" } },
      { id: 3, kind: "reasoning", body: { text: "Pricing notes found. Checking what the team said in Slack." } },
      { id: 2, kind: "tool_call", body: { tool_name: "mcp__server__memory__search", ms: 0, code: "ok", output_preview: "4 notes", call_id: "c1" } },
      { id: 1, kind: "tool_call", body: { tool_name: "mcp__server__memory__search", target: '{"q":"pricing"}', ms: 0, code: "ok", output_preview: "", call_id: "c1" } },
    ];
    const r = res();
    await agentRunProgress({ params: { run_id: RUN } } as never, r as never);
    expect(r.code).toBe(200);
    const body = r.body as { status: string; summary: string; toolCount: number; items: Array<Record<string, unknown>> };
    expect(body.status).toBe("running");
    expect(body.toolCount).toBe(1);
    expect(body.items.map((i) => i.type)).toEqual(["group", "thought", "group"]);
    expect(body.items[0]).toMatchObject({
      type: "group",
      label: "Checked what it knows about your company",
      state: "done",
      tools: [{ name: "search", input: '{"q":"pricing"}', output: "4 notes", state: "done" }],
    });
    expect(body.items[1]).toMatchObject({ type: "thought", text: "Pricing notes found. Checking what the team said in Slack." });
    expect(body.items[2]).toMatchObject({ type: "group", label: "Checked your team chat", state: "running" });
    expect(body.summary).toBe("Checked your team chat…");
    expect(JSON.stringify(body)).not.toContain("mcp__server__");
  });

  it("settles the panel when the run is terminal", async () => {
    db.runRows = [{ id: RUN, status: "cancelled", actor_user_id: "u-1" }];
    db.eventRows = [
      { id: 1, kind: "tool_call", body: { tool_name: "web_search__search", target: "{}", ms: 0, code: "ok", output_preview: "" } },
    ];
    const r = res();
    await agentRunProgress({ params: { run_id: RUN } } as never, r as never);
    const body = r.body as { summary: string; items: Array<{ state: string }> };
    expect(body.summary).toBe("Stopped");
    expect(body.items.some((i) => i.state === "running")).toBe(false);
  });

  it("degrades to no activity when the events read errors", async () => {
    db.eventError = { message: "boom" };
    const r = res();
    await agentRunProgress({ params: { run_id: RUN } } as never, r as never);
    expect(r.code).toBe(200);
    const body = r.body as { status: string; items: unknown[] };
    expect(body.status).toBe("running");
    expect(body.items).toEqual([
      { type: "step", key: "received", label: "Request received", state: "done" },
    ]);
  });

  it("surfaces a failed run read as a 500, not as an empty success", async () => {
    db.runError = { message: "db down" };
    const r = res();
    await agentRunProgress({ params: { run_id: RUN } } as never, r as never);
    expect(r.code).toBe(500);
  });
});
