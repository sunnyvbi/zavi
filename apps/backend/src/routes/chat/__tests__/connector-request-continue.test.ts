
import { describe, it, expect, vi, beforeEach } from "vitest";

const RUN = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT_RUN = "22222222-2222-4222-8222-222222222222";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  agent_runs: [] as Row[],
  agent_thread_messages: [] as Row[],
  connector_metadata: [] as Row[],
  enqueue: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ user_id: "u1", tenant_id: "tenant-A", access_token: "tok" }),
}));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: db.enqueue }));
const ORDER_COLUMNS: Record<string, string> = {
  agent_runs: "enqueued_at",
  agent_thread_messages: "created_at",
};

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: keyof typeof db) => {
      const preds: Array<(r: Row) => boolean> = [];
      let orderError: { message: string } | null = null;
      const b: Record<string, unknown> = {};
      const rows = () => (db[table] as Row[]).filter((r) => preds.every((p) => p(r)));
      b.select = () => b;
      b.eq = (col: string, val: unknown) => {
        preds.push((r) => r[col] === val);
        return b;
      };
      b.filter = (col: string, _op: string, val: unknown) => {
        const key = col.split("->>")[1];
        preds.push((r) => (r.payload as Row | undefined)?.[key] === val);
        return b;
      };
      b.in = async (col: string, vals: unknown[]) => {
        preds.push((r) => vals.includes(r[col]));
        return { data: rows(), error: null };
      };
      b.order = (col: string) => {
        if (ORDER_COLUMNS[table] !== col) orderError = { message: `column ${table}.${col} does not exist` };
        return b;
      };
      b.limit = async (n: number) =>
        orderError ? { data: null, error: orderError } : { data: rows().slice(0, n), error: null };
      b.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      return b;
    },
  }),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connectorRequestContinue } from "../connector-request-continue";

function request(over: Record<string, unknown> = {}) {
  return {
    kind: "connector_request",
    v: 1,
    request_id: "r1",
    slug: "meta_ads",
    label: "Meta Ads",
    connect: "oauth",
    reason: "to read campaigns",
    origin: "model",
    mode: "connect",
    run_id: RUN,
    created_at: "2026-09-22T10:00:00.000Z",
    ...over,
  };
}

async function call(runId: string, body: unknown = {}) {
  let status = 0;
  let json: unknown;
  const res = {
    status(s: number) {
      status = s;
      return this;
    },
    json(j: unknown) {
      json = j;
      return this;
    },
  };
  await connectorRequestContinue({ params: { run_id: runId }, body } as never, res as never);
  return { status, json: json as Record<string, unknown> };
}

beforeEach(() => {
  db.agent_runs = [
    {
      id: RUN,
      tenant_id: "tenant-A",
      agent_slug: "performance-marketer",
      trigger: "chat",
      payload: { thread_id: "th1", user_message_id: "m1" },
    },
    { id: OTHER_TENANT_RUN, tenant_id: "tenant-B", agent_slug: "operator", trigger: "chat", payload: { thread_id: "th9" } },
  ];
  db.agent_thread_messages = [
    { tenant_id: "tenant-A", agent_run_id: RUN, sender_role: "assistant", meta: { connector_request: request() } },
  ];
  db.connector_metadata = [];
  db.enqueue.mockReset();
  db.enqueue.mockResolvedValue({ run_id: "new-run" });
});

describe("connector request Continue", () => {
  it("another tenant's run_id is not found and enqueues nothing", async () => {
    const r = await call(OTHER_TENANT_RUN);
    expect(r.status).toBe(404);
    expect(db.enqueue).not.toHaveBeenCalled();
  });

  it("409 not_connected_yet while the connector row is absent", async () => {
    const r = await call(RUN);
    expect(r).toEqual({ status: 409, json: { error: "not_connected_yet" } });
    expect(db.enqueue).not.toHaveBeenCalled();
  });

  it("reconnect: a row older than the request is still 409", async () => {
    db.agent_thread_messages[0].meta = { connector_request: request({ mode: "reconnect" }) };
    db.connector_metadata = [{ tenant_id: "tenant-A", slug: "meta_ads", connected_at: "2026-09-21T00:00:00Z" }];
    expect((await call(RUN)).status).toBe(409);
    db.connector_metadata[0].connected_at = "2026-09-22T11:00:00Z";
    expect((await call(RUN)).status).toBe(200);
  });

  it("enqueues the origin turn on the same thread + agent with the continuation markers", async () => {
    db.connector_metadata = [{ tenant_id: "tenant-A", slug: "meta_ads", connected_at: "2026-09-22T11:00:00Z" }];
    const r = await call(RUN);
    expect(r).toEqual({ status: 200, json: { run_id: "new-run" } });
    expect(db.enqueue).toHaveBeenCalledWith({
      agent_slug: "performance-marketer",
      tenant_id: "tenant-A",
      trigger: "chat",
      user_access_token: "tok",
      parent_run_id: RUN,
      payload: {
        thread_id: "th1",
        user_message_id: "m1",
        connector_continue_of: RUN,
        connector_continue_label: "Meta Ads",
      },
    });
  });

  it("copies only thread/user message/input extras, never one-shot keys", async () => {
    db.agent_runs[0].payload = {
      thread_id: "th1",
      user_message_id: "m1",
      task_description: "fix the footer",
      resume_of_run_id: "r0",
      internal_resume_turn: "approved",
      command_slug: "ship",
    };
    db.connector_metadata = [{ tenant_id: "tenant-A", slug: "meta_ads", connected_at: "2026-09-22T11:00:00Z" }];
    await call(RUN);
    const payload = db.enqueue.mock.calls[0]![0].payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      ["connector_continue_label", "connector_continue_of", "task_description", "thread_id", "user_message_id"].sort(),
    );
  });

  it("an alias row satisfies the request (instagram_social ← composio.instagram)", async () => {
    db.agent_thread_messages[0].meta = { connector_request: request({ slug: "instagram_social", label: "Instagram" }) };
    db.connector_metadata = [{ tenant_id: "tenant-A", slug: "composio.instagram", connected_at: "2026-09-22T11:00:00Z" }];
    expect((await call(RUN)).status).toBe(200);
  });

  it("the umbrella github row does not satisfy a github request", async () => {
    db.agent_thread_messages[0].meta = { connector_request: request({ slug: "github", label: "GitHub" }) };
    db.connector_metadata = [
      { tenant_id: "tenant-A", slug: "github", account_login: "Praxis-build", connected_at: "2026-09-22T11:00:00Z" },
    ];
    expect(await call(RUN)).toEqual({ status: 409, json: { error: "not_connected_yet" } });
  });

  it("repo gate still refusing at enqueue maps to 409 not_connected_yet", async () => {
    db.connector_metadata = [{ tenant_id: "tenant-A", slug: "meta_ads", connected_at: "2026-09-22T11:00:00Z" }];
    const err = new Error("rejected");
    err.name = "SandboxRepoAccessRequiredError";
    db.enqueue.mockRejectedValue(err);
    expect(await call(RUN)).toEqual({ status: 409, json: { error: "not_connected_yet" } });
  });

  it("a failed or cancelled continuation is not reused: a fresh one is enqueued", async () => {
    db.connector_metadata = [{ tenant_id: "tenant-A", slug: "meta_ads", connected_at: "2026-09-22T11:00:00Z" }];
    for (const [id, status] of [["dead-1", "dispatch_error"], ["dead-2", "cancelled"]]) {
      db.agent_runs.push({ id, tenant_id: "tenant-A", agent_slug: "performance-marketer", trigger: "chat", status, payload: { connector_continue_of: RUN } });
    }
    expect(await call(RUN)).toEqual({ status: 200, json: { run_id: "new-run" } });
    expect(db.enqueue).toHaveBeenCalledTimes(1);
  });

  it("a continuation paused for approval is reused, not duplicated", async () => {
    db.connector_metadata = [{ tenant_id: "tenant-A", slug: "meta_ads", connected_at: "2026-09-22T11:00:00Z" }];
    db.agent_runs.push({ id: "paused-1", tenant_id: "tenant-A", agent_slug: "performance-marketer", trigger: "chat", status: "paused_awaiting_approval", payload: { connector_continue_of: RUN } });
    expect(await call(RUN)).toEqual({ status: 200, json: { run_id: "paused-1" } });
    expect(db.enqueue).not.toHaveBeenCalled();
  });

  it("the continuation is enqueued with the founder's bearer (enqueued_by = auth.uid())", async () => {
    db.connector_metadata = [{ tenant_id: "tenant-A", slug: "meta_ads", connected_at: "2026-09-22T11:00:00Z" }];
    await call(RUN);
    expect(db.enqueue.mock.calls[0]![0].user_access_token).toBe("tok");
    const runner = readFileSync(join(__dirname, "../../../services/agents/runner.ts"), "utf8");
    expect(runner).toMatch(/\(input\.trigger === "manual" \|\| input\.trigger === "chat"\) && !!input\.user_access_token/);
    expect(runner).toMatch(/userWritesRow && input\.user_access_token\s*\? serverClientFromBearer\(input\.user_access_token\)/);
  });

  it("returns the existing continuation instead of enqueueing twice", async () => {
    db.connector_metadata = [{ tenant_id: "tenant-A", slug: "meta_ads", connected_at: "2026-09-22T11:00:00Z" }];
    db.agent_runs.push({
      id: "earlier-continuation",
      tenant_id: "tenant-A",
      agent_slug: "performance-marketer",
      trigger: "chat",
      status: "success",
      payload: { thread_id: "th1", connector_continue_of: RUN },
    });
    const r = await call(RUN);
    expect(r).toEqual({ status: 200, json: { run_id: "earlier-continuation" } });
    expect(db.enqueue).not.toHaveBeenCalled();
  });

  it("ignores the client body: the slug probed is the one on the persisted reply", async () => {
    db.connector_metadata = [{ tenant_id: "tenant-A", slug: "github", connected_at: "2026-09-22T11:00:00Z" }];
    const r = await call(RUN, { slug: "github", mode: "connect", label: "GitHub" });
    expect(r).toEqual({ status: 409, json: { error: "not_connected_yet" } });
  });

  it("404 when the run's reply carries no connector request", async () => {
    db.agent_thread_messages = [];
    expect((await call(RUN)).status).toBe(404);
  });
});
