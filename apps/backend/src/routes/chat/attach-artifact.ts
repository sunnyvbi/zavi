
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { asTenantId, tenantStorage } from "@/services/tenant-client";
import {
  normalizeChatImage,
  storeNormalizedChatImage,
  MAX_UPLOAD_BYTES as MAX_IMAGE_BYTES,
} from "@/services/chat-images/store-chat-image";
import { CHAT_DOC_MAX_BYTES } from "./upload-doc";

const Body = z.object({ artifact_id: z.string().uuid() }).strict();

const EXT_CONTENT_TYPE: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  csv: "text/csv",
};

function attachTarget(filename: string, mime: string): { kind: "image" } | { kind: "doc"; ext: string } | null {
  const lower = filename.toLocaleLowerCase("en-US");
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  if (mime.startsWith("image/")) return { kind: "image" };
  if (ext in EXT_CONTENT_TYPE) return { kind: "doc", ext };
  if (ext === "md" || ext === "markdown" || mime === "text/markdown") {
    return { kind: "doc", ext: "txt" };
  }
  return null;
}

export async function attachRunArtifact(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "invalid_body", message: "artifact_id must be a uuid" },
    });
    return;
  }

  const sb = serverClientFromBearer(auth.access_token);
  const { data: row, error } = await sb
    .from("run_artifacts")
    .select("id, tenant_id, bucket, storage_path, filename, mime, bytes")
    .eq("id", parsed.data.artifact_id)
    .eq("tenant_id", auth.tenant_id)
    .maybeSingle();

  if (error) {
    res.status(500).json({
      error: { code: "artifact_lookup_failed", message: "Could not read that file." },
    });
    return;
  }
  if (!row || row.tenant_id !== auth.tenant_id || row.bucket === "agent-chat-images") {
    res.status(404).json({
      error: { code: "artifact_not_found", message: "That file is not available." },
    });
    return;
  }

  const filename = String(row.filename ?? "");
  const target = attachTarget(filename, String(row.mime ?? ""));
  if (!target) {
    res.status(400).json({
      error: {
        code: "unsupported_artifact",
        message: "Zavi can only attach images, PDF, DOCX, CSV, TXT or Markdown files.",
      },
    });
    return;
  }

  const cap = target.kind === "image" ? MAX_IMAGE_BYTES : CHAT_DOC_MAX_BYTES;
  const mb = Math.floor(cap / 1024 / 1024);
  if (typeof row.bytes === "number" && row.bytes > cap) {
    res.status(400).json({
      error: { code: "artifact_too_large", message: `That file is over ${mb}MB.` },
    });
    return;
  }

  const storage = tenantStorage(asTenantId(auth.tenant_id));
  const download = await storage
    .from(String(row.bucket))
    .download(String(row.storage_path));
  if (download.error || !download.data) {
    res.status(502).json({
      error: { code: "artifact_download_failed", message: "Could not read that file." },
    });
    return;
  }
  const buf = Buffer.from(await download.data.arrayBuffer());
  if (buf.byteLength > cap) {
    res.status(400).json({
      error: { code: "artifact_too_large", message: `That file is over ${mb}MB.` },
    });
    return;
  }

  if (target.kind === "image") {
    const normalized = await normalizeChatImage(buf);
    if (!normalized.ok) {
      res.status(normalized.status).json({
        error: { code: normalized.code, message: normalized.message },
      });
      return;
    }
    const stored = await storeNormalizedChatImage(auth.tenant_id, normalized.jpeg);
    if (!stored.ok) {
      res.status(stored.status).json({
        error: { code: stored.code, message: stored.message },
      });
      return;
    }
    res.status(200).json({ kind: "image", image_path: stored.image_path, filename });
    return;
  }

  const storagePath = `${auth.tenant_id}/${randomUUID()}.${target.ext}`;
  const { error: upErr } = await storage
    .from("agent-chat-docs")
    .upload(storagePath, buf, {
      contentType: EXT_CONTENT_TYPE[target.ext],
      upsert: false,
    });
  if (upErr) {
    res.status(500).json({ error: { code: "upload_failed", message: upErr.message } });
    return;
  }

  res.status(200).json({ kind: "doc", doc_path: storagePath, filename });
}
