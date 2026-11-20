import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ blob: {} as Record<string, unknown> }));
vi.mock("@/services/supabase", () => {
  const q: Record<string, unknown> = {
    select: () => q,
    eq: () => q,
    maybeSingle: () => ({ data: { blob: h.blob }, error: null }),
  };
  return { serviceClient: () => ({ from: () => q }) };
});

import { parseVerdict, isRunScoringEnabled } from "../run-scorer";

describe("run-scorer parseVerdict", () => {
  it("parses a clean minified verdict", () => {
    expect(parseVerdict('{"score":87,"rationale":"solid"}')).toEqual({
      score: 87,
      rationale: "solid",
    });
  });

  it("extracts the object from prose/fences", () => {
    const v = parseVerdict('Here you go:\n```json\n{"score": 42, "rationale": "thin"}\n```');
    expect(v?.score).toBe(42);
    expect(v?.rationale).toBe("thin");
  });

  it("clamps out-of-range + rounds", () => {
    expect(parseVerdict('{"score":140,"rationale":"x"}')?.score).toBe(100);
    expect(parseVerdict('{"score":0,"rationale":"x"}')?.score).toBe(1);
    expect(parseVerdict('{"score":73.6,"rationale":"x"}')?.score).toBe(74);
  });

  it("returns null on non-numeric / unparseable", () => {
    expect(parseVerdict('{"score":"high"}')).toBeNull();
    expect(parseVerdict("no json here")).toBeNull();
    expect(parseVerdict("")).toBeNull();
  });

  it("tolerates a missing rationale", () => {
    expect(parseVerdict('{"score":55}')).toEqual({ score: 55, rationale: "" });
  });
});

describe("run-scorer kill flag", () => {
  beforeEach(() => {
    h.blob = {};
  });
  it("default (absent) → enabled", async () => {
    h.blob = {};
    expect(await isRunScoringEnabled()).toBe(true);
  });
  it("explicit false → disabled", async () => {
    h.blob = { run_scoring_enabled: false };
    expect(await isRunScoringEnabled()).toBe(false);
  });
  it("explicit true → enabled", async () => {
    h.blob = { run_scoring_enabled: true };
    expect(await isRunScoringEnabled()).toBe(true);
  });
});
