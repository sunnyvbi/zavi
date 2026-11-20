
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import {
  readSignedUrl,
  SIGN_TTL_SECONDS,
  signedUrlCacheKey,
  storeSignedUrl,
} from "@/services/run-artifacts/signed-url-cache";

export const TTL_SECONDS = 600;
export const CLIENT_CACHE_SECONDS = 480;
const ARTIFACT_BUCKET = "agent-artifacts";
const SIGNABLE_BUCKETS: ReadonlySet<string> = new Set([
  ARTIFACT_BUCKET,
  "launch-video-artifacts",
  "agent-chat-images",
]);
const VALID_SHAPE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[a-z0-9._-]+$/;

export type ThumbnailTransform = {
  width: number;
  height?: number;
  resize: "cover" | "contain";
  quality: number;
};
export const IMAGE_THUMBNAIL: ThumbnailTransform = {
  width: 640,
  resize: "contain",
  quality: 72,
};

export function isTenantArtifactPath(tenantId: string, storagePath: string): boolean {
  return storagePath.startsWith(`${tenantId}/`) && VALID_SHAPE.test(storagePath);
}

export function isSignableArtifactBucket(bucket: string): boolean {
  return SIGNABLE_BUCKETS.has(bucket);
}

const ID_TAG = /(?<=\S)\s+(?=[a-f]*\d)[0-9a-f]{8}$/;

const GENERATED_VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i;
const TRAILING_VIDEO_EXTS = /(\.(mp4|mov|webm|m4v)\s*)+$/i;

const VIDEO_SLUG_MAX = 80;

export function slugifyDownloadStem(text: string): string {
  const slug = String(text ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['\u2019]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= VIDEO_SLUG_MAX) return slug;
  const cut = slug.slice(0, VIDEO_SLUG_MAX);
  const boundary = cut.lastIndexOf("-");
  return (boundary >= 20 ? cut.slice(0, boundary) : cut).replace(/-+$/, "");
}

export function videoDownloadName(name: string): string {
  const raw = String(name ?? "").trim();
  const ext = (raw.match(GENERATED_VIDEO_EXT)?.[0] ?? ".mp4").toLowerCase();
  const stem = raw.replace(GENERATED_VIDEO_EXT, "").replace(ID_TAG, "");
  return `${slugifyDownloadStem(stem) || "video"}${ext}`;
}

export function downloadSourceName(filename: string, title?: string | null): string {
  const storedExt = String(filename ?? "").match(GENERATED_VIDEO_EXT)?.[0];
  if (!storedExt) return filename;
  const titleStem = slugifyDownloadStem(String(title ?? "").trim().replace(TRAILING_VIDEO_EXTS, ""));
  return titleStem ? `${titleStem}${storedExt.toLowerCase()}` : filename;
}

function downloadNameFor(name: string): string {
  return GENERATED_VIDEO_EXT.test(name) ? videoDownloadName(name) : name;
}

export async function signTenantArtifactPath(
  tenantId: string,
  storagePath: string,
  ttlSeconds: number = TTL_SECONDS,
  bucket: string = ARTIFACT_BUCKET,
  downloadFilename?: string,
  transform?: ThumbnailTransform,
): Promise<string | null> {
  const path = storagePath ?? "";
  if (!isTenantArtifactPath(tenantId, path)) return null;
  if (!isSignableArtifactBucket(bucket)) return null;
  const lower = path.toLowerCase();
  const downloadOpt = downloadFilename || lower.endsWith(".html") || lower.endsWith(".svg")
    ? { download: downloadNameFor(downloadFilename || path.split("/").pop() || "artifact") }
    : undefined;
  const options = downloadOpt || transform ? { ...downloadOpt, transform } : undefined;
  const key = signedUrlCacheKey(bucket, path, options);
  const remembered = readSignedUrl(key);
  if (remembered) return remembered;
  const signFor = Math.max(ttlSeconds, SIGN_TTL_SECONDS);
  try {
    const { data, error } = await serviceClient()
      .storage.from(bucket)
      .createSignedUrl(path, signFor, options);
    if (error || !data?.signedUrl) return null;
    storeSignedUrl(key, data.signedUrl, signFor);
    return data.signedUrl;
  } catch {
    return null;
  }
}

const SIGN_BATCH_SIZE = 100;
const HTML_SIGN_CONCURRENCY = 6;

export type ArtifactPathToSign = {
  storagePath: string;
  bucket?: string | null;
};

export async function signTenantArtifactPaths(
  tenantId: string,
  items: ArtifactPathToSign[],
  ttlSeconds: number = TTL_SECONDS,
): Promise<Array<string | null>> {
  const signed = new Array<string | null>(items.length).fill(null);
  const byBucket = new Map<string, Map<string, number[]>>();
  const downloadIndexes: number[] = [];

  items.forEach((item, index) => {
    const path = item.storagePath ?? "";
    const bucket = item.bucket ?? ARTIFACT_BUCKET;
    if (!isTenantArtifactPath(tenantId, path)) return;
    if (!isSignableArtifactBucket(bucket)) return;
    const lower = path.toLowerCase();
    if (lower.endsWith(".html") || lower.endsWith(".svg")) {
      downloadIndexes.push(index);
      return;
    }
    const remembered = readSignedUrl(signedUrlCacheKey(bucket, path, undefined));
    if (remembered) {
      signed[index] = remembered;
      return;
    }
    const paths = byBucket.get(bucket) ?? new Map<string, number[]>();
    paths.set(path, [...(paths.get(path) ?? []), index]);
    byBucket.set(bucket, paths);
  });
  const signFor = Math.max(ttlSeconds, SIGN_TTL_SECONDS);

  const batches: Promise<void>[] = [];
  for (const [bucket, paths] of byBucket) {
    const unique = [...paths.keys()];
    for (let start = 0; start < unique.length; start += SIGN_BATCH_SIZE) {
      const chunk = unique.slice(start, start + SIGN_BATCH_SIZE);
      batches.push(
        (async () => {
          try {
            const { data, error } = await serviceClient()
              .storage.from(bucket)
              .createSignedUrls(chunk, signFor);
            if (error || !data) return;
            for (const entry of data) {
              if (entry.error || !entry.path || !entry.signedUrl) continue;
              storeSignedUrl(signedUrlCacheKey(bucket, entry.path, undefined), entry.signedUrl, signFor);
              for (const index of paths.get(entry.path) ?? []) {
                signed[index] = entry.signedUrl;
              }
            }
          } catch {
          }
        })(),
      );
    }
  }
  let cursor = 0;
  const htmlWorker = async (): Promise<void> => {
    for (let n = cursor++; n < downloadIndexes.length; n = cursor++) {
      const index = downloadIndexes[n];
      const item = items[index];
      signed[index] = await signTenantArtifactPath(
        tenantId,
        item.storagePath,
        ttlSeconds,
        item.bucket ?? undefined,
      );
    }
  };
  for (let w = 0; w < Math.min(HTML_SIGN_CONCURRENCY, downloadIndexes.length); w++) {
    batches.push(htmlWorker());
  }
  await Promise.all(batches);
  return signed;
}

export async function runArtifactUrl(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const id = (req.params.id ?? "").trim();
  if (!id) {
    res
      .status(400)
      .json({ error: { code: "missing_id", message: "artifact id required" } });
    return;
  }

  const { data: row, error: rowErr } = await serviceClient()
    .from("run_artifacts")
    .select("tenant_id, storage_path, bucket, filename, title, mime")
    .eq("id", id)
    .single();

  const path = (row as { storage_path?: string } | null)?.storage_path ?? "";
  const rowBucket = (row as { bucket?: string | null } | null)?.bucket ?? ARTIFACT_BUCKET;
  const ownerTenant = (row as { tenant_id?: string } | null)?.tenant_id ?? "";
  const expectedPrefix = `${auth.tenant_id}/`;

  if (
    rowErr ||
    !row ||
    ownerTenant !== auth.tenant_id ||
    !path.startsWith(expectedPrefix) ||
    !isTenantArtifactPath(auth.tenant_id, path)
  ) {
    res.status(403).json({
      error: {
        code: "artifact_not_owned",
        message: "artifact not found or not owned by tenant",
      },
    });
    return;
  }

  const rowFile = row as { filename?: string; title?: string | null };
  const download =
    req.query?.download === "1" && rowFile.filename
      ? downloadSourceName(rowFile.filename, rowFile.title)
      : undefined;
  const mime = String((row as { mime?: string | null }).mime ?? "");
  const thumbnail =
    !download && req.query?.thumb === "1" && mime.startsWith("image/")
      ? IMAGE_THUMBNAIL
      : undefined;
  const signedUrl = await signTenantArtifactPath(
    auth.tenant_id,
    path,
    TTL_SECONDS,
    rowBucket,
    download,
    thumbnail,
  );

  if (!signedUrl) {
    res.status(404).json({
      error: {
        code: "sign_failed",
        message: "could not sign artifact url",
      },
    });
    return;
  }

  if (!download) res.set("Cache-Control", `private, max-age=${CLIENT_CACHE_SECONDS}`);
  res.status(200).json({ signed_url: signedUrl, expires_in: TTL_SECONDS });
}
