
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AGENT_MD = readFileSync(join(__dirname, "..", "agent.md"), "utf-8");

describe("chief-of-staff prompt — the soup scaffolding stays deleted", () => {
  it('does not prescribe an "At a glance" block', () => {
    expect(AGENT_MD).not.toMatch(/At a glance/i);
  });

  it("does not cap the opening at a line count (the cap is what made it soup)", () => {
    expect(AGENT_MD).not.toMatch(/≤\s*5 lines|<=\s*5 lines|max(imum)? 5 lines/i);
  });

  it('does not tell the agent to "compress aggressively"', () => {
    expect(AGENT_MD).not.toMatch(/compress aggressively/i);
  });

  it("does not order tier vocabulary into founder-facing prose", () => {
    expect(AGENT_MD).not.toMatch(/Tiers 3-4|Tiers 3–4/);
  });
});

describe("chief-of-staff prompt — tiers rank, they do not talk", () => {
  it("still defines the 4-tier ranking (the structured fields need it)", () => {
    expect(AGENT_MD).toMatch(/## The 4-tier ordering/);
    expect(AGENT_MD).toMatch(/tier1/);
  });

  it("says the tiers are internal machinery, not words the founder reads", () => {
    expect(AGENT_MD).toMatch(/Rank in tiers; write in English\./);
  });

  it("still forbids explaining the internal envelope", () => {
    expect(AGENT_MD).toMatch(/Internal machinery — never explain how you work/);
  });
});

describe("chief-of-staff prompt — what the digest must still do", () => {
  it("still leads with what needs the founder", () => {
    expect(AGENT_MD).toMatch(/Lead with the thing that needs a decision/i);
  });

  it("still points at the real approvals route and forbids the invented one", () => {
    expect(AGENT_MD).toMatch(/workspace\?agent=chief-of-staff/);
    expect(AGENT_MD).toMatch(/never invent a per-item/i);
  });

  it("still writes for a cold reader", () => {
    expect(AGENT_MD).toMatch(/reading it cold/i);
  });

  it("keeps the calm-day contract (a quiet digest is calibration, not failure)", () => {
    expect(AGENT_MD).toMatch(/calm-day contract/i);
    expect(AGENT_MD).toMatch(/SIGNAL OF CALIBRATION/);
  });
});

describe("chief-of-staff prompt — no instructions to fill a dead field", () => {
  it("does not ask the model to emit accountability[]", () => {
    expect(AGENT_MD).not.toMatch(/`accountability\[\]`/);
    expect(AGENT_MD).not.toMatch(/"accountability":/);
  });

  it("still keeps weekly_priorities (this one IS persisted)", () => {
    expect(AGENT_MD).toMatch(/`weekly_priorities\[\]`/);
  });

  it("keeps the ledger reasoning the dead field hung off", () => {
    expect(AGENT_MD).toMatch(/never call a rejected dispatch a miss/i);
    expect(AGENT_MD).toMatch(/Misses are loud/);
  });
});
