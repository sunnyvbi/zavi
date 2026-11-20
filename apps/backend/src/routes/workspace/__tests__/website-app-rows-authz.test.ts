
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), role: vi.fn(), rows: vi.fn(), log: vi.fn(), update: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.auth }));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: async (auth: unknown, allowed: readonly string[], res: Response) => {
    const role = await mocks.role();
    if (!role || !allowed.includes(role)) {
      res.status(403).json({
        error: { code: "forbidden", message: `This action requires one of: ${allowed.join(", ")}. Your role: ${role ?? "none"}.` },
      });
      return false;
    }
    return true;
  },
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: mocks.log }));
vi.mock("@/services/website/app-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/website/app-data")>();
  return { ...actual, readGeneratedAppRows: mocks.rows, updateGeneratedAppRow: mocks.update };
});

import { getWebsiteAppRowsHandler, updateWebsiteAppRowHandler } from "../website-app-rows";

function response() {
  let status = 200;
  let body: unknown;
  const res = {
    status: vi.fn((value: number) => { status = value; return res; }),
    json: vi.fn((value: unknown) => { body = value; return res; }),
  } as unknown as Response;
  return { res, result: () => ({ status, body }) };
}

const req = { query: { table: "users", limit: "10", offset: "0" } } as unknown as Request;

describe("GET /api/website/app-rows authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-a" });
    mocks.log.mockResolvedValue(undefined);
    mocks.rows.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }], columns: [], has_more: false });
  });

  it("403s a member and never touches the app database", async () => {
    mocks.role.mockResolvedValue("member");
    const { res, result } = response();
    await getWebsiteAppRowsHandler(req, res);
    expect(result()).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
    expect(mocks.rows).not.toHaveBeenCalled();
  });

  it("403s a caller whose tenant role row is missing", async () => {
    mocks.role.mockResolvedValue(null);
    const { res, result } = response();
    await getWebsiteAppRowsHandler(req, res);
    expect(result()).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
    expect(mocks.rows).not.toHaveBeenCalled();
  });

  for (const role of ["owner", "admin"] as const) {
    it(`still serves 200 to an ${role}`, async () => {
      mocks.role.mockResolvedValue(role);
      const { res, result } = response();
      await getWebsiteAppRowsHandler(req, res);
      expect(mocks.rows).toHaveBeenCalledWith({ tenantId: "tenant-a", table: "users", limit: 10, offset: 0 });
      expect(result()).toMatchObject({ status: 200, body: { connected: true, supported: true } });
    });
  }

  it("audit-logs the read with no row contents or query values in meta", async () => {
    mocks.role.mockResolvedValue("owner");
    const { res } = response();
    await getWebsiteAppRowsHandler(req, res);
    expect(mocks.log).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "info",
        source: "website.app_data",
        code: "app_data_read",
        tenant_id: "tenant-a",
        meta: { initiated_by_user: "user-a", op: "read", driver: "postgres", table: "users", count: 2 },
      }),
    );
    const meta = (mocks.log.mock.calls[0][0] as { meta: Record<string, unknown> }).meta;
    expect(Object.keys(meta).sort()).toEqual(["count", "driver", "initiated_by_user", "op", "table"]);
  });
});

describe("PATCH /api/website/app-rows role-change audit (site roles R5)", () => {
  const patch = {
    body: { table: "users", key: { id: 7 }, version: "9", values: { role: "admin" } },
  } as unknown as Request;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-a" });
    mocks.role.mockResolvedValue("owner");
    mocks.log.mockResolvedValue(undefined);
  });

  it("logs app_role_changed with table, target id and closed from/to values, and strips roleChange from the response", async () => {
    mocks.update.mockResolvedValue({
      values: { id: "7", role: "admin" }, key: { id: "7" }, version: "10", truncated: [],
      roleChange: { table: "users", target_id: "7", from: "user", to: "admin" },
    });
    const { res, result } = response();
    await updateWebsiteAppRowHandler(patch, res);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-a", table: "users" }));
    expect(result().status).toBe(200);
    expect(JSON.stringify(result().body)).not.toContain("roleChange");
    const call = mocks.log.mock.calls.find((c) => (c[0] as { code: string }).code === "app_role_changed");
    expect(call?.[0]).toMatchObject({
      source: "website.app_data",
      tenant_id: "tenant-a",
      meta: { initiated_by_user: "user-a", table: "users", target_id: "7", from_role: "user", to_role: "admin" },
    });
  });

  it("no app_role_changed when the update did not change a role", async () => {
    mocks.update.mockResolvedValue({ values: {}, key: {}, version: "10", truncated: [], roleChange: null });
    const { res } = response();
    await updateWebsiteAppRowHandler(patch, res);
    expect(mocks.log.mock.calls.some((c) => (c[0] as { code: string }).code === "app_role_changed")).toBe(false);
  });

  it("a member cannot change a role", async () => {
    mocks.role.mockResolvedValue("member");
    const { res, result } = response();
    await updateWebsiteAppRowHandler(patch, res);
    expect(result().status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
