import { describe, it, expect } from "vitest";
import { buildPreviewFilterChain } from "../render";

const countOf = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("public preview filter chain", () => {
  it("scales to 720p by default — not the old 360p", () => {
    expect(buildPreviewFilterChain({ text: "zaviagent.com" })).toContain("scale=1280:-2");
  });

  it("stamps EXACTLY ONE watermark, and it is corner-anchored", () => {
    const vf = buildPreviewFilterChain({ text: "zaviagent.com" });
    expect(countOf(vf, "drawtext=")).toBe(1);
    expect(vf).toContain("x=w-text_w-16");
    expect(vf).toContain("y=h-text_h-16");
    expect(vf).not.toContain("x=(w-text_w)/2");
    expect(vf).not.toContain("y=(h-text_h)/2");
  });

  it("still carries the mark — removing the centre stamp must not remove the watermark", () => {
    expect(buildPreviewFilterChain({ text: "zaviagent.com" })).toContain("zaviagent.com");
  });

  it("honours an explicit maxWidth and clamps it to sane bounds", () => {
    expect(buildPreviewFilterChain({ text: "x", maxWidth: 640 })).toContain("scale=640:-2");
    expect(buildPreviewFilterChain({ text: "x", maxWidth: 4000 })).toContain("scale=1280:-2");
    expect(buildPreviewFilterChain({ text: "x", maxWidth: 10 })).toContain("scale=160:-2");
  });

  it("escapes drawtext metacharacters so a colon in the text cannot break the chain", () => {
    expect(buildPreviewFilterChain({ text: "https://zaviagent.com" })).toContain(
      "https\\://zaviagent.com",
    );
  });
});
