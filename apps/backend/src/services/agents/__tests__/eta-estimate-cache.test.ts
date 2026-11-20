import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  reads: [] as Array<{ tenant: unknown; slug: unknown }>,
  rows: new Map<string, Array<{ started_at: string; finished_at: string }>>(),
  failNext: 0,
  throwNext: 0,
  gate: null as null | Promise<void>,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const f: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (col: string, v: unknown) => {
          f[col] = v;
          return q;
        },
        not: () => q,
        gte: () => q,
        order: () => q,
        limit: async () => {
          h.reads.push({ tenant: f.tenant_id, slug: f.agent_slug });
          if (h.gate) await h.gate;
          if (h.throwNext > 0) {
            h.throwNext -= 1;
            throw new Error("network");
          }
          if (h.failNext > 0) {
            h.failNext -= 1;
            return { data: null, error: { message: "boom" } };
          }
          return { data: h.rows.get(`${f.tenant_id}:${f.agent_slug}`) ?? [], error: null };
        },
      };
      return q;
    },
  }),
}));

import { clearRunEtaCache, estimateRunEta, ETA_CACHE_TTL_MS, FLEET_DEFAULTS_MS } from "../eta-estimate";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

function runs(n: number, ms: number) {
  const out: Array<{ started_at: string; finished_at: string }> = [];
  for (let i = 0; i < n; i++) {
    const start = Date.UTC(2026, 9, 1, 0, i);
    out.push({ started_at: new Date(start).toISOString(), finished_at: new Date(start + ms).toISOString() });
  }
  return out;
}

beforeEach(() => {
  clearRunEtaCache();
  h.reads.length = 0;
  h.rows.clear();
  h.failNext = 0;
  h.throwNext = 0;
  h.gate = null;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("estimateRunEta — 5-minute stats cache keyed tenant:slug", () => {
  it("a second run start within 5 minutes reuses the stats, a later one re-reads them", async () => {
    h.rows.set(`${T1}:engineer`, runs(6, 90_000));
    const first = await estimateRunEta(T1, "engineer");
    expect(first).toMatchObject({ basis: "tenant", p50_ms: 90_000, n: 6 });
    h.rows.set(`${T1}:engineer`, runs(6, 30_000));
    vi.setSystemTime(Date.now() + ETA_CACHE_TTL_MS - 1);
    expect(await estimateRunEta(T1, "engineer")).toEqual(first);
    expect(h.reads).toHaveLength(1);
    vi.setSystemTime(Date.now() + 2);
    expect(await estimateRunEta(T1, "engineer")).toMatchObject({ p50_ms: 30_000 });
    expect(h.reads).toHaveLength(2);
  });

  it("never serves one tenant's stats to another, nor one agent's to another", async () => {
    h.rows.set(`${T1}:engineer`, runs(6, 90_000));
    h.rows.set(`${T2}:engineer`, runs(6, 10_000));
    h.rows.set(`${T1}:research`, runs(6, 500_000));
    expect((await estimateRunEta(T1, "engineer")).p50_ms).toBe(90_000);
    expect((await estimateRunEta(T2, "engineer")).p50_ms).toBe(10_000);
    expect((await estimateRunEta(T1, "research")).p50_ms).toBe(500_000);
    expect(h.reads).toEqual([
      { tenant: T1, slug: "engineer" },
      { tenant: T2, slug: "engineer" },
      { tenant: T1, slug: "research" },
    ]);
  });

  it("a prefetch and the dispatcher's read share one in-flight query", async () => {
    h.rows.set(`${T1}:engineer`, runs(6, 90_000));
    let release!: () => void;
    h.gate = new Promise<void>((r) => { release = r; });
    const prefetch = estimateRunEta(T1, "engineer");
    const dispatcher = estimateRunEta(T1, "engineer");
    release();
    expect(await dispatcher).toEqual(await prefetch);
    expect(h.reads).toHaveLength(1);
  });

  it("a failed read falls back to the fleet default and is NOT cached", async () => {
    h.rows.set(`${T1}:engineer`, runs(6, 90_000));
    h.failNext = 1;
    const fallback = await estimateRunEta(T1, "engineer");
    expect(fallback).toMatchObject({ basis: "fleet_default", p50_ms: FLEET_DEFAULTS_MS.engineer.p50 });
    expect(await estimateRunEta(T1, "engineer")).toMatchObject({ basis: "tenant", p50_ms: 90_000 });
    h.throwNext = 1;
    clearRunEtaCache();
    expect(await estimateRunEta(T1, "engineer")).toMatchObject({ basis: "fleet_default" });
    expect(await estimateRunEta(T1, "engineer")).toMatchObject({ basis: "tenant" });
    expect(h.reads).toHaveLength(4);
  });

  it("a caller waiting on a read that fails retries instead of keeping the fallback", async () => {
    h.rows.set(`${T1}:engineer`, runs(6, 90_000));
    let release!: () => void;
    h.gate = new Promise<void>((r) => { release = r; });
    h.failNext = 1;
    const a = estimateRunEta(T1, "engineer");
    const b = estimateRunEta(T1, "engineer");
    release();
    expect(await a).toMatchObject({ basis: "fleet_default" });
    expect(await b).toMatchObject({ basis: "tenant" });
  });

  it("never rejects", async () => {
    h.throwNext = 5;
    await expect(estimateRunEta(T1, "engineer")).resolves.toMatchObject({ basis: "fleet_default" });
  });
});
