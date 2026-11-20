import { describe, it, expect } from "vitest";
import { stripSignoff } from "../strip-signoff";

describe("stripSignoff", () => {
  it.each([
    ["Why do you want to raise it?\n\n\nRegards,\nRavi R.", "Why do you want to raise it?"],
    ["Go ahead.\n\nThanks,\nRavi", "Go ahead."],
    ["Pause it.\nBest,\nR", "Pause it."],
    ["Yes\n\nSent from my iPhone", "Yes"],
    ["Yes please\n\nCheers\nRavi Ramadasu\n\nSent from my iPhone", "Yes please"],
    ["Hold it.\r\nKind regards,\r\nRavi R.", "Hold it."],
  ])("strips the sign-off from %j", (input, expected) => {
    expect(stripSignoff(input)).toBe(expected);
  });

  it.each([
    "Thanks",
    "Thanks for the update, go ahead",
    "With regards to the budget, keep it at $149.",
    "Sounds good.\nThanks\nraise it to 200",
    "Sounds good.\nThanks\nalso pause the Leads ad set",
    "Thanks,\nRavi\nAlso: what about TikTok?\nAnd LinkedIn?",
    "Send exactly this reply:\nThanks,\nRavi",
  ])("keeps %j", (input) => {
    expect(stripSignoff(input)).toBe(input);
  });
});
