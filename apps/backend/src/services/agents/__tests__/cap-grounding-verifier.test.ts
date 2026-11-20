import { describe, it, expect } from "vitest";
import { verifyCapGrounding } from "../cap-grounding-verifier";
import type { ToolCallTrace } from "@/services/tools/types";

function trace(
  name: string,
  output: string,
  status: ToolCallTrace["status"] = "ok",
): ToolCallTrace {
  return { name, input_preview: "", output_preview: output, ms: 12, status };
}

const META_OUT =
  '{"ad_sets":[{"ad_set_name":"Host ad set","daily_budget_usd":30,"spend_usd":209.4,"roas":0,' +
  '"geo_locations":{"cities":[{"name":"Miami","radius":50},{"name":"Orlando","radius":25}]}}]}';

describe("verifyCapGrounding — confabulated cap → soft hedge", () => {
  describe("HEDGES (the bad path)", () => {
    it("hedges a confabulated $50/week cap not in any tool output", () => {
      const r = verifyCapGrounding({
        reply:
          "Keep host campaigns at or under the standing $50/week cap you have in place.",
        toolCalls: [trace("meta_ads__list_campaigns", META_OUT)],
      });
      expect(r.hedged).toBe(true);
      expect(r.flags.ungrounded_amounts).toContain("50");
      expect(r.text).toMatch(/Unverified cap\/policy/);
      expect(r.text).toContain("$50");
    });

    it("hedges an invented '$75 requires approval' threshold", () => {
      const r = verifyCapGrounding({
        reply: "Refunds above $75 require approval per our policy.",
        toolCalls: [trace("meta_ads__list_campaigns", META_OUT)],
      });
      expect(r.hedged).toBe(true);
      expect(r.flags.ungrounded_amounts).toContain("75");
    });

    it("hedges even when only memory tools ran (memory ≠ live tool result)", () => {
      const r = verifyCapGrounding({
        reply: "Host campaigns are capped at $50/week.",
        toolCalls: [trace("memory__search", '{"notes":["$50 referral reward"]}')],
      });
      expect(r.hedged).toBe(true);
      expect(r.flags.ungrounded_amounts).toContain("50");
    });

    it("memory tool INPUTS never ground a cap either", () => {
      const r = verifyCapGrounding({
        reply: "Host campaigns are capped at $50/week.",
        toolCalls: [
          {
            name: "memory__search",
            input_preview: '{"query":"$50 weekly cap"}',
            output_preview: "{}",
            ms: 5,
            status: "ok",
          },
        ],
      });
      expect(r.hedged).toBe(true);
      expect(r.flags.ungrounded_amounts).toContain("50");
    });

    it("still hedges an invented cap in a sentence that does NOT cite the $500 rule, even when another sentence does", () => {
      const r = verifyCapGrounding({
        reply:
          "This stays under the $500/week net-new cap. Separately, host campaigns are capped at $50/week.",
        toolCalls: [trace("meta_ads__list_campaigns", META_OUT)],
      });
      expect(r.hedged).toBe(true);
      expect(r.flags.ungrounded_amounts).toContain("50");
    });
  });

  describe("DOES NOT hedge (the good path)", () => {
    it("passes the real $500 net-new weekly cap (allowlisted hard rule)", () => {
      const r = verifyCapGrounding({
        reply:
          "I kept the proposal under the $500 net-new weekly spend cap, so it routes to approval.",
        toolCalls: [trace("meta_ads__list_campaigns", META_OUT)],
      });
      expect(r.hedged).toBe(false);
    });

    it("does NOT hedge the agent's own arithmetic compared against the cited $500 rule (run da02f991)", () => {
      const r = verifyCapGrounding({
        reply:
          "That raise adds $1,008/week net-new, which exceeds the $500/week hard ceiling, so it routes to approval.",
        toolCalls: [trace("meta_ads__list_campaigns", META_OUT)],
      });
      expect(r.hedged).toBe(false);
      expect(r.flags.has_cap_claim).toBe(true);
    });

    it("passes an amount the agent itself passed INTO a propose_* tool this run (input_preview grounding)", () => {
      const r = verifyCapGrounding({
        reply: "The $39/day budget is the limit I proposed for this ad set.",
        toolCalls: [
          {
            name: "meta_ads__propose_budget_change",
            input_preview:
              '{"ad_set_id":"123","new_daily_budget_usd":39,"current_daily_budget_usd":30,"rationale":"step +30%"}',
            output_preview: '{"status":"queued"}',
            ms: 40,
            status: "ok",
          },
        ],
      });
      expect(r.hedged).toBe(false);
    });

    it("passes a plain budget report ($30/day) — not policy-framed", () => {
      const r = verifyCapGrounding({
        reply:
          "The Bay Area ad set's daily budget is $30/day. I'd raise it to $60/day.",
        toolCalls: [trace("meta_ads__list_ad_sets", META_OUT)],
      });
      expect(r.hedged).toBe(false);
    });

    it("passes a cap whose amount IS present as a money value in tool output", () => {
      const r = verifyCapGrounding({
        reply: "The ad set is capped at $30/day per its current daily budget.",
        toolCalls: [trace("meta_ads__list_ad_sets", META_OUT)],
      });
      expect(r.hedged).toBe(false);
    });

    it("does not match 'needs ~50 conversions per week' (no $ token)", () => {
      const r = verifyCapGrounding({
        reply:
          "Meta's purchase optimization needs ~50 conversions per ad set per week to exit the learning phase.",
        toolCalls: [trace("meta_ads__list_campaigns", META_OUT)],
      });
      expect(r.hedged).toBe(false);
    });

    it("no tool calls + no cap claim → clean passthrough", () => {
      const r = verifyCapGrounding({
        reply: "Spend last 7 days was $679 at 2.36x ROAS.",
        toolCalls: [],
      });
      expect(r.hedged).toBe(false);
      expect(r.flags.has_cap_claim).toBe(false);
    });
  });
});
