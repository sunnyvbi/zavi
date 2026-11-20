import { describe, expect, it } from "vitest";
import { claimComposerSeed, isComposerSeedClaimed } from "./composerSeedGuard";

describe("claimComposerSeed", () => {
  it("lets exactly one caller dispatch a seed", () => {
    const seed = { text: "What needs my attention right now?", nonce: 1 };
    expect(claimComposerSeed(seed)).toBe(true);
    expect(claimComposerSeed(seed)).toBe(false);
  });

  it("still refuses after the first claimer is gone — the unmount/remount case", () => {
    const seed = { text: "What did the team do this week?", nonce: 1 };
    const welcomeInstance = claimComposerSeed(seed);
    const replacementInstance = claimComposerSeed(seed);
    expect([welcomeInstance, replacementInstance]).toEqual([true, false]);
  });

  it("treats each click as its own seed, even at the same nonce", () => {
    expect(claimComposerSeed({ text: "same text", nonce: 1 })).toBe(true);
    expect(claimComposerSeed({ text: "same text", nonce: 1 })).toBe(true);
  });

  it("does not claim a seed merely by asking about it", () => {
    const seed = { text: "hello", nonce: 7 };
    expect(isComposerSeedClaimed(seed)).toBe(false);
    expect(claimComposerSeed(seed)).toBe(true);
    expect(isComposerSeedClaimed(seed)).toBe(true);
  });
});
