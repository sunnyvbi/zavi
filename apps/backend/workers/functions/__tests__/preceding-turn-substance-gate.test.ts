import { describe, it, expect } from "vitest";
import { precedingTurnChunks, precedingTurnEarnsDelivery } from "../_reply-format";
import { scrubTransientFailurePhrases } from "@/services/agents/scrub-agent-egress";

const LEAKED_PRECEDING = [
  "No hits on `carUnavailableDates` in either frontend. Let me search with broader terms.",
  "Files are large. Reading targeted sections in parallel.",
  "Search budget exhausted. Reading the located files directly with targeted line ranges.",
];
const LEAKED_FINAL =
  "I've hit my read budget ceiling. Here's a complete, honest picture of what I confirmed vs. what I couldn't reach:";

const REAL_DELIVERABLE = `Found it. The bug is exactly one line, and I can trace it precisely.

**Root cause:** In \`getBlockedOrBookedDates\` (line 867), \`startDate\` is created **without a timezone**, so it uses local server time (UTC in prod):

\`\`\`ts
// Line 867 — BUG
const startDate = moment({ year: yearNumber, month: monthNumber - 1, day: 1 }).startOf('day');
\`\`\`

This means \`cursor\` and \`candidateStart\` iterate in **UTC midnight**, while the host's blackout dates were stored at local midnight, so the comparison is off by the UTC offset for every host outside UTC.`;

describe("preceding-turn substance gate — upcar-ai leak regression", () => {
  it("none of the three leaked preceding turns reach Slack", () => {
    for (const turn of LEAKED_PRECEDING) {
      expect(precedingTurnEarnsDelivery(turn), `must not deliver: ${turn}`).toBe(false);
    }
    const out = precedingTurnChunks([...LEAKED_PRECEDING, LEAKED_FINAL], false, 2800);
    expect(out).toEqual([]);
  });

  it("a genuine long-form deliverable still reaches Slack", () => {
    expect(precedingTurnEarnsDelivery(REAL_DELIVERABLE)).toBe(true);
    const out = precedingTurnChunks([REAL_DELIVERABLE, "final answer turn"], false, 2800);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("getBlockedOrBookedDates");
  });

  it("a real structured deliverable earns delivery below the prose floor", () => {
    const table = [
      "| Charge | Amount | Status | Refunded |",
      "|---|---|---|---|",
      "| ch_3U041MLKcPR2aUso10KZ0u41 | $714.00 | Succeeded | $0 |",
      "| ch_3U03yMLKcPR2aUso0O9qTBOJ | $714.00 | Failed | - |",
    ].join("\n");
    expect(precedingTurnEarnsDelivery(table)).toBe(true);
  });

  it("STRUCTURE IS NOT A FREE PASS — short bulleted/fenced self-narration stays blocked", () => {
    expect(
      precedingTurnEarnsDelivery(
        "Checking three things:\n- the payout record\n- the connected account\n- the webhook log",
      ),
    ).toBe(false);
    expect(precedingTurnEarnsDelivery('Got this back:\n```\n{"total":0}\n```\nLet me widen the query.')).toBe(false);
  });

  it("a bare status ping never delivers, however it is phrased", () => {
    expect(precedingTurnEarnsDelivery("Re-checking now.")).toBe(false);
    expect(precedingTurnEarnsDelivery("Retrying with a shorter filename.")).toBe(false);
    expect(precedingTurnEarnsDelivery("Very tight budget — smallest possible read.")).toBe(false);
    expect(precedingTurnEarnsDelivery("On it — digging in now, ~10m. PR incoming.")).toBe(false);
  });

  it("the FINAL turn's read-budget narration is rewritten, not published", () => {
    const r = scrubTransientFailurePhrases(LEAKED_FINAL);
    expect(r.hits).toBeGreaterThan(0);
    expect(r.text).not.toMatch(/read budget/i);
    expect(r.text).not.toMatch(/ceiling/i);
    expect(r.text).toContain("what I confirmed vs. what I couldn't reach");
  });

  it("read/search/tool budget phrasings all collapse to one neutral caveat", () => {
    for (const s of [
      "I've hit my read budget ceiling.",
      "I hit the search budget limit.",
      "We reached our tool budget cap.",
      "I ran into the rate limit.",
    ]) {
      expect(scrubTransientFailurePhrases(s).hits, s).toBeGreaterThan(0);
    }
  });
});
