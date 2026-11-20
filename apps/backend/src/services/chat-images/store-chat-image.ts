
import type { NextFunction, Request, Response } from "express";
import multer, { MulterError } from "multer";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { asTenantId, tenantStorage } from "@/services/tenant-client";

export const CHAT_IMAGE_BUCKET = "agent-chat-images";
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_LONG_EDGE = 1568;
const JPEG_QUALITY = 85;
const LIMIT_INPUT_PIXELS = 67108864;

type ImageMime = "image/png" | "image/jpeg" | "image/webp";
export function sniffImageMime(buf: Buffer): ImageMime | null {
  if (buf.length < 12) return null;
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return "image/png";
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

export function chatImageUploadMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const inner = upload.single("file");
  inner(req, res, (err: unknown) => {
    if (err instanceof MulterError) {
      const code =
        err.code === "LIMIT_FILE_SIZE" ? "file_too_large" : "upload_rejected";
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? `image exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024}MB cap`
          : err.message;
      res.status(400).json({ error: { code, message } });
      return;
    }
    if (err) {
      res
        .status(400)
        .json({ error: { code: "upload_rejected", message: String(err) } });
      return;
    }
    next();
  });
}

export type ChatImageError = {
  ok: false;
  status: 400 | 500;
  code: string;
  message: string;
};

export function readUploadedFile(
  req: Request,
): { ok: true; file: Express.Multer.File } | ChatImageError {
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) {
    return {
      ok: false,
      status: 400,
      code: "no_file",
      message: "file field is required",
    };
  }
  return { ok: true, file };
}

export async function normalizeChatImage(
  buf: Buffer,
): Promise<{ ok: true; jpeg: Buffer } | ChatImageError> {
  const sniffed = sniffImageMime(buf);
  if (!sniffed) {
    return {
      ok: false,
      status: 400,
      code: "unsupported_mime",
      message: "file content not recognized as png/jpeg/webp",
    };
  }

  try {
    const jpeg = await sharp(buf, {
      failOn: "truncated",
      limitInputPixels: LIMIT_INPUT_PIXELS,
    })
      .rotate()
      .resize(MAX_OUTPUT_LONG_EDGE, MAX_OUTPUT_LONG_EDGE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    return { ok: true, jpeg };
  } catch (e) {
    return {
      ok: false,
      status: 400,
      code: "invalid_image",
      message: `image could not be processed: ${(e as Error).message}`,
    };
  }
}

export async function storeNormalizedChatImage(
  tenant_id: string,
  jpeg: Buffer,
  folder?: string,
): Promise<{ ok: true; image_path: string } | ChatImageError> {
  if (folder !== undefined && !/^[0-9a-f-]{36}$/.test(folder)) {
    return { ok: false, status: 400, code: "invalid_image", message: "invalid image folder" };
  }
  const path = folder ? `${tenant_id}/${folder}/${randomUUID()}.jpg` : `${tenant_id}/${randomUUID()}.jpg`;

  const { error: upErr } = await tenantStorage(asTenantId(tenant_id))
    .from(CHAT_IMAGE_BUCKET)
    .upload(path, jpeg, {
      contentType: "image/jpeg",
      upsert: false,
    });

  if (upErr) {
    return {
      ok: false,
      status: 500,
      code: "upload_failed",
      message: upErr.message,
    };
  }
  return { ok: true, image_path: path };
}

export function sendChatImageError(res: Response, err: ChatImageError): void {
  res.status(err.status).json({ error: { code: err.code, message: err.message } });
}
