import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { asTenantId, tenantClient, tenantRpc, tenantStorage } from "@/services/tenant-client";
import { SITE_EDITS_APP_PREFIX } from "./site-inline-edits";

export const SITE_PREVIEW_SNAPSHOT_BUCKET = "agent-artifacts";
export const SITE_PREVIEW_DEVICES = ["desktop", "mobile"] as const;
export type SitePreviewDevice = (typeof SITE_PREVIEW_DEVICES)[number];

const SNAPSHOT_QUALITY = 80;
const MAX_INPUT_B64 = 600_000;
const LIMIT_INPUT_PIXELS = 4096 * 4096;
const MAX_WIDTH: Record<SitePreviewDevice, number> = { desktop: 1440, mobile: 780 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNAPSHOT_RE = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\/site-preview-(desktop|mobile)-[0-9a-f]{12}\.jpg$/;

export function isSitePreviewDevice(value: unknown): value is SitePreviewDevice {
  return value === "desktop" || value === "mobile";
}

export function newSitePreviewSnapshotPath(
  tenant_id: string,
  site_id: string,
  device: SitePreviewDevice,
  token: string = randomBytes(6).toString("hex"),
): string | null {
  if (!UUID_RE.test(tenant_id) || !UUID_RE.test(site_id) || !isSitePreviewDevice(device) || !/^[0-9a-f]{12}$/.test(token)) return null;
  return `${tenant_id.toLowerCase()}/${site_id.toLowerCase()}/site-preview-${device}-${token}.jpg`;
}

export function isSitePreviewSnapshotPath(tenant_id: string, site_id: string, path: unknown, device?: SitePreviewDevice): path is string {
  const m = typeof path === "string" ? SNAPSHOT_RE.exec(path) : null;
  return !!m && m[1] === tenant_id.toLowerCase() && m[2] === site_id.toLowerCase() && (device === undefined || m[3] === device);
}

export type SitePreviewSnapshotRow = { device: SitePreviewDevice; path: string; taken_at: string; width: number; height: number };

export function snapshotIsFresh(input: { taken_at: string; changed_at: string | null; pending_edits: boolean }): boolean {
  if (input.pending_edits) return false;
  const taken = Date.parse(input.taken_at);
  if (!Number.isFinite(taken)) return false;
  if (input.changed_at === null) return true;
  const changed = Date.parse(input.changed_at);
  return Number.isFinite(changed) && taken > changed;
}

type Bucket = {
  upload: (path: string, body: Buffer, opts: { contentType: string; upsert: boolean }) => PromiseLike<{ error: { message?: string } | null }>;
  remove: (paths: string[]) => PromiseLike<{ error: { message?: string } | null }>;
  list: (prefix: string, opts: { limit: number; search?: string }) => PromiseLike<{ data: Array<{ name: string }> | null; error: { message?: string } | null }>;
};

export type SnapshotPointer = { outcome: "set" | "stale" | "not_found"; replaced: string | null };

export type SitePreviewSnapshotDeps = {
  bucket?: (tenant_id: string) => Bucket;
  encode?: (jpeg: Buffer, device: SitePreviewDevice) => Promise<{ body: Buffer; width: number; height: number }>;
  setPointer?: (input: { tenant_id: string; site_id: string; device: SitePreviewDevice; path: string; taken_at: Date; width: number; height: number }) => Promise<SnapshotPointer>;
  markChanged?: (tenant_id: string, site_id: string, at: Date) => Promise<boolean>;
  readRows?: (tenant_id: string, site_id: string) => Promise<SitePreviewSnapshotRow[]>;
  readChangedAt?: (tenant_id: string, site_id: string) => Promise<string | null>;
  hasPendingEdits?: (tenant_id: string, site_id: string) => Promise<boolean>;
  now?: () => number;
};

export type SitePreviewSnapshotStore = {
  save: (input: { tenant_id: string; site_id: string; device: SitePreviewDevice; jpeg_b64: string; taken_at: Date }) => Promise<boolean>;
  markChanged: (tenant_id: string, site_id: string) => Promise<boolean>;
  fresh: (tenant_id: string, site_id: string) => Promise<SitePreviewSnapshotRow[]>;
  removeAll: (input: { tenant_id: string; site_id: string }) => Promise<void>;
};

function defaultBucket(tenant_id: string): Bucket {
  return tenantStorage(asTenantId(tenant_id)).from(SITE_PREVIEW_SNAPSHOT_BUCKET) as unknown as Bucket;
}

async function defaultEncode(jpeg: Buffer, device: SitePreviewDevice): Promise<{ body: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(jpeg, { failOn: "truncated", limitInputPixels: LIMIT_INPUT_PIXELS })
    .resize(MAX_WIDTH[device], null, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: SNAPSHOT_QUALITY, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { body: data, width: info.width, height: info.height };
}

async function defaultSetPointer(input: { tenant_id: string; site_id: string; device: SitePreviewDevice; path: string; taken_at: Date; width: number; height: number }): Promise<SnapshotPointer> {
  const { data, error } = await tenantRpc(asTenantId(input.tenant_id), "site_set_preview_snapshot", {
    p_site_id: input.site_id,
    p_device: input.device,
    p_path: input.path,
    p_taken_at: input.taken_at.toISOString(),
    p_width: input.width,
    p_height: input.height,
  });
  if (error) throw new Error(`site_set_preview_snapshot failed${error.code ? ` (${error.code})` : ""}: ${error.message ?? "unknown error"}`);
  const r = (data ?? {}) as { outcome?: unknown; replaced?: unknown };
  const outcome = r.outcome === "set" || r.outcome === "stale" ? r.outcome : "not_found";
  return { outcome, replaced: typeof r.replaced === "string" ? r.replaced : null };
}

async function defaultMarkChanged(tenant_id: string, site_id: string, at: Date): Promise<boolean> {
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "site_mark_preview_changed", { p_site_id: site_id, p_at: at.toISOString() });
  if (error) throw new Error(`site_mark_preview_changed failed: ${error.message ?? "unknown error"}`);
  return data === true;
}

async function defaultReadRows(tenant_id: string, site_id: string): Promise<SitePreviewSnapshotRow[]> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("site_preview_snapshots")
    .select("device, path, taken_at, width, height")
    .eq("site_id", site_id);
  if (error) throw new Error(`preview snapshot read failed: ${error.message}`);
  return ((data ?? []) as SitePreviewSnapshotRow[]).filter((r) => isSitePreviewDevice(r.device));
}

async function defaultReadChangedAt(tenant_id: string, site_id: string): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from("sites").select("preview_changed_at, last_edit_at").eq("id", site_id).maybeSingle();
  if (error) throw new Error(`preview change read failed: ${error.message}`);
  return latestChange(data as { preview_changed_at?: unknown; last_edit_at?: unknown } | null);
}

export function latestChange(row: { preview_changed_at?: unknown; last_edit_at?: unknown } | null): string | null {
  const stamps = [row?.preview_changed_at, row?.last_edit_at].filter((v): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)));
  if (!stamps.length) return null;
  return stamps.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

async function defaultHasPendingEdits(tenant_id: string, site_id: string): Promise<boolean> {
  const { count, error } = await tenantClient(asTenantId(tenant_id))
    .from("website_edits")
    .select("id", { count: "exact", head: true })
    .eq("app_id", `${SITE_EDITS_APP_PREFIX}${site_id}`);
  if (error) throw new Error(`pending edits read failed: ${error.message}`);
  return (count ?? 0) > 0;
}

function why(e: unknown): string {
  return String((e as { message?: unknown })?.message ?? e).slice(0, 200);
}

async function removeQuietly(store: Bucket, path: string): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    try {
      const { error } = await store.remove([path]);
      if (!error) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function createSitePreviewSnapshotStore(deps: SitePreviewSnapshotDeps = {}): SitePreviewSnapshotStore {
  const bucket = deps.bucket ?? defaultBucket;
  const encode = deps.encode ?? defaultEncode;
  const setPointer = deps.setPointer ?? defaultSetPointer;
  const markChanged = deps.markChanged ?? defaultMarkChanged;
  const readRows = deps.readRows ?? defaultReadRows;
  const readChangedAt = deps.readChangedAt ?? defaultReadChangedAt;
  const hasPendingEdits = deps.hasPendingEdits ?? defaultHasPendingEdits;
  const now = deps.now ?? Date.now;

  return {
    async save({ tenant_id, site_id, device, jpeg_b64, taken_at }) {
      const path = newSitePreviewSnapshotPath(tenant_id, site_id, device);
      if (!path || !jpeg_b64 || jpeg_b64.length > MAX_INPUT_B64 || !Number.isFinite(taken_at?.getTime())) return false;
      const store = bucket(tenant_id);
      let size: { width: number; height: number };
      try {
        const encoded = await encode(Buffer.from(jpeg_b64, "base64"), device);
        size = { width: encoded.width, height: encoded.height };
        const { error } = await store.upload(path, encoded.body, { contentType: "image/jpeg", upsert: false });
        if (error) {
          console.warn(`[site-preview-snapshot] upload failed site=${site_id} device=${device}: ${why(error)}`);
          return false;
        }
      } catch (e) {
        console.warn(`[site-preview-snapshot] could not store site=${site_id} device=${device}: ${why(e)}`);
        return false;
      }
      let pointer: SnapshotPointer;
      try {
        pointer = await setPointer({ tenant_id, site_id, device, path, taken_at, ...size });
      } catch (e) {
        console.warn(`[site-preview-snapshot] ALERT pointer outcome unknown site=${site_id} path=${path}: ${why(e)}`);
        return false;
      }
      if (pointer.outcome !== "set") {
        if (!(await removeQuietly(store, path))) console.error(`[site-preview-snapshot] ALERT orphaned snapshot ${path} (pointer ${pointer.outcome})`);
        return false;
      }
      const prev = pointer.replaced;
      if (prev && prev !== path && isSitePreviewSnapshotPath(tenant_id, site_id, prev, device)) {
        await Promise.resolve(store.remove([prev])).catch(() => undefined);
      }
      return true;
    },

    async markChanged(tenant_id, site_id) {
      if (!UUID_RE.test(tenant_id) || !UUID_RE.test(site_id)) return false;
      return markChanged(tenant_id, site_id, new Date(now()));
    },

    async fresh(tenant_id, site_id) {
      if (!UUID_RE.test(tenant_id) || !UUID_RE.test(site_id)) return [];
      const [rows, changed_at, pending_edits] = await Promise.all([
        readRows(tenant_id, site_id),
        readChangedAt(tenant_id, site_id),
        hasPendingEdits(tenant_id, site_id),
      ]);
      return rows.filter(
        (r) =>
          isSitePreviewSnapshotPath(tenant_id, site_id, r.path, r.device) &&
          snapshotIsFresh({ taken_at: r.taken_at, changed_at, pending_edits }),
      );
    },

    async removeAll({ tenant_id, site_id }) {
      if (!UUID_RE.test(tenant_id) || !UUID_RE.test(site_id)) return;
      const store = bucket(tenant_id);
      const prefix = `${tenant_id.toLowerCase()}/${site_id.toLowerCase()}`;
      for (let page = 0; page < 50; page++) {
        const { data, error } = await store.list(prefix, { limit: 100, search: "site-preview-" });
        if (error) throw new Error(`preview snapshot list failed: ${why(error)}`);
        const paths = (data ?? []).map((o) => `${prefix}/${o?.name}`).filter((p) => isSitePreviewSnapshotPath(tenant_id, site_id, p));
        if (paths.length === 0) return;
        const removed = await store.remove(paths);
        if (removed.error) throw new Error(`preview snapshot delete failed: ${why(removed.error)}`);
      }
      throw new Error("preview snapshot delete did not finish");
    },
  };
}

let _store: SitePreviewSnapshotStore | null = null;
export function sitePreviewSnapshotStore(): SitePreviewSnapshotStore {
  return (_store ??= createSitePreviewSnapshotStore());
}
