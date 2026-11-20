import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/data-gateway", () => ({
  loadDbAccess: vi.fn(async () => ({ policy: {} })),
  visibleCatalog: (c: unknown) => c,
  withAttachedDriver: vi.fn(),
}));

const getCatalogMock = vi.fn();
vi.mock("../catalog", () => ({
  getCatalog: (tenantId: string) => getCatalogMock(tenantId),
  getDeclaredDialect: async () => "mongodb",
  renderCatalogDigest: () => "(rendered schema)",
  renderCatalogIndex: () => [{ name: "users" }],
}));
vi.mock("../discovery/retry", () => ({
  maybeRediscoverCatalog: async (_t: string, cur: unknown) => cur,
}));

import { operatorDbCatalogTool } from "../tools";

beforeEach(() => {
  getCatalogMock.mockReset();
});

const ctx = { tenant_id: "t1" } as never;

describe("operatorDbCatalogTool — empty-tables guard (I1)", () => {
  it("zero discovered collections → ready:false with a 'no collections' note", async () => {
    getCatalogMock.mockResolvedValue({
      dialect: "mongodb",
      catalog: { tables: [] },
      hints: {},
      discovery_error: null,
    });

    const res = await operatorDbCatalogTool.execute(ctx, {});

    expect(res).toMatchObject({ ok: true, data: { ready: false } });
    expect((res as { data: { note: string } }).data.note).toContain("no collections");
  });

  it("one or more discovered collections → ready:true", async () => {
    getCatalogMock.mockResolvedValue({
      dialect: "mongodb",
      catalog: {
        tables: [
          { name: "users", columns: [{ name: "id", type: "string", nullable: false }], rowEstimate: 10 },
        ],
      },
      hints: {},
      discovery_error: null,
    });

    const res = await operatorDbCatalogTool.execute(ctx, {});

    expect(res).toMatchObject({ ok: true, data: { ready: true } });
  });
});
