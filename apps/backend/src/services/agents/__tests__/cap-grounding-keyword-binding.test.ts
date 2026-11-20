import { describe, it, expect } from "vitest";
import { verifyCapGrounding } from "../cap-grounding-verifier";
import type { ToolCallTrace } from "@/services/tools/types";

const META_TOOLS: ToolCallTrace[] = [
  {
    name: "mcp__server__meta_ads__list_ad_sets",
    output_preview: JSON.stringify({
      ad_sets: [
        {
          ad_set_name: "Gig Rentals Purchase",
          daily_budget_usd: 80,
          spend_usd: 344.75,
        },
      ],
    }),
  } as unknown as ToolCallTrace,
];

describe("cap-grounding: policy keyword binds to the ADJACENT dollar token", () => {
  it("does NOT hedge a derived rate that merely shares a clause with a real cap", () => {
    const reply =
      "Existing ad set: 2,553 reach, spending $344.75/7d (~$49/day) against an $80 cap.";
    const res = verifyCapGrounding({ reply, toolCalls: META_TOOLS });
    expect(res.flags.ungrounded_amounts).toEqual([]);
    expect(res.hedged).toBe(false);
    expect(res.text).toBe(reply);
  });

  it("STILL hedges a confabulated cap that no tool supports", () => {
    const reply = "I left it alone because of the standing $50/week cap on host campaigns.";
    const res = verifyCapGrounding({ reply, toolCalls: META_TOOLS });
    expect(res.flags.ungrounded_amounts).toContain("50");
    expect(res.hedged).toBe(true);
    expect(res.text).toContain("Unverified cap/policy");
  });

  it("hedges a keyword-then-money confabulation too ('capped at $250')", () => {
    const res = verifyCapGrounding({
      reply: "Spend is capped at $250/day by your workspace policy.",
      toolCalls: META_TOOLS,
    });
    expect(res.flags.ungrounded_amounts).toContain("250");
    expect(res.hedged).toBe(true);
  });

  it("does not hedge a cap that IS grounded in tool output", () => {
    const res = verifyCapGrounding({
      reply: "The ad set runs against an $80 cap.",
      toolCalls: META_TOOLS,
    });
    expect(res.hedged).toBe(false);
  });

  it("binds a colon-form cap ('cap: $250') even when a real cap shares the clause", () => {
    const res = verifyCapGrounding({
      reply: "Existing $80 cap; cap: $250 for retargeting.",
      toolCalls: META_TOOLS,
    });
    expect(res.flags.ungrounded_amounts).toContain("250");
    expect(res.hedged).toBe(true);
  });

  it("does not bind on a keyword substring ('capacity' is not 'cap')", () => {
    const res = verifyCapGrounding({
      reply: "Running at $49 capacity against the $80 ceiling.",
      toolCalls: META_TOOLS,
    });
    expect(res.flags.ungrounded_amounts).toEqual([]);
    expect(res.hedged).toBe(false);
  });

  it("a plain budget report with no policy keyword is never a candidate", () => {
    const res = verifyCapGrounding({
      reply: "Daily budget is $30 and yesterday's spend was $27.12.",
      toolCalls: META_TOOLS,
    });
    expect(res.flags.has_cap_claim).toBe(false);
    expect(res.hedged).toBe(false);
  });
});
