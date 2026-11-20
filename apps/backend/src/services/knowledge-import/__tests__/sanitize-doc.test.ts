import { describe, it, expect } from "vitest";
import { sanitizeDocumentText } from "../sanitize-doc";

describe("sanitizeDocumentText", () => {
  it("keeps line breaks, including blank lines", () => {
    expect(sanitizeDocumentText("one\ntwo\n\nfour")).toBe("one\ntwo\n\nfour");
    expect(sanitizeDocumentText("a\r\nb")).toBe("a\nb");
  });
  it("still strips markup and decodes entities like the web sanitizer", () => {
    expect(sanitizeDocumentText("<b>bold</b>\nsk&#45;x")).toBe("bold\nsk-x");
  });
});
