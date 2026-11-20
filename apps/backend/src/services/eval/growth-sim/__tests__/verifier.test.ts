import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));

import labels from "../sheets/verifier-labels.json";
import { CAUSAL_DENTAL } from "../causal-scenarios";
import { runScenario } from "../loop";
import { REFERENCE_AGENTS } from "../reference-agents";
import { VERIFIER_PROMPT, classifyBoth, combine, parseLabels, verifyPrompt, withVerifier, type Classifier } from "../verifier";
import type { CausalSpec } from "../types";

const answers = (xs: string[]): Classifier => async () => xs.map((x, i) => `${i + 1}: ${x}`).join("\n");

describe("move verifier", () => {
  it("the prompt is the frozen one (re-run verify-check before changing it)", () => {
    expect(createHash("sha256").update(VERIFIER_PROMPT).digest("hex")).toBe(
      "2ff9f45e8e3866180d72750aa627e164756a999c9be9b1e7becacd0a3e9090ea",
    );
  });

  it("never shows the model cgo's tag", () => {
    const p = verifyPrompt([{ agent: "engineer", intent: "Fix the booking form" }]);
    expect(p).toContain("1. (engineer) Fix the booking form");
    expect(p).not.toMatch(/declared|problem: conversion/);
  });

  it("parses n: label lines; a missing or unknown answer is ambiguous", () => {
    expect(parseLabels("1: traffic\n2) Conversion\nnoise\n3: vibes", 4)).toEqual(["traffic", "conversion", "ambiguous", "ambiguous"]);
  });

  it("matches when both, or one while the other is unsure, name the declared problem", () => {
    expect(combine("conversion", "conversion", "conversion")).toBe("match");
    expect(combine("conversion", "conversion", "ambiguous")).toBe("match");
    expect(combine("conversion", "ambiguous", "conversion")).toBe("match");
    expect(combine("conversion", "traffic", "traffic")).toBe("mismatch");
    expect(combine("conversion", "traffic", "ambiguous")).toBe("mismatch");
    expect(combine("conversion", "conversion", "traffic")).toBe("ambiguous");
    expect(combine("conversion", "ambiguous", "ambiguous")).toBe("ambiguous");
  });

  it("the answer key covers 30 moves, each labelled from the list", () => {
    expect(labels.items).toHaveLength(30);
    for (const it of labels.items) expect(["traffic", "conversion", "activation", "retention", "offer", "tracking", "channel", "other", "ambiguous"]).toContain(it.label);
  });

  it("classifyBoth sends one prompt per model and returns a pair per move", async () => {
    const out = await classifyBoth([{ agent: "a", intent: "x" }, { agent: "b", intent: "y" }], answers(["traffic", "tracking"]), answers(["traffic", "channel"]));
    expect(out).toEqual([["traffic", "traffic"], ["tracking", "channel"]]);
  });

  it("a move the verifiers read as another problem does the work its words describe, and counts as a mislabel", async () => {
    const spec = CAUSAL_DENTAL.causal as CausalSpec;
    const always = (label: string): Classifier => async (p) =>
      p.split("\n").filter((l) => /^\d+\. /.test(l)).map((_, i) => `${i + 1}: ${label}`).join("\n");
    const log = await runScenario(CAUSAL_DENTAL, { seed: 1, arm: "with", adapter: withVerifier(REFERENCE_AGENTS.perfect(spec), always("channel"), always("channel")) });
    expect(log.final.jobs.length).toBeGreaterThan(0);
    expect(log.final.jobs.every((j) => j.problem === "channel")).toBe(true);
    expect(log.final.conversion).toBe(spec.conversion.current);
    const moves = log.days.flatMap((d) => d.applied?.moves ?? []);
    expect(moves[0]).toMatchObject({ declared: "conversion", verdict: "mismatch", verifiers: ["channel", "channel"], problem: "channel" });

    const unsure = await runScenario(CAUSAL_DENTAL, { seed: 1, arm: "with", adapter: withVerifier(REFERENCE_AGENTS.perfect(spec), always("ambiguous"), always("ambiguous")) });
    expect(unsure.final.jobs.filter((j) => j.stage !== "channel").every((j) => j.problem === "conversion")).toBe(true);

    const ok = await runScenario(CAUSAL_DENTAL, { seed: 1, arm: "with", adapter: withVerifier(REFERENCE_AGENTS.perfect(spec), always("conversion"), always("conversion")) });
    expect(ok.final.conversion).toBeCloseTo(spec.conversion.reachable, 10);
  });
});
