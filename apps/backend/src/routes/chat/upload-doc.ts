
import type { NextFunction, Request, Response } from "express";
import multer, { MulterError } from "multer";
import { randomUUID } from "node:crypto";
import { authMiddleware, requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import path from "node:path";

export const CHAT_DOC_MAX_BYTES = 10 * 1024 * 1024;
export const CHAT_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const VIDEO_BUCKET = "launch-video-media";

const EXT_CONTENT_TYPE: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  csv: "text/csv",
};

const STORED_AS_TXT = new Set(["md", "markdown"]);

function sniffIsPdf(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  return (
    buf[0] === 0x25 &&
    buf[1] === 0x50 &&
    buf[2] === 0x44 &&
    buf[3] === 0x46
  );
}

function sniffIsMp4(buf: Buffer): boolean {
  return buf.length >= 12 && buf.toString("latin1", 4, 8) === "ftyp";
}

function multerSingle(maxBytes: number) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes } });
  return (req: Request, res: Response, next: NextFunction): void => {
    upload.single("file")(req, res, (err: unknown) => {
      if (err instanceof MulterError) {
        const code =
          err.code === "LIMIT_FILE_SIZE" ? "file_too_large" : "upload_rejected";
        const message =
          err.code === "LIMIT_FILE_SIZE"
            ? `file exceeds ${maxBytes / 1024 / 1024}MB cap`
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
  };
}

export const chatDocUploadMiddleware = multerSingle(CHAT_DOC_MAX_BYTES);
export const chatVideoUploadMiddleware = multerSingle(CHAT_VIDEO_MAX_BYTES);

export async function chatVideoUpload(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) {
    res.status(400).json({ error: { code: "no_file", message: "file field is required" } });
    return;
  }
  if (!sniffIsMp4(file.buffer)) {
    res.status(400).json({
      error: { code: "invalid_mp4", message: "file content does not appear to be an MP4" },
    });
    return;
  }

  const storagePath = `${auth.tenant_id}/${randomUUID()}.mp4`;
  const { error: upErr } = await serviceClient()
    .storage.from(VIDEO_BUCKET)
    .upload(storagePath, file.buffer, { contentType: "video/mp4", upsert: false });
  if (upErr) {
    res.status(500).json({ error: { code: "upload_failed", message: upErr.message } });
    return;
  }
  res.status(200).json({ video_path: storagePath });
}

export async function chatDocUpload(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) {
    res
      .status(400)
      .json({ error: { code: "no_file", message: "file field is required" } });
    return;
  }

  const rawExt = path.extname(file.originalname).toLowerCase().slice(1);
  const ext = STORED_AS_TXT.has(rawExt) ? "txt" : rawExt;
  if (!Object.hasOwn(EXT_CONTENT_TYPE, ext)) {
    res.status(400).json({
      error: {
        code: "unsupported_extension",
        message: `extension .${rawExt} not supported (allowed: ${[...Object.keys(EXT_CONTENT_TYPE), ...STORED_AS_TXT].join(", ")})`,
      },
    });
    return;
  }

  if (ext === "pdf" && !sniffIsPdf(file.buffer)) {
    res.status(400).json({
      error: {
        code: "invalid_pdf",
        message: "file content does not appear to be a PDF",
      },
    });
    return;
  }

  const storagePath = `${auth.tenant_id}/${randomUUID()}.${ext}`;

  const { error: upErr } = await serviceClient()
    .storage.from("agent-chat-docs")
    .upload(storagePath, file.buffer, {
      contentType: EXT_CONTENT_TYPE[ext],
      upsert: false,
    });

  if (upErr) {
    res
      .status(500)
      .json({ error: { code: "upload_failed", message: upErr.message } });
    return;
  }

  res.status(200).json({ doc_path: storagePath });
}

export const chatDocUploadChain = [authMiddleware, chatDocUploadMiddleware, chatDocUpload];
export const chatVideoUploadChain = [authMiddleware, chatVideoUploadMiddleware, chatVideoUpload];
