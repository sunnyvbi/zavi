import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseResume } from "../../services/resume-parse";

const pdfPath = join(__dirname, "fixtures/sample.pdf");
const docxPath = join(__dirname, "fixtures/sample.docx");

describe("parseResume", () => {
  it("extracts text from a PDF buffer", async () => {
    const buf = readFileSync(pdfPath);
    const out = await parseResume({ buffer: buf, mimetype: "application/pdf" });
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.parse_error).toBeUndefined();
  });

  it("extracts text from a docx buffer", async () => {
    if (!existsSync(docxPath)) {
      return;
    }
    const buf = readFileSync(docxPath);
    const out = await parseResume({
      buffer: buf,
      mimetype:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(out.text.length).toBeGreaterThan(0);
  });

  it("handles plaintext as identity", async () => {
    const out = await parseResume({
      buffer: Buffer.from("Plain resume text", "utf-8"),
      mimetype: "text/plain",
    });
    expect(out.text).toBe("Plain resume text");
  });

  it("returns parse_error for unsupported mimetypes without throwing", async () => {
    const out = await parseResume({
      buffer: Buffer.from("x"),
      mimetype: "image/png",
    });
    expect(out.text).toBe("");
    expect(out.parse_error).toMatch(/unsupported/i);
  });
});
