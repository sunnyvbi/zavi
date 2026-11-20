import { describe, it, expect, vi } from "vitest";
import { runSeedCard, type SeedStages } from "../run-card";

const outcome = (points: number) => async () => ({ evidence: { ok: true }, points, max_points: 20, cost_usd: 0.05 });

function stages(): SeedStages {
  return {
    profile: vi.fn(async () => ({ evidence: { company_name: "A", search_term: "x", country: "US", rivals: [] }, cost_usd: 0.1 })),
    google: vi.fn(outcome(10)),
    ai: vi.fn(outcome(5)),
    seo: vi.fn(outcome(14)),
    design: vi.fn(outcome(12)),
    compare: vi.fn(outcome(20)),
    diagnosis: vi.fn(async () => ({ evidence: {}, cost_usd: 0.01 })),
  } as unknown as SeedStages;
}

const deps = () => ({
  runStage: vi.fn(async (key: string, fn: (c: never) => Promise<{ evidence: unknown; points?: number; cost_usd: number }>, ctx: never) => {
    const o = await fn(ctx);
    return { part: { state: "done", evidence: o.evidence, points: o.points, fetched_at: null }, cost_usd: o.cost_usd };
  }),
  applyProfile: vi.fn(async () => undefined),
  saveScore: vi.fn(async () => undefined),
});

describe("runSeedCard", () => {
  it("runs every stage once, in the worker's order, and scores the checks", async () => {
    const s = stages();
    const d = deps();
    const r = await runSeedCard({ id: "c", domain: "a.com", locale: "US", parts: {} } as never, s, d as never);
    expect(r.score).toMatchObject({ total: 61, out_of: 100 });
    expect(d.runStage.mock.calls.map((c) => c[0])).toEqual(["profile", "google", "ai", "seo", "design", "compare", "diagnosis"]);
    expect(r.cost_usd).toBeCloseTo(0.36, 4);
  });
  it("on resume, parts already done are kept and their stages are not run (no double spend)", async () => {
    const s = stages();
    const d = deps();
    const done = (points: number) => ({ state: "done", evidence: {}, points, fetched_at: null });
    const parts = { profile: { state: "done", evidence: { company_name: "A", search_term: "x", country: "US", rivals: [] }, fetched_at: null }, google: done(10), ai: done(5) };
    const r = await runSeedCard({ id: "c", domain: "a.com", locale: "US", parts } as never, s, d as never);
    expect(d.runStage.mock.calls.map((c) => c[0])).toEqual(["seo", "design", "compare", "diagnosis"]);
    expect(s.profile).not.toHaveBeenCalled();
    expect(r.score.total).toBe(61);
  });
});

describe("resume keeps downstream stages fresh", () => {
  it("compare and diagnosis are redone when an earlier stage ran again", async () => {
    const s = stages();
    const d = deps();
    const done = (points: number) => ({ state: "done", evidence: {}, points, fetched_at: null });
    const parts = {
      profile: { state: "done", evidence: { company_name: "A", search_term: "x", country: "US", rivals: [] }, fetched_at: null },
      google: done(10), ai: done(5), seo: { state: "unavailable", evidence: null, fetched_at: null }, design: done(12), compare: done(20), diagnosis: done(0),
    };
    await runSeedCard({ id: "c", domain: "a.com", locale: "US", parts } as never, s, d as never);
    expect(d.runStage.mock.calls.map((c) => c[0])).toEqual(["seo", "compare", "diagnosis"]);
  });
  it("nothing runs when every part is done", async () => {
    const d = deps();
    const done = (points: number) => ({ state: "done", evidence: {}, points, fetched_at: null });
    const parts = { profile: { state: "done", evidence: { company_name: "A", search_term: "x", country: "US", rivals: [] }, fetched_at: null }, google: done(1), ai: done(1), seo: done(1), design: done(1), compare: done(1), diagnosis: done(0) };
    await runSeedCard({ id: "c", domain: "a.com", locale: "US", parts } as never, stages(), d as never);
    expect(d.runStage).not.toHaveBeenCalled();
  });
});

import { seedStages, localSavingsUsd } from "../run-card";
import { StageUnavailableError } from "../../stages";
describe("local work is not charged to the seed run", () => {
  it("the model and render estimates are taken back out, never below zero", async () => {
    const st = seedStages({ complete: async () => "{}", enrichment: async () => "{}", render: async () => null });
    expect(localSavingsUsd("profile", { complete: 0, enrichment: 0 })).toBe(0);
    expect(localSavingsUsd("profile", { complete: 1, enrichment: 4 })).toBeCloseTo(0.085, 6);
    expect(localSavingsUsd("google", { complete: 1, enrichment: 0 })).toBeCloseTo(0.005, 6);
    expect(localSavingsUsd("google", { complete: 0, enrichment: 0 })).toBe(0);
    const err = await st.design({ card_id: "c", domain: "a.com", url: "https://a.com/", profile: null, parts: {}, visitor_country: null } as never).catch((e) => e);
    expect(err).toBeInstanceOf(StageUnavailableError);
    expect((err as StageUnavailableError).cost_usd).toBe(0);
  });
});
