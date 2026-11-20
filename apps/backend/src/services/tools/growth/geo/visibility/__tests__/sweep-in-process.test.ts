
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({ tables: {} as Record<string, Array<Record<string, unknown>>> }));

vi.mock("@/services/settings", () => ({
  getBoolSetting: async () => true,
  getNumberSetting: async () => 3,
  getStringSetting: async () => "",
}));

vi.mock("@/services/tenant-client", () => {
  function builder(table: string, tenant: string) {
    const rows = (db.tables[table] ??= []);
    const filters: Array<(r: Row) => boolean> = [(r) => r.tenant_id === tenant];
    let op: { kind: "select" } | { kind: "update"; values: Row } | { kind: "upsert"; rows: Row[] } = { kind: "select" };
    const match = () => rows.filter((r) => filters.every((f) => f(r)));
    const run = () => {
      if (op.kind === "update") {
        const hit = match();
        for (const r of hit) Object.assign(r, op.values);
        return { data: hit, error: null };
      }
      if (op.kind === "upsert") {
        for (const r of op.rows) {
          const dup = rows.some(
            (x) =>
              x.tenant_id === tenant &&
              x.sweep_id === r.sweep_id &&
              x.prompt_id === r.prompt_id &&
              x.engine === r.engine &&
              x.repeat_index === r.repeat_index,
          );
          if (!dup) rows.push({ ...r, tenant_id: tenant });
        }
        return { data: null, error: null };
      }
      return { data: match(), error: null };
    };
    const b = {
      select: () => b,
      eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), b),
      in: (col: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[col])), b),
      update: (values: Row) => ((op = { kind: "update", values }), b),
      upsert: (rs: Row[]) => ((op = { kind: "upsert", rows: rs }), b),
      maybeSingle: () => Promise.resolve({ data: match()[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
    };
    return b;
  }
  return {
    asTenantId: (t: string) => t,
    tenantClient: (tid: string) => ({ from: (table: string) => builder(table, tid) }),
    tenantRpc: vi.fn(),
    preTenantRpc: vi.fn(),
  };
});

import { runSweepInProcess } from "../sweep";
import type { EngineAnswer } from "../dataforseo";

const TID = "11111111-1111-1111-1111-111111111111";

function seedSweep(): void {
  db.tables = {
    geo_prompt_sweeps: [
      {
        id: "s1",
        tenant_id: TID,
        status: "running",
        country: "US",
        location_code: 2840,
        language_code: "en",
        brand: "Upcar",
        owned_domains: ["upcar.ai"],
        rivals: ["Turo"],
        rival_set_hash: "r",
        engines: ["chatgpt", "claude", "gemini", "perplexity"],
        repeats: 3,
        prompts: [{ id: "p1", text: "best car rental app", source: "zavi" }],
        prompt_set_hash: "p",
        responses_planned: 12,
        started_at: "2026-09-21T05:00:00Z",
        finished_at: null,
      },
    ],
    geo_prompt_responses: [],
  };
}

const answer = (text: string, cited: string[] = []): EngineAnswer => ({
  ok: true,
  text,
  citations: cited.map((url) => ({ url, title: null, domain: null })),
  fan_out_queries: [],
  model: "m",
  cost_usd: 0.01,
  data_source: "dataforseo.llm_scraper",
});

beforeEach(seedSweep);

describe("runSweepInProcess", () => {
  it("asks every slot, stores the answers, and finalizes the sweep WITH metrics", async () => {
    const ask = vi.fn(async (engine: { id: string }) =>
      engine.id === "claude"
        ? answer("Turo is the biggest option.")
        : answer("Upcar is the best pick for hourly rentals.", ["https://upcar.ai/pricing"]),
    );
    const r = await runSweepInProcess(TID, "s1", { ask: ask as never });

    expect(ask).toHaveBeenCalledTimes(12);
    expect(r).toEqual({ status: "complete", collected: 12, failed: 0 });
    const sweep = db.tables.geo_prompt_sweeps[0];
    expect(sweep.status).toBe("complete");
    const m = sweep.metrics as { mention_rate: { rate: number }; citation_rate: { rate: number }; share_of_voice: { share: number } };
    expect(m.mention_rate.rate).toBe(0.75);
    expect(m.citation_rate.rate).toBe(0.75);
    expect(m.share_of_voice.share).toBe(0.75);
  });

  it("finalizes as partial when some calls fail — the rates stand on what was collected", async () => {
    let n = 0;
    const ask = vi.fn(async (): Promise<EngineAnswer> =>
      ++n <= 4
        ? { ok: false, error_code: "dataforseo_40200", cost_usd: null, data_source: "dataforseo.llm_scraper" }
        : answer("Upcar works."),
    );
    const r = await runSweepInProcess(TID, "s1", { ask: ask as never });
    expect(r).toEqual({ status: "partial", collected: 8, failed: 4 });
    expect(db.tables.geo_prompt_sweeps[0].status).toBe("partial");
  });

  it("never asks a slot twice", async () => {
    const ask = vi.fn(async () => answer("Upcar."));
    await runSweepInProcess(TID, "s1", { ask: ask as never });
    db.tables.geo_prompt_sweeps[0].status = "running";
    await runSweepInProcess(TID, "s1", { ask: ask as never });
    expect(ask).toHaveBeenCalledTimes(12);
  });

  it("does nothing for a sweep that is no longer running", async () => {
    db.tables.geo_prompt_sweeps[0].status = "failed";
    const ask = vi.fn();
    await expect(runSweepInProcess(TID, "s1", { ask: ask as never })).resolves.toMatchObject({ status: "skipped" });
    expect(ask).not.toHaveBeenCalled();
  });
});
