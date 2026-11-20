
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { loadCoreInheritedBlocks, withShapePacks } from "@/services/agents/generic-dispatcher";

const RAW = readFileSync(join(__dirname, "..", "agent.md"), "utf-8");

const INHERITS: string[] =
  (matter(RAW).data as { metadata?: { praxis?: { inherits?: string[] } } })
    .metadata?.praxis?.inherits ?? [];
const AGENT_MD = loadCoreInheritedBlocks(INHERITS) + "\n" + RAW;
const MARKETPLACE_MD = loadCoreInheritedBlocks(withShapePacks(INHERITS, "marketplace")) + "\n" + RAW;

describe("performance-marketer prompt — grounding-before-scale", () => {
  it("has the ground-unit-economics-before-spend section", () => {
    expect(AGENT_MD).toMatch(/Ground the unit economics BEFORE you judge spend/);
  });
  it("instructs using the grounding reads early in any scaling/CAC question", () => {
    expect(AGENT_MD).toMatch(/use them early in any diagnosis \/ scaling/i);
  });
});

describe("performance-marketer prompt — pixel-health early", () => {
  it("requires calling pixel_health early", () => {
    expect(AGENT_MD).toMatch(/pixel_health[\s\S]*?early/i);
  });
});

describe("performance-marketer prompt — sample floor is Meta-pixel purchases", () => {
  it("requires every RAISE rationale to state n=X purchases", () => {
    expect(AGENT_MD).toContain("n=X purchases");
  });
  it("pins the n>=10 floor to Meta pixel purchases, NOT verified bookings", () => {
    expect(AGENT_MD).toMatch(/Meta pixel purchases[\s\S]*?NOT verified bookings/i);
  });
});

describe("performance-marketer prompt — pixel-vs-verified side-by-side, no blend", () => {
  it("requires rendering pixel-reported vs verified side by side", () => {
    expect(AGENT_MD).toMatch(/side by side/i);
  });
  it("bans blending the two measurements", () => {
    expect(AGENT_MD).toMatch(/NEVER blend/);
  });
  it("requires the per-campaign coverage %", () => {
    expect(AGENT_MD).toMatch(/coverage %/);
  });
});

describe("performance-marketer prompt — verified is a confidence signal, investigate not cut", () => {
  it("says verified is NOT the ranker (pixel ROAS stays the ranker)", () => {
    expect(AGENT_MD).toMatch(/Pixel ROAS stays the ranker/i);
  });
  it("says pixel-high + verified-low means investigate attribution, not cut", () => {
    expect(AGENT_MD).toMatch(/investigate attribution/i);
    expect(AGENT_MD).toMatch(/NOT "cut/);
  });
});

describe("performance-marketer prompt — blind-spots honesty footer", () => {
  it("requires a Blind spots section naming what wasn't seen", () => {
    expect(AGENT_MD).toMatch(/### Blind spots/);
    expect(AGENT_MD).toMatch(/what you could NOT see this run/i);
  });
});

describe("performance-marketer prompt — constraint-first growth mandate", () => {
  it("has the Constraint-first growth mandate section", () => {
    expect(AGENT_MD).toMatch(/## Constraint-first growth mandate/);
  });
  it("requires establishing the binding constraint before any spend", () => {
    expect(AGENT_MD).toMatch(/binding constraint/i);
    expect(MARKETPLACE_MD).toMatch(/demand-limited/);
    expect(MARKETPLACE_MD).toMatch(/supply-limited/);
  });
  it("states the never-supply-into-no-demand hard rule (no-demand-expansion)", () => {
    expect(MARKETPLACE_MD).toMatch(/NEVER propose supply-side or new-geo/);
    expect(MARKETPLACE_MD).toMatch(/without DEMAND evidence/);
    expect(MARKETPLACE_MD).toMatch(/no-demand-expansion rule/);
  });
  it("carves out operator-typed commands (mandate must not gate an authorized command)", () => {
    expect(AGENT_MD).toMatch(/CARVE-OUT/);
    expect(AGENT_MD).toMatch(/does NOT gate an explicit operator-typed command/i);
    expect(AGENT_MD).toMatch(/NEVER delay or refuse an authorized command/i);
  });
  it("the two-sided wording reaches a marketplace only; every other shape gets the core", () => {
    for (const shape of ["saas", "services", "other", null] as const) {
      const md = loadCoreInheritedBlocks(withShapePacks(INHERITS, shape)) + "\n" + RAW;
      expect(md).not.toMatch(/demand-limited|no-demand-expansion rule/);
      expect(md).toMatch(/## Constraint-first growth mandate/);
    }
  });
  it("scopes the default-to-hold to supply-side / new-geo / expansion only", () => {
    expect(MARKETPLACE_MD).toMatch(/applies ONLY to SUPPLY-SIDE \/ NEW-GEO \/ EXPANSION/);
    expect(MARKETPLACE_MD).toMatch(/does NOT block normal in-market OPTIMIZATION/i);
  });
});

describe("performance-marketer prompt — the paid core is actually inherited", () => {
  it("declares paid-channel in inherits", () => {
    expect(INHERITS).toContain("paid-channel");
  });
  it("the assembled prompt carries the core, not just the agent body", () => {
    expect(AGENT_MD).toMatch(/Paid channel — the discipline every ad platform shares/);
  });
});

describe("performance-marketer prompt — money guards (previously unasserted)", () => {
  it("pins the >$500 net-new weekly approval gate", () => {
    expect(AGENT_MD).toMatch(/more than \$500 net-new weekly spend without the explicit\s+approval gate/i);
  });
  it("pins the no-pause-without-7-day-trailing-data rule", () => {
    expect(AGENT_MD).toMatch(/[Nn]ever recommend pausing a line without 7-day-trailing data/);
  });
  it("pins the n>=10 raise floor", () => {
    expect(AGENT_MD).toMatch(/10 attributed conversions in the ranking window/);
    expect(AGENT_MD).toMatch(/re-check at n\u226510/);
  });
  it("pins the +30% step cap with its +$10/day floor", () => {
    expect(AGENT_MD).toMatch(/max\(\+30% of current daily, \+\$10\/day\)/);
  });
  it("pins underspend-is-not-a-budget-problem", () => {
    expect(AGENT_MD).toMatch(/Underspend is NOT a budget problem/);
  });
  it("keeps verified conversions OUT of the floor, the cap and the gate", () => {
    expect(AGENT_MD).toMatch(
      /[Vv]erified conversions never feed the n\u226510 floor, the step cap, or the\s+approval\s+gate/,
    );
  });
});
