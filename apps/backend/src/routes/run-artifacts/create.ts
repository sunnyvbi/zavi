import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import multer, { MulterError } from "multer";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { tenantClient, tenantStorage } from "@/services/tenant-client";
import {
  artifactBytesMatchMime,
  artifactMimeForFilename,
  sanitizeArtifactFilename,
} from "@/services/agents/sdk/mcp-sandbox";
import { presentArtifact, type ArtifactRow } from "@/services/run-artifacts/model";
import { signTenantArtifactPath, TTL_SECONDS } from "./file-url";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4 },
});

export function createRunArtifactUpload(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  upload.single("file")(req, res, (error: unknown) => {
    if (error instanceof MulterError) {
      res.status(400).json({
        error: {
          code: error.code === "LIMIT_FILE_SIZE" ? "file_too_large" : "upload_rejected",
          message: error.code === "LIMIT_FILE_SIZE"
            ? "Artifact exceeds the 25 MB limit."
            : error.message,
        },
      });
      return;
    }
    if (error) {
      res.status(400).json({
        error: { code: "upload_rejected", message: "Could not read the upload." },
      });
      return;
    }
    next();
  });
}

async function readableThread(
  accessToken: string,
  tenantId: string,
  threadId: string,
): Promise<{ agent_slug: string } | null> {
  const { data, error } = await serverClientFromBearer(accessToken)
    .from("agent_threads")
    .select("agent_slug")
    .eq("tenant_id", tenantId)
    .eq("id", threadId)
    .maybeSingle();
  if (error || !data) return null;
  return data as { agent_slug: string };
}

export async function createRunArtifact(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) {
    res.status(400).json({ error: { code: "missing_file", message: "A file is required." } });
    return;
  }

  const filename = sanitizeArtifactFilename(file.originalname);
  const mime = artifactMimeForFilename(filename);
  if (!filename || !mime || mime === "video/mp4") {
    res.status(400).json({
      error: {
        code: "unsupported_file",
        message: "Upload a PDF, CSV, XLSX, PPTX, or PNG artifact.",
      },
    });
    return;
  }
  if (!artifactBytesMatchMime(file.buffer, mime)) {
    res.status(400).json({
      error: { code: "content_mismatch", message: "The file content does not match its extension." },
    });
    return;
  }

  const rawTitle = typeof req.body.title === "string" ? req.body.title.trim() : "";
  if (rawTitle.length > 160) {
    res.status(400).json({
      error: { code: "title_too_long", message: "Title must be 160 characters or fewer." },
    });
    return;
  }

  const rawThreadId = typeof req.body.source_thread_id === "string"
    ? req.body.source_thread_id.trim()
    : "";
  let threadId: string | null = null;
  let agentSlug: string | null = null;
  if (rawThreadId) {
    if (!UUID_RE.test(rawThreadId)) {
      res.status(400).json({ error: { code: "invalid_source", message: "Source chat is invalid." } });
      return;
    }
    const source = await readableThread(auth.access_token, auth.tenant_id, rawThreadId);
    if (!source) {
      res.status(403).json({ error: { code: "source_not_owned", message: "Source chat is unavailable." } });
      return;
    }
    threadId = rawThreadId;
    agentSlug = source.agent_slug;
  }

  const runId = randomUUID();
  const storagePath = `${auth.tenant_id}/${runId}/${filename}`;
  const store = tenantStorage(auth.tenant_id);
  const db = tenantClient(auth.tenant_id);
  const { error: uploadError } = await store
    .from("agent-artifacts")
    .upload(storagePath, file.buffer, { contentType: mime, upsert: false });
  if (uploadError) {
    res.status(500).json({ error: { code: "upload_failed", message: "Could not store artifact." } });
    return;
  }

  const { data, error } = await db
    .from("run_artifacts")
    .insert({
      tenant_id: auth.tenant_id,
      run_id: runId,
      storage_path: storagePath,
      bucket: "agent-artifacts",
      filename,
      title: rawTitle || null,
      mime,
      bytes: file.buffer.byteLength,
      agent_slug: agentSlug,
      thread_id: threadId,
      created_by: auth.user_id,
    })
    .select("id, tenant_id, run_id, storage_path, bucket, filename, title, mime, bytes, created_at, updated_at, agent_slug, thread_id")
    .single();

  if (error || !data) {
    await store.from("agent-artifacts").remove([storagePath]);
    res.status(500).json({ error: { code: "create_failed", message: "Could not create artifact." } });
    return;
  }

  const row = data as ArtifactRow;
  const previewUrl = await signTenantArtifactPath(auth.tenant_id, row.storage_path);
  res.status(201).json({ artifact: presentArtifact(row, previewUrl), expires_in: TTL_SECONDS });
}
