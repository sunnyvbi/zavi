import { describe, it, expect } from "vitest";
import { verifyClaimGrounding } from "../claim-grounding-verifier";
import type { ToolCallTrace } from "@/services/tools/types";

function trace(
  name: string,
  output: string,
  status: ToolCallTrace["status"] = "ok",
): ToolCallTrace {
  return {
    name,
    input_preview: "",
    output_preview: output,
    ms: 12,
    status,
  };
}

describe("verifyClaimGrounding — block→hedge posture", () => {
  describe("HEDGES (the bad path)", () => {
    it("hedges when absence claim + truncated live tool result", () => {
      const out = verifyClaimGrounding({
        reply:
          "The Bay Area campaign has been deleted from the Meta account for the third consecutive run.",
        toolCalls: [
          trace(
            "meta_ads__list_campaigns",
            '{"campaigns":[{"id":"c_001"}],"_truncated":true,"_total":53}',
          ),
        ],
      });
      expect(out.hedged).toBe(true);
      expect(out.text).toMatch(/May be out of date/);
      expect(out.text).toMatch(/capped/);
      expect(out.text).toMatch(/Bay Area campaign has been deleted/);
      expect(out.flags.has_absence_claim).toBe(true);
      expect(out.flags.truncated_evidence).toBe(true);
      expect(out.flags.matched_patterns).toContain("passive-removed");
    });

    it("hedges when absence claim + memory was used (no live tool)", () => {
      const out = verifyClaimGrounding({
        reply: "The rental_bayarea_intent campaign does not exist anymore.",
        toolCalls: [
          trace(
            "memory__search",
            '{"hits":[{"slug":"rental_bayarea_intent","title":"campaign"}]}',
          ),
        ],
      });
      expect(out.hedged).toBe(true);
      expect(out.text).toMatch(/memory, which may be stale/);
      expect(out.flags.memory_used).toBe(true);
      expect(out.flags.matched_patterns).toContain("does-not-exist");
    });

    it("hedges the incident phrasing: 'Google MCP not connected'", () => {
      const out = verifyClaimGrounding({
        reply:
          "Google MCP not connected — no Google data this run. Surface to operator.",
        toolCalls: [
          trace(
            "meta_ads__list_campaigns",
            '{"campaigns":[],"_truncated":true,"_total":4}',
          ),
        ],
      });
      expect(out.hedged).toBe(true);
      expect(out.flags.matched_patterns).toContain("mcp-not-connected");
    });

    it("hedges 'appears to have been deleted' (incident phrasing)", () => {
      const out = verifyClaimGrounding({
        reply:
          "The campaign appears to have been deleted or renamed in Meta.",
        toolCalls: [
          trace(
            "meta_ads__list_campaigns",
            '{"campaigns":[{"id":"c_1"}],"_truncated":true,"_total":4}',
          ),
        ],
      });
      expect(out.flags.matched_patterns).toContain("appears-removed");
      expect(out.hedged).toBe(true);
    });

    it("hedge banner appears BEFORE the original reply (read order matters)", () => {
      const out = verifyClaimGrounding({
        reply: "X has been removed.",
        toolCalls: [trace("memory__search", '{"hits":[]}')],
      });
      const bannerIdx = out.text.indexOf("May be out of date");
      const originalIdx = out.text.indexOf("X has been removed.");
      expect(bannerIdx).toBeGreaterThanOrEqual(0);
      expect(originalIdx).toBeGreaterThan(bannerIdx);
    });
  });

  describe("LETS THROUGH (the good path)", () => {
    it("no hedge when reply has no absence claim", () => {
      const out = verifyClaimGrounding({
        reply: "Bay Area campaign is ACTIVE at $30/day, unchanged since Apr 30.",
        toolCalls: [
          trace(
            "meta_ads__list_campaigns",
            '{"campaigns":[{"id":"c_001","name":"Bay Area"}],"_truncated":true}',
          ),
        ],
      });
      expect(out.hedged).toBe(false);
      expect(out.text).toBe(
        "Bay Area campaign is ACTIVE at $30/day, unchanged since Apr 30.",
      );
      expect(out.flags.has_absence_claim).toBe(false);
    });

    it("no hedge when absence claim is backed by a clean (non-truncated) live tool result", () => {
      const out = verifyClaimGrounding({
        reply: "The Q3 campaign has been deleted.",
        toolCalls: [
          trace(
            "meta_ads__list_campaigns",
            '{"campaigns":[{"id":"c_001","name":"Q4"}],"_total":1}',
          ),
        ],
      });
      expect(out.hedged).toBe(false);
      expect(out.flags.has_absence_claim).toBe(true);
      expect(out.flags.memory_used).toBe(false);
      expect(out.flags.truncated_evidence).toBe(false);
    });

    it("no hedge when reply is empty or whitespace", () => {
      const out = verifyClaimGrounding({
        reply: "",
        toolCalls: [trace("memory__search", "{}")],
      });
      expect(out.hedged).toBe(false);
      expect(out.flags.has_absence_claim).toBe(false);
    });

    it("absence claim with ZERO tool calls → HEDGES (no_grounding_tool, #13)", () => {
      const out = verifyClaimGrounding({
        reply: "X has been deleted.",
        toolCalls: [],
      });
      expect(out.hedged).toBe(true);
      expect(out.flags.no_grounding_tool).toBe(true);
      expect(out.flags.memory_used).toBe(false);
      expect(out.flags.truncated_evidence).toBe(false);
      expect(out.text).toMatch(/no live tool result backed this claim/);
      expect(out.text).toMatch(/X has been deleted\./);
    });

    it("absence claim + a clean live tool run → NOT hedged (no_grounding_tool false)", () => {
      const out = verifyClaimGrounding({
        reply: "That campaign does not exist.",
        toolCalls: [
          trace("meta_ads__list_campaigns", '{"campaigns":[],"_total":0}'),
        ],
      });
      expect(out.flags.has_absence_claim).toBe(true);
      expect(out.flags.no_grounding_tool).toBe(false);
      expect(out.hedged).toBe(false);
    });

    it("memory truncation alone does NOT trigger truncated_evidence", () => {
      const out = verifyClaimGrounding({
        reply: "Y is no longer available.",
        toolCalls: [
          trace("memory__search", '{"hits":[],"_truncated":true,"_total":99}'),
        ],
      });
      expect(out.flags.memory_used).toBe(true);
      expect(out.flags.truncated_evidence).toBe(false);
      expect(out.hedged).toBe(true);
    });

    it("does not match 'I deleted the typo' kind of prose (passive-removed needs aux)", () => {
      const out = verifyClaimGrounding({
        reply:
          "Acknowledged. I deleted the typo and re-ran the migration; nothing else changed.",
        toolCalls: [
          trace(
            "meta_ads__list_campaigns",
            '{"campaigns":[],"_truncated":true}',
          ),
        ],
      });
      expect(out.flags.matched_patterns).toEqual([]);
      expect(out.hedged).toBe(false);
    });
  });

  describe("flags are always populated", () => {
    it("returns flags even when hedged=false", () => {
      const out = verifyClaimGrounding({
        reply: "fine",
        toolCalls: [],
      });
      expect(out.flags).toBeDefined();
      expect(out.flags.has_absence_claim).toBe(false);
      expect(out.flags.memory_used).toBe(false);
      expect(out.flags.truncated_evidence).toBe(false);
      expect(out.flags.no_grounding_tool).toBe(false);
      expect(out.flags.matched_patterns).toEqual([]);
    });
  });
});
