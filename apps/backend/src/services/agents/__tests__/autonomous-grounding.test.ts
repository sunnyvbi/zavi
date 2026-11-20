import { describe, it, expect } from "vitest";
import {
  applyAutonomousGrounding,
  stripAutonomousGroundingBanner,
  hasAutonomousHardFlagBanner,
  extractAutonomousGroundingFigure,
} from "../autonomous-grounding";
import { verifyEntityTractionGrounding } from "../entity-traction-grounding-verifier";
import type { ToolCallTrace } from "@/services/tools/types";

function trace(
  name: string,
  output: string,
  status: ToolCallTrace["status"] = "ok",
  input = "",
): ToolCallTrace {
  return { name, input_preview: input, output_preview: output, ms: 12, status };
}

describe("applyAutonomousGrounding — autonomous-run claim-grounding backstop", () => {
  describe("Layer 1 — absence-claim hedge (mirrors chat verifier)", () => {
    it("hedges an absence claim built on a truncated live tool result", () => {
      const r = applyAutonomousGrounding({
        text: "The Bay Area campaign has been deleted from the Meta account.",
        toolCalls: [
          trace(
            "meta_ads__list_campaigns",
            '{"campaigns":[{"id":"c_001"}],"_truncated":true,"_total":53}',
          ),
        ],
      });
      expect(r.annotated).toBe(true);
      expect(r.claim_grounding_hedged).toBe(true);
      expect(r.text).toMatch(/May be out of date/);
      expect(r.text).toMatch(/Bay Area campaign has been deleted/);
      expect(r.claim_grounding_flags.has_absence_claim).toBe(true);
      expect(r.claim_grounding_flags.truncated_evidence).toBe(true);
    });

    it("hedges an absence claim built on memory-only evidence", () => {
      const r = applyAutonomousGrounding({
        text: "The rental_bayarea_intent campaign does not exist anymore.",
        toolCalls: [trace("memory__search", '{"hits":[{"slug":"x"}]}')],
      });
      expect(r.claim_grounding_hedged).toBe(true);
      expect(r.text).toMatch(/memory, which may be stale/);
      expect(r.claim_grounding_flags.memory_used).toBe(true);
    });
  });

  describe("Layer 2 — deterministic hard flag (previously eval-only, now runtime)", () => {
    it("annotates a fabricated file:line cite no tool ever read", () => {
      const r = applyAutonomousGrounding({
        text: "The cancel-overcharge guard is at tripPriceHelpers.ts:2408.",
        toolCalls: [
          trace(
            "mcp__server__github__search_code",
            '{"total":3,"items":[]}',
            "ok",
            '{"input":{"query":"cancel"}}',
          ),
        ],
      });
      expect(r.annotated).toBe(true);
      expect(r.deterministic_hard_flag).toBe(true);
      expect(r.deterministic_patterns).toContain("line_cite_not_read");
      expect(r.text).toMatch(/Unverified figure/);
      expect(r.text).not.toMatch(/line_cite_not_read/);
      expect(r.text).toMatch(/tripPriceHelpers\.ts:2408/);
    });

    it("annotates a present-tense state claim made with ZERO tool calls", () => {
      const r = applyAutonomousGrounding({
        text: "The fix is already staged and sitting in /approvals waiting for your click.",
        toolCalls: [],
      });
      expect(r.deterministic_hard_flag).toBe(true);
      expect(r.deterministic_patterns).toContain("tc0_state_claim");
      expect(r.text).toMatch(/Unverified figure/);
    });

    it("annotates a '0 hits' claim contradicting a search that returned >0", () => {
      const r = applyAutonomousGrounding({
        text: "There are 0 hits for the canceled-trip handler in the repo.",
        toolCalls: [
          trace(
            "mcp__server__github__search_code",
            '{"total":7,"items":[]}',
            "ok",
            '{"input":{"query":"canceled"}}',
          ),
        ],
      });
      expect(r.deterministic_hard_flag).toBe(true);
      expect(r.deterministic_patterns).toContain("tool_count_mismatch");
    });
  });

  describe("clean output passes through untouched", () => {
    it("does NOT annotate a grounded answer with no absence/cite/state claim", () => {
      const r = applyAutonomousGrounding({
        text: "Reviewed the weekly metrics. Bookings are up 4% week-over-week; nothing needs action.",
        toolCalls: [trace("operator_db__query", '{"rows":[{"bookings":120}]}')],
      });
      expect(r.annotated).toBe(false);
      expect(r.claim_grounding_hedged).toBe(false);
      expect(r.deterministic_hard_flag).toBe(false);
      expect(r.text).toBe(
        "Reviewed the weekly metrics. Bookings are up 4% week-over-week; nothing needs action.",
      );
    });

    it("does NOT annotate a cite that WAS actually read this run (no false flag)", () => {
      const r = applyAutonomousGrounding({
        text: "The guard lives at foo.ts:1406.",
        toolCalls: [
          trace(
            "mcp__sandbox__view",
            '{"content":"..."}',
            "ok",
            '{"path":"apps/backend/src/foo.ts","view_range":[1400,1450]}',
          ),
        ],
      });
      expect(r.deterministic_hard_flag).toBe(false);
      expect(r.annotated).toBe(false);
    });

    it("treats empty/whitespace output as a no-op", () => {
      const r = applyAutonomousGrounding({ text: "", toolCalls: [] });
      expect(r.annotated).toBe(false);
      expect(r.text).toBe("");
    });
  });

  describe("both layers can stack on one run", () => {
    it("carries both notes and preserves the original output", () => {
      const r = applyAutonomousGrounding({
        text: "The campaign no longer exists; the handler is at ads.ts:990.",
        toolCalls: [trace("memory__search", '{"hits":[{"slug":"x"}]}')],
      });
      expect(r.annotated).toBe(true);
      expect(r.claim_grounding_hedged).toBe(true);
      expect(r.deterministic_hard_flag).toBe(true);
      expect(r.text).toMatch(/May be out of date/);
      expect(r.text).toMatch(/Unverified figure/);
      expect(r.text).toMatch(/handler is at ads\.ts:990/);
    });
  });

  describe("hard-flag note is NAMED and BOTTOM-placed", () => {
    it("names the specific figure instead of a blind boilerplate warning", () => {
      const r = applyAutonomousGrounding({
        text: "Your revenue is $196/day right now.",
        toolCalls: [],
        agentSlug: "operator",
      });
      expect(r.deterministic_hard_flag).toBe(true);
      expect(r.text).toMatch(/Unverified figure\*\* \(not from your live data\): \$196\./);
      expect(r.text).not.toMatch(/claim not backed by live data/);
    });

    it("appends the note BELOW the answer (answer leads, caveat is a footnote)", () => {
      const r = applyAutonomousGrounding({
        text: "Your revenue is $196/day right now.",
        toolCalls: [],
        agentSlug: "operator",
      });
      expect(r.text.indexOf("Your revenue")).toBeLessThan(r.text.indexOf("Unverified figure"));
      expect(r.text.trimStart().startsWith("Your revenue")).toBe(true);
    });
  });

  describe("stripAutonomousGroundingBanner (dedup seam)", () => {
    it("strips the note from MID-text, not just a prefix", () => {
      const stacked = [
        "Your revenue is $196/day.",
        "",
        "> ⚠️ **Unverified figure** (not from your live data): $196.",
        "",
        "> ⚠️ **Unverified** (illustrative, not from your data): Acme, Globex.",
      ].join("\n");
      const out = stripAutonomousGroundingBanner(stacked);
      expect(out).not.toMatch(/Unverified figure/);
      expect(out).toMatch(/Unverified\*\* \(illustrative/);
      expect(out).toMatch(/Your revenue is \$196\/day\./);
      expect(out.match(/⚠️/g) ?? []).toHaveLength(1);
    });

    it("is a no-op when the note is absent", () => {
      const plain = "Just an answer with no caveat.";
      expect(stripAutonomousGroundingBanner(plain)).toBe(plain);
    });

    it("does NOT eat real answer content that merely quotes the label (codex P3)", () => {
      const answer = [
        "Here is how the guard works.",
        "The **Unverified figure** note means the number was not pulled this run.",
      ].join("\n");
      expect(stripAutonomousGroundingBanner(answer)).toBe(answer);
    });

    it("MERGE co-fire: a fabricated FIGURE and a fabricated NAME list both survive in one note (codex P1)", () => {
      const reply =
        "Your revenue is $196/day. For the seed round, reach out to Jane Smithson, John Dorner, and Alex Leeward.";
      const g = applyAutonomousGrounding({ text: reply, toolCalls: [], agentSlug: "operator" });
      expect(g.deterministic_hard_flag).toBe(true);
      const figure = extractAutonomousGroundingFigure(g.text);
      const base = stripAutonomousGroundingBanner(g.text);
      const et = verifyEntityTractionGrounding({
        reply: base,
        toolCalls: [],
        userMessage: "how are we doing + who to raise from?",
        mergeFigure: figure,
      });
      expect(et.hedged).toBe(true);
      expect(et.text).toMatch(/\$196/);
      expect(et.text).toMatch(/Jane Smithson/);
      expect(et.text.match(/⚠️/g) ?? []).toHaveLength(1);
      expect(et.text).toMatch(/Unverified\*\* \(not from your live data\): \$196; /);
      expect(et.text.indexOf("Your revenue")).toBeLessThan(et.text.indexOf("⚠️"));
    });

    it("extracts the figure token so it can be MERGED, not dropped", () => {
      const r = applyAutonomousGrounding({
        text: "Your revenue is $196/day right now.",
        toolCalls: [],
        agentSlug: "operator",
      });
      expect(extractAutonomousGroundingFigure(r.text)).toBe("$196");
      expect(extractAutonomousGroundingFigure("no note here")).toBeNull();
    });

    it("round-trips: an annotated output strips back to exactly one note", () => {
      const r = applyAutonomousGrounding({
        text: "Your revenue is $196/day right now.",
        toolCalls: [],
        agentSlug: "operator",
      });
      expect(hasAutonomousHardFlagBanner(r.text)).toBe(true);
      const stripped = stripAutonomousGroundingBanner(r.text);
      expect(hasAutonomousHardFlagBanner(stripped)).toBe(false);
      expect(stripped).toMatch(/Your revenue is \$196\/day/);
    });
  });
});
