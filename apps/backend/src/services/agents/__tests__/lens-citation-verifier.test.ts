import { describe, it, expect } from "vitest";
import {
  checkLensCitation,
  isJudgmentClassOutput,
  LENS_CITATION_AGENTS,
} from "../lens-citation-verifier";

const DIGEST_BODY =
  "## Funnel diagnosis\nThe binding constraint this run is activation. " +
  "Below are the Tier 1 bets I recommend, ordered by lever lift. " +
  "Bet: rebalance budget toward the converting geo and hold the rest. " +
  "Rationale: the diagnosis shows a clear leak at the activation stage. ".repeat(4);

describe("lens-citation-verifier (advisory soft check)", () => {
  it("is dormant — no agent is gated (Move 2 dropped, NO-GO eval 2026-07-08)", () => {
    expect(LENS_CITATION_AGENTS.size).toBe(0);
    expect(LENS_CITATION_AGENTS.has("growth-lead")).toBe(false);
    expect(LENS_CITATION_AGENTS.has("performance-marketer")).toBe(false);
  });

  it("skips a short lookup / greeting (not judgment-class)", () => {
    expect(isJudgmentClassOutput("Your CAC is $42.")).toBe(false);
    const r = checkLensCitation("growth-lead", "Hi! Your CAC is $42.");
    expect(r.judgmentClass).toBe(false);
    expect(r.cited).toBe(false);
  });

  it("marks a substantive digest as judgment-class", () => {
    expect(isJudgmentClassOutput(DIGEST_BODY)).toBe(true);
  });

  it("detects an uncited judgment-class growth reply", () => {
    const r = checkLensCitation("growth-lead", DIGEST_BODY);
    expect(r.judgmentClass).toBe(true);
    expect(r.cited).toBe(false);
    expect(r.hitCount).toBe(0);
  });

  it("counts distinct named growth lenses cited", () => {
    const reply =
      DIGEST_BODY +
      "\nBy the Leaky-bucket rule, fix activation before acquisition. " +
      "The AARRR funnel puts the constraint at activation, and CAC:LTV is still under 3:1.";
    const r = checkLensCitation("growth-lead", reply);
    expect(r.cited).toBe(true);
    expect(r.hitCount).toBe(3);
  });

  it("detects paid-media lens citations (MER, below-click)", () => {
    const reply =
      DIGEST_BODY +
      "\nJudge on MER, not platform ROAS. This is a below-click leak — the ad works, don't cut it.";
    const r = checkLensCitation("performance-marketer", reply);
    expect(r.cited).toBe(true);
    expect(r.hitCount).toBeGreaterThanOrEqual(2);
  });

  it("returns no hits for an agent with no lens table", () => {
    const r = checkLensCitation("engineer", DIGEST_BODY);
    expect(r.cited).toBe(false);
    expect(r.hitCount).toBe(0);
  });
});
