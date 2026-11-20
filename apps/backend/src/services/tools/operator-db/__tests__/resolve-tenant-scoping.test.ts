import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

const CONFIG_BY_TENANT: Record<string, Record<string, unknown> | null> = {
  "tenant-a": { type: "postgres", mode: "direct", connection_secret_key: "operator_db.connection_string" },
  "tenant-b": null,
};
const scopedTo: string[] = [];

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tid: string) => {
    scopedTo.push(tid);
    return {
      from: () => ({ select: () => ({ maybeSingle: async () => ({ data: CONFIG_BY_TENANT[tid] ?? null, error: null }) }) }),
    };
  },
}));
vi.mock("../catalog", () => ({
  getCatalog: vi.fn(async (tenant_id: string) =>
    tenant_id === "tenant-a"
      ? { dialect: "postgres", catalog: { tables: [{ name: "users", columns: [] }] }, hints: {}, catalog_hash: "h", discovery_error: null }
      : null,
  ),
  hintsToSchemaMapShape: () => ({}),
}));
vi.mock("../mapping", () => ({ getConfirmedMapping: async () => null, applyConfirmedMap: (m: unknown) => m }));
vi.mock("@/services/secrets/vault", () => ({
  getSecret: vi.fn(async (tenant_id: string) => (tenant_id === "tenant-a" ? "postgres://a-only-connection" : null)),
}));

import { loadDbAccess } from "@/services/data-gateway/resolve";

beforeEach(() => {
  scopedTo.length = 0;
});

describe("loadDbAccess — tenant scoping + graceful connector-absent", () => {
  it("scopes the config lookup by the PASSED tenant_id (cross-tenant isolation)", async () => {
    const resolved = await loadDbAccess("tenant-a");
    expect(resolved.connectionString).toBe("postgres://a-only-connection");
    expect(scopedTo.length).toBeGreaterThan(0);
    expect(new Set(scopedTo)).toEqual(new Set(["tenant-a"]));
  });

  it("tenant with NO connector → ExpectedToolError(operator_db_not_connected) (recoverable, not a crash)", async () => {
    await expect(loadDbAccess("tenant-b")).rejects.toBeInstanceOf(ExpectedToolError);
    await expect(loadDbAccess("tenant-b")).rejects.toMatchObject({ code: "operator_db_not_connected" });
    expect(scopedTo.every((t) => t === "tenant-b")).toBe(true);
  });
});
