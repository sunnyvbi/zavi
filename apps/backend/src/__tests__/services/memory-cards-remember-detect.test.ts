import { describe, it, expect } from "vitest";

import { detectRemember } from "../../services/memory-cards/remember-detect";

const MENTION = "<@U08FYQSBP6K>";

describe("detectRemember — phrase form (pre-existing behavior)", () => {
  it.each([
    `${MENTION} remember this — gift cards don't work on extensions`,
    `${MENTION} can you save this for later`,
    `${MENTION} note this: the threshold is 550`,
    `${MENTION} add to brain: we invoice manually`,
    `${MENTION} make a note of the 550 cutoff`,
  ])("fires on %s", (text) => {
    expect(detectRemember(text)).toBe(true);
  });

  it.each([
    `${MENTION} can guest use giftcard to pay for extension?`,
    `${MENTION} what do we know about gift cards`,
    `${MENTION}`,
    "",
  ])("does not fire on %s", (text) => {
    expect(detectRemember(text)).toBe(false);
  });

  it("still fires on a phrase-form question", () => {
    expect(detectRemember(`${MENTION} remember this, ok?`)).toBe(true);
  });
});

describe("detectRemember — prefix form", () => {
  it.each(["fb", "FB", "note", "remember", "feedback", "save", "capture", "memo"])(
    "fires on the %s: label",
    (label) => {
      expect(
        detectRemember(`${MENTION} ${label}: gift cards can't be used on extensions`),
      ).toBe(true);
    },
  );

  it("tolerates spacing and punctuation around the mention", () => {
    expect(detectRemember(`${MENTION}, fb : extensions are card-only`)).toBe(true);
    expect(detectRemember(`  ${MENTION}   note:extensions are card-only`)).toBe(true);
  });

  it("fires in a DM with no mention at all", () => {
    expect(detectRemember("fb: extensions are card-only")).toBe(true);
  });

  it("captures a multi-line body", () => {
    expect(detectRemember(`${MENTION} fb: gift cards\nare initial-booking only`)).toBe(true);
  });

  it.each([
    `${MENTION} one note: we should ship Friday`,
    `${MENTION} the fb: prefix didn't work for me`,
    `${MENTION} can you check the note: field on the booking`,
  ])("does not fire mid-sentence: %s", (text) => {
    expect(detectRemember(text)).toBe(false);
  });

  it("does not fire on an empty body after the label", () => {
    expect(detectRemember(`${MENTION} fb:`)).toBe(false);
    expect(detectRemember(`${MENTION} fb:   `)).toBe(false);
  });

  it.each([
    `${MENTION} fb: what's our spend this week?`,
    `${MENTION} note: did the extension path ever ship?`,
  ])("does not fire on a prefixed question: %s", (text) => {
    expect(detectRemember(text)).toBe(false);
  });

  it("still fires on a prefixed statement about facebook spend", () => {
    expect(detectRemember(`${MENTION} fb: spend is up 20% week over week`)).toBe(true);
  });

  it("does not fire on an unrelated label", () => {
    expect(detectRemember(`${MENTION} todo: fix the extension path`)).toBe(false);
  });
});
