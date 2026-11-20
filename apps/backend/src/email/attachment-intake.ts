
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { tenantStorage, type TenantId } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";

const DOC_BUCKET = "agent-chat-docs";

const ALLOW: Record<string, "pdf" | "docx" | "csv" | "txt"> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/csv": "csv",
  "text/plain": "txt",
};
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_COUNT = 5;

export type InboundAttachment = {
  filename?: unknown;
  mime_type?: unknown;
  ext?: unknown;
  size_bytes?: unknown;
  sha256?: unknown;
  content_base64?: unknown;
};

export type StoredAttachment = {
  storage_path: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
};

export function sniffOk(ext: string, buf: Buffer): boolean {
  if (ext === "pdf") return buf.length >= 4 && buf.subarray(0, 4).toString("latin1") === "%PDF";
  if (ext === "docx") {
    return (
      buf.length >= 4 &&
      buf[0] === 0x50 &&
      buf[1] === 0x4b &&
      (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07) &&
      (buf[3] === 0x04 || buf[3] === 0x06 || buf[3] === 0x08)
    );
  }
  return true;
}

export type ValidatedAttachment = { buf: Buffer; ext: "pdf" | "docx" | "csv" | "txt"; mime: string; filename: string };

export function validateAttachment(att: InboundAttachment): ValidatedAttachment | { skip: string } {
  const mime = String(att?.mime_type ?? "").toLowerCase().split(";")[0].trim();
  const ext = ALLOW[mime];
  if (!ext) return { skip: `disallowed_mime:${mime || "none"}` };

  const b64 = typeof att?.content_base64 === "string" ? att.content_base64 : "";
  if (!b64) return { skip: "empty_content" };

  let buf: Buffer;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    return { skip: "bad_base64" };
  }
  if (buf.length === 0) return { skip: "empty_after_decode" };
  if (buf.length > MAX_BYTES) return { skip: `oversize:${buf.length}` };

  const claimedSha = typeof att?.sha256 === "string" ? att.sha256.toLowerCase() : "";
  if (claimedSha) {
    const actual = createHash("sha256").update(buf).digest("hex");
    if (actual !== claimedSha) return { skip: "sha256_mismatch" };
  }

  if (!sniffOk(ext, buf)) return { skip: `magic_mismatch:${ext}` };

  const filename = safeFilename(att?.filename, ext);
  return { buf, ext, mime, filename };
}

function safeFilename(name: unknown, ext: string): string {
  const base = String(name ?? "")
    .replace(/[/\\\r\n\t\0]/g, "_")
    .replace(/[^\w.\- ]/g, "")
    .trim()
    .slice(0, 120);
  return base || `attachment.${ext}`;
}

export type Uploader = (
  path: string,
  buf: Buffer,
  contentType: string,
) => Promise<{ error: { message: string } | null }>;

function defaultUploader(tid: TenantId): Uploader {
  const storage = tenantStorage(tid);
  return async (path, buf, contentType) => {
    const { error } = await storage
      .from(DOC_BUCKET)
      .upload(path, buf, { contentType, upsert: false });
    return { error: error ? { message: error.message } : null };
  };
}

export async function storeInboundAttachments(
  tid: TenantId,
  attachments: unknown,
  opts?: { uploader?: Uploader; tenantIdForLog?: string },
): Promise<StoredAttachment[]> {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  const uploader = opts?.uploader ?? defaultUploader(tid);
  const stored: StoredAttachment[] = [];
  let processed = 0;

  for (const raw of attachments) {
    if (stored.length >= MAX_COUNT) break;
    processed++;
    const v = validateAttachment(raw as InboundAttachment);
    if ("skip" in v) {
      await logEvent({
        level: "info",
        source: "email-attachment-intake",
        code: "email.attachment.skipped",
        message: `inbound attachment skipped (${v.skip})`,
        tenant_id: opts?.tenantIdForLog,
      }).catch(() => {});
      continue;
    }
    const path = `${String(tid)}/${randomUUID()}.${v.ext}`;
    const { error } = await uploader(path, v.buf, v.mime);
    if (error) {
      await logEvent({
        level: "warn",
        source: "email-attachment-intake",
        code: "email.attachment.upload_failed",
        message: `inbound attachment upload failed: ${error.message}`,
        tenant_id: opts?.tenantIdForLog,
      }).catch(() => {});
      continue;
    }
    stored.push({
      storage_path: path,
      filename: v.filename,
      mime_type: v.mime,
      size_bytes: v.buf.length,
    });
  }

  if (processed > stored.length) {
    await logEvent({
      level: "info",
      source: "email-attachment-intake",
      code: "email.attachment.partial",
      message: `stored ${stored.length}/${processed} inbound attachments`,
      tenant_id: opts?.tenantIdForLog,
    }).catch(() => {});
  }
  return stored;
}
