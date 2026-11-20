
import { describe, it, expect, vi, beforeEach } from "vitest";

const { assertStaffMock } = vi.hoisted(() => ({
  assertStaffMock: vi.fn(() => ({ user_id: "u-staff", email: "ravi@upcar.ai" })),
}));
vi.mock("@/services/auth/staff-middleware", () => ({ assertStaff: assertStaffMock }));

const { serviceClientMock, cfg, reset } = vi.hoisted(() => {
  type Result = { data: unknown; error: { message: string } | null; count?: number };
  const c = { tables: {} as Record<string, Result> };
  const CHAIN = ["select", "eq", "in", "is", "or", "gte", "order", "limit"];
  const client = {
    from: (table: string) => {
      const result = (): Result => c.tables[table] ?? { data: null, error: null };
      const b: Record<string, unknown> = {};
      for (const op of CHAIN) b[op] = () => b;
      b.maybeSingle = () => Promise.resolve(result());
      b.single = () => Promise.resolve(result());
      b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(onF, onR);
      return b;
    },
  };
  return {
    serviceClientMock: vi.fn(() => client),
    cfg: c,
    reset: () => {
      c.tables = {};
      assertStaffMock.mockReset();
      assertStaffMock.mockReturnValue({ user_id: "u-staff", email: "ravi@upcar.ai" });
    },
  };
});
vi.mock("@/services/supabase", () => ({ serviceClient: serviceClientMock }));

import type { Request, Response } from "express";
import {
  buildConnectionList,
  buildChatList,
  buildChatErrors,
  staffTenantActivity,
} from "../tenant-activity";

function mockRes() {
  const res: Partial<Response> & { _status: number; _json: any } = {
    _status: 200,
    _json: undefined,
    status(code: number) {
      this._status = code;
      return this as unknown as Response;
    },
    json(body: unknown) {
      this._json = body;
      return this as unknown as Response;
    },
  };
  return res as Response & { _status: number; _json: any };
}
const reqFor = (id: string) => ({ params: { tenant_id: id } }) as unknown as Request;

beforeEach(() => reset());

describe("buildConnectionList", () => {
  it("merges all four layers, labels, and orders live-first", () => {
    const rows = buildConnectionList(
      [
        { slug: "slack", team_name: "Acme HQ", scopes: ["chat:write", "files:read"], connected_at: "2026-01-01T00:00:00Z" },
        { slug: "stripe", team_name: null, scopes: null, connected_at: null },
      ],
      [{ server_id: "sentry", transport: "http", enabled: true, created_at: "2026-01-02T00:00:00Z" }],
      [{ resource_kind: "hosting", provider: "render", status: "pending", mode: "provisioned", created_at: "2026-01-03T00:00:00Z" }],
      { type: "mongo", created_at: "2026-01-04T00:00:00Z" },
    );
    expect(rows).toHaveLength(5);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey["connector:slack"].status).toBe("connected");
    expect(byKey["connector:slack"].detail).toBe("Acme HQ · 2 scopes");
    expect(byKey["connector:stripe"].status).toBe("pending");
    expect(byKey["mcp:sentry"].status).toBe("enabled");
    expect(byKey["operator_db"].label).toBe("Your database (query)");
    expect(rows[rows.length - 1].status).toBe("pending");
  });
  it("empty everything → empty list", () => {
    expect(buildConnectionList([], [], [], null)).toEqual([]);
  });
});

describe("buildChatList", () => {
  it("attaches message counts, 0 when absent", () => {
    const out = buildChatList(
      [
        { id: "t1", agent_slug: "engineer", title: "Fix login", created_at: "2026-01-01T00:00:00Z", last_message_at: "2026-01-02T00:00:00Z" },
        { id: "t2", agent_slug: "pm", title: null, created_at: "2026-01-01T00:00:00Z", last_message_at: "2026-01-03T00:00:00Z" },
      ],
      new Map([["t1", 8]]),
    );
    expect(out[0].messages).toBe(8);
    expect(out[1].messages).toBe(0);
  });
});

describe("buildChatErrors", () => {
  it("keeps error-status OR non-null-error runs, normalizes message", () => {
    const out = buildChatErrors([
      { id: "r1", agent_slug: "engineer", status: "dispatch_error", error: null, enqueued_at: "2026-01-01T00:00:00Z", finished_at: null },
      { id: "r2", agent_slug: "pm", status: "success", error: "tool timeout", enqueued_at: "2026-01-02T00:00:00Z", finished_at: "2026-01-02T01:00:00Z" },
      { id: "r3", agent_slug: "qa", status: "success", error: null, enqueued_at: "2026-01-03T00:00:00Z", finished_at: null },
    ]);
    expect(out.map((e) => e.run_id)).toEqual(["r1", "r2"]);
    expect(out[0].error).toBe("dispatch_error");
    expect(out[1].error).toBe("tool timeout");
    expect(out[1].at).toBe("2026-01-02T01:00:00Z");
  });
});

describe("staffTenantActivity handler", () => {
  const TID = "73db45ff-457e-4541-bc8f-bdb625390204";

  it("non-staff → throws before any DB read", async () => {
    assertStaffMock.mockImplementation(() => {
      throw new Error("not_staff");
    });
    await expect(staffTenantActivity(reqFor(TID), mockRes())).rejects.toThrow("not_staff");
  });

  it("tenant not found → 404", async () => {
    cfg.tables["tenants"] = { data: null, error: null };
    const res = mockRes();
    await staffTenantActivity(reqFor(TID), res);
    expect(res._status).toBe(404);
    expect(res._json.error.code).toBe("tenant_not_found");
  });

  it("happy path → 200, three sections present, degraded empty", async () => {
    cfg.tables["tenants"] = { data: { id: TID }, error: null };
    const res = mockRes();
    await staffTenantActivity(reqFor(TID), res);
    expect(res._status).toBe(200);
    expect(res._json.connections).toEqual([]);
    expect(res._json.chats).toEqual({ total: 0, items: [] });
    expect(res._json.chat_errors).toEqual({ total: 0, items: [] });
    expect(res._json.degraded).toEqual([]);
    expect(res._json.list_cap).toBe(100);
  });

  it("a section query error → that section falls back + key in degraded, still 200", async () => {
    cfg.tables["tenants"] = { data: { id: TID }, error: null };
    cfg.tables["agent_threads"] = { data: null, error: { message: "boom" } };
    const res = mockRes();
    await staffTenantActivity(reqFor(TID), res);
    expect(res._status).toBe(200);
    expect(res._json.chats).toEqual({ total: 0, items: [] });
    expect(res._json.degraded).toContain("chats");
  });
});
