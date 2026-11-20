
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { describeIntakeGaps } from "../intake-gaps";

const schema = z.object({ audience: z.string(), url: z.string(), tone: z.string().min(3) });

function gapsFor(input: unknown): string {
  try {
    schema.parse(input);
    throw new Error("expected a parse failure");
  } catch (e) {
    return describeIntakeGaps(e);
  }
}

describe("describeIntakeGaps", () => {
  it("names EVERY missing field in one message", () => {
    const msg = gapsFor({ tone: "bold" });
    expect(msg).toContain("`audience`");
    expect(msg).toContain("`url`");
    expect(msg).toContain("2 things");
  });

  it("explains what each known field is, so the model can ask for it in words", () => {
    expect(gapsFor({ url: "x", tone: "bold" })).toContain("who the video is for");
  });

  it("separates present-but-unusable from missing", () => {
    const msg = gapsFor({ audience: "renters", url: "x", tone: "a" });
    expect(msg).toContain("present but not usable");
    expect(msg).toContain("`tone`");
  });

  it("carries no raw ZodIssue JSON", () => {
    const msg = gapsFor({ tone: "bold" });
    expect(msg).not.toContain("invalid_type");
    expect(msg).not.toContain('"path"');
  });

  it("falls back to the raw message on a non-zod error rather than swallowing it", () => {
    expect(describeIntakeGaps(new Error("boom"))).toContain("boom");
  });
});

describe("both render_video branches use it", () => {
  it("names the exact fields the incident run lost, in ONE message", () => {
    const msg = gapsFor({});
    expect(msg).toContain("`audience`");
    expect(msg).toContain("`url`");
    expect(msg.split("I still need").length).toBe(2);
  });
});
