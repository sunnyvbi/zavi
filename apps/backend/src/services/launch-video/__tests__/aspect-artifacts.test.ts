import { describe, it, expect } from "vitest";
import { resolveRenderAspects, aspectArtifactFilename } from "../aspect-artifacts";

describe("resolveRenderAspects", () => {
  it("uses an explicit aspects list (filtered to valid, deduped)", () => {
    expect(resolveRenderAspects(["9:16", "16:9"], "16:9")).toEqual(["9:16", "16:9"]);
    expect(resolveRenderAspects(["9:16", "9:16", "1:1"], "16:9")).toEqual(["9:16", "1:1"]);
    expect(resolveRenderAspects(["9:16", "4:3", "garbage"], "16:9")).toEqual(["9:16"]);
  });

  it("falls back to the brief aspect when no explicit list", () => {
    expect(resolveRenderAspects(undefined, "9:16")).toEqual(["9:16"]);
    expect(resolveRenderAspects([], "1:1")).toEqual(["1:1"]);
    expect(resolveRenderAspects(undefined, undefined)).toEqual(["16:9"]);
    expect(resolveRenderAspects("not-an-array", "16:9")).toEqual(["16:9"]);
  });
});

describe("aspectArtifactFilename", () => {
  it("maps each aspect to a distinct artifact filename → N aspects = N rows", () => {
    expect(aspectArtifactFilename("16:9")).toBe("video-16x9.mp4");
    expect(aspectArtifactFilename("1:1")).toBe("video-1x1.mp4");
    expect(aspectArtifactFilename("9:16")).toBe("video-9x16.mp4");
    const names = (["16:9", "1:1", "9:16"] as const).map((a) => aspectArtifactFilename(a));
    expect(new Set(names).size).toBe(3);
  });

  it("single-variant (no label) is BYTE-IDENTICAL to the legacy single-arg call", () => {
    expect(aspectArtifactFilename("16:9", undefined)).toBe("video-16x9.mp4");
    expect(aspectArtifactFilename("16:9")).toBe("video-16x9.mp4");
  });

  it("A/B variant label inserts a variant token before the aspect token", () => {
    expect(aspectArtifactFilename("16:9", "A")).toBe("video-A-16x9.mp4");
    expect(aspectArtifactFilename("9:16", "B")).toBe("video-B-9x16.mp4");
    const combos = [
      aspectArtifactFilename("16:9", "A"),
      aspectArtifactFilename("9:16", "A"),
      aspectArtifactFilename("16:9", "B"),
      aspectArtifactFilename("9:16", "B"),
    ];
    expect(new Set(combos).size).toBe(4);
  });
});
