
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const THREAD_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const { assertStaffMock } = vi.hoisted(() => ({
  assertStaffMock: vi.fn(() => ({ user_id: "u-staff", email: "ravi@upcar.ai" })),
}));
vi.mock("@/services/auth/staff-middleware", () => ({ assertStaff: assertStaffMock }));

const { writeStaffAuditMock } = vi.hoisted(() => ({
  writeStaffAuditMock: vi.fn(async (_input: Record<string, unknown>) => undefined),
}));
vi.mock("@/services/staff/audit", () => ({ writeStaffAudit: writeStaffAuditMock }));

const { serviceClientMock, state } = vi.hoisted(() => {
  const SCHEMA: Record<string, string[]> = {
    agent_threads: [
      "id", "tenant_id", "agent_slug", "user_id", "title", "created_at",
      "last_message_at", "deleted_at", "synthetic",
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
      user_id: "u-1",
      title: "t",
      created_at: "2026-07-20",
      last_message_at: "2026-07-21",
      deleted_at: null,
      synthetic: false,
    } as Record<string, unknown> | null,
    threadList: [
      {
        id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        agent_slug: "engineer",
        user_id: "u-1",
        title: "one",
        created_at: "2026-07-20",
        last_message_at: "2026-07-21",
        synthetic: false,
      },
    ] as unknown[],
    messages: [
      {
        id: "m1",
        thread_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        sender_role: "user",
        body: "CUSTOMER_PRIVATE_BODY_SENTINEL",
      },
    ] as unknown[],
    runs: [{ id: "run-1", status: "success" }] as unknown[],
    decisions: [{ id: "d1", decision_class: "support-lead.reply", status: "proposed" }] as unknown[],
    columnsSeen: [] as string[],
  };

  function resolveFor(table: string): { data: unknown; error: null } {
    if (table === "agent_runs") return { data: state.runs, error: null };
    if (table === "agent_thread_messages") return { data: state.messages, error: null };
    if (table === "decisions") return { data: state.decisions, error: null };
    return { data: state.threadList, error: null };
  }

  const client = {
    from(table: string) {
      const b: Record<string, unknown> = {};
      const track = (spec: string) => {
        assertColumns(table, spec);
        for (const raw of spec.split(",")) state.columnsSeen.push(`${table}.${raw.trim()}`);
      };
      b.select = (spec: string) => { track(spec); return b; };
      b.eq = (col: string) => { track(col); return b; };
      b.is = (col: string) => { track(col); return b; };
      b.in = (col: string) => { track(col); return b; };
      b.order = (col: string) => { track(col); return b; };
      b.range = () => b;
      b.limit = () => b;
      b.maybeSingle = () => Promise.resolve({ data: state.thread, error: null });
      b.then = (onOk: (v: unknown) => unknown) => Promise.resolve(resolveFor(table)).then(onOk);
      return b;
    },
  };
  return { serviceClientMock: vi.fn(() => client), state };
});
vi.mock("@/services/tenant-client", () => ({ staffCrossTenantClient: serviceClientMock }));

import { staffTenantThreadList, staffTenantThreadRead } from "../tenant-threads";

function makeRes() {
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(p: unknown) { this.payload = p; return this; },
  };
  return res;
}

function readReq(opts: { tenant?: string; thread?: string } = {}) {
  return {
    params: { tenant_id: opts.tenant ?? TENANT_A, thread_id: opts.thread ?? THREAD_ID },
    query: {},
  } as unknown as Parameters<typeof staffTenantThreadRead>[0];
}

function listReq(opts: { tenant?: string; query?: Record<string, unknown> } = {}) {
  return {
    params: { tenant_id: opts.tenant ?? TENANT_A },
    query: opts.query ?? {},
  } as unknown as Parameters<typeof staffTenantThreadList>[0];
}

beforeEach(() => {
  assertStaffMock.mockReset();
  assertStaffMock.mockReturnValue({ user_id: "u-staff", email: "ravi@upcar.ai" });
  writeStaffAuditMock.mockReset();
  writeStaffAuditMock.mockResolvedValue(undefined);
  state.columnsSeen = [];
  state.thread = {
    id: THREAD_ID,
    tenant_id: TENANT_A,
    agent_slug: "operator",
    user_id: "u-1",
    title: "t",
    created_at: "2026-07-20",
    last_message_at: "2026-07-21",
    deleted_at: null,
    synthetic: false,
  };
});

describe("staffTenantThreadRead — tenant isolation", () => {
  it("thread of tenant B under a tenant-A path → flat 403 with ZERO message bodies", async () => {
    state.thread = { ...(state.thread as Record<string, unknown>), tenant_id: TENANT_B };
    const res = makeRes();
    await staffTenantThreadRead(readReq({ tenant: TENANT_A }), res as never);

    expect(res.statusCode).toBe(403);
    expect((res.payload as { error: { code: string } }).error.code).toBe("thread_tenant_mismatch");
    expect(JSON.stringify(res.payload)).not.toContain("CUSTOMER_PRIVATE_BODY_SENTINEL");
    expect(res.payload).not.toHaveProperty("messages");
    expect(writeStaffAuditMock).not.toHaveBeenCalled();
  });

  it("malformed thread id → clean 400, never a raw Postgres error", async () => {
    const res = makeRes();
    await staffTenantThreadRead(readReq({ thread: "not-a-uuid" }), res as never);
    expect(res.statusCode).toBe(400);
    expect((res.payload as { error: { code: string } }).error.code).toBe("invalid_thread_id");
  });
});

describe("staffTenantThreadRead — staff gate", () => {
  it("a non-staff caller never reaches a query", async () => {
    assertStaffMock.mockImplementation(() => {
      throw new Error("assertStaff: req.staff missing — handler not mounted under requireStaff guard");
    });
    const res = makeRes();
    await expect(staffTenantThreadRead(readReq(), res as never)).rejects.toThrow(/assertStaff/);
    expect(state.columnsSeen).toHaveLength(0);
    expect(writeStaffAuditMock).not.toHaveBeenCalled();
  });
});

describe("staffTenantThreadRead — schema conformance (PR #1995 regression)", () => {
  it("reads a full transcript without asking for a column Postgres would 42703 on", async () => {
    const res = makeRes();
    await staffTenantThreadRead(readReq(), res as never);

    expect(res.statusCode).toBe(200);
    const body = res.payload as { messages: unknown[]; runs: unknown[]; decisions: unknown[] };
    expect(body.messages).toHaveLength(1);
    expect(body.runs).toHaveLength(1);
    expect(body.decisions).toHaveLength(1);

    expect(state.columnsSeen).toContain("agent_runs.enqueued_at");
    expect(state.columnsSeen).toContain("decisions.emitted_at");
    expect(state.columnsSeen).not.toContain("agent_runs.created_at");
    expect(state.columnsSeen).not.toContain("decisions.created_at");
  });

  it("audits the transcript read with the required actor fields and no message bodies", async () => {
    const res = makeRes();
    await staffTenantThreadRead(readReq(), res as never);

    expect(writeStaffAuditMock).toHaveBeenCalledTimes(1);
    const arg = writeStaffAuditMock.mock.calls[0][0];
    expect(arg.actor_user_id).toBe("u-staff");
    expect(arg.actor_email).toBe("ravi@upcar.ai");
    expect(arg.action).toBe("staff.thread.read");
    expect(arg.target_id).toBe(THREAD_ID);
    expect(arg.tenant_id).toBe(TENANT_A);
    expect(JSON.stringify(arg.meta)).not.toContain("CUSTOMER_PRIVATE_BODY_SENTINEL");
  });
});

describe("staffTenantThreadRead — agent_slug is metadata, not a boundary", () => {
  it.each(["content-seo", "company-founder", "daily-brief"])(
    "a thread on removed agent %s still reads",
    async (slug) => {
      state.thread = { ...(state.thread as Record<string, unknown>), agent_slug: slug };
      const res = makeRes();
      await staffTenantThreadRead(readReq(), res as never);

      expect(res.statusCode).toBe(200);
      expect((res.payload as { thread: { agent_slug: string } }).thread.agent_slug).toBe(slug);
    },
  );
});

describe("staffTenantThreadList", () => {
  it("returns items with message counts and hides nothing behind a bad limit", async () => {
    const res = makeRes();
    await staffTenantThreadList(listReq({ query: { limit: "999999" } }), res as never);

    expect(res.statusCode).toBe(200);
    const body = res.payload as { items: Array<{ message_count: number }>; has_more: boolean };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].message_count).toBe(1);
    expect(body.has_more).toBe(false);
    expect(state.columnsSeen).toContain("agent_threads.deleted_at");
  });

  it("rejects a malformed tenant id before querying", async () => {
    const res = makeRes();
    await staffTenantThreadList(listReq({ tenant: "nope" }), res as never);
    expect(res.statusCode).toBe(400);
    expect(state.columnsSeen).toHaveLength(0);
  });
});
