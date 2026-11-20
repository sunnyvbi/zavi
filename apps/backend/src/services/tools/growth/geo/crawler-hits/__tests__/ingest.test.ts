import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  resolve: { data: null as unknown, error: null as unknown },
  resolveCalls: 0,
  recordCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: vi.fn(),
  preTenantRpc: async () => {
    state.resolveCalls++;
    return state.resolve;
  },
  tenantRpc: async (_tid: string, name: string, args: Record<string, unknown>) => {
    state.recordCalls.push({ name, args });
    return { data: (args.p_rows as unknown[]).length, error: null };
  },
}));

import { displayPrefix, generateIngestToken, hashIngestToken, ingestLogBatch, resolveIngestToken } from "../ingest";

beforeEach(() => {
  state.resolve = { data: null, error: null };
  state.resolveCalls = 0;
  state.recordCalls = [];
});

describe("ingest token", () => {
  it("is 32 random bytes behind a prefix, stored only as sha256", () => {
    const a = generateIngestToken();
    expect(a).toMatch(/^zgeo_[0-9a-f]{64}$/);
    expect(generateIngestToken()).not.toBe(a);
    expect(hashIngestToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashIngestToken(a)).not.toContain(a.slice(5, 20));
    expect(displayPrefix(a)).toHaveLength(11);
  });

  it("never reaches the database for a malformed bearer", async () => {
    expect(await resolveIngestToken("Bearer nonsense")).toBeNull();
    expect(await resolveIngestToken("zgeo_short")).toBeNull();
    expect(state.resolveCalls).toBe(0);
  });

  it("resolves an active token to the tenant on its row", async () => {
    state.resolve = { data: [{ tenant_id: "t1", token_id: "k1" }], error: null };
    expect(await resolveIngestToken(generateIngestToken())).toEqual({ tenant_id: "t1", token_id: "k1" });
  });

  it("treats a resolver error as no token, not as a tenant", async () => {
    state.resolve = { data: null, error: { message: "db down" } };
    expect(await resolveIngestToken(generateIngestToken())).toBeNull();
  });
});

describe("ingestLogBatch", () => {
  it("writes aggregated rows through the token-checking RPC, scoped to the resolved tenant", async () => {
    const lines = [
      JSON.stringify({ user_agent: "PerplexityBot/1.0", path: "/a", status: 200, timestamp: "2026-09-16T10:00:00Z" }),
      JSON.stringify({ user_agent: "PerplexityBot/1.0", path: "/a", status: 200, timestamp: "2026-09-16T11:00:00Z" }),
      JSON.stringify({ user_agent: "curl/8", path: "/", status: 200, timestamp: "2026-09-16T11:00:00Z" }),
    ].join("\n");
    const r = await ingestLogBatch({ tenant_id: "t1", token_id: "k1" }, Buffer.from(lines), Date.parse("2026-09-17T00:00:00Z"));
    expect(r).toMatchObject({ records: 3, matched: 2, ignored: 1, rows_written: 1 });
    expect(state.recordCalls).toHaveLength(1);
    expect(state.recordCalls[0].name).toBe("geo_record_crawler_hits");
    expect(state.recordCalls[0].args.p_token_id).toBe("k1");
    expect(state.recordCalls[0].args.p_rows).toEqual([
      expect.objectContaining({ day: "2026-09-16", bot: "PerplexityBot", path: "/a", status: 200, hits: 2 }),
    ]);
  });
});
