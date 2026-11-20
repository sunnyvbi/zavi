import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

const resolveOperatorDb = vi.fn();
const getCatalog = vi.fn();
const getDeclaredDialect = vi.fn();
const maybeRediscoverCatalog = vi.fn();

vi.mock("@/services/data-gateway", () => ({
  loadDbAccess: async (...a: unknown[]) => {
    await resolveOperatorDb(...a);
    return { policy: {} };
  },
  visibleCatalog: (c: unknown) => c,
  withAttachedDriver: vi.fn(),
}));
vi.mock("../catalog", () => ({
  getCatalog: (...a: unknown[]) => getCatalog(...a),
  getDeclaredDialect: (...a: unknown[]) => getDeclaredDialect(...a),
  renderCatalogDigest: () => "users(...)",
  renderCatalogIndex: () => [{ name: "users" }],
  allowedCollectionsFromCatalog: () => new Set<string>(),
}));
const rediscoveryRequestedRecently = vi.fn(() => false);
vi.mock("../discovery/retry", () => ({
  maybeRediscoverCatalog: (...a: unknown[]) => maybeRediscoverCatalog(...a),
  rediscoveryRequestedRecently: (...a: unknown[]) => rediscoveryRequestedRecently(...(a as [])),
}));

import { operatorDbCatalogTool } from "../tools";

const ctx = { tenant_id: "t1" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  maybeRediscoverCatalog.mockImplementation(async (_t: string, cur: unknown) => cur);
  rediscoveryRequestedRecently.mockReturnValue(false);
});

describe("operator_db_catalog not-ready states", () => {
  it("not_connected — no config, no dialect", async () => {
    getCatalog.mockResolvedValue(null);
    getDeclaredDialect.mockResolvedValue(null);
    resolveOperatorDb.mockRejectedValue(new Error("operator_db_not_connected"));
    const r = await operatorDbCatalogTool.execute(ctx, {} as never) as { data: Record<string, unknown> };
    expect(r.data).toMatchObject({ ready: false, reason: "not_connected", next_step: "operator_action" });
    expect(r.data.dialect).toBeUndefined();
  });

  it("discovery_failed — surfaces dialect + reconnect next_step (the #10 wrong-stack guard)", async () => {
    getCatalog.mockResolvedValue({
      dialect: "mongodb",
      catalog: { tables: [] },
      hints: {},
      discovery_error: "connect ETIMEDOUT",
      updated_at: new Date().toISOString(),
    });
    getDeclaredDialect.mockResolvedValue("mongodb");
    resolveOperatorDb.mockRejectedValue(new Error("operator_db_not_discovered"));
    const r = await operatorDbCatalogTool.execute(ctx, {} as never) as { data: Record<string, unknown> };
    expect(r.data).toMatchObject({
      ready: false,
      dialect: "mongodb",
      reason: "discovery_failed",
      next_step: "operator_action",
    });
  });

  it("a failed catalog that is being re-scanned right now says retry shortly, never reconnect", async () => {
    getCatalog.mockResolvedValue({
      dialect: "mongodb",
      catalog: { tables: [] },
      hints: {},
      discovery_error: "operation exceeded time limit",
      updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    getDeclaredDialect.mockResolvedValue("mongodb");
    resolveOperatorDb.mockRejectedValue(new Error("operator_db_not_discovered"));
    rediscoveryRequestedRecently.mockReturnValue(true);
    const r = await operatorDbCatalogTool.execute(ctx, {} as never) as { data: Record<string, unknown> };
    expect(r.data).toMatchObject({ ready: false, reason: "discovery_pending", next_step: "auto" });
  });

  it("a failure written in the last hour (the retry already failed) still says reconnect", async () => {
    getCatalog.mockResolvedValue({
      dialect: "mongodb",
      catalog: { tables: [] },
      hints: {},
      discovery_error: "operation exceeded time limit",
      updated_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    });
    getDeclaredDialect.mockResolvedValue("mongodb");
    resolveOperatorDb.mockRejectedValue(new Error("operator_db_not_discovered"));
    rediscoveryRequestedRecently.mockReturnValue(true);
    const r = await operatorDbCatalogTool.execute(ctx, {} as never) as { data: Record<string, unknown> };
    expect(r.data).toMatchObject({ reason: "discovery_failed", next_step: "operator_action" });
  });

  it("secret_missing — config+dialect present but Vault secret gone → operator_action, NOT auto-retry", async () => {
    getCatalog.mockResolvedValue(null);
    getDeclaredDialect.mockResolvedValue("mongodb");
    resolveOperatorDb.mockRejectedValue(new ExpectedToolError("operator_db_secret_missing", "missing in Vault"));
    const r = await operatorDbCatalogTool.execute(ctx, {} as never) as { data: Record<string, unknown> };
    expect(r.data).toMatchObject({ ready: false, dialect: "mongodb", reason: "connection_unavailable", next_step: "operator_action" });
  });

  it("discovery_pending — dialect from config even with no catalog row yet", async () => {
    getCatalog.mockResolvedValue(null);
    getDeclaredDialect.mockResolvedValue("mongodb");
    resolveOperatorDb.mockRejectedValue(new Error("operator_db_not_discovered"));
    const r = await operatorDbCatalogTool.execute(ctx, {} as never) as { data: Record<string, unknown> };
    expect(r.data).toMatchObject({ ready: false, dialect: "mongodb", reason: "discovery_pending", next_step: "auto" });
  });

  it("empty_catalog — connected, dialect known, zero collections", async () => {
    const cat = { dialect: "mongodb", catalog: { tables: [] }, hints: {}, discovery_error: null, updated_at: null };
    getCatalog.mockResolvedValue(cat);
    getDeclaredDialect.mockResolvedValue("mongodb");
    resolveOperatorDb.mockResolvedValue(undefined);
    const r = await operatorDbCatalogTool.execute(ctx, {} as never) as { data: Record<string, unknown> };
    expect(r.data).toMatchObject({ ready: false, dialect: "mongodb", reason: "empty_catalog" });
  });

  const readyCatalog = () => ({
    dialect: "mongodb",
    catalog: { tables: [{ name: "users", columns: [], rowEstimate: 1 }] },
    hints: { users: "users" },
    discovery_error: null,
    updated_at: null,
  });

  it("ready (default) — dialect + name index, columns omitted", async () => {
    getCatalog.mockResolvedValue(readyCatalog());
    getDeclaredDialect.mockResolvedValue("mongodb");
    resolveOperatorDb.mockResolvedValue(undefined);
    const r = await operatorDbCatalogTool.execute(ctx, {} as never) as { data: Record<string, unknown> };
    expect(r.data).toMatchObject({
      ready: true,
      dialect: "mongodb",
      total_collections: 1,
      collections: [{ name: "users" }],
    });
    expect(r.data.schema).toBeUndefined();
    expect(String(r.data.note)).toContain("tables:[...]");
  });

  it("ready (tables:[...]) — dialect + name index + requested columns", async () => {
    getCatalog.mockResolvedValue(readyCatalog());
    getDeclaredDialect.mockResolvedValue("mongodb");
    resolveOperatorDb.mockResolvedValue(undefined);
    const r = await operatorDbCatalogTool.execute(ctx, { tables: ["users"] } as never) as { data: Record<string, unknown> };
    expect(r.data).toMatchObject({ ready: true, dialect: "mongodb" });
    expect(r.data.schema).toBe("users(...)");
    expect(r.data.collections).toEqual([{ name: "users" }]);
    expect(r.data.unknown_tables).toBeUndefined();
  });

  it("reports unknown table names instead of silently dropping them", async () => {
    getCatalog.mockResolvedValue(readyCatalog());
    getDeclaredDialect.mockResolvedValue("mongodb");
    resolveOperatorDb.mockResolvedValue(undefined);
    const r = await operatorDbCatalogTool.execute(ctx, { tables: ["nope"] } as never) as { data: Record<string, unknown> };
    expect(r.data.unknown_tables).toEqual(["nope"]);
    expect(r.data.collections).toEqual([{ name: "users" }]);
  });

  it("self-heals: lazy rediscovery flips not-ready → ready within the same call", async () => {
    const stale = { dialect: "mongodb", catalog: { tables: [] }, hints: {}, discovery_error: "boom", updated_at: new Date(Date.now() - 20 * 60_000).toISOString() };
    const healed = { dialect: "mongodb", catalog: { tables: [{ name: "users", columns: [], rowEstimate: 1 }] }, hints: {}, discovery_error: null, updated_at: new Date().toISOString() };
    getCatalog.mockResolvedValue(stale);
    maybeRediscoverCatalog.mockResolvedValue(healed);
    getDeclaredDialect.mockResolvedValue("mongodb");
    resolveOperatorDb.mockResolvedValue(undefined);
    const r = await operatorDbCatalogTool.execute(ctx, {} as never) as { data: Record<string, unknown> };
    expect(maybeRediscoverCatalog).toHaveBeenCalledOnce();
    expect(r.data).toMatchObject({ ready: true, dialect: "mongodb" });
  });
});

describe("operator_db_catalog on a kept last good catalog (2026-10-13 outage)", () => {
  const base = { dialect: "mongodb", catalog: { tables: [{ name: "users", columns: [] }] }, hints: {}, catalog_hash: "h", coverage: null, discovery_error: null, updated_at: new Date().toISOString() };

  it("must-catch: ready, with a note that the list is from the last good scan", async () => {
    getCatalog.mockResolvedValue({ ...base, discovered_at: "2026-10-12T09:00:00Z", rescan_error: "operation exceeded time limit", rescan_failed_at: "2026-10-14T06:00:00Z" });
    resolveOperatorDb.mockResolvedValue(undefined);
    const r = (await operatorDbCatalogTool.execute(ctx, {} as never)) as { data: Record<string, unknown> };
    expect(r.data).toMatchObject({
      ready: true,
      freshness: { last_good_scan_at: "2026-10-12T09:00:00Z", latest_rescan_failed_at: "2026-10-14T06:00:00Z" },
    });
    expect(String(r.data.freshness_note)).toMatch(/last successful scan \(2026-10-12T09:00:00Z\).*may be missing/);
  });

  it("must-not-catch: a catalog the latest scan replaced carries no freshness note", async () => {
    getCatalog.mockResolvedValue(base);
    resolveOperatorDb.mockResolvedValue(undefined);
    const r = (await operatorDbCatalogTool.execute(ctx, {} as never)) as { data: Record<string, unknown> };
    expect(r.data.ready).toBe(true);
    expect(r.data).not.toHaveProperty("freshness");
    expect(r.data).not.toHaveProperty("freshness_note");
  });
});
