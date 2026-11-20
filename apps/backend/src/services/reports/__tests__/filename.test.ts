
import { describe, it, expect } from "vitest";
import { normalizeArtifactFilename } from "../filename";
import { ExpectedToolError } from "@/services/tools/types";

describe("normalizeArtifactFilename", () => {
  it("accepts a clean `.pdf` filename unchanged", () => {
    const out = normalizeArtifactFilename("report.pdf");
    expect(out).toEqual({ filename: "report.pdf", mime: "application/pdf" });
  });

  it("force-appends `.pdf` when missing", () => {
    const out = normalizeArtifactFilename("q1-report");
    expect(out.filename).toBe("q1-report.pdf");
    expect(out.mime).toBe("application/pdf");
  });

  it("strips path traversal (`../leak.pdf` → `leak.pdf`)", () => {
    const out = normalizeArtifactFilename("../leak.pdf");
    expect(out.filename).toBe("leak.pdf");
  });

  it("force-appends `.pdf` when given a non-pdf extension (`report.html` → `report.html.pdf`)", () => {
    const out = normalizeArtifactFilename("report.html");
    expect(out.filename).toBe("report.html.pdf");
  });

  it("throws ExpectedToolError(filename_invalid) on empty sanitization output", () => {
    expect(() => normalizeArtifactFilename("///")).toThrow(ExpectedToolError);
    try {
      normalizeArtifactFilename("///");
    } catch (e) {
      expect((e as ExpectedToolError).code).toBe("filename_invalid");
    }
  });

  it("respects the 120-char cap even after `.pdf` is appended", () => {
    const longName = "a".repeat(200);
    const out = normalizeArtifactFilename(longName);
    expect(out.filename.length).toBeLessThanOrEqual(120);
    expect(out.filename.endsWith(".pdf")).toBe(true);
  });
});
