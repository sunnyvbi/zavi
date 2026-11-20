
import { asTenantId, tenantClient, type TenantId } from "@/services/tenant-client";
import { signTenantArtifactPath, type ThumbnailTransform } from "@/routes/run-artifacts/file-url";

export type RunImage = {
  id: string;
  storage_path: string;
  bucket: string | null;
  filename: string;
};

export type StoredMedia = {
  kind: "image" | "video";
  artifact_id?: string;
  storage_path: string;
  bucket: string | null;
  alt: string;
  filename?: string;
  ai_generated?: boolean;
};

export async function loadRunImages(tid: TenantId, runId: string): Promise<RunImage[]> {
  const { data, error } = await tenantClient(tid)
    .from("run_artifacts")
    .select("id, storage_path, bucket, filename, mime")
    .eq("run_id", runId)
    .like("mime", "image/%")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`run_artifacts read failed: ${error.message}`);
  return Array.isArray(data) ? (data as RunImage[]) : [];
}

const CARD_IMAGE: ThumbnailTransform = { width: 480, height: 720, resize: "contain", quality: 75 };

export function altTextOf(content: string): string | null {
  const m = content.match(/^[ \t*_-]*alt(?:[ \t]*text)?[ \t]*[:\-][ \t]*(.+)$/im);
  const v = m ? m[1].replace(/^[\s*_]+|[\s*_]+$/g, "").trim() : "";
  return v ? v.slice(0, 300) : null;
}

export function attachRunImage(
  content: string | null | undefined,
  fallbackAlt: string,
  images: readonly RunImage[],
): StoredMedia | null {
  if (!content || images.length === 0) return null;
  const lower = content.toLowerCase();
  const hit = images.find((i) => i.filename && lower.includes(i.filename.toLowerCase()));
  if (!hit) return null;
  const alt = altTextOf(content) ?? fallbackAlt;
  return { kind: "image", artifact_id: hit.id, storage_path: hit.storage_path, bucket: hit.bucket, alt };
}

const NOT_POST_ART = /^(?:tab-task|browser-task)-|screen[-_ ]?shot/i;

export function attachRunImages(
  posts: ReadonlyArray<{ content: string | null | undefined; alt: string } | null>,
  images: readonly RunImage[],
): Array<StoredMedia | null> {
  const named = posts.map((p) => (p ? attachRunImage(p.content, p.alt, images) : null));
  const used = new Set(named.flatMap((m) => (m?.artifact_id ? [m.artifact_id] : [])));
  const waiting = posts.flatMap((p, i) => (p && !named[i] ? [i] : []));
  const spare = images.filter((img) => !used.has(img.id) && !NOT_POST_ART.test(img.filename));
  if (waiting.length === 0 || waiting.length !== spare.length) return named;
  waiting.forEach((i, k) => {
    const img = spare[k];
    named[i] = { kind: "image", artifact_id: img.id, storage_path: img.storage_path, bucket: img.bucket, alt: altTextOf(posts[i]!.content ?? "") ?? posts[i]!.alt };
  });
  return named;
}

type WithBody = { body?: unknown };

async function videoArtifactIds(tenantId: string, storagePaths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (storagePaths.length === 0) return out;
  try {
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("run_artifacts")
      .select("id, storage_path")
      .in("storage_path", [...new Set(storagePaths)])
      .limit(storagePaths.length * 2);
    if (error) return out;
    for (const r of (data ?? []) as Array<{ id: string; storage_path: string }>) out.set(r.storage_path, r.id);
  } catch {
  }
  return out;
}

export async function signActionMedia<T extends WithBody>(tenantId: string, actions: T[]): Promise<T[]> {
  const idx: number[] = [];
  const paths: { storagePath: string; bucket: string | null; video: boolean; filename: string | null }[] = [];
  actions.forEach((a, i) => {
    const m = (a.body as { media?: Partial<StoredMedia> } | null | undefined)?.media;
    if (m && typeof m.storage_path === "string") {
      idx.push(i);
      paths.push({
        storagePath: m.storage_path,
        bucket: m.bucket ?? null,
        video: m.kind === "video",
        filename: typeof m.filename === "string" ? m.filename : null,
      });
    }
  });
  if (idx.length === 0) return actions;
  const sign = (p: (typeof paths)[number], download?: string) =>
    signTenantArtifactPath(
      tenantId,
      p.storagePath,
      undefined,
      p.bucket ?? undefined,
      download,
      p.video ? undefined : CARD_IMAGE,
    ).catch(() => null);
  const [signed, downloads, artifactIds] = await Promise.all([
    Promise.all(paths.map((p) => sign(p))),
    Promise.all(
      paths.map((p) => (p.video ? sign(p, p.filename ?? p.storagePath.split("/").pop() ?? "video.mp4") : Promise.resolve(null))),
    ),
    videoArtifactIds(tenantId, paths.filter((p) => p.video).map((p) => p.storagePath)),
  ]);
  const out = [...actions];
  idx.forEach((i, k) => {
    const body = { ...(out[i].body as Record<string, unknown>) };
    const m = body.media as StoredMedia;
    const url = signed[k];
    if (url && m.kind === "video") {
      body.media = {
        kind: "video",
        url,
        alt: m.alt,
        ...(downloads[k] ? { download_url: downloads[k] } : {}),
        ...(artifactIds.get(paths[k].storagePath) ? { artifact_id: artifactIds.get(paths[k].storagePath) } : {}),
        ai_generated: m.ai_generated === true,
      };
    } else if (url) body.media = { kind: m.kind, url, alt: m.alt };
    else delete body.media;
    out[i] = { ...out[i], body };
  });
  return out;
}
