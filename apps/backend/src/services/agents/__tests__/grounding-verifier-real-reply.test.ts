import { describe, it, expect } from "vitest";
import { verifyCapGrounding, amountInToolOutputs } from "../cap-grounding-verifier";
import { verifyRoasSampleGrounding } from "../roas-sample-grounding-verifier";
import fixture from "./__fixtures__/real-ads-reply.json";

const toolCalls = fixture.toolCalls as any;

describe("grounding verifiers on the real ads reply (run 6812c7a5)", () => {
  it("cap: real money values ground TRUE against JSON-escaped previews", () => {
    expect(amountInToolOutputs("80", toolCalls, { includeInputs: true })).toBe(true);
    expect(amountInToolOutputs("66.83", toolCalls, { includeInputs: true })).toBe(true);
    expect(amountInToolOutputs("40", toolCalls, { includeInputs: true })).toBe(true);
    expect(amountInToolOutputs("10", toolCalls, { includeInputs: true })).toBe(true);
  });

  it("cap: the real reply is NOT hedged (no false 'Unverified cap' banner)", () => {
    const r = verifyCapGrounding({ reply: fixture.reply, toolCalls });
    expect(r.hedged).toBe(false);
    expect(r.flags.ungrounded_amounts).toEqual([]);
  });

  it("roas: the real reply is NOT hedged (retro scoreboard is not a live move)", () => {
    const r = verifyRoasSampleGrounding({ reply: fixture.reply, toolCalls });
    expect(r.hedged).toBe(false);
  });

  it("cap: a genuinely fabricated cap NOT in tool output STILL hedges", () => {
    const reply = "Standing policy: host campaigns have a $737/week hard cap.";
    const r = verifyCapGrounding({ reply, toolCalls });
    expect(r.hedged).toBe(true);
    expect(r.flags.ungrounded_amounts).toContain("737");
  });

  it("banner (when it does fire) is appended BELOW the reply, not prepended", () => {
    const reply = "Do the thing. Standing policy: a $737/week hard cap applies.";
    const r = verifyCapGrounding({ reply, toolCalls });
    expect(r.hedged).toBe(true);
    expect(r.text.startsWith("Do the thing")).toBe(true);
    expect(r.text).toMatch(/Unverified cap\/policy/);
  });
});
