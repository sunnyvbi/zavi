
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import type { Request, Response } from "express";
import sharp from "sharp";

const TENANT_A = "11111111-aaaa-aaaa-aaaa-111111111111";
const USER_A = "22222222-bbbb-bbbb-bbbb-222222222222";

vi.mock("../../services/auth/middleware", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("../../services/supabase", () => ({
  serviceClient: vi.fn(),
}));

import { requireAuth } from "../../services/auth/middleware";
import { serviceClient } from "../../services/supabase";
import { chatImageUpload } from "../../routes/chat/upload-image";

function mkRes(): Response & { _status: number; _body: unknown } {
  const r: Partial<Response> & { _status: number; _body: unknown } = {
    _status: 0,
    _body: undefined,
    status(code: number) {
      r._status = code;
      return r as Response;
    },
    json(body: unknown) {
      r._body = body;
      return r as Response;
    },
  };
  return r as Response & { _status: number; _body: unknown };
}

function mkReq(file?: Express.Multer.File): Request {
  return { file } as unknown as Request;
}

let uploadSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  uploadSpy = vi.fn().mockResolvedValue({ data: { path: "stored" }, error: null });
  (serviceClient as ReturnType<typeof vi.fn>).mockReturnValue({
    storage: { from: () => ({ upload: uploadSpy }) },
  });
  (requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
    user_id: USER_A,
    tenant_id: TENANT_A,
    access_token: "fake",
  });
});

let realPng: Buffer;
let realJpeg: Buffer;
let realWebp: Buffer;
let transparentPng: Buffer;
let truncatedPng: Buffer;
let gifBytes: Buffer;
let randomGarbage: Buffer;

beforeAll(async () => {
  realPng = await sharp({
    create: { width: 100, height: 100, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  realJpeg = await sharp({
    create: { width: 100, height: 100, channels: 3, background: "red" },
  })
    .jpeg()
    .toBuffer();
  realWebp = await sharp({
    create: { width: 100, height: 100, channels: 3, background: "red" },
  })
    .webp()
    .toBuffer();
  transparentPng = await sharp({
    create: {
      width: 100,
      height: 100,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
  truncatedPng = realPng.subarray(0, 30);
  gifBytes = Buffer.concat([
    Buffer.from("GIF89a", "ascii"),
    Buffer.alloc(50, 0x00),
  ]);
  randomGarbage = Buffer.from(Array.from({ length: 100 }, (_, i) => (i * 37) & 0xff));
});

function mkFile(buf: Buffer, mimetype: string): Express.Multer.File {
  return {
    fieldname: "file",
    originalname: "test.bin",
    encoding: "7bit",
    mimetype,
    size: buf.length,
    buffer: buf,
    destination: "",
    filename: "",
    path: "",
    stream: undefined as never,
  };
}

describe("chat-image-upload", () => {
  it("accepts real PNG → stores as .jpg with image/jpeg content-type", async () => {
    const req = mkReq(mkFile(realPng, "image/png"));
    const res = mkRes();
    await chatImageUpload(req, res);
    expect(res._status).toBe(200);
    expect((res._body as { image_path: string }).image_path).toMatch(
      new RegExp(`^${TENANT_A}/[0-9a-f-]{36}\\.jpg$`),
    );
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    const [path, buf, opts] = uploadSpy.mock.calls[0];
    expect(path).toMatch(/\.jpg$/);
    expect(opts.contentType).toBe("image/jpeg");
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xd8);
    expect(buf[2]).toBe(0xff);
  });

  it("accepts real JPEG → stores as .jpg", async () => {
    const req = mkReq(mkFile(realJpeg, "image/jpeg"));
    const res = mkRes();
    await chatImageUpload(req, res);
    expect(res._status).toBe(200);
    expect((res._body as { image_path: string }).image_path).toMatch(/\.jpg$/);
  });

  it("accepts real WebP → stores as .jpg (normalized output)", async () => {
    const req = mkReq(mkFile(realWebp, "image/webp"));
    const res = mkRes();
    await chatImageUpload(req, res);
    expect(res._status).toBe(200);
    expect((res._body as { image_path: string }).image_path).toMatch(/\.jpg$/);
    const [, buf] = uploadSpy.mock.calls[0];
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xd8);
  });

  it("rejects GIF bytes with 400 unsupported_mime (sniff catches it, header doesn't matter)", async () => {
    const req = mkReq(mkFile(gifBytes, "image/gif"));
    const res = mkRes();
    await chatImageUpload(req, res);
    expect(res._status).toBe(400);
    expect((res._body as { error: { code: string } }).error.code).toBe(
      "unsupported_mime",
    );
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it("rejects random binary garbage with 400 unsupported_mime", async () => {
    const req = mkReq(mkFile(randomGarbage, "image/png"));
    const res = mkRes();
    await chatImageUpload(req, res);
    expect(res._status).toBe(400);
    expect((res._body as { error: { code: string } }).error.code).toBe(
      "unsupported_mime",
    );
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it("rejects truncated-but-valid-magic-bytes with 400 invalid_image (sharp catch)", async () => {
    const req = mkReq(mkFile(truncatedPng, "image/png"));
    const res = mkRes();
    await chatImageUpload(req, res);
    expect(res._status).toBe(400);
    expect((res._body as { error: { code: string } }).error.code).toBe(
      "invalid_image",
    );
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it("SPOOF: JPEG bytes with Content-Type: image/png → sniffed as JPEG, normalized, stored as .jpg", async () => {
    const req = mkReq(mkFile(realJpeg, "image/png"));
    const res = mkRes();
    await chatImageUpload(req, res);
    expect(res._status).toBe(200);
    expect((res._body as { image_path: string }).image_path).toMatch(/\.jpg$/);
    const [, buf, opts] = uploadSpy.mock.calls[0];
    expect(opts.contentType).toBe("image/jpeg");
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xd8);
  });

  it("TRANSPARENCY: PNG with full alpha → flattened to white background in output JPEG", async () => {
    const req = mkReq(mkFile(transparentPng, "image/png"));
    const res = mkRes();
    await chatImageUpload(req, res);
    expect(res._status).toBe(200);
    const [, buf] = uploadSpy.mock.calls[0];
    const meta = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    const centerOffset =
      (Math.floor(meta.info.height / 2) * meta.info.width +
        Math.floor(meta.info.width / 2)) *
      meta.info.channels;
    const [r, g, b] = [
      meta.data[centerOffset],
      meta.data[centerOffset + 1],
      meta.data[centerOffset + 2],
    ];
    expect(r).toBeGreaterThan(240);
    expect(g).toBeGreaterThan(240);
    expect(b).toBeGreaterThan(240);
  });

  it("rejects missing file with 400 no_file", async () => {
    const req = mkReq(undefined);
    const res = mkRes();
    await chatImageUpload(req, res);
    expect(res._status).toBe(400);
    expect((res._body as { error: { code: string } }).error.code).toBe("no_file");
  });
});
