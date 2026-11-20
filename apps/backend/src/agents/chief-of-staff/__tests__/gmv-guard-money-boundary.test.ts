import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { detectConnectorAbsenceClaims } from "@/services/agents/negative-existence-grounding-verifier";

import { UNAVAILABLE, scrubUngroundedRevenue } from "../gmv-guard";

function scrubLine(line: string): string {
  const digest = { rendered_markdown: line };
  scrubUngroundedRevenue(digest);
  return digest.rendered_markdown;
}

describe("MONEY_RX does not eat the following word (bug 1)", () => {
  const cases: Array<[string, string]> = [
    ["**Revenue:** $53 May to $84 July", "May"],
    ["**Revenue:** $714 Monday refund", "Monday"],
    ["**Liquidity:** $12 kayak fee", "kayak"],
    ["**Revenue:** $5 MRR baseline", "MRR"],
    ["**GMV:** $27 March cohort", "March"],
  ];

  for (const [input, survivingWord] of cases) {
    it(`keeps "${survivingWord}" intact in: ${input}`, () => {
      const out = scrubLine(input);
      expect(out).toContain(survivingWord);
      expect(out).toContain(UNAVAILABLE);
      expect(out).not.toMatch(/\$\s?\d/);
    });
  }

  it("reproduces the exact prod corruption shape and no longer produces it", () => {
    const out = scrubLine("**Revenue-per-signup:** $53 May to $84 July");
    expect(out).not.toMatch(new RegExp(`${UNAVAILABLE}[a-z]`));
    expect(out).toBe(
      `**Revenue-per-signup:** ${UNAVAILABLE} May to ${UNAVAILABLE} July`,
    );
  });
});

describe("MONEY_RX still strips whole money tokens (no under-strip — bug 3)", () => {
  const mustFullyStrip = [
    "$100K/mo",
    "$1.2M",
    "$23k/wk",
    "$100,000",
    "$94.2k",
    "$53 M",
    "$5 million",
    "$5 million/mo",
    "$5 billion",
    "$2 thousand",
    "$3 trillion",
    "$4 millions",
  ];

  for (const token of mustFullyStrip) {
    it(`fully strips ${token}`, () => {
      const out = scrubLine(`**Revenue:** ${token} this month`);
      expect(out).toBe(`**Revenue:** ${UNAVAILABLE} this month`);
      expect(out).not.toMatch(/\d/);
      expect(out).not.toMatch(/thousand|million|billion|trillion/i);
    });
  }
});

describe("the placeholder no longer manufactures a connector-absence claim (bug 2)", () => {
  const sentence = (placeholder: string) =>
    `One ${placeholder} platform payout was canceled Jul 28 with no failure code (worth a quick Stripe look).`;

  it("the OLD phrase tripped the connector-absence verifier (documents the bug)", () => {
    const claims = detectConnectorAbsenceClaims(
      sentence("unavailable (DB not connected)"),
    );
    expect(claims.map((c) => c.connector)).toContain("stripe");
  });

  it("the NEW phrase does not", () => {
    const claims = detectConnectorAbsenceClaims(sentence(UNAVAILABLE));
    expect(claims).toHaveLength(0);
  });

  it("the phrase asserts no cause at all", () => {
    expect(UNAVAILABLE).not.toMatch(/connect|disconnect|db\b|database/i);
  });

  it("a genuinely-absent-connector sentence STILL trips the verifier", () => {
    const claims = detectConnectorAbsenceClaims(
      "Your Stripe account is not connected, so I could not pull payouts.",
    );
    expect(claims.map((c) => c.connector)).toContain("stripe");
  });
});

describe("guard still does what it existed to do", () => {
  it("leaves the company-anchor header figure alone (not a metric slot)", () => {
    const header = "**Day 14+ | ~600 hosts · ~$100K/mo GMV · 5 US states**";
    expect(scrubLine(header)).toBe(header);
  });

  it("scrubs a tier2 revenue metric value", () => {
    const digest = { tier2: [{ metrics: { gmv: "$100K/mo" } }] };
    const subs = scrubUngroundedRevenue(digest);
    expect(subs).toBe(1);
    expect(digest.tier2[0].metrics.gmv).toBe(UNAVAILABLE);
  });

  it("leaves a non-revenue line untouched", () => {
    const line = "**Support tickets:** 14 open, 3 over SLA";
    expect(scrubLine(line)).toBe(line);
  });
});

describe("prompt and code teach the same phrase (desync would re-open the P0)", () => {
  it("agent.md uses the exported constant and not the retired phrase", () => {
    const md = readFileSync(join(__dirname, "..", "agent.md"), "utf-8");
    expect(md).toContain(UNAVAILABLE);
    expect(md).not.toContain("unavailable (DB not connected)");
  });
});
