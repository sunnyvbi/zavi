
import sharp from "sharp";
import { IMAGE_PATH_RE } from "@/services/connectors/social-channels";
import { tenantClient, tenantStorage, type TenantId } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import {
  AD_ASSETS_BUCKET,
  LOGO_MAX_BYTES,
  pinnedFetch,
  sha256Hex,
  sniffLogoMime,
  imageDimensions,
  type LogoMime,
  type PinnedFetchDeps,
} from "./_logo";

export type AdImageSlot = "landscape" | "square" | "portrait" | "logo";

type SlotSpec = { ratio: number; min: [number, number]; max: [number, number]; label: string; shape: string };

export const AD_IMAGE_SLOTS: Record<AdImageSlot, SlotSpec> = {
  landscape: { ratio: 1.91, min: [600, 314], max: [1200, 628], label: "landscape image", shape: "1.91:1 (render it 16:9)" },
  square: { ratio: 1, min: [300, 300], max: [1200, 1200], label: "square image", shape: "1:1" },
  portrait: { ratio: 0.8, min: [480, 600], max: [960, 1200], label: "portrait image", shape: "4:5" },
  logo: { ratio: 1, min: [128, 128], max: [1200, 1200], label: "logo", shape: "1:1" },
};

export const MAX_TRIM = 0.1;
const RATIO_TOLERANCE = 0.01;
const SOURCE_MAX_BYTES = 20_000_000;

const ARTIFACT_BUCKET = "agent-artifacts";
const CHAT_IMAGE_BUCKET = "agent-chat-images";
const ARTIFACT_IMAGE_BUCKETS: ReadonlySet<string> = new Set([ARTIFACT_BUCKET, CHAT_IMAGE_BUCKET]);

export type AdImageSource = { artifact_id: string } | { filename: string } | { image_path: string } | { url: string };

export type AdImageRef = {
  storage_path: string;
  sha256: string;
  mime: LogoMime;
  width: number;
  height: number;
};

type Bucket = { download(path: string): Promise<{ data: Blob | null; error: { message?: string } | null }> };
type ArtifactRow = { id: string; storage_path: string; bucket: string | null; mime: string | null };
type StoreBucket = {
  upload(path: string, bytes: Buffer, o: { contentType: string; upsert: boolean }): Promise<{ error: { message?: string; statusCode?: string | number } | null }>;
  download(path: string): Promise<{ data: Blob | null; error: { message?: string; statusCode?: string | number; status?: number } | null }>;
};

export type AdImageDeps = {
  readArtifact?: (tid: TenantId, by: { id: string } | { filename: string }) => Promise<ArtifactRow | null>;
  bucket?: (tid: TenantId, name: string) => Bucket;
  store?: (tid: TenantId) => StoreBucket;
  fetch?: PinnedFetchDeps;
};

const notFound = (why: string) => new ExpectedToolError("google_ads_ad_image_not_found", `That image cannot be used: ${why}`);

async function defaultReadArtifact(tid: TenantId, by: { id: string } | { filename: string }): Promise<ArtifactRow | null> {
  let q = tenantClient(tid).from("run_artifacts").select("id, storage_path, bucket, mime").like("mime", "image/%");
  q = "id" in by ? q.eq("id", by.id) : q.eq("filename", by.filename).order("created_at", { ascending: false });
  const { data, error } = await q.limit(1);
  if (error) {
    throw new ExpectedToolError("google_ads_ad_image_unavailable", `The image could not be looked up right now (${error.message}); try again.`);
  }
  return ((data as ArtifactRow[] | null) ?? [])[0] ?? null;
}

const defaultBucket = (tid: TenantId, name: string): Bucket => tenantStorage(tid).from(name) as unknown as Bucket;
const defaultStore = (tid: TenantId): StoreBucket => tenantStorage(tid).from(AD_ASSETS_BUCKET) as unknown as StoreBucket;

async function download(tid: TenantId, bucket: string, path: string, deps: AdImageDeps): Promise<Buffer> {
  const { data, error } = await (deps.bucket ?? defaultBucket)(tid, bucket).download(path);
  if (error || !data) throw notFound("the file is no longer stored.");
  const bytes = Buffer.from(await data.arrayBuffer());
  if (bytes.length > SOURCE_MAX_BYTES) throw notFound(`it is ${bytes.length} bytes; the limit is ${SOURCE_MAX_BYTES}.`);
  return bytes;
}

export async function readAdImageSource(
  tid: TenantId,
  src: AdImageSource,
  deps: AdImageDeps = {},
): Promise<{ bytes: Buffer; artifact_id?: string }> {
  const tenantPrefix = `${String(tid).toLowerCase()}/`;
  if ("artifact_id" in src || "filename" in src) {
    const by = "artifact_id" in src ? { id: src.artifact_id } : { filename: src.filename };
    const row = await (deps.readArtifact ?? defaultReadArtifact)(tid, by);
    const bucket = row?.bucket ?? ARTIFACT_BUCKET;
    if (!row || !row.storage_path.startsWith(tenantPrefix) || !ARTIFACT_IMAGE_BUCKETS.has(bucket) || !(row.mime ?? "").startsWith("image/")) {
      throw notFound(`no image file ${"id" in by ? by.id : by.filename} in this workspace.`);
    }
    return { bytes: await download(tid, bucket, row.storage_path, deps), artifact_id: row.id };
  }
  if ("image_path" in src) {
    if (!IMAGE_PATH_RE.test(src.image_path) || !src.image_path.startsWith(tenantPrefix)) {
      throw notFound(`no uploaded image ${src.image_path} in this workspace.`);
    }
    return { bytes: await download(tid, CHAT_IMAGE_BUCKET, src.image_path, deps) };
  }
  return { bytes: (await pinnedFetch(src.url, { ...deps.fetch, what: "image" })).bytes };
}

export type FittedAdImage = { bytes: Buffer; mime: LogoMime; width: number; height: number; trimmed_pct: number };

export async function fitAdImage(source: Buffer, slot: AdImageSlot): Promise<FittedAdImage> {
  const spec = AD_IMAGE_SLOTS[slot];
  const invalid = (code: string, why: string) =>
    new ExpectedToolError(`google_ads_ad_image_${code}`, `The ${spec.label} cannot be used: ${why}`);
  let decoded: { data: Buffer; info: sharp.OutputInfo };
  try {
    decoded = await sharp(source, { failOn: "error" }).rotate().toBuffer({ resolveWithObject: true });
  } catch {
    throw invalid("invalid", "it is not an image Zavi can read.");
  }
  const { width: w, height: h } = decoded.info;
  const ratio = w / h;
  let crop: { left: number; top: number; width: number; height: number } | null = null;
  let trimmed = 0;
  if (Math.abs(ratio - spec.ratio) / spec.ratio > RATIO_TOLERANCE) {
    crop =
      ratio > spec.ratio
        ? { width: Math.round(h * spec.ratio), height: h, left: 0, top: 0 }
        : { width: w, height: Math.round(w / spec.ratio), left: 0, top: 0 };
    crop.left = Math.floor((w - crop.width) / 2);
    crop.top = Math.floor((h - crop.height) / 2);
    trimmed = ratio > spec.ratio ? 1 - crop.width / w : 1 - crop.height / h;
    if (trimmed > MAX_TRIM) {
      throw invalid(
        "wrong_shape",
        `it is ${w}x${h}, and fitting it to ${spec.shape} would cut ${Math.round(trimmed * 100)}% of it. Make a version in that shape instead.`,
      );
    }
  }
  const cw = crop?.width ?? w;
  const ch = crop?.height ?? h;
  if (cw < spec.min[0] || ch < spec.min[1]) {
    throw invalid("too_small", `it is ${cw}x${ch} at ${spec.shape}; Google needs at least ${spec.min[0]}x${spec.min[1]}.`);
  }
  const scale = Math.min(1, spec.max[0] / cw, spec.max[1] / ch);
  const sourceMime = sniffLogoMime(source);
  const header = imageDimensions(source);
  if (!crop && scale === 1 && sourceMime !== null && source.length <= LOGO_MAX_BYTES && header?.width === w && header.height === h) {
    return { bytes: source, mime: sourceMime, width: w, height: h, trimmed_pct: 0 };
  }
  let img = sharp(decoded.data);
  if (crop) img = img.extract(crop);
  const outW = Math.round(cw * scale);
  const outH = Math.round(ch * scale);
  if (scale < 1) img = img.resize(outW, outH);
  let mime: LogoMime = sourceMime === "image/jpeg" ? "image/jpeg" : "image/png";
  let bytes = mime === "image/png" ? await img.clone().png().toBuffer() : await img.clone().jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  if (bytes.length > LOGO_MAX_BYTES) {
    mime = "image/jpeg";
    bytes = await img.flatten({ background: "#ffffff" }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  }
  if (bytes.length > LOGO_MAX_BYTES) throw invalid("invalid", `even re-encoded it is ${bytes.length} bytes; the limit is ${LOGO_MAX_BYTES}.`);
  return { bytes, mime, width: outW, height: outH, trimmed_pct: Math.round(trimmed * 100) };
}

export function adImageStoragePath(tid: TenantId, sha256: string, mime: LogoMime): string {
  return `${String(tid).toLowerCase()}/images/${sha256}.${mime === "image/png" ? "png" : "jpg"}`;
}

export function adImagePathBelongsTo(tenantId: string, storagePath: string): boolean {
  return storagePath.startsWith(`${tenantId.toLowerCase()}/images/`);
}

export async function storeAdImage(tid: TenantId, img: FittedAdImage, deps: AdImageDeps = {}): Promise<AdImageRef> {
  const sha256 = sha256Hex(img.bytes);
  const storage_path = adImageStoragePath(tid, sha256, img.mime);
  const { error } = await (deps.store ?? defaultStore)(tid).upload(storage_path, img.bytes, { contentType: img.mime, upsert: false });
  if (error && !(String(error.statusCode ?? "") === "409" || /already exists|duplicate/i.test(error.message ?? ""))) {
    throw new ExpectedToolError("google_ads_ad_image_store_failed", `The image could not be saved: ${error.message}`);
  }
  return { storage_path, sha256, mime: img.mime, width: img.width, height: img.height };
}

export async function loadAdImageBytes(tid: TenantId, ref: AdImageRef, deps: AdImageDeps = {}): Promise<{ bytes: Buffer; base64: string }> {
  const mismatch = (why: string) =>
    new ExpectedToolError("google_ads_ad_image_mismatch", `A stored image for this card cannot be used: ${why}`);
  if (!adImagePathBelongsTo(String(tid), ref.storage_path)) throw mismatch("it belongs to another workspace.");
  if (adImageStoragePath(tid, ref.sha256, ref.mime) !== ref.storage_path) throw mismatch("its path does not match its hash.");
  const { data, error } = await (deps.store ?? defaultStore)(tid).download(ref.storage_path);
  if (error || !data) {
    const status = String(error?.statusCode ?? error?.status ?? "");
    if (status === "404" || /not found/i.test(error?.message ?? "")) throw mismatch("it is no longer stored.");
    throw new ExpectedToolError(
      "google_ads_ad_image_unavailable",
      `A stored image could not be read right now (${error?.message ?? "no data"}); try again.`,
    );
  }
  const bytes = Buffer.from(await data.arrayBuffer());
  if (sha256Hex(bytes) !== ref.sha256) throw mismatch("its bytes changed since Google checked them.");
  return { bytes, base64: bytes.toString("base64") };
}
