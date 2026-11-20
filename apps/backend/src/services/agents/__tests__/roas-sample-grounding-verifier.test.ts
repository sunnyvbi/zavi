import { describe, it, expect } from "vitest";
import { verifyRoasSampleGrounding } from "../roas-sample-grounding-verifier";
import type { ToolCallTrace } from "@/services/tools/types";

function trace(
  name: string,
  output: string,
  status: ToolCallTrace["status"] = "ok",
): ToolCallTrace {
  return { name, input_preview: "", output_preview: output, ms: 12, status };
}

describe("verifyRoasSampleGrounding — ungrounded scale-on-ROAS → soft hedge", () => {
  describe("HEDGES (the bad path — move on a ROAS with no n)", () => {
    it("hedges a scale recommendation off a ROAS with no purchase count", () => {
      const r = verifyRoasSampleGrounding({
        reply: "Scale Gig Rentals — it's at 27× ROAS.",
        toolCalls: [trace("meta_ads__list_campaigns", "{}")],
      });
      expect(r.hedged).toBe(true);
      expect(r.text).toMatch(/Sample-size caution/);
      expect(r.flags.ungrounded_sentences.length).toBe(1);
    });

    it("hedges a kill recommendation off a ROAS with no purchase count", () => {
      const r = verifyRoasSampleGrounding({
        reply: "Kill the Bay Area ad set, ROAS is only 0.7×.",
      });
      expect(r.hedged).toBe(true);
    });

    it("hedges a spelled-out 'return on ad spend' move with no n", () => {
      const r = verifyRoasSampleGrounding({
        reply: "Increase the host campaign — return on ad spend is 3.8×.",
      });
      expect(r.hedged).toBe(true);
    });
  });

  describe("DOES NOT hedge (the good path)", () => {
    it("passes a same-sentence grounded scale (n=20, 30d)", () => {
      const r = verifyRoasSampleGrounding({
        reply: "Scale Gig Rentals — 27× ROAS (n=20, 30d).",
      });
      expect(r.hedged).toBe(false);
    });

    it("passes an adjacent-sentence grounded scale (n in prior sentence)", () => {
      const r = verifyRoasSampleGrounding({
        reply:
          "Gig Rentals is at 27× ROAS. That's on n=20 over 30d. Scale it +15%.",
      });
      expect(r.hedged).toBe(false);
    });

    it("passes a plain report — no action verb (the key false-positive guard)", () => {
      const r = verifyRoasSampleGrounding({
        reply: "New Conversions ran 3.67× ROAS last week.",
      });
      expect(r.hedged).toBe(false);
      expect(r.flags.has_scale_roas_claim).toBe(false);
    });

    it("passes an action with no ROAS token", () => {
      const r = verifyRoasSampleGrounding({
        reply: "Scale Gig Rentals +10% — CPA improved and purchases rose.",
      });
      expect(r.hedged).toBe(false);
    });

    it("passes empty reply (fail-open)", () => {
      const r = verifyRoasSampleGrounding({ reply: "" });
      expect(r.hedged).toBe(false);
      expect(r.flags.has_scale_roas_claim).toBe(false);
    });

    it("passes a grounded reallocation (n on the target)", () => {
      const r = verifyRoasSampleGrounding({
        reply:
          "Reallocate budget from Leads (5× ROAS) to Purchase (26× ROAS, n=20, 30d).",
      });
      expect(r.hedged).toBe(false);
    });

    it("does NOT hedge an oversized step when propose_budget_change was already called with those amounts", () => {
      const r = verifyRoasSampleGrounding({
        reply:
          "Raise Gig Rentals Purchase from $72 to $144 — 20.74× ROAS on n=21, clear-cut upside.",
        toolCalls: [
          {
            name: "meta_ads__propose_budget_change",
            input_preview:
              '{"ad_set_id":"123","current_daily_budget_usd":72,"proposed_daily_budget_usd":144,"rationale":"strong ROAS"}',
            output_preview:
              '{"decision_id":"abc","within_cap":false,"forced_to_approval_by_step_guard":true}',
            ms: 40,
            status: "ok",
          },
        ],
      });
      expect(r.hedged).toBe(false);
      expect(r.flags.oversized_step_raises.length).toBe(0);
    });

    it("STILL hedges an oversized step when no propose tool was called (toolCalls absent)", () => {
      const r = verifyRoasSampleGrounding({
        reply:
          "Raise Gig Rentals Purchase from $72 to $144 — 20.74× ROAS on n=21, clear-cut upside.",
      });
      expect(r.hedged).toBe(true);
      expect(r.flags.oversized_step_raises.length).toBe(1);
    });
  });
});

describe("verifyRoasSampleGrounding — RAISE-specific risks (thin-n / oversized step)", () => {
  it("does NOT hedge a raise under a degraded pixel anymore (trust + suggest, 2026-06-07)", () => {
    const r = verifyRoasSampleGrounding({
      reply:
        "The Meta pixel is degraded so ROAS is unverified. Raise Gig from $72 to $90 — 20× ROAS on n=21 over 30d.",
    });
    expect(r.hedged).toBe(false);
  });

  it("hedges a raise on a thin sample (n<10)", () => {
    const r = verifyRoasSampleGrounding({
      reply: "Raise Regular Rentals — 23× ROAS on n=2 over 30d.",
    });
    expect(r.hedged).toBe(true);
    expect(r.flags.low_sample_raises.length).toBe(1);
  });

  it("hedges a raise with an oversized step (> +30% and > +$10/day)", () => {
    const r = verifyRoasSampleGrounding({
      reply: "Raise Gig from $30 to $90 — strong line, n=12 over 30d.",
    });
    expect(r.hedged).toBe(true);
    expect(r.flags.oversized_step_raises.length).toBe(1);
    expect(r.flags.low_sample_raises.length).toBe(0);
  });

  it("does NOT hedge a healthy raise (n≥10, ≤30% step, healthy pixel)", () => {
    const r = verifyRoasSampleGrounding({
      reply: "Raise Gig from $72 to $90 — 20× ROAS on n=21 over 30d.",
    });
    expect(r.hedged).toBe(false);
  });

  it("does NOT hedge a web_only raise (web_only is a floor, not degraded)", () => {
    const r = verifyRoasSampleGrounding({
      reply:
        "Pixel is web_only so treat ROAS as a floor. Raise Gig from $72 to $90 — 20× ROAS on n=21.",
    });
    expect(r.hedged).toBe(false);
  });

  it("does NOT flag an oversized step on a tiny budget (+$10/day floor)", () => {
    const r = verifyRoasSampleGrounding({
      reply: "Raise the test ad set from $2 to $12 — 20× ROAS on n=15.",
    });
    expect(r.hedged).toBe(false);
    expect(r.flags.oversized_step_raises.length).toBe(0);
  });

  it("catches the bare 'Scale ... from $X to $Y' form (not just 'scale up')", () => {
    const r = verifyRoasSampleGrounding({
      reply: "Scale Gig from $30 to $90 — 23× ROAS on n=2.",
    });
    expect(r.hedged).toBe(true);
    expect(r.flags.low_sample_raises.length).toBe(1);
    expect(r.flags.oversized_step_raises.length).toBe(1);
  });

  it("does NOT hedge 'scale back / scale down' (a decrease, not a raise)", () => {
    const r = verifyRoasSampleGrounding({
      reply: "Scale back the Bay Area ad set — only 0.6× ROAS on n=2.",
    });
    expect(r.hedged).toBe(false);
    expect(r.flags.low_sample_raises.length).toBe(0);
  });
});
