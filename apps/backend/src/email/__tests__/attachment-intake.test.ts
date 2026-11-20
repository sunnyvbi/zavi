import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

import {
  validateAttachment,
  sniffOk,
  storeInboundAttachments,
  type Uploader,
} from "../attachment-intake";
import { asTenantId } from "@/services/tenant-client";

const PDF = Buffer.from("%PDF-1.7\n...body...");
const b64 = (b: Buffer) => b.toString("base64");
function att(over: Record<string, unknown> = {}) {
  return {
    filename: "report.pdf",
    mime_type: "application/pdf",
    ext: "pdf",
    content_base64: b64(PDF),
    ...over,
  };
}

describe("validateAttachment — server-side re-validation (never trust the worker)", () => {
  it("accepts a real pdf", () => {
    const v = validateAttachment(att());
    expect("skip" in v).toBe(false);
    if (!("skip" in v)) {
      expect(v.ext).toBe("pdf");
      expect(v.mime).toBe("application/pdf");
      expect(v.buf.subarray(0, 4).toString()).toBe("%PDF");
    }
  });

  it("rejects a disallowed mime type", () => {
    expect(validateAttachment(att({ mime_type: "application/zip" }))).toEqual({
      skip: "disallowed_mime:application/zip",
    });
  });

  it("rejects a pdf mime whose bytes are NOT a pdf (magic mismatch)", () => {
    const fake = Buffer.from("<html>not a pdf</html>");
    expect(validateAttachment(att({ content_base64: b64(fake) }))).toEqual({
      skip: "magic_mismatch:pdf",
    });
  });

  it("rejects oversize (>6MB)", () => {
    const big = Buffer.concat([Buffer.from("%PDF"), Buffer.alloc(6 * 1024 * 1024 + 1)]);
    const v = validateAttachment(att({ content_base64: b64(big) }));
    expect("skip" in v && v.skip.startsWith("oversize")).toBe(true);
  });

  it("rejects empty content", () => {
    expect(validateAttachment(att({ content_base64: "" }))).toEqual({ skip: "empty_content" });
  });

  it("rejects a sha256 that does not match the decoded bytes (tamper)", () => {
    const v = validateAttachment(att({ sha256: "deadbeef" }));
    expect(v).toEqual({ skip: "sha256_mismatch" });
  });

  it("does NOT trust the worker-claimed ext — mime drives it", () => {
    const v = validateAttachment(att({ ext: "txt" }));
    expect("skip" in v ? v : v.ext).toBe("pdf");
  });

  it("accepts txt/csv without magic and sanitizes the filename", () => {
    const v = validateAttachment({
      filename: "../../etc/passwd\n.csv",
      mime_type: "text/csv",
      content_base64: b64(Buffer.from("a,b,c\n1,2,3")),
    });
    expect("skip" in v).toBe(false);
    if (!("skip" in v)) {
      expect(v.ext).toBe("csv");
      expect(v.filename).not.toContain("/");
      expect(v.filename).not.toContain("\n");
    }
  });

  it("sniffOk: docx PK zip magic accepted, random bytes rejected", () => {
    expect(sniffOk("docx", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe(true);
    expect(sniffOk("docx", Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBe(false);
    expect(sniffOk("txt", Buffer.from("anything"))).toBe(true);
  });
});

describe("storeInboundAttachments — tenant-scoped write + degrade-not-drop", () => {
  const TID = asTenantId("tenant-xyz");

  it("returns [] for non-array / empty input", async () => {
    expect(await storeInboundAttachments(TID, undefined)).toEqual([]);
    expect(await storeInboundAttachments(TID, [])).toEqual([]);
  });

  it("uploads a valid attachment to <tenant>/<uuid>.<ext> and returns the ref", async () => {
    const calls: Array<{ path: string; ct: string }> = [];
    const uploader: Uploader = async (path, _buf, ct) => {
      calls.push({ path, ct });
      return { error: null };
    };
    const stored = await storeInboundAttachments(TID, [att()], { uploader });
    expect(stored).toHaveLength(1);
    expect(stored[0].storage_path).toMatch(/^tenant-xyz\/[0-9a-f-]{36}\.pdf$/);
    expect(stored[0].mime_type).toBe("application/pdf");
    expect(calls[0].path).toBe(stored[0].storage_path);
    expect(calls[0].ct).toBe("application/pdf");
  });

  it("skips an invalid attachment but stores the valid ones (never drops the batch)", async () => {
    const uploader: Uploader = async () => ({ error: null });
    const stored = await storeInboundAttachments(
      TID,
      [att({ mime_type: "application/zip" }), att()],
      { uploader },
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].storage_path).toContain("tenant-xyz/");
  });

  it("degrades (skips) on an upload error, does not throw", async () => {
    const uploader: Uploader = async () => ({ error: { message: "bucket boom" } });
    const stored = await storeInboundAttachments(TID, [att()], { uploader });
    expect(stored).toEqual([]);
  });

  it("caps the count at 5", async () => {
    const uploader: Uploader = async () => ({ error: null });
    const many = Array.from({ length: 8 }, () => att());
    const stored = await storeInboundAttachments(TID, many, { uploader });
    expect(stored.length).toBeLessThanOrEqual(5);
  });

  it("writes the path prefix from the GUARDED tenant id (isolation boundary)", async () => {
    let seenPath = "";
    const uploader: Uploader = async (path) => {
      seenPath = path;
      return { error: null };
    };
    await storeInboundAttachments(asTenantId("tenant-A"), [att()], { uploader });
    expect(seenPath.startsWith("tenant-A/")).toBe(true);
  });
});
