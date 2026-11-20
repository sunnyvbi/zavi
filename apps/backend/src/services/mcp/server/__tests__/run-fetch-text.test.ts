
import { describe, it, expect } from "vitest";
import { buildRunFetchText } from "@/services/mcp/server/run-fetch-text";

describe("buildRunFetchText", () => {
  it("returns the structured decision when parsed is present", () => {
    const text = buildRunFetchText({
      parsed: { title: "fix(x)", repo: "a/b" },
      output_text: "ignored",
      raw_response_text: "ignored",
    });
    expect(text).toContain("fix(x)");
    expect(text).toContain("a/b");
  });

  it("falls back to output_text when parsed is null (the held-PR bug)", () => {
    const text = buildRunFetchText({
      parsed: null,
      output_text: "I'm not staging a PR — the critic flagged a P1. Root cause: …",
      raw_response_text: "raw",
    });
    expect(text).toContain("critic flagged a P1");
  });

  it("falls back to output_text when parsed is an EMPTY object", () => {
    const text = buildRunFetchText({
      parsed: {},
      output_text: "held: here is the diagnosis",
    });
    expect(text).toBe("held: here is the diagnosis");
  });

  it("falls back to raw_response_text when parsed AND output_text are empty", () => {
    const text = buildRunFetchText({
      parsed: null,
      output_text: "  ",
      raw_response_text: "the full model investigation",
    });
    expect(text).toBe("the full model investigation");
  });

  it("returns '{}' only when nothing useful exists", () => {
    expect(buildRunFetchText({ parsed: null })).toBe("{}");
    expect(
      buildRunFetchText({ parsed: {}, output_text: "", raw_response_text: "" }),
    ).toBe("{}");
  });
});
