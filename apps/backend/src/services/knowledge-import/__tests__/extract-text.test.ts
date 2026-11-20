import { describe, it, expect, vi } from "vitest";
vi.mock("pdf-parse", () => ({ default: vi.fn(async (b: Buffer) => ({ text: b.toString() === "scan" ? "  \n " : "PDF body text" })) }));
vi.mock("mammoth", () => ({ default: { extractRawText: vi.fn(async () => ({ value: "Word body text" })) } }));
import { extractText, fileKind } from "../extract-text";

describe("extractText", () => {
  it("reads utf8 text formats", async () => {
    for (const ext of ["md", "txt", "csv", "json"]) {
      expect(await extractText(Buffer.from("hello world"), ext)).toEqual({ ok: true, text: "hello world" });
    }
  });
  it("reads pdf and docx", async () => {
    expect(await extractText(Buffer.from("x"), "pdf")).toEqual({ ok: true, text: "PDF body text" });
    expect(await extractText(Buffer.from("x"), "docx")).toEqual({ ok: true, text: "Word body text" });
  });
  it("gives a founder-readable reason instead of throwing", async () => {
    expect(await extractText(Buffer.from(""), "md")).toEqual({ ok: false, reason: "the file is empty" });
    expect(await extractText(Buffer.from("scan"), "pdf")).toEqual({ ok: false, reason: "no text in it, it may be a scan" });
    expect(await extractText(Buffer.from("a\u0000b"), "txt")).toEqual({ ok: false, reason: "it isn't a text file" });
    expect(await extractText(Buffer.from("x"), "xlsx")).toEqual({ ok: false, reason: ".xlsx files aren't supported" });
  });
  it("classifies file kinds", () => {
    expect(fileKind("notes.MD")).toBe("text");
    expect(fileKind("logo.png")).toBe("image");
    expect(fileKind("sheet.xlsx")).toBe("unsupported");
  });
});
