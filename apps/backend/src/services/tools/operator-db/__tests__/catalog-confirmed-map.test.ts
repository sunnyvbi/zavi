import { describe, it, expect, vi, beforeEach } from "vitest";

const loadDbAccess = vi.fn();
vi.mock("@/services/data-gateway", () => ({
  loadDbAccess: (...a: unknown[]) => loadDbAccess(...a),
  visibleCatalog: (c: unknown) => c,
  withAttachedDriver: vi.fn(),
}));
vi.mock("../catalog", () => ({
  getCatalog: async () => ({
    dialect: "mongodb",
    catalog: { tables: [{ name: "orders" }, { name: "cancelled_orders" }] },
    hints: { bookings: { table: "cancelled_orders", created_at_field: "createdAt" } },
    discovered_at: "2026-10-14T18:17:51Z",
    catalog_hash: "h",
  }),
  getDeclaredDialect: async () => "mongodb",
  renderCatalogDigest: () => "orders(...)",
  renderCatalogIndex: () => [{ name: "orders" }, { name: "cancelled_orders" }],
  allowedCollectionsFromCatalog: () => new Set<string>(),
}));
vi.mock("../discovery/retry", () => ({
  maybeRediscoverCatalog: async (_t: string, cur: unknown) => cur,
  rediscoveryRequestedRecently: () => false,
}));

import { operatorDbCatalogTool } from "../tools";

const ctx = { tenant_id: "t1" } as never;

beforeEach(() => {
  loadDbAccess.mockReset();
});

async function run(input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const out = (await operatorDbCatalogTool.execute(ctx, input)) as { data: Record<string, unknown> };
  return out.data;
}

describe("operator_db_catalog: confirmed map vs hints", () => {
  it("returns the confirmed map, marks hints as guesses, and dates the snapshot", async () => {
    loadDbAccess.mockResolvedValue({
      policy: {},
      confirmed_map: { bookings: { table: "orders", label: "Orders", created_at_field: "createdAt", carried_from: "abc" } },
    });
    const data = await run();
    expect(data.confirmed_map).toEqual({ bookings: { table: "orders", created_at_field: "createdAt" } });
    expect(String(data.hints_note)).toMatch(/guesses/i);
    expect(String(data.hints_note)).toMatch(/confirmed_map/);
    expect(data.scanned_at).toBe("2026-10-14T18:17:51Z");
    expect(String(data.scan_note)).toMatch(/not a live read/i);
  });

  it("does the same on the detail path", async () => {
    loadDbAccess.mockResolvedValue({ policy: {}, confirmed_map: { bookings: { table: "orders", label: "Orders" } } });
    const data = await run({ tables: ["orders"] });
    expect(data.confirmed_map).toEqual({ bookings: { table: "orders" } });
    expect(data.scanned_at).toBe("2026-10-14T18:17:51Z");
  });

  it("says nothing is confirmed when there is no confirmed map", async () => {
    loadDbAccess.mockResolvedValue({ policy: {} });
    const data = await run();
    expect(data.confirmed_map).toBeNull();
    expect(String(data.hints_note)).toMatch(/guesses/i);
  });

  it("keeps the readiness gate that checks the saved login (a missing login is not ready)", async () => {
    loadDbAccess.mockResolvedValue({ policy: {} });
    await run();
    expect(loadDbAccess).toHaveBeenCalledWith("t1");
  });
});
