import { describe, it, expect } from "vitest";
import { downloadAsDocBlocks, pathBelongsToTenant } from "../chat-history";

const TENANT = "11111111-aaaa-aaaa-aaaa-111111111111";
const UUID = "22222222-bbbb-bbbb-bbbb-222222222222";
const docPath = (ext: string) => `${TENANT}/${UUID}.${ext}`;

const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF", "latin1");

type DownloadResult = {
  data: { arrayBuffer: () => Promise<ArrayBuffer> } | null;
  error: { message: string } | null;
};
function makeSb(handler: (path: string) => DownloadResult) {
  return {
    storage: { from: () => ({ download: async (p: string) => handler(p) }) },
  } as unknown as Parameters<typeof downloadAsDocBlocks>[0];
}
const ok = (buf: Buffer) => () => ({
  data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) },
  error: null,
});

describe("pathBelongsToTenant (doc)", () => {
  it("accepts a well-formed tenant-scoped doc path", () => {
    expect(pathBelongsToTenant(docPath("pdf"), TENANT, "doc")).toBe(true);
    expect(pathBelongsToTenant(docPath("docx"), TENANT, "doc")).toBe(true);
    expect(pathBelongsToTenant(docPath("csv"), TENANT, "doc")).toBe(true);
    expect(pathBelongsToTenant(docPath("txt"), TENANT, "doc")).toBe(true);
  });

  it("rejects another tenant's path (cross-tenant)", () => {
    const other = "99999999-cccc-cccc-cccc-999999999999";
    expect(pathBelongsToTenant(`${other}/${UUID}.pdf`, TENANT, "doc")).toBe(false);
  });

  it("rejects traversal + disallowed extension + wrong kind", () => {
    expect(pathBelongsToTenant(`${TENANT}/../etc/passwd.pdf`, TENANT, "doc")).toBe(false);
    expect(pathBelongsToTenant(`${TENANT}/${UUID}.exe`, TENANT, "doc")).toBe(false);
    expect(pathBelongsToTenant(`${TENANT}/${UUID}.pdf.exe`, TENANT, "doc")).toBe(false);
    expect(pathBelongsToTenant(docPath("pdf"), TENANT, "image")).toBe(false);
  });
});

describe("downloadAsDocBlocks", () => {
  it("pdf → native document block (base64)", async () => {
    const blocks = await downloadAsDocBlocks(makeSb(ok(PDF_BYTES)), docPath("pdf"));
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0]).toMatchObject({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: PDF_BYTES.toString("base64") },
    });
  });

  it("csv → text block with filename header", async () => {
    const csv = Buffer.from("a,b\n1,2", "utf-8");
    const blocks = await downloadAsDocBlocks(makeSb(ok(csv)), docPath("csv"));
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0]).toMatchObject({ type: "text" });
    expect((blocks?.[0] as { text: string }).text).toContain("a,b\n1,2");
    expect((blocks?.[0] as { text: string }).text).toContain(`${UUID}.csv`);
  });

  it("txt → text block", async () => {
    const txt = Buffer.from("hello world", "utf-8");
    const blocks = await downloadAsDocBlocks(makeSb(ok(txt)), docPath("txt"));
    expect((blocks?.[0] as { text: string }).text).toContain("hello world");
  });

  it("char-caps oversized text extraction", async () => {
    const huge = Buffer.from("x".repeat(250_000), "utf-8");
    const blocks = await downloadAsDocBlocks(makeSb(ok(huge)), docPath("txt"));
    const text = (blocks?.[0] as { text: string }).text;
    expect(text).toContain("truncated");
    expect(text.length).toBeLessThan(220_000);
  });

  it("returns null on download error (caller surfaces failure)", async () => {
    const sb = makeSb(() => ({ data: null, error: { message: "boom" } }));
    expect(await downloadAsDocBlocks(sb, docPath("pdf"))).toBeNull();
  });

  it("returns null for an unsupported extension", async () => {
    const blocks = await downloadAsDocBlocks(makeSb(ok(PDF_BYTES)), `${TENANT}/${UUID}.xlsx`);
    expect(blocks).toBeNull();
  });
});
