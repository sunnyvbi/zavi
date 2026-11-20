import { describe, expect, it } from "vitest";
import { formatArtifactBytes, formatArtifactDate, formatArtifactDateShort } from "./formatArtifact";
import { artifactTypeLabel, isArtifactFilter } from "./types";

describe("artifact presentation", () => {
  it("formats dates with an explicit stable timezone", () => {
    expect(formatArtifactDate("2026-09-08T23:30:00-07:00")).toBe("Sep 9, 2026");
    expect(formatArtifactDate("invalid")).toBe("Unknown date");
  });

  it("tile dates drop the year inside the current year and keep it otherwise", () => {
    const now = Date.parse("2026-09-25T12:00:00Z");
    expect(formatArtifactDateShort("2026-09-08T23:30:00-07:00", now)).toBe("Sep 9");
    expect(formatArtifactDateShort("2025-12-31T23:30:00Z", now)).toBe("Dec 31, 2025");
    expect(formatArtifactDateShort("2027-01-01T00:00:00Z", now)).toBe("Jan 1, 2027");
    expect(formatArtifactDateShort("invalid", now)).toBe("Unknown date");
  });

  it("formats file sizes", () => {
    expect(formatArtifactBytes(2048)).toBe("2.0 KB");
    expect(formatArtifactBytes(3.5 * 1024 * 1024)).toBe("3.5 MB");
  });

  it("accepts only real artifact filters", () => {
    expect(isArtifactFilter("dashboard")).toBe(true);
    expect(isArtifactFilter("all")).toBe(true);
    expect(isArtifactFilter("messages")).toBe(false);
    expect(artifactTypeLabel("presentation")).toBe("Slides");
  });
});
