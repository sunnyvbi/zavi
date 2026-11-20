import { describe, it, expect } from "vitest";
import {
  sanitizeArtifactFilename,
  artifactMimeForFilename,
  artifactBytesMatchMime,
  ARTIFACT_MAX_BYTES,
} from "../sdk/mcp-sandbox";

describe("sanitizeArtifactFilename — untrusted model input", () => {
  it("keeps a normal filename (lowercased)", () => {
    expect(sanitizeArtifactFilename("Report.PDF")).toBe("report.pdf");
  });

  it("strips path traversal — basename only, no directory survives", () => {
    expect(sanitizeArtifactFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeArtifactFilename("a/b/c/report.csv")).toBe("report.csv");
  });

  it("strips leading dots so no hidden/.. names", () => {
    expect(sanitizeArtifactFilename("...report.pdf")).toBe("report.pdf");
  });

  it("strips control chars and disallowed punctuation", () => {
    expect(sanitizeArtifactFilename("re\x00port name!.pdf")).toBe("reportname.pdf");
  });

  it("returns empty when nothing usable remains", () => {
    expect(sanitizeArtifactFilename("///")).toBe("");
    expect(sanitizeArtifactFilename("")).toBe("");
  });

  it("caps length at 120 chars", () => {
    const long = `${"a".repeat(200)}.pdf`;
    expect(sanitizeArtifactFilename(long).length).toBe(120);
  });
});

describe("artifactMimeForFilename — extension allowlist", () => {
  it("resolves the allowed extensions", () => {
    expect(artifactMimeForFilename("a.pdf")).toBe("application/pdf");
    expect(artifactMimeForFilename("a.csv")).toBe("text/csv");
    expect(artifactMimeForFilename("a.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(artifactMimeForFilename("a.pptx")).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(artifactMimeForFilename("a.png")).toBe("image/png");
    expect(artifactMimeForFilename("contact-sheet.png")).toBe("image/png");
  });

  it("rejects everything else", () => {
    expect(artifactMimeForFilename("a.exe")).toBeNull();
    expect(artifactMimeForFilename("a.html")).toBeNull();
    expect(artifactMimeForFilename("noextension")).toBeNull();
  });

  it("does NOT accept jpeg/webp/svg — PNG-only in v1 (each needs its own magic-byte branch)", () => {
    expect(artifactMimeForFilename("a.jpg")).toBeNull();
    expect(artifactMimeForFilename("a.jpeg")).toBeNull();
    expect(artifactMimeForFilename("a.webp")).toBeNull();
    expect(artifactMimeForFilename("a.svg")).toBeNull();
  });
});

describe("artifactBytesMatchMime — magic-byte sniff (content trust)", () => {
  const u8 = (...b: number[]) => Uint8Array.from(b);

  it("accepts a real PDF header", () => {
    expect(artifactBytesMatchMime(u8(0x25, 0x50, 0x44, 0x46, 0x2d), "application/pdf")).toBe(true);
  });

  it("rejects a non-PDF claiming to be PDF", () => {
    expect(artifactBytesMatchMime(u8(0x00, 0x01, 0x02, 0x03, 0x04), "application/pdf")).toBe(false);
  });

  it("accepts an XLSX (ZIP) header", () => {
    expect(
      artifactBytesMatchMime(
        u8(0x50, 0x4b, 0x03, 0x04),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe(true);
  });

  it("accepts a PPTX (ZIP) header and rejects a non-ZIP claiming pptx", () => {
    const pptxMime =
      "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    expect(artifactBytesMatchMime(u8(0x50, 0x4b, 0x03, 0x04), pptxMime)).toBe(true);
    expect(artifactBytesMatchMime(u8(0x25, 0x50, 0x44, 0x46, 0x2d), pptxMime)).toBe(false);
  });

  it("accepts CSV text but rejects content with a NUL byte", () => {
    expect(artifactBytesMatchMime(new TextEncoder().encode("a,b,c\n1,2,3"), "text/csv")).toBe(true);
    expect(artifactBytesMatchMime(u8(0x61, 0x00, 0x62), "text/csv")).toBe(false);
  });

  it("accepts an mp4 with `ftyp` at bytes 4-7", () => {
    expect(
      artifactBytesMatchMime(u8(0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73), "video/mp4"),
    ).toBe(true);
  });

  it("rejects a non-mp4 claiming to be mp4 (no ftyp box)", () => {
    expect(artifactBytesMatchMime(u8(0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07), "video/mp4")).toBe(false);
    expect(artifactBytesMatchMime(u8(0x66, 0x74, 0x79, 0x70), "video/mp4")).toBe(false);
  });

  it("accepts a real PNG 8-byte signature", () => {
    expect(
      artifactBytesMatchMime(
        u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00),
        "image/png",
      ),
    ).toBe(true);
  });

  it("rejects a non-PNG claiming to be PNG (and a truncated signature)", () => {
    expect(artifactBytesMatchMime(u8(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46), "image/png")).toBe(false);
    expect(artifactBytesMatchMime(u8(0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00), "image/png")).toBe(false);
    expect(artifactBytesMatchMime(u8(0x89, 0x50, 0x4e, 0x47), "image/png")).toBe(false);
  });

  it("rejects an unknown mime", () => {
    expect(artifactBytesMatchMime(u8(0x25, 0x50), "application/x-evil")).toBe(false);
  });
});

describe("artifact cap", () => {
  it("is 200 MB (raised from 25MB for launch-video mp4 headroom, 2026-06-29)", () => {
    expect(ARTIFACT_MAX_BYTES).toBe(200 * 1024 * 1024);
  });
});
