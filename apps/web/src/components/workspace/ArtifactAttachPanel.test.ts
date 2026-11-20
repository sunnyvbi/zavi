import { describe, expect, it } from "vitest";
import { isAttachableArtifact } from "./ArtifactAttachPanel";

describe("isAttachableArtifact", () => {
  it("never offers a tab-task step screenshot (it stays behind See what Zavi saw)", () => {
    expect(isAttachableArtifact({ filename: "tab-task-0b8f3a.jpg", mime: "image/jpeg" } as any)).toBe(false);
  });
  it("still offers ordinary images and documents", () => {
    expect(isAttachableArtifact({ filename: "chart.png", mime: "image/png" } as any)).toBe(true);
    expect(isAttachableArtifact({ filename: "brief.pdf", mime: "application/pdf" } as any)).toBe(true);
  });
});
