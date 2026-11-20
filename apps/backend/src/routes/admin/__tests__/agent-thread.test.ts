
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const THREAD_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const { assertStaffMock } = vi.hoisted(() => ({
  assertStaffMock: vi.fn(() => ({ user_id: "u-staff", email: "ravi@upcar.ai" })),
}));
vi.mock("@/services/auth/staff-middleware", () => ({ assertStaff: assertStaffMock }));

const { isInternalMock } = vi.hoisted(() => ({ isInternalMock: vi.fn(async () => false) }));
vi.mock("../staff-console-shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../staff-console-shared")>()),
  isStaffOrInternalTenant: isInternalMock,
}));

const { serviceClientMock, state } = vi.hoisted(() => {
  const SCHEMA: Record<string, string[]> = {
    agent_threads: [
      "id", "tenant_id", "agent_slug", "user_id", "title", "created_at",
      "last_message_at", "deleted_at",
    ],
    agent_thread_messages: [
      "id", "thread_id", "tenant_id", "sender_role", "body", "agent_run_id",
      "attachments", "meta", "created_at",
    ],
    agent_runs: [
      "id", "tenant_id", "agent_slug", "status", "trigger", "payload",
      "enqueued_at", "started_at", "finished_at", "error",
    ],
    decisions: [
      "id", "tenant_id", "agent_run_id", "decision_class", "status", "body",
      "approved_by_source", "emitted_at", "approved_at", "rejected_at",
    ],
  };

  function assertColumns(table: string, spec: string): void {
    const known = SCHEMA[table];
    if (!known) return;
    for (const raw of spec.split(",")) {
      const col = raw.trim().split("->")[0].trim();
      if (!col) continue;
      if (!known.includes(col)) {
        throw new Error(
          `column ${table}.${col} does not exist (Postgres would raise 42703). ` +
            `Known columns: ${known.join(", ")}`,
        );
      }
    }
  }

  const state = {
    thread: {
      id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      tenant_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      agent_slug: "operator",
      title: "t",
      created_at: "2026-07-17",
      last_message_at: "2026-07-17",
      deleted_at: null,
    } as Record<string, unknown> | null,
    messages: [{ id: "m1", sender_role: "user", body: "hi" }] as unknown[],
    runs: [{ id: "run-1", status: "success" }] as unknown[],
    decisions: [{ id: "d1", decision_class: "support-lead.reply", status: "proposed" }] as unknown[],
  };

  const client = {
    from(table: string) {
      const b: Record<string, unknown> = {};
      b.select = (spec: string) => {
        assertColumns(table, spec);
        return b;
      };
      b.eq = (col: string) => {
        assertColumns(table, col);
        return b;
      };
      b.in = (col: string) => {
        assertColumns(table, col);
        return b;
      };
      b.order = (col: string) => {
        assertColumns(table, col);
        return table === "agent_runs"
          ? Promise.resolve({ data: state.runs, error: null })
          : table === "agent_thread_messages"
            ? Promise.resolve({ data: state.messages, error: null })
            : Promise.resolve({ data: state.decisions, error: null });
      };
      b.maybeSingle = () => Promise.resolve({ data: state.thread, error: null });
      return b;
    },
  };
  return { serviceClientMock: vi.fn(() => client), state };
});
vi.mock("@/services/supabase", () => ({ serviceClient: serviceClientMock }));

import { staffAgentThreadRead } from "../agent-thread";

function makeReqRes(opts: { tenant?: string; slug?: string; thread?: string }) {
  const req = {
    params: {
      tenant_id: opts.tenant ?? TENANT_A,
      slug: opts.slug ?? "operator",
      thread_id: opts.thread ?? THREAD_ID,
    },
  } as unknown as Parameters<typeof staffAgentThreadRead>[0];
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
  return { req, res: res as unknown as Parameters<typeof staffAgentThreadRead>[1] & typeof res };
}

beforeEach(() => {
  assertStaffMock.mockReset();
  assertStaffMock.mockReturnValue({ user_id: "u-staff", email: "ravi@upcar.ai" });
  isInternalMock.mockReset();
  isInternalMock.mockResolvedValue(false);
  state.thread = {
    id: THREAD_ID,
    tenant_id: TENANT_A,
    agent_slug: "operator",
    title: "t",
    created_at: "2026-07-17",
    last_message_at: "2026-07-17",
    deleted_at: null,
  };
});

describe("staffAgentThreadRead (Slice 2)", () => {
  it("thread of tenant B requested under tenant A path → 403", async () => {
    state.thread = { ...(state.thread as Record<string, unknown>), tenant_id: TENANT_B };
    const { req, res } = makeReqRes({ tenant: TENANT_A });
    await staffAgentThreadRead(req, res);
    expect(res.statusCode).toBe(403);
    expect((res.payload as { error: { code: string } }).error.code).toBe("thread_tenant_mismatch");
  });

  it("non-operator slug → 400", async () => {
    const { req, res } = makeReqRes({ slug: "engineer" });
    await staffAgentThreadRead(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("malformed thread id → 400, never a raw Postgres error", async () => {
    const { req, res } = makeReqRes({ thread: "thr-1" });
    await staffAgentThreadRead(req, res);
    expect(res.statusCode).toBe(400);
    expect((res.payload as { error: { code: string } }).error.code).toBe("invalid_thread_id");
  });

  it("staff/internal tenant → 403 (parity with the chat + execute paths)", async () => {
    isInternalMock.mockResolvedValue(true);
    const { req, res } = makeReqRes({});
    await staffAgentThreadRead(req, res);
    expect(res.statusCode).toBe(403);
    expect((res.payload as { error: { code: string } }).error.code).toBe("tenant_not_operable");
  });

  it("missing thread → 404", async () => {
    state.thread = null;
    const { req, res } = makeReqRes({});
    await staffAgentThreadRead(req, res);
    expect(res.statusCode).toBe(404);
  });

  it("happy path returns messages + runs + decisions", async () => {
    const { req, res } = makeReqRes({});
    await staffAgentThreadRead(req, res);
    expect(res.statusCode).toBe(200);
    const p = res.payload as { messages: unknown[]; runs: unknown[]; decisions: unknown[] };
    expect(p.messages.length).toBe(1);
    expect(p.runs.length).toBe(1);
    expect(p.decisions.length).toBe(1);
  });

  it("the schema fake rejects agent_runs.created_at (the shipped bug)", () => {
    const sb = serviceClientMock();
    expect(() => (sb.from("agent_runs").select as (s: string) => unknown)("id, status, created_at")).toThrow(
      /agent_runs\.created_at does not exist/,
    );
  });

  it("the schema fake rejects decisions.created_at (the second shipped bug)", () => {
    const sb = serviceClientMock();
    expect(() => (sb.from("decisions").select as (s: string) => unknown)("id, body, created_at")).toThrow(
      /decisions\.created_at does not exist/,
    );
  });
});
