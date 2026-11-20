import { describe, it, expect } from "vitest";
import {
  verifyEntityTractionGrounding,
  entityTractionGuardMode,
  ENTITY_TRACTION_VALIDATOR_AGENTS,
} from "../entity-traction-grounding-verifier";
import type { ToolCallTrace } from "@/services/tools/types";

function trace(
  name: string,
  output: string,
  status: ToolCallTrace["status"] = "ok",
): ToolCallTrace {
  return { name, input_preview: "", output_preview: output, ms: 12, status };
}

const INVESTOR_DB_OK =
  '{"rows":[{"name":"Jyoti Bansal","firm":"Unusual Ventures"},{"name":"Elad Gil","firm":"Elad Gil"}]}';

describe("verifyEntityTractionGrounding — ungrounded investor names + traction → soft hedge", () => {
  describe("HEDGES (fabrication with NO grounding tool)", () => {
    it("hedges the incident: invented investor list with no investor_db/web tool", () => {
      const r = verifyEntityTractionGrounding({
        reply:
          "Here are angels to target: 1. **Nat Friedman** (ex-GitHub). 2. **Daniel Gross**. 3. **Naval Ravikant**, AngelList CEO. These are your best raise targets.",
        toolCalls: [trace("memory__search", "{}")],
        userMessage: "raise $1.5M from ~10 angels, give a top list",
      });
      expect(r.hedged).toBe(true);
      expect(r.flags.classes).toContain("named_entity_list");
    });

    it("hedges fabricated traction (pilots / reference customers) for a pre-revenue co", () => {
      const r = verifyEntityTractionGrounding({
        reply:
          "Lead with traction: we have 3 live pilots and 2-3 pilot operators willing to be reference calls. Operators don't go back once they try it.",
        toolCalls: [trace("memory__search", "{}")],
        userMessage: "what should I tell investors",
      });
      expect(r.hedged).toBe(true);
      expect(r.flags.classes).toContain("traction");
    });

    it("hedges a bare 'we have N paying customers' with no operator_db/stripe read", () => {
      const r = verifyEntityTractionGrounding({
        reply: "We have 100 paying customers and 12 design partners signed.",
        toolCalls: [],
        userMessage: "draft an investor update",
      });
      expect(r.hedged).toBe(true);
      expect(r.flags.classes).toContain("traction");
    });

    it("prepends a banner and preserves the original text below", () => {
      const reply =
        "Target these angels: Nat Friedman, Daniel Gross, Elad Gil, Aravind Srinivas — all great fits for the seed.";
      const r = verifyEntityTractionGrounding({
        reply,
        toolCalls: [],
        userMessage: "investor list please",
      });
      expect(r.hedged).toBe(true);
      expect(r.text).toMatch(/Unverified|not.*grounded|illustrative/i);
      expect(r.text).toContain(reply);
    });
  });

  describe("DOES NOT HEDGE (true / grounded / hypothetical)", () => {
    it("does NOT hedge investor names that came from investor_db this run", () => {
      const r = verifyEntityTractionGrounding({
        reply:
          "From the investor database: **Jyoti Bansal** (Unusual Ventures) and **Elad Gil** are strong seed fits for your raise.",
        toolCalls: [trace("investor_db__search", INVESTOR_DB_OK)],
        userMessage: "find me seed investors",
      });
      expect(r.hedged).toBe(false);
    });

    it("does NOT hedge traction numbers grounded in an operator_db read", () => {
      const r = verifyEntityTractionGrounding({
        reply: "You have 100 paying customers as of today's read.",
        toolCalls: [
          trace(
            "operator_db__query",
            '{"rows":[{"paying_customers":100}],"summary":"100 paying customers"}',
          ),
        ],
        userMessage: "how many paying customers do we have",
      });
      expect(r.hedged).toBe(false);
    });

    it("does NOT hedge names the USER supplied in their message", () => {
      const r = verifyEntityTractionGrounding({
        reply:
          "Nat Friedman and Daniel Gross are reasonable people to reach out to, given your ask.",
        toolCalls: [],
        userMessage:
          "should I reach out to Nat Friedman and Daniel Gross for the raise?",
      });
      expect(r.hedged).toBe(false);
    });

    it("does NOT hedge clearly hypothetical / illustrative phrasing", () => {
      const r = verifyEntityTractionGrounding({
        reply:
          "You'd want to target operator-angels — for example, people like ex-Meta product leaders or marketplace founders. Hypothetically, a name such as a well-known dev-tools angel would fit.",
        toolCalls: [],
        userMessage: "what kind of angels should I look for",
      });
      expect(r.hedged).toBe(false);
    });

    it("does NOT hedge an honest 'I can't ground that' refusal", () => {
      const r = verifyEntityTractionGrounding({
        reply:
          "I can't pull a verified customer count this run — Stripe isn't connected, so I won't state a number. We're pre-revenue per the company context.",
        toolCalls: [],
        userMessage: "how many customers do we have",
      });
      expect(r.hedged).toBe(false);
    });

    it("does NOT hedge ordinary ops prose with no entity/traction claim", () => {
      const r = verifyEntityTractionGrounding({
        reply:
          "I filed the Jira ticket and posted a summary to the channel. Want me to follow up on the deploy?",
        toolCalls: [],
        userMessage: "file a ticket for the bug",
      });
      expect(r.hedged).toBe(false);
    });
  });

  describe("mode gating", () => {
    it("defaults to off (dark) when env unset", () => {
      const prev = process.env.ENTITY_TRACTION_GUARD_MODE;
      delete process.env.ENTITY_TRACTION_GUARD_MODE;
      expect(entityTractionGuardMode()).toBe("off");
      if (prev !== undefined) process.env.ENTITY_TRACTION_GUARD_MODE = prev;
    });

    it("reads shadow / hedge from env, falls back to off on garbage", () => {
      const prev = process.env.ENTITY_TRACTION_GUARD_MODE;
      process.env.ENTITY_TRACTION_GUARD_MODE = "shadow";
      expect(entityTractionGuardMode()).toBe("shadow");
      process.env.ENTITY_TRACTION_GUARD_MODE = "hedge";
      expect(entityTractionGuardMode()).toBe("hedge");
      process.env.ENTITY_TRACTION_GUARD_MODE = "banana";
      expect(entityTractionGuardMode()).toBe("off");
      if (prev === undefined) delete process.env.ENTITY_TRACTION_GUARD_MODE;
      else process.env.ENTITY_TRACTION_GUARD_MODE = prev;
    });

    it("scopes to generalist + investor/sales-drafting agents", () => {
      expect(ENTITY_TRACTION_VALIDATOR_AGENTS.has("operator")).toBe(true);
      expect(ENTITY_TRACTION_VALIDATOR_AGENTS.has("advisor")).toBe(true);
      expect(ENTITY_TRACTION_VALIDATOR_AGENTS.has("engineer")).toBe(false);
    });
  });

  describe("illustrative name lists are NOT hedged", () => {
    const illustrative: Array<[string, string]> = [
      [
        "lenders like X, Y, Z",
        "Traditional venture debt lenders like Hercules Capital, Western Technology Investment, and Silicon Valley Bank extend credit to VC-backed companies. You would be locked out as a bootstrapped founder.",
      ],
      [
        "parenthetical example list",
        "Some newer lenders (Lighter Capital, Arc Technologies, Clearco Financing) offer revenue-based products instead. Those do not need prior equity.",
      ],
      [
        "firms such as",
        "Firms such as Bessemer Venture, Insight Partners, and Iconiq Growth publish their benchmarks. Read those before you model anything.",
      ],
    ];
    for (const [label, reply] of illustrative) {
      it(`does NOT hedge: ${label}`, () => {
        const r = verifyEntityTractionGrounding({
          reply,
          toolCalls: [],
          userMessage: "do I need VC equity for venture debt?",
        });
        expect(r.hedged).toBe(false);
      });
    }
  });

  describe("TARGET lists still hedge (illustrative suppression must not open a hole)", () => {
    it("hedges a bare imperative target list", () => {
      const r = verifyEntityTractionGrounding({
        reply: "For the seed round, reach out to Jane Smithson, John Dorner, and Alex Leeward this week.",
        toolCalls: [],
        userMessage: "who should I raise from?",
      });
      expect(r.hedged).toBe(true);
      expect(r.flags.classes).toContain("named_entity_list");
    });

    it("hedges an imperative target list that ALSO says 'like' (P1-b collision)", () => {
      const r = verifyEntityTractionGrounding({
        reply: "Reach out to angels like Nat Friedman, Daniel Gross, and Naval Ravikant for the pre-seed.",
        toolCalls: [],
        userMessage: "who should I raise from?",
      });
      expect(r.hedged).toBe(true);
      expect(r.flags.classes).toContain("named_entity_list");
    });

    it("hedges an imperative target list wrapped in parens (P1-b collision)", () => {
      const r = verifyEntityTractionGrounding({
        reply:
          "Reach out to these angels (Nat Friedman, Daniel Gross, Naval Ravikant) before the round closes.",
        toolCalls: [],
        userMessage: "who should I raise from?",
      });
      expect(r.hedged).toBe(true);
    });

    it.each([
      ["are strong fits", "For your seed round, angels like Nat Friedman, Daniel Gross, and Naval Ravikant are strong fits."],
      ["best bets", "Your best bets for the raise are Nat Friedman, Daniel Gross, and Naval Ravikant."],
      ["shortlist", "A shortlist for the seed round: Nat Friedman, Daniel Gross, Naval Ravikant."],
    ])("hedges a recommendation-framed target list (%s)", (_label, reply) => {
      const r = verifyEntityTractionGrounding({
        reply,
        toolCalls: [],
        userMessage: "who should I raise from?",
      });
      expect(r.hedged).toBe(true);
      expect(r.flags.classes).toContain("named_entity_list");
    });

    it("hedges fabricated traction even with named examples in parens (P2-d)", () => {
      const r = verifyEntityTractionGrounding({
        reply:
          "We have 100 paying customers (Acme Corp, Globex Industries, Cedar Labs) already on annual plans.",
        toolCalls: [],
        userMessage: "how's traction?",
      });
      expect(r.hedged).toBe(true);
      expect(r.flags.classes).toContain("traction");
    });
  });

  describe("the note NAMES the item and sits at the BOTTOM", () => {
    it("names the flagged target names and appends below the answer", () => {
      const reply = "For the seed round, reach out to Jane Smithson, John Dorner, and Alex Leeward this week.";
      const r = verifyEntityTractionGrounding({
        reply,
        toolCalls: [],
        userMessage: "who should I raise from?",
      });
      expect(r.hedged).toBe(true);
      expect(r.text).toMatch(/Unverified\*\* \(illustrative, not from your data\):/);
      expect(r.text).toMatch(/Jane Smithson/);
      expect(r.text).not.toMatch(/Unverified specifics/);
      expect(r.text.indexOf("For the seed round")).toBeLessThan(r.text.indexOf("⚠️"));
    });
  });
});
