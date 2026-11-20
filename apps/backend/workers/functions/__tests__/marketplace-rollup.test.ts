import { describe, expect, it, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  dbType: "postgres" as string,
  gatewayCtx: null as unknown,
  cfgDialect: "postgres" as string,
  cells: [] as Array<Record<string, unknown>>,
  ops: [] as Array<{ op: string; args: unknown[] }>,
  rpcError: null as null | { message: string },
  sqlCalls: 0,
  supply: [] as Array<Record<string, unknown>>,
  confirmedAt: undefined as string | undefined,
  sqlThrow: null as Error | null,
  statusWrites: [] as Array<{ key: string; value: Record<string, unknown> }>,
  statusWriteFails: false,
  tenantRow: { id: "t-1" } as null | { id: string },
  tenantLookupError: null as null | { message: string },
}));

vi.mock("../../client", () => ({
  inngest: { createFunction: (_a: unknown, _b: unknown, fn: unknown) => fn },
}));
vi.mock("@/services/settings", () => ({
  getBoolSetting: async () => true,
  setTenantSetting: async (_t: string, key: string, value: unknown) => {
    if (m.statusWriteFails && (value as { status?: string }).status === "ok") {
      throw new Error("settings write timeout");
    }
    m.statusWrites.push({ key, value: value as Record<string, unknown> });
  },
}));
vi.mock("@/services/marketplace-intel/self-serve", () => ({
  resolveMarketplaceConfig: async () => ({
    dialect: m.cfgDialect,
    tenant_id: "t-1",
    provenance: { source: "self_serve_confirmed", validated: true, confirmed_at: m.confirmedAt },
  }),
}));
vi.mock("@/services/data-gateway", () => ({
  withReadSession: async (ctx: unknown, fn: (s: unknown, a: unknown) => unknown) => {
    m.gatewayCtx = ctx;
    return fn({ dialect: m.dbType }, { dialect: m.dbType });
  },
}));
vi.mock("@/services/marketplace-intel/aggregate-sql", () => ({
  isSqlDialect: (t: string) => t === "postgres" || t === "mysql",
  computeSqlRollup: async () => {
    m.sqlCalls += 1;
    if (m.sqlThrow) throw m.sqlThrow;
    return { cells: m.cells, supply: m.supply };
  },
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    const chain: Record<string, unknown> = {};
    for (const k of ["from", "delete", "eq", "gte", "lt", "select"]) {
      chain[k] = (...args: unknown[]) => {
        m.ops.push({ op: k, args });
        return chain;
      };
    }
    chain.maybeSingle = async () => ({ data: m.tenantRow, error: m.tenantLookupError });
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ error: null });
    chain.rpc = async (...args: unknown[]) => {
      m.ops.push({ op: "rpc", args });
      return { error: m.rpcError };
    };
    return chain;
  },
}));

import { GatewayRefusal } from "@/services/data-gateway/types";
import { ExpectedToolError } from "@/services/tools/types";
import { classifyRollupError, marketplaceRollupRequestedFn, refusalReasonCode, rollupTenant } from "../marketplace-rollup";

const cell = (week_start: string) => ({
  state: "CA", geo_label: "CA", week_start, bookings_n: 10, active_supply_n: 5,
  gmv_proxy_n: null, demand_basis: "bookings", supply_basis: "booked_listings",
  confidence: "medium", suppressed: false,
});

beforeEach(() => {
  m.dbType = "postgres";
  m.cfgDialect = "postgres";
  m.cells = [cell("2026-07-06"), cell("2026-06-22"), cell("2026-09-14")];
  m.ops = [];
  m.rpcError = null;
  m.sqlCalls = 0;
  m.supply = [];
  m.confirmedAt = undefined;
  m.sqlThrow = null;
  m.statusWrites = [];
  m.statusWriteFails = false;
  m.tenantRow = { id: "t-1" };
  m.tenantLookupError = null;
});

describe("rollupTenant", () => {
  it("SQL tenant: writes, then prunes this tenant's older rows across the WHOLE window, records ok", async () => {
    const r = await rollupTenant("t-1");
    expect(r).toEqual({ status: "processed", rows: 3 });
    const rpcIdx = m.ops.findIndex((o) => o.op === "rpc");
    const delIdx = m.ops.findIndex((o) => o.op === "delete");
    expect(delIdx).toBeGreaterThan(rpcIdx);
    expect(m.ops).toContainEqual({ op: "eq", args: ["tenant_id", "t-1"] });
    const gte = m.ops.find((o) => o.op === "gte");
    const from = String(gte?.args[1]);
    expect(from < "2026-06-22" || Date.parse(from) <= Date.now() - 12 * 7 * 864e5).toBe(true);
    expect(new Date(from + "T00:00:00Z").getUTCDay()).toBe(1);
    expect(m.statusWrites.at(-1)?.value.status).toBe("ok");
  });

  it("self-serve: also drops every row computed before the confirmation", async () => {
    m.confirmedAt = "2026-09-16T10:00:00.000Z";
    await rollupTenant("t-1");
    const lts = m.ops.filter((o) => o.op === "lt");
    expect(lts.map((o) => o.args)).toContainEqual(["computed_at", "2026-09-16T10:00:00.000Z"]);
  });

  it("listings survive with zero bookings: one zero-booking row per state that has supply", async () => {
    m.cells = [];
    m.supply = [{ state: "CA", total_listings: 150, completed_listings: 150, confidence: "medium" }];
    const r = await rollupTenant("t-1");
    expect(r).toEqual({ status: "processed", rows: 1 });
    const rows = (m.ops.find((o) => o.op === "rpc")?.args[1] as { p_rows: Array<Record<string, unknown>> }).p_rows;
    expect(rows[0]).toMatchObject({ state: "CA", bookings_n: 0, total_listings: 150 });
  });

  it("locations that are not US states keep their supply, and a supply-only location gets its row", async () => {
    const at = (geo_label: string, bookings_n: number) => ({
      state: null, geo_label, week_start: "2026-09-14", bookings_n, active_supply_n: 3,
      gmv_proxy_n: null, demand_basis: "bookings", supply_basis: "booked_listings",
      confidence: "medium", suppressed: false,
    });
    m.cells = [at("Lagos", 36), at("Nairobi", 20)];
    m.supply = [
      { state: null, geo_label: "Lagos", total_listings: 40, completed_listings: 40, confidence: "medium" },
      { state: null, geo_label: "Nairobi", total_listings: 25, completed_listings: 25, confidence: "medium" },
      { state: null, geo_label: "Kampala", total_listings: 30, completed_listings: 30, confidence: "medium" },
    ];
    const r = await rollupTenant("t-1");
    expect(r).toEqual({ status: "processed", rows: 3 });
    const rows = (m.ops.find((o) => o.op === "rpc")?.args[1] as { p_rows: Array<Record<string, unknown>> }).p_rows;
    expect(rows.find((row) => row.geo_label === "Lagos")).toMatchObject({ state: null, total_listings: 40, completed_listings: 40 });
    expect(rows.find((row) => row.geo_label === "Nairobi")).toMatchObject({ total_listings: 25 });
    expect(rows.find((row) => row.geo_label === "Kampala")).toMatchObject({ state: null, bookings_n: 0, total_listings: 30 });
  });

  it("a failed run records a fixed code, never the raw database message", async () => {
    m.sqlThrow = new Error('invalid input syntax for type timestamp with time zone: "San Francisco"');
    await expect(rollupTenant("t-1")).rejects.toThrow();
    const w = m.statusWrites.at(-1);
    expect(w?.value).toMatchObject({ status: "failed", code: "bad_date_field" });
    expect(JSON.stringify(w)).not.toContain("San Francisco");
  });

  it("a read the gateway refused records 'refused' with the guard's code, never 'too much data' or the field names", async () => {
    m.sqlThrow = new GatewayRefusal("mongo_read_limit_too_large: $limit 10000 exceeds the row cap 5000", "zavi", ["orders"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(rollupTenant("t-1")).rejects.toThrow(/Refused by a data-access rule/);
      expect(m.statusWrites.at(-1)?.value).toMatchObject({
        status: "failed",
        code: "refused",
        refused_by: "zavi",
        reason_code: "mongo_read_limit_too_large",
      });
      const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("marketplace_rollup.failed"));
      expect(JSON.parse(line!)).toMatchObject({ tenant_id: "t-1", code: "refused", reason_code: "mongo_read_limit_too_large" });
      expect(line).not.toContain("exceeds");
    } finally {
      warn.mockRestore();
    }
  });

  it("a refusal reason without a leading code keeps its text out of the status", () => {
    expect(refusalReasonCode("orders.ssn is hidden from Zavi.")).toBe("unlisted");
    expect(refusalReasonCode("mongo_read_banned_operator: \"$expr\" is not permitted")).toBe("mongo_read_banned_operator");
    expect(classifyRollupError(new GatewayRefusal("customers is not a collection Zavi may read.", "connector"))).toBe("refused");
    expect(classifyRollupError(new Error("result exceeded the row cap"))).toBe("too_much_data");
    expect(classifyRollupError(new ExpectedToolError("connector_rows_truncated", "The answer passed your Zavi Connector's row cap, so the partial rows were not used."))).toBe("too_much_data");
  });

  it("a failed OK-status write fails the run so Inngest retries (page would otherwise stay on calculating)", async () => {
    m.statusWriteFails = true;
    await expect(rollupTenant("t-1")).rejects.toThrow(/settings write timeout/);
    expect(m.statusWrites.some((w) => w.value.status === "failed")).toBe(false);
  });

  it("never prunes when the write failed", async () => {
    m.rpcError = { message: "boom" };
    await expect(rollupTenant("t-1")).rejects.toThrow(/upsert_marketplace_rollup failed/);
    expect(m.ops.some((o) => o.op === "delete")).toBe(false);
  });

  it("skips when the connected engine differs from the setup's engine", async () => {
    m.dbType = "mysql";
    const r = await rollupTenant("t-1");
    expect(r.status).toBe("skipped");
    expect(m.sqlCalls).toBe(0);
    expect(m.ops).toHaveLength(0);
  });
});

describe("marketplaceRollupRequestedFn — re-verifies the event's tenant", () => {
  type Handler = (ctx: {
    event: { data: { tenant_id: unknown } };
    logger: { info: (msg: string) => void; warn: (msg: string) => void };
    step: { run: <T>(id: string, fn: () => Promise<T>) => Promise<T> };
  }) => Promise<{ status: string; reason?: string }>;
  const handler = marketplaceRollupRequestedFn as unknown as Handler;
  const ctx = (tenant_id: unknown) => ({
    event: { data: { tenant_id } },
    logger: { info: () => {}, warn: () => {} },
    step: { run: <T,>(_id: string, fn: () => Promise<T>) => fn() },
  });

  it("an event naming a tenant that does not exist skips without touching any operator DB", async () => {
    m.tenantRow = null;
    const r = await handler(ctx("forged-tenant"));
    expect(r.status).toBe("skipped");
    expect(r.reason).toMatch(/tenant/);
    expect(m.sqlCalls).toBe(0);
    expect(m.statusWrites).toHaveLength(0);
  });

  it("a missing or non-string tenant_id skips before any lookup", async () => {
    for (const bad of [undefined, "", 42]) {
      m.ops = [];
      const r = await handler(ctx(bad));
      expect(r.status).toBe("skipped");
      expect(m.ops).toHaveLength(0);
    }
    expect(m.sqlCalls).toBe(0);
  });

  it("a failed tenant lookup throws so Inngest retries, and never runs the rollup", async () => {
    m.tenantLookupError = { message: "connection reset" };
    await expect(handler(ctx("t-1"))).rejects.toThrow(/tenant check failed/);
    expect(m.sqlCalls).toBe(0);
  });

  it("a real tenant runs the rollup as before, after looking the tenant up by id", async () => {
    const r = await handler(ctx("t-1"));
    expect(r.status).toBe("processed");
    expect(m.ops.slice(0, 3)).toEqual([
      { op: "from", args: ["tenants"] },
      { op: "select", args: ["id"] },
      { op: "eq", args: ["id", "t-1"] },
    ]);
  });
});

describe("marketplace rollup reads through the data gateway", () => {
  it("as background 'Marketplace rollup' for the server-derived tenant", async () => {
    m.dbType = "postgres";
    m.cfgDialect = "postgres";
    const { rollupTenant } = await import("../marketplace-rollup");
    await rollupTenant("t-1").catch(() => undefined);
    expect(m.gatewayCtx).toEqual({ tenant_id: "t-1", caller: { kind: "background", feature: "Marketplace rollup" } });
  });
});
