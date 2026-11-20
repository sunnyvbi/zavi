import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import {
  IMAGE_THUMBNAIL,
  isTenantArtifactPath,
  signTenantArtifactPath,
  TTL_SECONDS,
} from "./file-url";

export const MAX_THUMBNAIL_IDS = 60;
const SIGN_CONCURRENCY = 6;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = {
  id: string;
  tenant_id: string;
  storage_path: string;
  bucket: string | null;
  mime: string | null;
};

export async function runArtifactThumbnails(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const raw = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]) : null;
  if (!raw) {
    res.status(400).json({ error: { code: "missing_ids", message: "ids must be an array" } });
    return;
  }
  const ids = [...new Set(raw.filter((v): v is string => typeof v === "string" && UUID_RE.test(v)))];
  if (ids.length === 0 || ids.length > MAX_THUMBNAIL_IDS) {
    res.status(400).json({
      error: { code: "invalid_ids", message: `ids must hold 1 to ${MAX_THUMBNAIL_IDS} artifact ids` },
    });
    return;
  }

  const { data, error } = await tenantClient(asTenantId(auth.tenant_id))
    .from("run_artifacts")
    .select("id, tenant_id, storage_path, bucket, mime")
    .in("id", ids);
  if (error) {
    res.status(500).json({ error: { code: "thumbnails_failed", message: "Could not sign thumbnails." } });
    return;
  }

  const rows = ((Array.isArray(data) ? data : []) as Row[]).filter(
    (row) =>
      row.tenant_id === auth.tenant_id &&
      String(row.mime ?? "").startsWith("image/") &&
      isTenantArtifactPath(auth.tenant_id, row.storage_path ?? ""),
  );

  const thumbnails: Record<string, string | null> = {};
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (let n = cursor++; n < rows.length; n = cursor++) {
      const row = rows[n];
      thumbnails[row.id] = await signTenantArtifactPath(
        auth.tenant_id,
        row.storage_path,
        TTL_SECONDS,
        row.bucket ?? undefined,
        undefined,
        IMAGE_THUMBNAIL,
      );
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SIGN_CONCURRENCY, rows.length) }, () => worker()),
  );

  res.status(200).json({ thumbnails, expires_in: TTL_SECONDS });
}
