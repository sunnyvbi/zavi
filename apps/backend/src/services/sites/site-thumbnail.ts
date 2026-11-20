
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { asTenantId, tenantRpc, tenantStorage } from "@/services/tenant-client";

export const SITE_THUMBNAIL_BUCKET = "agent-artifacts";
export const SITE_THUMBNAIL_WIDTH = 640;
const SITE_THUMBNAIL_QUALITY = 78;
const MAX_INPUT_B64 = 600_000;
const LIMIT_INPUT_PIXELS = 4096 * 4096;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THUMB_RE = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\/site-thumb-[0-9a-f]{12}\.jpg$/;

export function newSiteThumbnailPath(tenant_id: string, site_id: string, token: string = randomBytes(6).toString("hex")): string | null {
  if (!UUID_RE.test(tenant_id) || !UUID_RE.test(site_id) || !/^[0-9a-f]{12}$/.test(token)) return null;
  return `${tenant_id.toLowerCase()}/${site_id.toLowerCase()}/site-thumb-${token}.jpg`;
}

export function isSiteThumbnailPath(tenant_id: string, site_id: string, path: string | null | undefined): path is string {
  const m = typeof path === "string" ? THUMB_RE.exec(path) : null;
  return !!m && m[1] === tenant_id.toLowerCase() && m[2] === site_id.toLowerCase();
}

type Bucket = {
  upload: (path: string, body: Buffer, opts: { contentType: string; upsert: boolean }) => PromiseLike<{ error: { message?: string } | null }>;
  remove: (paths: string[]) => PromiseLike<{ error: { message?: string } | null }>;
  list: (prefix: string, opts: { limit: number }) => PromiseLike<{ data: Array<{ name: string }> | null; error: { message?: string } | null }>;
};

export type SiteThumbnailStore = {
  save: (input: { tenant_id: string; site_id: string; jpeg_b64: string; taken_at: Date }) => Promise<boolean>;
  removeAll: (input: { tenant_id: string; site_id: string }) => Promise<void>;
};

export type SiteThumbnailPointer = { outcome: "set" | "stale" | "not_found"; replaced: string | null };

export type SiteThumbnailDeps = {
  bucket?: (tenant_id: string) => Bucket;
  resize?: (jpeg: Buffer) => Promise<Buffer>;
  setPointer?: (tenant_id: string, site_id: string, path: string, taken_at: Date) => Promise<SiteThumbnailPointer>;
};

function defaultBucket(tenant_id: string): Bucket {
  return tenantStorage(asTenantId(tenant_id)).from(SITE_THUMBNAIL_BUCKET) as unknown as Bucket;
}

async function defaultResize(jpeg: Buffer): Promise<Buffer> {
  return sharp(jpeg, { failOn: "truncated", limitInputPixels: LIMIT_INPUT_PIXELS })
    .resize(SITE_THUMBNAIL_WIDTH, null, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: SITE_THUMBNAIL_QUALITY, mozjpeg: true })
    .toBuffer();
}

async function defaultSetPointer(tenant_id: string, site_id: string, path: string, taken_at: Date): Promise<SiteThumbnailPointer> {
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "site_set_thumbnail", {
    p_site_id: site_id,
    p_path: path,
    p_taken_at: taken_at.toISOString(),
  });
  if (error) throw new Error(`site_set_thumbnail failed${error.code ? ` (${error.code})` : ""}: ${error.message ?? "unknown error"}`);
  const r = (data ?? {}) as { outcome?: unknown; replaced?: unknown };
  const outcome = r.outcome === "set" || r.outcome === "stale" ? r.outcome : "not_found";
  return { outcome, replaced: typeof r.replaced === "string" ? r.replaced : null };
}

function why(e: unknown): string {
  return String((e as { message?: unknown })?.message ?? e).slice(0, 200);
}

async function removeWithRetry(store: Bucket, path: string, attempts = 3): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const { error } = await store.remove([path]);
      if (!error) return true;
    } catch {
    }
    await new Promise<void>((r) => setTimeout(r, 500 * (i + 1)).unref?.());
  }
  return false;
}

export function createSiteThumbnailStore(deps: SiteThumbnailDeps = {}): SiteThumbnailStore {
  const bucket = deps.bucket ?? defaultBucket;
  const resize = deps.resize ?? defaultResize;
  const setPointer = deps.setPointer ?? defaultSetPointer;

  return {
    async save({ tenant_id, site_id, jpeg_b64, taken_at }) {
      const path = newSiteThumbnailPath(tenant_id, site_id);
      if (!path || !jpeg_b64 || jpeg_b64.length > MAX_INPUT_B64 || !Number.isFinite(taken_at?.getTime())) return false;
      const store = bucket(tenant_id);
      try {
        const small = await resize(Buffer.from(jpeg_b64, "base64"));
        const { error } = await store.upload(path, small, { contentType: "image/jpeg", upsert: false });
        if (error) {
          console.warn(`[site-thumbnail] upload failed site=${site_id}: ${why(error)}`);
          return false;
        }
      } catch (e) {
        console.warn(`[site-thumbnail] could not store site=${site_id}: ${why(e)}`);
        return false;
      }
      let pointer: SiteThumbnailPointer;
      try {
        pointer = await setPointer(tenant_id, site_id, path, taken_at);
      } catch (e) {
        console.warn(`[site-thumbnail] ALERT pointer outcome unknown site=${site_id} path=${path}: ${why(e)}`);
        return false;
      }
      if (pointer.outcome !== "set") {
        if (!(await removeWithRetry(store, path))) {
          console.error(`[site-thumbnail] ALERT orphaned screenshot ${path} (pointer ${pointer.outcome})`);
        }
        return false;
      }
      const prev = pointer.replaced;
      if (prev && prev !== path && isSiteThumbnailPath(tenant_id, site_id, prev)) {
        await Promise.resolve(store.remove([prev])).catch(() => undefined);
      }
      return true;
    },

    async removeAll({ tenant_id, site_id }) {
      if (!UUID_RE.test(tenant_id) || !UUID_RE.test(site_id)) return;
      const store = bucket(tenant_id);
      const prefix = `${tenant_id.toLowerCase()}/${site_id.toLowerCase()}`;
      for (let page = 0; page < 50; page++) {
        const { data, error } = await store.list(prefix, { limit: 100 });
        if (error) throw new Error(`thumbnail list failed: ${why(error)}`);
        const paths = (data ?? []).map((o) => `${prefix}/${o?.name}`).filter((p) => isSiteThumbnailPath(tenant_id, site_id, p));
        if (paths.length === 0) return;
        const removed = await store.remove(paths);
        if (removed.error) throw new Error(`thumbnail delete failed: ${why(removed.error)}`);
      }
      throw new Error("thumbnail delete did not finish");
    },
  };
}

let _store: SiteThumbnailStore | null = null;
export function siteThumbnailStore(): SiteThumbnailStore {
  return (_store ??= createSiteThumbnailStore());
}
