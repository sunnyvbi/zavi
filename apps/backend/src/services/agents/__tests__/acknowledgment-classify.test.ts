import { describe, it, expect } from "vitest";
import {
  isPureAcknowledgment,
  endsWithQuestionOrOffer,
  shouldSuppressAsAck,
  isPureGratitude,
  isContextFreeCourtesy,
} from "../acknowledgment-classify";

describe("isPureGratitude — never-a-go-signal courtesy subset", () => {
  for (const t of [
    "thanks",
    "thank you",
    "thank u",
    "thanks!",
    "thank you so much",
    "thanks a lot",
    "thx",
    "ty",
    "appreciate it",
    "much appreciated",
    "cheers",
    "  thank you  ",
    "thanks 🙏",
  ]) {
    it(`true: ${JSON.stringify(t)}`, () => {
      expect(isPureGratitude(t)).toBe(true);
    });
  }
  for (const t of [
    "thanks, also rename the button to Save",
    "ok",
    "okay",
    "sure",
    "cool",
    "got it",
    "thank them for me",
    "",
    "   ",
  ]) {
    it(`false: ${JSON.stringify(t)}`, () => {
      expect(isPureGratitude(t)).toBe(false);
    });
  }
});

describe("isContextFreeCourtesy — gratitude OR greeting, safe without prior turn", () => {
  it("true for gratitude and greetings", () => {
    expect(isContextFreeCourtesy("thank you")).toBe(true);
    expect(isContextFreeCourtesy("thanks!")).toBe(true);
    expect(isContextFreeCourtesy("hey")).toBe(true);
    expect(isContextFreeCourtesy("good morning")).toBe(true);
  });
  it("false for affirmative-capable tokens (need prior-turn context to suppress)", () => {
    expect(isContextFreeCourtesy("ok")).toBe(false);
    expect(isContextFreeCourtesy("okay")).toBe(false);
    expect(isContextFreeCourtesy("sure")).toBe(false);
    expect(isContextFreeCourtesy("got it")).toBe(false);
  });
  it("false for real follow-ups", () => {
    expect(isContextFreeCourtesy("thanks, also rename the button")).toBe(false);
    expect(isContextFreeCourtesy("hey can you fix the login bug")).toBe(false);
  });
});

describe("isPureAcknowledgment", () => {
  describe("PURE ACK (true) — suppress the run", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["bare okay (the reported bug)", "okay"],
      ["ok", "ok"],
      ["uppercase OK", "OK"],
      ["ok with trailing punctuation", "ok."],
      ["okay with bang", "okay!"],
      ["single k", "k"],
      ["kk", "kk"],
      ["cool", "cool"],
      ["thanks", "thanks"],
      ["thank you", "thank you"],
      ["thx", "thx"],
      ["ty", "ty"],
      ["got it", "got it"],
      ["gotcha", "gotcha"],
      ["understood", "understood"],
      ["noted", "noted"],
      ["alright", "alright"],
      ["leading/trailing whitespace", "  okay  "],
      ["thanks with emoji tail", "thanks 🙏"],
      ["got it with period", "got it."],
      ["ok thanks combo", "ok thanks"],
      ["great thanks", "great, thanks"],
      ["thanks so much", "thanks so much"],
    ];
    for (const [label, text] of cases) {
      it(label, () => {
        expect(isPureAcknowledgment(text)).toBe(true);
      });
    }
  });

  describe("REAL TURN (false) — must still dispatch", () => {
    const cases: ReadonlyArray<readonly [string, string | null | undefined]> = [
      ["ack that carries a real task", "okay but also fix the login bug"],
      ["ok then a question", "ok, what's the status of the deploy?"],
      ["a real question", "first do you think this strategy works?"],
      ["sure followed by an ask", "sure, can you ship the PR now"],
      ["thanks plus a follow-up", "thanks, now add the null check"],
      ["a verb imperative", "fix the failing test"],
      ["a long message opening with ok", "ok so here is the full plan for next quarter that I want you to execute"],
      ["bare sure (ambiguous go-signal)", "sure"],
      ["makes sense (ambiguous go-signal)", "makes sense"],
      ["sounds good (ambiguous go-signal)", "sounds good"],
      ["will do (ambiguous go-signal)", "will do"],
      ["empty string", ""],
      ["whitespace only", "   "],
      ["a word that merely starts with ok", "okayish numbers, run the report"],
      ["null", null],
      ["undefined", undefined],
      ["non-string number", 42 as unknown as string],
    ];
    for (const [label, text] of cases) {
      it(label, () => {
        expect(isPureAcknowledgment(text)).toBe(false);
      });
    }
  });
});

describe("endsWithQuestionOrOffer", () => {
  it("true when the prior assistant turn ends with a question", () => {
    expect(endsWithQuestionOrOffer("Want me to ship a change?")).toBe(true);
    expect(endsWithQuestionOrOffer("  Should I proceed?  ")).toBe(true);
  });
  it("true for statement-form offers/CTAs (no '?')", () => {
    expect(
      endsWithQuestionOrOffer("---\nReply **`yes`** to open the PR, or tell me what to adjust."),
    ).toBe(true);
    expect(
      endsWithQuestionOrOffer('Reply with "add 1, 3" or "add all" or "skip" to confirm.'),
    ).toBe(true);
    expect(
      endsWithQuestionOrOffer("I can fix that now. Let me know if you want me to proceed."),
    ).toBe(true);
    expect(endsWithQuestionOrOffer("I'll proceed once you say the word.")).toBe(true);
  });
  it("false for a plain statement, empty, or non-string", () => {
    expect(endsWithQuestionOrOffer("Done — shipped the fix.")).toBe(false);
    expect(endsWithQuestionOrOffer("Pushed the change and it deployed clean.")).toBe(false);
    expect(endsWithQuestionOrOffer("")).toBe(false);
    expect(endsWithQuestionOrOffer(null)).toBe(false);
    expect(endsWithQuestionOrOffer(undefined)).toBe(false);
  });
  it("does not trip on 'reply' mentioned early in a long body", () => {
    const longBody =
      "I checked the reply handler in chat-send.ts and traced the bug. " +
      "It was a missing null guard in the dispatch path. " +
      "The fix adds the guard and a test. Everything is green now and merged.";
    expect(endsWithQuestionOrOffer(longBody)).toBe(false);
  });
});

describe("shouldSuppressAsAck — the full no-run decision", () => {
  it("suppresses a pure ack after a plain statement (the reported bug)", () => {
    expect(
      shouldSuppressAsAck({
        message: "okay",
        priorAssistantBody: "Done — I merged the PR and it deployed.",
        priorWasClarify: false,
      }),
    ).toBe(true);
  });

  it("does NOT suppress an ack that answers a prose offer (ends with ?)", () => {
    expect(
      shouldSuppressAsAck({
        message: "okay",
        priorAssistantBody:
          "I can fix the login bug in auth-middleware. Want me to ship a change?",
        priorWasClarify: false,
      }),
    ).toBe(false);
  });

  it("does NOT suppress an ack after a statement-form offer (no '?')", () => {
    expect(
      shouldSuppressAsAck({
        message: "okay",
        priorAssistantBody:
          "I can ship that change now. Reply `yes` and I'll open the PR.",
        priorWasClarify: false,
      }),
    ).toBe(false);
  });

  it("does NOT suppress when the prior turn was a clarify card", () => {
    expect(
      shouldSuppressAsAck({
        message: "okay",
        priorAssistantBody: "Here is a summary.",
        priorWasClarify: true,
      }),
    ).toBe(false);
  });

  it("does NOT suppress a bare go-signal even after a statement", () => {
    expect(
      shouldSuppressAsAck({
        message: "sure",
        priorAssistantBody: "All set.",
        priorWasClarify: false,
      }),
    ).toBe(false);
  });

  it("still suppresses a terminal courtesy after a statement", () => {
    expect(
      shouldSuppressAsAck({
        message: "thanks!",
        priorAssistantBody: "Pushed the change.",
        priorWasClarify: false,
      }),
    ).toBe(true);
  });
});
