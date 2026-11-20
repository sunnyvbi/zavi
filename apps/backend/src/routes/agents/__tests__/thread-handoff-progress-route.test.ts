
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
    selects: [] as Array<{ table: string; columns: string }>,
    threadRows: [] as unknown[],
    runRows: [] as unknown[],
    eventsByRun: {} as Record<string, unknown[]>,
    runError: null as { message: string } | null,
    lineageEdges: [] as unknown[],
    lineageRuns: [] as unknown[],
  };
  const makeTable = (table: string) => {
    let runId = "";
    let byIds = false;
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = (columns: string) => { d.selects.push({ table, columns }); return chain; };
    chain.order = self;
    chain.gte = self;
    chain.in = (col: string) => {
      if (table === "agent_runs" && col === "id") byIds = true;
      return chain;
    };
    chain.eq = (col: string, val: unknown) => {
      d.filters.push({ table, col, val });
      if (table === "thread_event" && col === "agent_run_id") runId = String(val);
      return chain;
    };
    chain.limit = async () =>
      table === "agent_threads"
        ? { data: d.threadRows, error: null }
        : table === "delegation_lineage"
          ? { data: d.lineageEdges, error: null }
          : table === "agent_runs"
            ? { data: byIds ? d.lineageRuns : d.runRows, error: d.runError }
            : { data: d.eventsByRun[runId] ?? [], error: null };
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

import { threadHandoffProgress } from "../thread-handoff-progress";

const THREAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const child = (id: string, actor: string, status = "running") => ({
  id,
  agent_slug: "meta_ads",
  status,
  payload: { operator_thread_id: THREAD, inherited_actor: { actor_user_id: actor } },
});

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
const call = async () => {
  const r = res();
  await threadHandoffProgress({ params: { thread_id: THREAD } } as never, r as never);
  return r;
};

beforeEach(() => {
  state.auth = { user_id: "u-1", tenant_id: "t-1", access_token: "tok" };
  db.tenantIds = [];
  db.filters = [];
  db.selects = [];
  db.threadRows = [{ id: THREAD, user_id: "u-1" }];
  db.runRows = [];
  db.eventsByRun = {};
  db.runError = null;
  db.lineageEdges = [];
  db.lineageRuns = [];
});

describe("handoff progress — isolation", () => {
  it("reads through the tenant facade, scoped to the JWT's tenant", async () => {
    const r = await call();
    expect(r.code).toBe(200);
    expect(db.tenantIds).toEqual(["t-1"]);
  });

  it("404s a thread that belongs to someone ELSE in the same tenant", async () => {
    db.threadRows = [{ id: THREAD, user_id: "u-2" }];
    db.runRows = [child("r-1", "u-2")];
    const r = await call();
    expect(r.code).toBe(404);
  });

  it("gives an absent thread the SAME answer as one that is not yours", async () => {
    db.threadRows = [{ id: THREAD, user_id: "u-2" }];
    const notMine = await call();
    db.threadRows = [];
    const missing = await call();
    expect(notMine.code).toBe(missing.code);
    expect(JSON.stringify(notMine.body)).toBe(JSON.stringify(missing.body));
  });

  it("drops a child run whose inherited actor is not the caller", async () => {
    db.runRows = [child("r-mine", "u-1"), child("r-theirs", "u-2")];
    const r = await call();
    const runs = (r.body as { runs: Array<{ run_id: string }> }).runs;
    expect(runs.map((x) => x.run_id)).toEqual(["r-mine"]);
  });

  it("looks up handoff runs for THIS thread only", async () => {
    await call();
    expect(db.filters).toContainEqual({ table: "agent_runs", col: "trigger", val: "handoff" });
    expect(db.filters).toContainEqual({ table: "agent_runs", col: "payload->>operator_thread_id", val: THREAD });
  });

  it("400s a malformed thread_id before it reaches the database", async () => {
    const r = res();
    await threadHandoffProgress({ params: { thread_id: "nope" } } as never, r as never);
    expect(r.code).toBe(400);
    expect(db.tenantIds).toEqual([]);
  });

  it("refuses an unauthenticated caller (requireAuth owns the response)", async () => {
    state.auth = null;
    const r = await call();
    expect(r.code).toBeNull();
    expect(db.tenantIds).toEqual([]);
  });
});

describe("handoff progress — behaviour", () => {
  it("links a direct child to its thread parent using the delegation ledger", async () => {
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    db.runRows = [child(id, "u-1"), child("legacy", "u-1")];
    db.lineageEdges = [{ child_run_id: id, parent_run_id: "parent" }];
    db.lineageRuns = [child(id, "u-1")];
    const r = await call();
    expect((r.body as { runs: unknown[] }).runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ run_id: id, parent_run_id: "parent" }),
      expect.objectContaining({ run_id: "legacy", parent_run_id: null }),
    ]));
  });

  it("does not label a parent's own answer as a handoff acknowledgement for internal work", async () => {
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const ask = { ...child(id, "u-1"), payload: { ...child(id, "u-1").payload, ask_id: "ask", ask_parent_run_id: "parent" } };
    db.runRows = [ask];
    db.lineageEdges = [{ child_run_id: id, parent_run_id: "parent" }];
    db.lineageRuns = [ask];
    const r = await call();
    expect((r.body as { runs: unknown[] }).runs).toEqual([expect.objectContaining({ run_id: id, parent_run_id: null })]);
  });

  it("returns actual run timing for direct and lineage specialists, with nulls for an unstarted run", async () => {
    const started_at = "2026-11-17T08:00:13Z";
    const finished_at = "2026-11-17T08:01:26Z";
    const lineageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    db.runRows = [{ ...child("direct", "u-1", "success"), started_at, finished_at }, child("queued", "u-1", "queued")];
    db.lineageEdges = [{ child_run_id: lineageId }];
    db.lineageRuns = [{ ...child(lineageId, "u-1"), started_at, finished_at: null }];
    const r = await call();
    const runs = (r.body as { runs: Array<{ run_id: string; started_at: string | null; finished_at: string | null }> }).runs;
    expect(runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ run_id: "direct", started_at, finished_at }),
      expect.objectContaining({ run_id: "queued", started_at: null, finished_at: null }),
      expect.objectContaining({ run_id: lineageId, started_at, finished_at: null }),
    ]));
    const childReads = db.selects.filter(s => s.table === "agent_runs" && s.columns.includes("agent_slug"));
    expect(childReads).toHaveLength(2);
    for (const { columns } of childReads) {
      expect(columns).toContain("started_at");
      expect(columns).toContain("finished_at");
    }
  });

  it("folds a working specialist into the story shape", async () => {
    db.runRows = [child("r-1", "u-1")];
    db.eventsByRun["r-1"] = [
      { id: 2, kind: "tool_call", body: { tool_name: "mcp__server__meta_ads__list_campaigns", target: "{}", ms: 0, code: "ok", output_preview: "" } },
      { id: 1, kind: "reasoning", body: { text: "Pulling the last 7 days from your ad account." } },
    ];
    const r = await call();
    const run = (r.body as { runs: Array<{ agent_slug: string; panel: { state: string; summary: string; items: Array<Record<string, unknown>> } }> }).runs[0]!;
    expect(run.agent_slug).toBe("meta_ads");
    expect(run.panel.state).toBe("running");
    expect(run.panel.items.map((i) => i.type)).toEqual(["thought", "group"]);
    expect(run.panel.summary).toBe("Checked your ads…");
    expect(JSON.stringify(run)).not.toContain("mcp__server__");
  });

  it("unions lineage-linked children, still applying the person check", async () => {
    const LIN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    db.runRows = [child("r-1", "u-1", "success")];
    db.lineageEdges = [{ child_run_id: LIN }, { child_run_id: OTHER }];
    db.lineageRuns = [
      { id: LIN, agent_slug: "engineer", status: "running", payload: { inherited_actor: { actor_user_id: "u-1" } } },
      { id: OTHER, agent_slug: "engineer", status: "running", payload: { inherited_actor: { actor_user_id: "u-2" } } },
    ];
    const r = await call();
    const runs = (r.body as { runs: Array<{ run_id: string }> }).runs;
    expect(runs.map((x) => x.run_id)).toEqual(["r-1", LIN]);
    expect(JSON.stringify(runs)).not.toContain("run_status");
  });

  it("degrades to no runs when the lookup errors", async () => {
    db.runError = { message: "boom" };
    const r = await call();
    expect(r.code).toBe(200);
    expect(r.body).toEqual({ runs: [] });
  });

  it("keeps successful parallel-handoff children (the web hides them once the combined reply lists them) and drops column-batch children", async () => {
    const batchChild = { ...child("batch-child", "u-1", "success"), payload: {
      ...child("batch-child", "u-1").payload, handoff_batch_id: "batch-1",
    } };
    db.eventsByRun["parent-run"] = [{ id: 1, kind: "chat_assistant", body: { text: "Combined answer" } }];
    db.runRows = [batchChild, { ...child("column-batch", "u-1", "success"), batch_id: "batch-2" }, child("direct", "u-1", "success")];
    for (let reload = 0; reload < 2; reload++) {
      const r = await call();
      expect((r.body as { runs: Array<{ run_id: string }> }).runs.map(r => r.run_id).sort()).toEqual(["batch-child", "direct"]);
    }
  });

  it("keeps running internal work visible but drops completed internal/ask runs", async () => {
    const internal = child("internal", "u-1", "success");
    db.runRows = [
      { ...internal, payload: { inherited_actor: { actor_user_id: "u-1" } } },
      { ...child("ask", "u-1", "success"), payload: { ...internal.payload, ask_id: "ask-1", ask_parent_run_id: "parent-run" } },
      { ...child("running-batch", "u-1"), payload: { ...internal.payload, handoff_batch_id: "batch-1" } },
    ];
    const r = await call();
    expect((r.body as { runs: Array<{ run_id: string }> }).runs.map(r => r.run_id)).toEqual(["running-batch"]);
  });
});
