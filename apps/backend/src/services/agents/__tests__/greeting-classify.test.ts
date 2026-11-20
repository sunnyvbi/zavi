import { describe, it, expect } from "vitest";
import {
  isLowIntentGreeting,
  isPureAcknowledgment,
} from "../acknowledgment-classify";

function isLowIntentTurn(text: string): boolean {
  return isLowIntentGreeting(text) || isPureAcknowledgment(text);
}

describe("isLowIntentGreeting", () => {
  describe("GREETING (true) — suppress the run", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["bare hey", "hey"],
      ["heyy", "heyy"],
      ["hi", "hi"],
      ["hii", "hii"],
      ["hello", "hello"],
      ["helloo", "helloo"],
      ["hiya", "hiya"],
      ["yo", "yo"],
      ["hey there", "hey there"],
      ["hi there", "hi there"],
      ["hello there", "hello there"],
      ["howdy", "howdy"],
      ["greetings", "greetings"],
      ["good morning", "good morning"],
      ["good afternoon", "good afternoon"],
      ["good evening", "good evening"],
      ["hey team", "hey team"],
      ["hi all", "hi all"],
      ["uppercase HELLO", "HELLO"],
      ["trailing punctuation", "hello!"],
      ["leading/trailing whitespace", "  hey  "],
      ["hi with emoji tail", "hi 👋"],
    ];
    for (const [label, text] of cases) {
      it(label, () => {
        expect(isLowIntentGreeting(text)).toBe(true);
      });
    }
  });

  describe("REAL TURN (false) — must still dispatch", () => {
    const cases: ReadonlyArray<readonly [string, string | null | undefined]> = [
      ["a real task — fix the deeplink bug", "fix the deeplink bug"],
      ["greeting that carries a real task", "hey can you fix the login bug"],
      ["hi then a question", "hi, what's the status of the deploy?"],
      ["a verb imperative", "ship the PR now"],
      ["a long message opening with hi", "hi so here is the full plan for next quarter to execute"],
      ["an ack, not a greeting", "okay"],
      ["a word that merely starts with hi", "highlight the failing tests please"],
      ["empty string", ""],
      ["whitespace only", "   "],
      ["null", null],
      ["undefined", undefined],
    ];
    for (const [label, text] of cases) {
      it(label, () => {
        expect(isLowIntentGreeting(text)).toBe(false);
      });
    }
  });
});

describe("isLowIntentTurn (route's combined greeting-OR-ack gate)", () => {
  it("hey is low-intent (true)", () => {
    expect(isLowIntentTurn("hey")).toBe(true);
  });
  it("hello is low-intent (true)", () => {
    expect(isLowIntentTurn("hello")).toBe(true);
  });
  it("okay is low-intent (true) — rides the ack classifier", () => {
    expect(isLowIntentTurn("okay")).toBe(true);
  });
  it("a real task is NOT low-intent (false)", () => {
    expect(isLowIntentTurn("fix the deeplink bug")).toBe(false);
  });
});
