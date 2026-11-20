import { describe, it, expect } from "vitest";
import {
  decideProvenanceEmit,
  shouldHardBlock,
} from "../provenance-emit-gate";
import type { ToolCallTrace } from "@/services/tools/types";

function trace(
  name: string,
  output: string,
  status: ToolCallTrace["status"] = "ok",
): ToolCallTrace {
  return { name, input_preview: "", output_preview: output, ms: 12, status };
}

const META_OUT =
  '{"ad_sets":[{"ad_set_name":"Host ad set","daily_budget_usd":30,"spend_usd":209.4,' +
  '"geo_locations":{"cities":[{"name":"Miami","radius":50}]}}]}';

const UNPROVENANCED_CAP_BODY = {
  summary: "Keep host campaigns under the standing $50/week cap you have in place.",
  rationale: "Spend is trending up; hold to the cap.",
  metadata: { source: "weekly-digest" },
};

describe("decideProvenanceEmit — ②B provenance emit-gate (Slice D3, contract 1)", () => {
  describe("flag OFF (default) — inert, byte-identical", () => {
    it("returns 'pass' with the SAME body reference even for a money agent + unprovenanced cap", () => {
      const r = decideProvenanceEmit({
        enabled: false,
        agentSlug: "performance-marketer",
        body: UNPROVENANCED_CAP_BODY,
        toolCalls: [trace("meta_ads__list_campaigns", META_OUT)],
      });
      expect(r.disposition).toBe("pass");
      expect(r.reason).toBe("ok");
      expect(r.body).toBe(UNPROVENANCED_CAP_BODY);
      expect(r.ungrounded_amounts).toEqual([]);
    });
  });

  describe("flag ON, money agent, unprovenanced cap → route_to_review (STILL EMITS, never dropped)", () => {
    it("routes-not-suppresses: disposition route_to_review + banner + provenance_missing reason", () => {
      const r = decideProvenanceEmit({
        enabled: true,
        agentSlug: "performance-marketer",
        body: UNPROVENANCED_CAP_BODY,
        toolCalls: [trace("meta_ads__list_campaigns", META_OUT)],
      });
      expect(r.disposition).toBe("route_to_review");
      expect(r.reason).toBe("provenance_missing");
      expect(r.ungrounded_amounts).toContain("50");

      expect(r.body).toBeTruthy();
      const body = r.body as Record<string, unknown>;
      expect(String(body.summary)).toMatch(/Human review required/);
      expect(String(body.summary)).toContain("$50");
      expect(String(body.summary)).toContain("standing $50/week cap");
      const meta = body.metadata as Record<string, unknown>;
      const review = meta.provenance_review as Record<string, unknown>;
      expect(review.required).toBe(true);
      expect(review.reason).toBe("provenance_missing");
    });

    it("does NOT mutate the caller's input body (returns a copy)", () => {
      const input = JSON.parse(JSON.stringify(UNPROVENANCED_CAP_BODY));
      const r = decideProvenanceEmit({
        enabled: true,
        agentSlug: "performance-marketer",
        body: input,
        toolCalls: [trace("meta_ads__list_campaigns", META_OUT)],
      });
      expect(r.disposition).toBe("route_to_review");
      expect(input.summary).toBe(UNPROVENANCED_CAP_BODY.summary);
      expect(r.body).not.toBe(input);
    });

    it("attaches the review banner even when no known text field exists (never loses the signal)", () => {
      const r = decideProvenanceEmit({
        enabled: true,
        agentSlug: "performance-marketer",
        body: { note: "Cap host spend at $50/week per the standing limit." },
        toolCalls: [trace("meta_ads__list_campaigns", META_OUT)],
      });
      expect(r.disposition).toBe("route_to_review");
      const body = r.body as Record<string, unknown>;
      expect(String(body.provenance_review_banner)).toMatch(/Human review required/);
      const meta = body.metadata as Record<string, unknown>;
      expect((meta.provenance_review as Record<string, unknown>).required).toBe(true);
    });
  });

  describe("flag ON — the GOOD paths return 'pass' unchanged", () => {
    it("grounded cap (money value present in tool output) → pass, body unchanged", () => {
      const body = {
        summary: "Hold host campaigns to the $30/day budget cap.",
      };
      const r = decideProvenanceEmit({
        enabled: true,
        agentSlug: "performance-marketer",
        body,
        toolCalls: [trace("meta_ads__list_campaigns", META_OUT)],
      });
      expect(r.disposition).toBe("pass");
      expect(r.body).toBe(body);
    });

    it("the allowlisted $500 standing cap → pass (agent.md hard rule)", () => {
      const body = { summary: "Net-new spend stays under the $500 weekly cap." };
      const r = decideProvenanceEmit({
        enabled: true,
        agentSlug: "performance-marketer",
        body,
        toolCalls: [trace("meta_ads__list_campaigns", META_OUT)],
      });
      expect(r.disposition).toBe("pass");
      expect(r.body).toBe(body);
    });

    it("a plain budget report (no policy keyword) → pass", () => {
      const body = { summary: "Daily budget is $30 and spend was $209.40 this week." };
      const r = decideProvenanceEmit({
        enabled: true,
        agentSlug: "performance-marketer",
        body,
        toolCalls: [trace("meta_ads__list_campaigns", META_OUT)],
      });
      expect(r.disposition).toBe("pass");
      expect(r.body).toBe(body);
    });
  });

  describe("flag ON — non-money agent is never gated", () => {
    it("a NON-money agent with an unprovenanced cap → pass (class gate)", () => {
      const r = decideProvenanceEmit({
        enabled: true,
        agentSlug: "growth-lead",
        body: UNPROVENANCED_CAP_BODY,
        toolCalls: [trace("meta_ads__list_campaigns", META_OUT)],
      });
      expect(r.disposition).toBe("pass");
      expect(r.body).toBe(UNPROVENANCED_CAP_BODY);
    });

    it("dispute-response (the other money agent) IS gated", () => {
      const r = decideProvenanceEmit({
        enabled: true,
        agentSlug: "dispute-response",
        body: UNPROVENANCED_CAP_BODY,
        toolCalls: [trace("stripe__list_disputes", "{}")],
      });
      expect(r.disposition).toBe("route_to_review");
      expect(r.ungrounded_amounts).toContain("50");
    });
  });

  describe("unprovenanced cap routes for review — never a silent drop", () => {
    it("the Tier-1 configuration of shouldHardBlock yields false (unarmed today)", () => {
      expect(
        shouldHardBlock({
          agentSlug: "performance-marketer",
          ungroundedAmounts: ["50", "9999"],
        }),
      ).toBe(false);
    });

    it("an unprovenanced cap never resolves to 'block' in Tier-1 — it routes", () => {
      const r = decideProvenanceEmit({
        enabled: true,
        agentSlug: "performance-marketer",
        body: { summary: "Cap at $50/week and also at $1,000/month per policy." },
        toolCalls: [trace("meta_ads__list_campaigns", META_OUT)],
      });
      expect(r.disposition).not.toBe("block");
      expect(r.disposition).toBe("route_to_review");
    });
  });

  describe("robustness", () => {
    it("empty body → pass", () => {
      const r = decideProvenanceEmit({
        enabled: true,
        agentSlug: "performance-marketer",
        body: {},
        toolCalls: [],
      });
      expect(r.disposition).toBe("pass");
    });

    it("non-object body → pass when no cap claim", () => {
      const r = decideProvenanceEmit({
        enabled: true,
        agentSlug: "performance-marketer",
        body: "just a string with no cap",
        toolCalls: [],
      });
      expect(r.disposition).toBe("pass");
    });
  });
});
