import { apiJson } from "../../lib/api";
import type {
  Artifact,
  ArtifactFilter,
  ArtifactResponse,
  ArtifactType,
  ArtifactsResponse,
  SignedArtifactUrlResponse,
} from "./types";

export type ArtifactListParams = {
  q?: string;
  type?: ArtifactFilter;
};

const MAX_ARTIFACT_TITLE_LENGTH = 160;

function artifactPath(id: string): string {
  return `/api/run-artifacts/${encodeURIComponent(id)}`;
}

function listQuery(params: ArtifactListParams): string {
  const values: string[] = [];
  const query = params.q?.trim();
  const type = params.type && params.type !== "all" ? params.type : undefined;
  if (query) values.push(`q=${encodeURIComponent(query)}`);
  if (type) values.push(`type=${encodeURIComponent(type)}`);
  return values.length > 0 ? `?${values.join("&")}` : "";
}

export function fetchArtifacts(
  params: ArtifactListParams = {},
): Promise<ArtifactsResponse> {
  return apiJson<ArtifactsResponse>(`/api/run-artifacts${listQuery(params)}`);
}

export function renameArtifact(
  id: string,
  title: string,
): Promise<ArtifactResponse> {
  const trimmedTitle = title.trim();
  if (!trimmedTitle || trimmedTitle.length > MAX_ARTIFACT_TITLE_LENGTH) {
    return Promise.reject(
      new Error("Title must be between 1 and 160 characters."),
    );
  }
  return apiJson<ArtifactResponse>(artifactPath(id), {
    method: "PATCH",
    body: JSON.stringify({ title: trimmedTitle }),
  });
}

export function deleteArtifact(id: string): Promise<unknown> {
  return apiJson<unknown>(artifactPath(id), { method: "DELETE" });
}

export function fetchArtifactUrl(
  id: string,
  download = false,
): Promise<SignedArtifactUrlResponse> {
  const suffix = download ? "?download=1" : "";
  return apiJson<SignedArtifactUrlResponse>(
    `${artifactPath(id)}/url${suffix}`,
  );
}

export function fetchArtifactPreviewUrl(
  id: string,
): Promise<SignedArtifactUrlResponse> {
  return fetchArtifactUrl(id);
}

export function fetchArtifactDownloadUrl(
  id: string,
): Promise<SignedArtifactUrlResponse> {
  return fetchArtifactUrl(id, true);
}

const THUMB_REUSE_MS = 8 * 60 * 1000;
const THUMB_BATCH_WAIT_MS = 30;
const THUMB_BATCH_MAX = 40;
const thumbCache = new Map<string, { url: string | null; at: number }>();
const thumbQueue = new Map<string, ((url: string | null) => void)[]>();
let thumbFlush: ReturnType<typeof setTimeout> | null = null;

async function flushThumbnailQueue(): Promise<void> {
  thumbFlush = null;
  const batch = [...thumbQueue.entries()].slice(0, THUMB_BATCH_MAX);
  for (const [id] of batch) thumbQueue.delete(id);
  if (thumbQueue.size > 0) thumbFlush = setTimeout(() => void flushThumbnailQueue(), 0);
  let urls: Record<string, string | null> = {};
  try {
    const payload = await apiJson<{ thumbnails?: Record<string, string | null> }>("/api/run-artifacts/thumbnails", {
      method: "POST",
      body: JSON.stringify({ ids: batch.map(([id]) => id) }),
    });
    urls = payload.thumbnails ?? {};
  } catch {
    urls = {};
  }
  const now = Date.now();
  for (const [id, waiters] of batch) {
    const url = urls[id] ?? null;
    thumbCache.set(id, { url, at: now });
    for (const resolve of waiters) resolve(url);
  }
}

export function cachedArtifactThumbnail(id: string): string | null | undefined {
  const hit = thumbCache.get(id);
  return hit && Date.now() - hit.at < THUMB_REUSE_MS ? hit.url : undefined;
}

export function loadArtifactThumbnail(id: string): Promise<string | null> {
  const cached = cachedArtifactThumbnail(id);
  if (cached !== undefined) return Promise.resolve(cached);
  return new Promise((resolve) => {
    thumbQueue.set(id, [...(thumbQueue.get(id) ?? []), resolve]);
    if (!thumbFlush) thumbFlush = setTimeout(() => void flushThumbnailQueue(), THUMB_BATCH_WAIT_MS);
  });
}

export type { Artifact, ArtifactFilter, ArtifactType };
