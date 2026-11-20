import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), role: vi.fn(), tables: vi.fn(), log: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.auth }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRole: mocks.role }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: mocks.log }));
vi.mock("@/services/website/app-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/website/app-data")>();
  return { ...actual, listGeneratedAppTables: mocks.tables };
});

import { AppDataError } from "@/services/website/app-data";
import { getWebsiteAppCatalogHandler } from "../website-app-catalog";

function response() {
  let status = 200;
  let body: unknown;
  const res = {
    status: vi.fn((value: number) => { status = value; return res; }),
    json: vi.fn((value: unknown) => { body = value; return res; }),
  } as unknown as Response;
  return { res, result: () => ({ status, body }) };
}

describe("GET /api/website/app-catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-a" });
    mocks.role.mockResolvedValue("owner");
    mocks.log.mockResolvedValue(undefined);
  });

  it("loads only the authenticated tenant's generated database catalog", async () => {
    mocks.tables.mockResolvedValue([{ name: "users", row_estimate: 1, columns: [{ name: "id" }, { name: "email" }], primary_key: ["id"], writable: true }]);
    const { res, result } = response();
    await getWebsiteAppCatalogHandler({} as Request, res);
    expect(mocks.tables).toHaveBeenCalledWith("tenant-a");
    expect(result()).toMatchObject({ status: 200, body: { connected: true, can_write: true, tables: [{ name: "users", columns: [{ name: "id" }, { name: "email" }] }], entities: { users: { table: "users", id_field: "id" } } } });
  });

  it("exposes structure to members but not mutation authority", async () => {
    mocks.role.mockResolvedValue("member");
    mocks.tables.mockResolvedValue([]);
    const { res, result } = response();
    await getWebsiteAppCatalogHandler({} as Request, res);
    expect(result()).toMatchObject({ status: 200, body: { connected: true, can_write: false, tables: [] } });
  });

  it("returns a clean not-ready state without exposing credentials", async () => {
    mocks.tables.mockRejectedValue(new AppDataError("app_db_not_ready", "not ready"));
    const { res, result } = response();
    await getWebsiteAppCatalogHandler({} as Request, res);
    expect(result()).toEqual({ status: 200, body: { connected: false, reason: "not_ready", dialect: "postgres" } });
  });
});
