import { describe, it, expect } from "vitest";
import {
  chunkText,
  precedingTurnChunks,
  shouldDropPrecedingTurn,
} from "../_reply-format";

const CHUNK = 2900;

describe("chunkText", () => {
  it("empty → []", () => expect(chunkText("", CHUNK)).toEqual([]));
  it("short → single chunk", () => expect(chunkText("hi", CHUNK)).toEqual(["hi"]));
  it("splits a >size single line into size-bounded pieces", () => {
    const out = chunkText("x".repeat(CHUNK * 2 + 5), CHUNK);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(CHUNK);
  });
});

describe("precedingTurnChunks — multi-turn delivery + render-seam leak filter", () => {
  it("null/undefined/single/<2 → []", () => {
    expect(precedingTurnChunks(null, false, CHUNK)).toEqual([]);
    expect(precedingTurnChunks(undefined, false, CHUNK)).toEqual([]);
    expect(precedingTurnChunks(["only one"], false, CHUNK)).toEqual([]);
  });

  it("error reply → [] (failures stay single-message)", () => {
    expect(precedingTurnChunks(["breakdown", "follow-up"], true, CHUNK)).toEqual([]);
  });

  it("delivers a genuine breakdown preceding turn; last turn (==output_text) dropped", () => {
    const breakdown = [
        "Here is the full owner receipt breakdown, line by line:",
        "",
        "The trip subtotal is $421.92 and the deposit hold is $200, which is why the",
        "card shows $621.92 pending rather than the trip price alone. The deposit is an",
        "authorization, not a capture, so it never leaves the guest's account unless a",
        "claim is filed and released against it after the trip closes.",
      ].join("\n");
    const out = precedingTurnChunks([breakdown, "saved to memory, reply above"], false, CHUNK);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("owner receipt breakdown");
    expect(out.join("\n")).not.toContain("saved to memory");
  });

  it("converts each preceding turn markdown → mrkdwn (no literal **bold**)", () => {
    const turn = [
      "Here is the **bold** breakdown of what changed:",
      "",
      "- the payout destination moved to the connected account",
      "- the retry schedule is now driven by Stripe, not by us",
    ].join("\n");
    const out = precedingTurnChunks([turn, "follow-up"], false, CHUNK);
    expect(out[0]).not.toContain("**");
    expect(out[0]).toContain("bold");
  });

  it("DROPS a raw scratchpad preceding turn (render-seam leak)", () => {
    const out = precedingTurnChunks(
      ["Now let me check the setup.ts to understand how tests are structured", "final answer"],
      false,
      CHUNK,
    );
    expect(out).toEqual([]);
  });

  it("DROPS a multi-line scratchpad turn (opener + internal-action lines)", () => {
    const out = precedingTurnChunks(
      ["Now let me apply the edits\nWire the reason validation into handleSaveUser\nRun the tests", "final"],
      false,
      CHUNK,
    );
    expect(out).toEqual([]);
  });

  it("KEEPS a substantive breakdown even if it opens with a sequencing word", () => {
    const breakdown = [
      "First, the root cause is a missing null guard.",
      "The fix touches three files in the payout path, all of them on the write side,",
      "so nothing that only reads the payout record has to change alongside them.",
      "Each change is independently revertable, which means we can ship them one at a",
      "time and stop at any point without leaving the path half-migrated.",
    ].join("\n");
    const out = precedingTurnChunks([breakdown, "follow-up"], false, CHUNK);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("root cause");
  });
});

describe("shouldDropPrecedingTurn", () => {
  it("drops process-only scratchpad lines (narration opener)", () => {
    expect(shouldDropPrecedingTurn("Now let me check the file")).toBe(true);
    expect(shouldDropPrecedingTurn("I'll now apply the edits")).toBe(true);
    expect(shouldDropPrecedingTurn("Let's wire the validation in")).toBe(true);
  });
  it("ACCEPTED false-negative: a bare internal-action opener w/o a narration opener is KEPT (gate stays narrow so a short genuine status isn't dropped)", () => {
    expect(shouldDropPrecedingTurn("Wiring the allowlist into the handler")).toBe(false);
  });
  it("DROPS a narration opener over a code block (this test used to certify the leak)", () => {
    expect(shouldDropPrecedingTurn("Now here's the change:\n```ts\nconst x = 1;\n```")).toBe(true);
  });
  it("keeps genuine content with no process opener", () => {
    expect(
      shouldDropPrecedingTurn(
        "Here is the full owner receipt breakdown with every line item and when each one shows.",
      ),
    ).toBe(false);
  });
  it("keeps a sequencing-opener turn that carries real multi-line content", () => {
    expect(
      shouldDropPrecedingTurn(
        "First, the root cause is a null guard.\nThe fix touches three files.\nEach is revertable.",
      ),
    ).toBe(false);
  });
});
