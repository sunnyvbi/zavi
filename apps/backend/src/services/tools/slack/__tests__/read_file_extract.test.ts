
import { describe, expect, it } from "vitest";
import { extractText, renderInputToText } from "../read_file";

describe("renderInputToText — read our own document back losslessly", () => {
  it("flattens the structured render input we rendered the PDF from", () => {
    const text = renderInputToText({
      title: "Meta Pixel Implementation Plan: private-rents.com",
      sections: [
        {
          heading: "1. Executive Summary",
          body_markdown: "Wire Meta Pixel + CAPI into private-rents.com.",
        },
        {
          heading: "2. Files",
          table: {
            columns: ["File", "Action"],
            rows: [["MetaPixel.tsx", "CREATE"]],
          },
        },
      ],
    });

    expect(text).toContain("# Meta Pixel Implementation Plan: private-rents.com");
    expect(text).toContain("## 1. Executive Summary");
    expect(text).toContain("Wire Meta Pixel + CAPI into private-rents.com.");
    expect(text).toContain("| File | Action |");
    expect(text).toContain("| MetaPixel.tsx | CREATE |");
  });

  it("returns empty string on a shape it cannot use (caller falls back to download)", () => {
    expect(renderInputToText(null)).toBe("");
    expect(renderInputToText({ title: "no sections" })).toBe("");
  });
});

describe("extractText", () => {
  it("reads plain text and markdown", async () => {
    const buf = Buffer.from("# Plan\n\nStep one.", "utf-8");
    await expect(extractText(buf, "markdown", "plan.md")).resolves.toContain("Step one.");
    await expect(extractText(buf, "", "plan.txt")).resolves.toContain("# Plan");
  });

  it("raises a VISIBLE error on an unsupported type — never an empty success", async () => {
    await expect(
      extractText(Buffer.from([0x00, 0x01]), "png", "screenshot.png"),
    ).rejects.toMatchObject({ code: "file_unreadable" });
  });
});
