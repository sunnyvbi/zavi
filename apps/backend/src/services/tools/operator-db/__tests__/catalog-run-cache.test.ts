import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { other } = vi.hoisted(() => ({
  other: (name: string) => ({ name, effect: "read", description: name, input_schema: { parse: (x: unknown) => x }, execute: () => ({ ok: true }) }),
}));
const st = vi.hoisted(() => ({
  catalog: vi.fn(),
  query: vi.fn(),
  generation: 1,
  hash: "h1" as string | null,
}));

vi.mock("@/services/tools/operator-db/tools", () => {
  const spec = (name: string, fn: (...a: unknown[]) => unknown) => ({
    name,
    effect: "read",
    description: name,
    input_schema: z.object({ tables: z.array(z.string()).max(3).optional(), q: z.string().optional() }),
    execute: (ctx: unknown, input: unknown) => fn(ctx, input),
  });
  return {
    operatorDbCatalogTool: spec("operator_db_catalog", (...a) => st.catalog(...a)),
    operatorDbQueryTool: spec("operator_db_query", (...a) => st.query(...a)),
    queryUserTool: spec("operator_db_query_user", () => ({ ok: true })),
    queryListingTool: spec("operator_db_query_listing", () => ({ ok: true })),
    queryRecentTransactionsTool: spec("operator_db_query_recent_transactions", () => ({ ok: true })),
  };
});
vi.mock("@/services/tools/operator-db/aggregates", () => ({
  queryBookingsByGeoCategoryTool: other("operator_db_a1"),
  queryActiveSupplyByGeoCategoryTool: other("operator_db_a2"),
  queryFunnelByGeoCategoryTool: other("operator_db_a3"),
  queryVerifiedBookingsByCampaignTool: other("operator_db_a4"),
  queryNewUsersTool: other("operator_db_a5"),
  queryNewBookingsTool: other("operator_db_a6"),
  operatorDbSummaryTool: other("operator_db_a7"),
}));
vi.mock("@/services/mcp/internal/codeact-tool", () => ({ codeactTool: other("operator_db_codeact") }));
vi.mock("@/services/data-gateway", () => ({
  collectAccessNotes: async (fn: () => Promise<unknown>) => ({ result: await fn(), notes: [{ table: "users" }] }),
  readDbGeneration: async () => st.generation,
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/tools/operator-db/mapping", () => ({ getCatalogHash: async () => st.hash }));

import { callOperatorDbTool } from "@/services/mcp/internal/operator-db";
import { CATALOG_RUN_CACHE_TTL_MS, __testOnly } from "../catalog-run-cache";

const READY = { ok: true, data: { ready: true, collections: ["users"] } };
const run = (tenant: string, runId: string | null, args: unknown = {}) =>
  callOperatorDbTool(tenant, "catalog", args, runId ? { run_id: runId, agent_slug: "cgo" } : {});

beforeEach(() => {
  __testOnly.runs.clear();
  st.catalog.mockReset().mockResolvedValue(READY);
  st.query.mockReset().mockResolvedValue({ ok: true, data: { rows: [] } });
  st.generation = 1;
  st.hash = "h1";
  vi.useRealTimers();
});

describe("operator_db catalog, cached per run", () => {
  it("reads the catalog once for a repeat of the same call in one run", async () => {
    const first = await run("t1", "r1");
    const second = await run("t1", "r1");
    expect(st.catalog).toHaveBeenCalledTimes(1);
    expect(second.content).toBe(first.content);
    expect(first.access_notes).toHaveLength(1);
    expect(second.access_notes).toBeUndefined();
  });

  it("treats the same tables in any order as the same call, and other tables as a new one", async () => {
    await run("t1", "r1", { tables: ["b", "a"] });
    await run("t1", "r1", { tables: ["a", "b", "a"] });
    expect(st.catalog).toHaveBeenCalledTimes(1);
    await run("t1", "r1", { tables: ["c"] });
    await run("t1", "r1");
    expect(st.catalog).toHaveBeenCalledTimes(3);
  });

  it("never shares a catalog across runs or tenants", async () => {
    await run("t1", "r1");
    await run("t1", "r2");
    await run("t2", "r1");
    expect(st.catalog).toHaveBeenCalledTimes(3);
  });

  it("does not cache without a run id", async () => {
    await run("t1", null);
    await run("t1", null);
    expect(st.catalog).toHaveBeenCalledTimes(2);
  });

  it("does not cache a catalog that is not ready", async () => {
    st.catalog.mockResolvedValue({ ok: true, data: { ready: false, reason: "discovery_pending" } });
    await run("t1", "r1");
    await run("t1", "r1");
    expect(st.catalog).toHaveBeenCalledTimes(2);
  });

  it("drops the run's catalog when another operator_db call in the run fails", async () => {
    await run("t1", "r1");
    st.query.mockRejectedValueOnce(Object.assign(new Error("server selection timed out"), { code: 13 }));
    await expect(callOperatorDbTool("t1", "query", { q: "x" }, { run_id: "r1" })).rejects.toThrow();
    await run("t1", "r1");
    expect(st.catalog).toHaveBeenCalledTimes(2);
  });

  it("drops the run's catalog when the catalog call itself throws", async () => {
    await run("t1", "r1", { tables: ["a"] });
    st.catalog.mockRejectedValueOnce(new Error("boom"));
    await expect(run("t1", "r1")).rejects.toThrow();
    await run("t1", "r1", { tables: ["a"] });
    expect(st.catalog).toHaveBeenCalledTimes(3);
  });

  it("re-reads after the cache entry expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-12T10:00:00Z"));
    await run("t1", "r1");
    vi.setSystemTime(Date.now() + CATALOG_RUN_CACHE_TTL_MS + 1);
    await run("t1", "r1");
    expect(st.catalog).toHaveBeenCalledTimes(2);
  });

  it("reads again after the connection or What Zavi can see changes mid-run", async () => {
    await run("t1", "r1");
    st.generation = 2;
    await run("t1", "r1");
    await run("t1", "r1");
    expect(st.catalog).toHaveBeenCalledTimes(2);
  });

  it("reads again after a rediscovery rewrites the catalog at the same generation", async () => {
    await run("t1", "r1");
    st.hash = "h2";
    await run("t1", "r1");
    expect(st.catalog).toHaveBeenCalledTimes(2);
  });

  it("does not cache when the catalog hash cannot be read", async () => {
    st.hash = null;
    await run("t1", "r1");
    await run("t1", "r1");
    expect(st.catalog).toHaveBeenCalledTimes(2);
  });

  it("never answers invalid input from the cache", async () => {
    await run("t1", "r1");
    const bad = await run("t1", "r1", { tables: "users" });
    expect(bad.is_error).toBe(true);
    expect(JSON.parse(bad.content).error).toBe("tool_input_invalid");
    const tooMany = await run("t1", "r1", { tables: ["a", "b", "c", "d"] });
    expect(tooMany.is_error).toBe(true);
  });

  it("shares one read between parallel identical calls", async () => {
    let release: (v: unknown) => void = () => undefined;
    st.catalog.mockImplementation(() => new Promise((r) => (release = r)));
    const both = Promise.all([run("t1", "r1"), run("t1", "r1")]);
    await vi.waitFor(() => expect(st.catalog).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 5));
    release(READY);
    const [a, b] = await both;
    expect(st.catalog).toHaveBeenCalledTimes(1);
    expect(a.content).toBe(b.content);
  });

  it("holds a bounded number of different calls per run", async () => {
    for (let i = 0; i < __testOnly.MAX_INPUTS_PER_RUN + 2; i++) await run("t1", "r1", { tables: [`t${i}`] });
    expect(__testOnly.runs.get("t1|r1")?.byInput.size).toBe(__testOnly.MAX_INPUTS_PER_RUN);
  });

  it("a parallel caller sharing a read that throws gets the throw, with no second read", async () => {
    let fail: (e: Error) => void = () => undefined;
    st.catalog.mockImplementation(() => new Promise((_r, rej) => (fail = rej)));
    const a = run("t1", "r1");
    const b = run("t1", "r1");
    await vi.waitFor(() => expect(st.catalog).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 5));
    fail(new Error("driver down"));
    await expect(a).rejects.toThrow();
    await expect(b).rejects.toThrow();
    expect(st.catalog).toHaveBeenCalledTimes(1);
    expect(__testOnly.runs.has("t1|r1")).toBe(false);
  });
});
