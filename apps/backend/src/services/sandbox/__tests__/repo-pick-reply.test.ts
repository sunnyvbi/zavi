import { describe, it, expect } from "vitest";
import { parseRepoPickReply } from "../repo-picker";

const REPOS = ["acme/ios", "acme/android", "acme/web", "acme/web-private"];

describe("parseRepoPickReply", () => {
  it("accepts a bare letter in the forms people type", () => {
    for (const reply of ["A", "a", "A.", "A)", "(A)", "**A**", "option a", "A) the first one", "A - that one"]) {
      expect(parseRepoPickReply(reply, REPOS)).toBe("acme/ios");
    }
    expect(parseRepoPickReply("C", REPOS)).toBe("acme/web");
  });

  it("never reads a sentence's leading word as a letter pick", () => {
    expect(parseRepoPickReply("A launch-ready landing page", REPOS)).toBeNull();
    expect(parseRepoPickReply("I need a new signup flow", REPOS)).toBeNull();
    expect(parseRepoPickReply("B2B pricing page", REPOS)).toBeNull();
  });

  it("still accepts full and bare repo names", () => {
    expect(parseRepoPickReply("use acme/web please", REPOS)).toBe("acme/web");
    expect(parseRepoPickReply("android", REPOS)).toBe("acme/android");
  });
});
