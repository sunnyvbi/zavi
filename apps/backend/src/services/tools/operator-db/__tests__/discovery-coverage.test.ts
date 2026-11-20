import { describe, it, expect, vi } from "vitest";
import { coverageFromRaw } from "../discovery/index";
import type { RawIntrospection, DiscoveryCoverage } from "../types";

function raw(over: Partial<RawIntrospection> = {}): RawIntrospection {
  return {
    dialect: "mysql",
    tables: [],
    skippedUnsafeNames: 0,
    namesSeenTotal: 0,
    deadlineHit: false,
    listingTruncated: false,
    ...over,
  };
}
const tbl = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `t${i}`, columns: [], rowEstimate: null }));

describe("coverageFromRaw", () => {
  it("reports the REAL total alongside what was indexed", () => {
    const c = coverageFromRaw(raw({ tables: tbl(1000), namesSeenTotal: 1204, skippedUnsafeNames: 4 }));
    expect(c).toEqual<DiscoveryCoverage>({
      tables_total: 1204,
      tables_indexed: 1000,
      skipped_unsafe_names: 4,
      deadline_hit: false,
      listing_truncated: false,
    });
  });

  it("carries the deadline flag — a time-truncated catalog is not a complete one", () => {
    expect(coverageFromRaw(raw({ tables: tbl(400), namesSeenTotal: 900, deadlineHit: true })).deadline_hit).toBe(true);
  });

  it("carries listing_truncated, which makes tables_total a lower bound", () => {
    expect(coverageFromRaw(raw({ dialect: "dynamodb", listingTruncated: true })).listing_truncated).toBe(true);
  });

  it("a fully-indexed schema reports totals that match", () => {
    const c = coverageFromRaw(raw({ tables: tbl(12), namesSeenTotal: 12 }));
    expect(c.tables_total).toBe(c.tables_indexed);
  });
});

const catalogState: {
  coverage: DiscoveryCoverage | null;
} = { coverage: null };

vi.mock("../catalog", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getCatalog: async () => ({
      dialect: "mysql",
      catalog: { tables: [{ name: "users", columns: [], rowEstimate: 10 }] },
      hints: {},
      catalog_hash: "h",
      coverage: catalogState.coverage,
      discovery_error: null,
      updated_at: null,
    }),
    getDeclaredDialect: async () => "mysql",
    renderCatalogIndex: () => [{ name: "users", rows: 10 }],
    renderCatalogDigest: () => "users(...)",
  };
});
vi.mock("@/services/data-gateway", () => ({ loadDbAccess: async () => ({ policy: {} }), visibleCatalog: (c: unknown) => c, withAttachedDriver: async () => ({}) }));
vi.mock("../discovery/retry", () => ({ maybeRediscoverCatalog: async (_t: string, r: unknown) => r }));

const ctx = { tenant_id: "t1" } as never;

describe("operator_db_catalog — coverage surfacing", () => {
  it("a PARTIAL catalog is flagged and forbids absence claims", async () => {
    catalogState.coverage = {
      tables_total: 1204,
      tables_indexed: 1000,
      skipped_unsafe_names: 4,
      deadline_hit: false,
      listing_truncated: false,
    };
    const { operatorDbCatalogTool } = await import("../tools");
    const res = (await operatorDbCatalogTool.execute(ctx, {})) as {
      data: { coverage?: { complete: boolean }; coverage_note?: string };
    };
    expect(res.data.coverage?.complete).toBe(false);
    expect(res.data.coverage_note).toMatch(/PARTIAL VIEW/);
    expect(res.data.coverage_note).toMatch(/204 of 1204/);
    expect(res.data.coverage_note).toMatch(/not identifier-safe/);
    expect(res.data.coverage_note).toMatch(/Do NOT tell the user a table or field does not exist/);
  });

  it("a COMPLETE catalog is marked complete and carries no scary note", async () => {
    catalogState.coverage = {
      tables_total: 1,
      tables_indexed: 1,
      skipped_unsafe_names: 0,
      deadline_hit: false,
      listing_truncated: false,
    };
    const { operatorDbCatalogTool } = await import("../tools");
    const res = (await operatorDbCatalogTool.execute(ctx, {})) as {
      data: { coverage?: { complete: boolean }; coverage_note?: string };
    };
    expect(res.data.coverage?.complete).toBe(true);
    expect(res.data.coverage_note).toBeUndefined();
  });

  it("UNKNOWN coverage emits no coverage claim at all — never a synthesised 'complete'", async () => {
    catalogState.coverage = null;
    const { operatorDbCatalogTool } = await import("../tools");
    const res = (await operatorDbCatalogTool.execute(ctx, {})) as {
      data: Record<string, unknown>;
    };
    expect(res.data).not.toHaveProperty("coverage");
    expect(res.data).not.toHaveProperty("coverage_note");
  });
});
