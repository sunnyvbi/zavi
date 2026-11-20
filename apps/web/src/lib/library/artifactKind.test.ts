
import { describe, it, expect } from "vitest";
import {
  artifactKind,
  formatBytes,
  formatCreatedAt,
  ARTIFACT_KINDS,
} from "./artifactKind";

describe("artifactKind", () => {
  it("classifies the file types the report__* tools actually emit", () => {
    expect(artifactKind("application/pdf", "q3-report.pdf")).toBe("Document");
    expect(artifactKind("text/csv", "spend.csv")).toBe("Spreadsheet");
    expect(
      artifactKind(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "model.xlsx",
      ),
    ).toBe("Spreadsheet");
    expect(artifactKind("image/png", "post-1.png")).toBe("Image");
    expect(artifactKind("text/html", "launch-post.html")).toBe("Document");
    expect(artifactKind("text/plain", "copy-1.txt")).toBe("Document");
  });

  it("badges video rows that exist in prod but come from no report tool", () => {
    expect(artifactKind("video/mp4", "video-16x9.mp4")).toBe("Video");
  });

  it("separates a deck from a report even though both are PDFs", () => {
    expect(artifactKind("application/pdf", "seed-deck.pdf")).toBe("Deck");
    expect(artifactKind("application/pdf", "investor deck.pdf")).toBe("Deck");
    expect(artifactKind("application/pdf", "q3-slides.pdf")).toBe("Deck");
    expect(artifactKind("application/pdf", "decklist.pdf")).toBe("Document");
    expect(artifactKind("application/pdf", "redecking-costs.pdf")).toBe("Document");
  });

  it("falls back on extension when the mime is missing or generic", () => {
    expect(artifactKind("", "report.pdf")).toBe("Document");
    expect(artifactKind("application/octet-stream", "data.csv")).toBe("Spreadsheet");
    expect(artifactKind("application/octet-stream", "mystery.bin")).toBe("File");
    expect(artifactKind("", "")).toBe("File");
  });

  it("only advertises kinds the filter chips can render", () => {
    for (const mime of ["application/pdf", "text/csv", "image/png", "x/y"]) {
      const k = artifactKind(mime, "f");
      expect(ARTIFACT_KINDS).toContain(k);
    }
  });
});

describe("formatBytes", () => {
  it("scales B / KB / MB", () => {
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(1024 * 500)).toBe("500 KB");
    expect(formatBytes(1024 * 1024 * 3.5)).toBe("3.5 MB");
  });

  it("renders a dash placeholder for a missing size rather than a misleading '0 B'", () => {
    expect(formatBytes(0)).toBe("-");
    expect(formatBytes(-1)).toBe("-");
    expect(formatBytes(Number.NaN)).toBe("-");
  });
});

describe("formatCreatedAt", () => {
  it("omits the year for the current year and includes it otherwise", () => {
    const now = new Date("2026-08-31T00:00:00Z");
    expect(formatCreatedAt("2026-08-30T12:00:00Z", now)).not.toMatch(/2026/);
    expect(formatCreatedAt("2024-01-05T12:00:00Z", now)).toMatch(/2024/);
  });

  it("never throws on a malformed timestamp", () => {
    expect(formatCreatedAt("not-a-date")).toBe("-");
  });
});
