import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryResult = { data: Record<string, unknown> | null; error: { message: string } | null };

const calls: Array<{ method: string; args: unknown[] }> = [];
let queuedResults: QueryResult[] = [];

function builder() {
  const b: Record<string, (...args: unknown[]) => unknown> = {};
  for (const method of ["select", "eq"]) {
    b[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return b;
    };
  }
  b.maybeSingle = async () => {
    calls.push({ method: "maybeSingle", args: [] });
    return queuedResults.shift() ?? { data: null, error: null };
  };
  return b;
}

const fromSpy = vi.fn((table: string) => {
  calls.push({ method: "from", args: [table] });
  return builder();
});

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: fromSpy }),
}));

import { getCatalog, getDeclaredDialect } from "../catalog";
import { getCatalogHash, getConfirmedMapping } from "../mapping";

beforeEach(() => {
  calls.length = 0;
  queuedResults = [];
  fromSpy.mockClear();
});

function expectTenantScope(table: string, tenantId: string) {
  expect(calls).toEqual(
    expect.arrayContaining([
      { method: "from", args: [table] },
      { method: "eq", args: ["tenant_id", tenantId] },
    ]),
  );
}

describe("operator DB metadata reads — tenantClient scoping", () => {
  it("getCatalog scopes tenant_db_catalog by tenant_id", async () => {
    queuedResults.push({
      data: {
        dialect: "mongodb",
        catalog: { tables: [] },
        hints: {},
        catalog_hash: "hash-1",
        discovery_error: null,
        updated_at: "2026-07-04T00:00:00Z",
      },
      error: null,
    });

    const out = await getCatalog("tenant-A");

    expect(out?.catalog_hash).toBe("hash-1");
    expectTenantScope("tenant_db_catalog", "tenant-A");
  });

  it("getCatalog never serves a catalog written under another source epoch", async () => {
    const row = { dialect: "mongodb", catalog: { tables: [{ name: "users" }] }, hints: {}, catalog_hash: "h", discovery_error: null, updated_at: null };
    queuedResults.push({ data: { ...row, source_epoch: 1 }, error: null }, { data: { source_epoch: 2 }, error: null });
    expect(await getCatalog("tenant-A")).toBeNull();
    expectTenantScope("tenant_db_generation", "tenant-A");

    queuedResults.push(
      { data: { ...row, source_epoch: 2, rescan_error: "timed out", rescan_failed_at: "2026-10-14T06:00:00Z", discovered_at: "2026-10-12T09:00:00Z" }, error: null },
      { data: { source_epoch: 2 }, error: null },
    );
    expect(await getCatalog("tenant-A")).toMatchObject({ rescan_error: "timed out", rescan_failed_at: "2026-10-14T06:00:00Z", discovered_at: "2026-10-12T09:00:00Z" });
  });

  it("getCatalog fails closed when the source epoch cannot be read", async () => {
    queuedResults.push({ data: { dialect: "mongodb", catalog: { tables: [{ name: "users" }] }, hints: {}, source_epoch: 0 }, error: null }, { data: null, error: { message: "down" } });
    expect(await getCatalog("tenant-A")).toBeNull();
  });

  it("getDeclaredDialect scopes tenant_db_config by tenant_id", async () => {
    queuedResults.push({ data: { type: "postgres" }, error: null });

    await expect(getDeclaredDialect("tenant-B")).resolves.toBe("postgres");
    expectTenantScope("tenant_db_config", "tenant-B");
  });

  it("getCatalogHash scopes tenant_db_catalog by tenant_id", async () => {
    queuedResults.push({ data: { catalog_hash: "hash-2" }, error: null });

    await expect(getCatalogHash("tenant-C")).resolves.toBe("hash-2");
    expectTenantScope("tenant_db_catalog", "tenant-C");
  });

  it("getConfirmedMapping scopes mapping_confirmed by tenant_id and current hash", async () => {
    queuedResults.push({
      data: {
        catalog_hash: "hash-3",
        confirmed_map: { bookings: { table: "bookings", label: "Bookings" } },
        confirmed_at: "2026-07-04T00:00:00Z",
      },
      error: null,
    });

    const out = await getConfirmedMapping("tenant-D", "hash-3");

    expect(out?.catalog_hash).toBe("hash-3");
    expectTenantScope("mapping_confirmed", "tenant-D");
    expect(calls).toEqual(expect.arrayContaining([{ method: "eq", args: ["catalog_hash", "hash-3"] }]));
  });
});
