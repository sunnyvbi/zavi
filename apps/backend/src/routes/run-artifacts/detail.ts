import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { tenantClient, tenantStorage, type TenantId } from "@/services/tenant-client";
import {
  isSignableArtifactBucket,
  isTenantArtifactPath,
  signTenantArtifactPath,
  TTL_SECONDS,
} from "./file-url";
import { serverClientFromBearer } from "@/services/supabase";
import { presentArtifact, readableThreadIds, type ArtifactRow } from "@/services/run-artifacts/model";

const SELECT_FIELDS = "id, tenant_id, run_id, storage_path, bucket, filename, title, mime, bytes, created_at, updated_at, agent_slug, thread_id";

async function readOwnedArtifact(tenantId: TenantId, id: string): Promise<ArtifactRow | null> {
  const { data, error } = await tenantClient(tenantId)
    .from("run_artifacts")
    .select(SELECT_FIELDS)
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle();
  return error || !data ? null : data as ArtifactRow;
}

function artifactId(req: Request): string {
  return typeof req.params.id === "string" ? req.params.id.trim() : "";
}

export async function getRunArtifact(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const row = await readOwnedArtifact(auth.tenant_id, artifactId(req));
  if (!row) {
    res.status(404).json({ error: { code: "not_found", message: "Artifact not found." } });
    return;
  }
  const bucket = row.bucket ?? "agent-artifacts";
  const previewUrl = await signTenantArtifactPath(
    auth.tenant_id,
    row.storage_path,
    TTL_SECONDS,
    bucket,
  );
  const downloadUrl = await signTenantArtifactPath(
    auth.tenant_id,
    row.storage_path,
    TTL_SECONDS,
    bucket,
    row.filename,
  );
  const readable = await readableThreadIds(serverClientFromBearer(auth.access_token), [row]);
  res.status(200).json({
    artifact: { ...presentArtifact(row, previewUrl, readable), download_url: downloadUrl },
    expires_in: TTL_SECONDS,
  });
}

export async function updateRunArtifact(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  if (!title || title.length > 160) {
    res.status(400).json({
      error: { code: "invalid_title", message: "Title must be between 1 and 160 characters." },
    });
    return;
  }

  const db = tenantClient(auth.tenant_id);
  const { data, error } = await db
    .from("run_artifacts")
    .update({ title })
    .eq("tenant_id", auth.tenant_id)
    .eq("id", artifactId(req))
    .select(SELECT_FIELDS)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: { code: "update_failed", message: "Could not rename artifact." } });
    return;
  }
  if (!data) {
    res.status(404).json({ error: { code: "not_found", message: "Artifact not found." } });
    return;
  }

  const row = data as ArtifactRow;
  const previewUrl = await signTenantArtifactPath(
    auth.tenant_id,
    row.storage_path,
    TTL_SECONDS,
    row.bucket ?? undefined,
  );
  const readable = await readableThreadIds(serverClientFromBearer(auth.access_token), [row]);
  res.status(200).json({ artifact: presentArtifact(row, previewUrl, readable) });
}

export async function deleteRunArtifact(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const row = await readOwnedArtifact(auth.tenant_id, artifactId(req));
  if (!row) {
    res.status(404).json({ error: { code: "not_found", message: "Artifact not found." } });
    return;
  }

  const bucket = row.bucket ?? "agent-artifacts";
  if (!isSignableArtifactBucket(bucket) || !isTenantArtifactPath(auth.tenant_id, row.storage_path)) {
    res.status(409).json({
      error: { code: "invalid_storage_binding", message: "Artifact storage is invalid." },
    });
    return;
  }

  const db = tenantClient(auth.tenant_id);
  const { error: storageError } = await tenantStorage(auth.tenant_id).from(bucket).remove([row.storage_path]);
  if (storageError) {
    res.status(500).json({ error: { code: "delete_failed", message: "Could not delete artifact file." } });
    return;
  }
  const { error } = await db
    .from("run_artifacts")
    .delete()
    .eq("tenant_id", auth.tenant_id)
    .eq("id", row.id);
  if (error) {
    res.status(500).json({ error: { code: "delete_failed", message: "Could not delete artifact." } });
    return;
  }
  res.status(204).send();
}
