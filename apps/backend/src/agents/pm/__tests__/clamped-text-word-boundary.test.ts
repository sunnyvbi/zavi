
import { describe, it, expect } from "vitest";
import { clampedText } from "../output-schema";

const FULL =
  "passing. Single User-agent: * with Allow: /. No named AI crawler rules (GPTBot, PerplexityBot, ClaudeBot) are present.";

describe("clampedText — truncation is visible and lands on a word", () => {
  const schema = clampedText(1, 80);

  it("no longer ends mid-token the way the prod card did", () => {
    const out = schema.parse(FULL) as string;
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith("(GPTBot, ")).toBe(false);
    expect(out).not.toMatch(/[,;:\s-]…$/);
  });

  it("marks the cut so a reader can tell truncation from terseness", () => {
    const out = schema.parse(FULL) as string;
    expect(out.endsWith("…")).toBe(true);
  });

  it("breaks on a space, not through a word", () => {
    const out = schema.parse(FULL) as string;
    const body = out.slice(0, -1);
    for (const tok of body.split(" ").filter(Boolean)) {
      expect(FULL).toContain(tok);
    }
  });

  it("leaves a value that already fits completely untouched", () => {
    const short = "passing";
    expect(schema.parse(short)).toBe(short);
    expect(schema.parse(short)).not.toContain("…");
  });

  it("still truncates when there is no space to break on", () => {
    const oneToken = "x".repeat(200);
    const out = schema.parse(oneToken) as string;
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.length).toBeGreaterThan(60);
  });

  it("never returns an empty string, which would fail the min check", () => {
    for (const max of [2, 3, 5, 10]) {
      const out = clampedText(1, max).parse("alpha beta gamma delta") as string;
      expect(out.length).toBeGreaterThan(0);
      expect(out.length).toBeLessThanOrEqual(max);
    }
  });
});
