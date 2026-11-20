
import { randomUUID } from "node:crypto";
import { DEV_STUB_MODEL } from "@/services/media-router/dev-stub";
import sharp from "sharp";
import { logEvent } from "@/services/logging/logEvent";
import type { MediaAspect, MediaFailReason, MediaTask } from "@/services/media-router/types";
import {
  SITE_IMAGE_ASPECTS,
  SITE_IMAGE_DIR,
  SITE_IMAGE_MARKER,
  SITE_IMAGE_URL_DIR,
  siteImageModelPrompt,
  siteImageTask,
  toWebpVariants,
  type SiteImageAspect,
} from "@/services/site-images/generate";
import { SITE_REPO_DIR, type SiteSandbox } from "./contract";
import type { DirectChangeFile, DirectChangePlan } from "./site-direct-change";
import { sandboxScriptCommand } from "./site-text-direct";

export type ImageReplaceMode = "generate" | "edit" | "url";
export type ImageReplaceRequest = { src: string; mode: ImageReplaceMode; text: string; mask?: Uint8Array };

export const IMAGE_PROMPT_MIN = 3;
export const IMAGE_PROMPT_MAX = 600;
const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(?:webp|png|jpe?g|avif|gif)$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const IMAGE_MASK_MAX_BYTES = 700 * 1024;
const MASK_DATA_URL_RE = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MASK_PIXEL_LIMIT = 40_000_000;
const MASK_FEATHER_SIGMA = 2;
const MASK_ASPECT_TOLERANCE = 0.03;
export const PHOTO_PREVIEW_MAX = 1280;

export type ImageReplaceError =
  | "bad_request"
  | "not_a_site_image"
  | "image_missing"
  | "not_in_source"
  | "marker_unreadable"
  | "insufficient_credits"
  | "credits_unavailable"
  | "not_configured"
  | "generation_failed"
  | "download_failed"
  | "convert_failed"
  | "mask_unreadable"
  | "mask_empty";

export type ImageReplaceDeps = {
  configured: (task: MediaTask) => Promise<boolean>;
  estimate: (task: MediaTask, req: { prompt: string; aspect_ratio: MediaAspect }) => Promise<number>;
  afford: (tenant_id: string, cost_usd: number) => Promise<"ok" | "short" | "unknown">;
  generate: (
    task: MediaTask,
    req: { prompt: string; aspect_ratio: MediaAspect; reference_url?: string },
  ) => Promise<{ ok: true; url: string; cost_usd: number; model: string } | { ok: false; reason: MediaFailReason; error: string }>;
  download: (url: string, maxBytes: number) => Promise<Uint8Array | null>;
  fetchPublic: (url: string) => Promise<Uint8Array | null>;
  shareReference: (tenant_id: string, bytes: Uint8Array) => Promise<{ url: string; done: () => Promise<void> } | null>;
};

type MarkerEntry = {
  slug: string;
  src: string;
  srcset: string;
  width: number;
  height: number;
  alt: string;
  aspect: SiteImageAspect;
  model?: string;
  created_at?: string;
  [k: string]: unknown;
};
type Marker = { version: 1; generated: number; images: MarkerEntry[] };

export function cleanImageRequest(raw: unknown): ImageReplaceRequest | null {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const mode = r.mode === "generate" || r.mode === "edit" || r.mode === "url" ? r.mode : null;
  const src = typeof r.src === "string" ? r.src.trim() : "";
  const text = typeof r.text === "string" ? r.text.replace(/\s+/g, " ").trim() : "";
  if (!mode || !src || src.length > 300) return null;
  if (mode === "url" ? !/^https:\/\/\S{4,2000}$/i.test(text) : text.length < IMAGE_PROMPT_MIN || text.length > IMAGE_PROMPT_MAX) return null;
  if (r.mask === undefined || r.mask === null) return { src, mode, text };
  if (mode !== "edit") return null;
  const mask = decodeImageMask(r.mask);
  return mask ? { src, mode, text, mask } : null;
}

export function decodeImageMask(raw: unknown): Uint8Array | null {
  if (typeof raw !== "string" || raw.length > 32 + Math.ceil(IMAGE_MASK_MAX_BYTES / 3) * 4) return null;
  const m = MASK_DATA_URL_RE.exec(raw);
  if (!m) return null;
  const bytes = Buffer.from(m[1]!, "base64");
  if (bytes.length < PNG_MAGIC.length || bytes.length > IMAGE_MASK_MAX_BYTES) return null;
  if (!PNG_MAGIC.every((b, i) => bytes[i] === b)) return null;
  return new Uint8Array(bytes);
}

export async function maskAlpha(
  mask: Uint8Array,
  width: number,
  height: number,
): Promise<{ alpha: Uint8Array } | { reason: "mask_unreadable" | "mask_empty" }> {
  try {
    const src = await sharp(mask, { limitInputPixels: MASK_PIXEL_LIMIT })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const mw = src.info.width;
    const mh = src.info.height;
    if (!(mw > 0 && mh > 0 && width > 0 && height > 0) || src.info.channels !== 4) return { reason: "mask_unreadable" };
    if (Math.abs(Math.log(mw / mh / (width / height))) > MASK_ASPECT_TOLERANCE) return { reason: "mask_unreadable" };
    const gray = Buffer.alloc(mw * mh);
    for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
      const lum = (src.data[i]! + src.data[i + 1]! + src.data[i + 2]!) / 3;
      gray[p] = Math.round((lum * src.data[i + 3]!) / 255);
    }
    const sized = await sharp(gray, { raw: { width: mw, height: mh, channels: 1 } })
      .resize(width, height, { fit: "fill" })
      .extractChannel(0)
      .raw()
      .toBuffer();
    if (sized.length !== width * height) return { reason: "mask_unreadable" };
    let painted = 0;
    for (let p = 0; p < sized.length; p++) if (sized[p]! >= 128) painted++;
    if (painted === 0) return { reason: "mask_empty" };
    const soft = await sharp(sized, { raw: { width, height, channels: 1 } })
      .blur(MASK_FEATHER_SIGMA)
      .extractChannel(0)
      .raw()
      .toBuffer();
    if (soft.length !== sized.length) return { reason: "mask_unreadable" };
    const alpha = new Uint8Array(sized.length);
    for (let p = 0; p < alpha.length; p++) alpha[p] = Math.min(sized[p]!, soft[p]!);
    return { alpha };
  } catch {
    return { reason: "mask_unreadable" };
  }
}

export async function compositeMasked(reference: Uint8Array, edited: Uint8Array, alpha: Uint8Array): Promise<Buffer> {
  const ref = await sharp(reference).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = ref.info;
  if (alpha.length !== width * height || ref.info.channels !== 4) throw new Error("mask_size");
  const next = await sharp(edited).rotate().resize(width, height, { fit: "fill" }).ensureAlpha().raw().toBuffer();
  if (next.length !== ref.data.length) throw new Error("edited_size");
  const out = Buffer.from(ref.data);
  for (let p = 0; p < alpha.length; p++) {
    const a = alpha[p]!;
    if (a === 0) continue;
    const i = p * 4;
    if (a === 255) {
      next.copy(out, i, i, i + 4);
      continue;
    }
    for (let c = 0; c < 4; c++) out[i + c] = Math.round((ref.data[i + c]! * (255 - a) + next[i + c]! * a) / 255);
  }
  return sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

export async function photoPreview(sandbox: SiteSandbox, src: string): Promise<{ data_url: string; width: number; height: number } | null> {
  const file = imageFileOf(src);
  if (!file) return null;
  const bytes = await readBytes(sandbox, `public${SITE_IMAGE_URL_DIR}/${file}`);
  if (!bytes) return null;
  try {
    const turned = sharp(bytes).rotate();
    const { info } = await turned.clone().raw().toBuffer({ resolveWithObject: true });
    const small = await turned
      .clone()
      .resize({ width: PHOTO_PREVIEW_MAX, height: PHOTO_PREVIEW_MAX, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    return { data_url: `data:image/webp;base64,${small.toString("base64")}`, width: info.width, height: info.height };
  } catch {
    return null;
  }
}

export function imageFileOf(src: string): string | null {
  const m = /^\/images\/([^/?#]+)$/.exec(src.trim());
  return m && FILE_RE.test(m[1]!) ? m[1]! : null;
}

export function parseImageMarker(raw: string | null): Marker | null {
  if (raw === null) return { version: 1, generated: 0, images: [] };
  try {
    const v = JSON.parse(raw) as { generated?: unknown; images?: unknown };
    if (!v || typeof v !== "object" || !Array.isArray(v.images) || typeof v.generated !== "number" || !Number.isFinite(v.generated)) return null;
    const images = (v.images as unknown[]).filter(
      (e): e is MarkerEntry =>
        !!e &&
        typeof e === "object" &&
        typeof (e as MarkerEntry).slug === "string" &&
        typeof (e as MarkerEntry).src === "string" &&
        typeof (e as MarkerEntry).srcset === "string",
    );
    return { version: 1, generated: Math.max(0, Math.floor(v.generated)), images };
  } catch {
    return null;
  }
}

function srcsetFiles(srcset: string): string[] {
  return srcset
    .split(",")
    .map((s) => s.trim().split(/\s+/)[0] ?? "")
    .filter((p) => p.startsWith(`${SITE_IMAGE_URL_DIR}/`));
}

export function nearestAspect(width: number, height: number): SiteImageAspect {
  const r = width / Math.max(1, height);
  const ratio = (a: SiteImageAspect) => {
    const [w, h] = a.split(":").map(Number) as [number, number];
    return w / h;
  };
  return [...SITE_IMAGE_ASPECTS].sort((a, b) => Math.abs(Math.log(r / ratio(a))) - Math.abs(Math.log(r / ratio(b))))[0]!;
}

export function nextSlug(base: string, taken: ReadonlySet<string>): string {
  const root = (base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-\d+$/, "") || "photo").slice(0, 34);
  for (let n = 2; n < 1000; n++) {
    const s = `${root}-${n}`;
    if (!taken.has(s)) return s;
  }
  return `${root}-${randomUUID().slice(0, 4)}`;
}

const BEFORE_TOKEN = "(?<![A-Za-z0-9._/-])";
const AFTER_TOKEN = "(?![A-Za-z0-9._-])";

export function rewriteImageRefs(
  files: ReadonlyArray<{ path: string; content: string }>,
  mapping: ReadonlyMap<string, string>,
): Array<{ path: string; before: string; after: string }> {
  const out: Array<{ path: string; before: string; after: string }> = [];
  for (const f of files) {
    let after = f.content;
    for (const [from, to] of mapping) {
      const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      after = after.replace(new RegExp(`${BEFORE_TOKEN}${esc}${AFTER_TOKEN}`, "g"), to);
    }
    if (after !== f.content) out.push({ path: f.path, before: f.content, after });
  }
  return out;
}

const GREP_MARK = "__ZAVI_IMG_REFS__";

async function filesReferencing(sandbox: SiteSandbox, paths: string[]): Promise<string[] | null> {
  const script = String.raw`const fs = require("fs");
const input = JSON.parse(Buffer.from(fs.readFileSync(0, "utf8").trim(), "base64").toString("utf8"));
const hits = [];
let seen = 0;
function consider(rel) {
  if (++seen > 3000) return;
  let st; try { st = fs.lstatSync(rel); } catch (e) { return; }
  if (!st.isFile() || st.size > 400000) return;
  const c = fs.readFileSync(rel, "utf8");
  if (input.paths.some((p) => c.includes(p))) hits.push(rel);
}
function walk(dir, depth) {
  if (depth > 12) return;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const rel = dir + "/" + e.name;
    if (e.isDirectory()) walk(rel, depth + 1);
    else if (/\.(tsx|ts|jsx|css)$/.test(e.name) && !e.name.endsWith(".d.ts")) consider(rel);
  }
}
walk("src", 0);
consider("index.html");
process.stdout.write("${GREP_MARK}" + JSON.stringify(hits) + "\n");
`;
  const r = await sandbox.run(sandboxScriptCommand(script, { paths }), { cwd: SITE_REPO_DIR, timeoutMs: 30_000 });
  const line = r.stdout.split("\n").find((l) => l.startsWith(GREP_MARK));
  if (r.exitCode !== 0 || !line) return null;
  try {
    const v = JSON.parse(line.slice(GREP_MARK.length)) as unknown;
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : null;
  } catch {
    return null;
  }
}

async function readBytes(sandbox: SiteSandbox, repoPath: string): Promise<Uint8Array | null> {
  const raw = await sandbox.readFile(`${SITE_REPO_DIR}/${repoPath}`).catch(() => null);
  if (raw === null) return null;
  return typeof raw === "string" ? new Uint8Array(Buffer.from(raw, "binary")) : new Uint8Array(raw);
}

async function readText(sandbox: SiteSandbox, repoPath: string): Promise<string | null | undefined> {
  const listed = await sandbox.run(`test -e ${repoPath} && echo yes || echo no`, { cwd: SITE_REPO_DIR, timeoutMs: 15_000 });
  if (listed.exitCode !== 0) return undefined;
  if (listed.stdout.trim() === "no") return null;
  const raw = await sandbox.readFile(`${SITE_REPO_DIR}/${repoPath}`).catch(() => undefined);
  if (raw === undefined) return undefined;
  return typeof raw === "string" ? raw : raw.toString("utf8");
}

export function imageEditPrompt(instruction: string): string {
  const what = instruction.replace(/\s+/g, " ").trim().slice(0, IMAGE_PROMPT_MAX).replace(/[.\s]+$/, "");
  return [
    `Edit this photo: ${what}.`,
    "Change only what is asked; keep the framing, light, colours and style of the rest of the photo.",
    "No text, no words, no logos, no watermarks, no brand marks, no recognizable real or famous people.",
  ].join(" ");
}

export type ImageReplaceOutcome = { src: string; srcset: string; places: number };

export type PreparedImage = {
  request: ImageReplaceRequest;
  file: string;
  oldPaths: string[];
  entry: MarkerEntry | null;
  aspect: SiteImageAspect;
  variants: Array<{ width: number; height: number; data: Uint8Array }>;
  model: string;
  cost_usd: number;
  charge: { task: MediaTask; cost_usd: number } | null;
  markerRaw: string | null;
};

export async function prepareImage(
  sandbox: SiteSandbox,
  input: { tenant_id: string; site_id: string; request: ImageReplaceRequest },
  deps: ImageReplaceDeps,
): Promise<PreparedImage | { reason: ImageReplaceError | "sandbox_read_failed" }> {
  const req = input.request;
  const file = imageFileOf(req.src);
  if (!file) return { reason: "not_a_site_image" };
  const markerRaw = await readText(sandbox, SITE_IMAGE_MARKER);
  const marker = markerRaw === undefined ? null : parseImageMarker(markerRaw);
  if (!marker || markerRaw === undefined) return { reason: "marker_unreadable" };
  const oldSrc = `${SITE_IMAGE_URL_DIR}/${file}`;
  const entry = marker.images.find((e) => e.src === oldSrc || srcsetFiles(e.srcset).includes(oldSrc)) ?? null;
  const oldPaths = entry ? [...new Set([entry.src, ...srcsetFiles(entry.srcset)])] : [oldSrc];
  const oldBytes = await readBytes(sandbox, `public${oldPaths[0]}`);
  if (!oldBytes) return { reason: "image_missing" };
  let aspect: SiteImageAspect;
  if (entry && (SITE_IMAGE_ASPECTS as readonly string[]).includes(entry.aspect)) aspect = entry.aspect;
  else {
    const meta = await sharp(oldBytes).metadata().catch(() => null);
    if (!meta?.width || !meta.height) return { reason: "image_missing" };
    const turned = (meta.orientation ?? 1) >= 5;
    aspect = nearestAspect(turned ? meta.height : meta.width, turned ? meta.width : meta.height);
  }
  const refs = await filesReferencing(sandbox, oldPaths);
  if (refs === null) return { reason: "sandbox_read_failed" };
  if (refs.length === 0) return { reason: "not_in_source" };

  let reference: Buffer | null = null;
  let alpha: Uint8Array | null = null;
  if (req.mode === "edit") {
    reference = await sharp(oldBytes).rotate().png().toBuffer().catch(() => null);
    if (!reference) return { reason: "generation_failed" };
  }
  if (req.mode === "edit" && req.mask && reference) {
    const meta = await sharp(reference).metadata().catch(() => null);
    if (!meta?.width || !meta.height) return { reason: "image_missing" };
    const made = await maskAlpha(req.mask, meta.width, meta.height);
    if ("reason" in made) return { reason: made.reason };
    alpha = made.alpha;
  }

  let bytes: Uint8Array | null = null;
  let cost = 0;
  let task: MediaTask | null = null;
  let estimate = 0;
  let model = "imported";
  if (req.mode === "url") {
    bytes = await deps.fetchPublic(req.text).catch(() => null);
    if (!bytes) return { reason: "download_failed" };
  } else {
    task = req.mode === "edit" ? "image.edit" : siteImageTask(aspect);
    if (!(await deps.configured(task).catch(() => false))) return { reason: "not_configured" };
    estimate = Math.max(0, (await deps.estimate(task, { prompt: req.text, aspect_ratio: aspect }).catch(() => 0)) || 0);
    if (!(estimate > 0)) return { reason: "credits_unavailable" };
    const wallet = await deps.afford(input.tenant_id, estimate).catch(() => "unknown" as const);
    if (wallet === "short") return { reason: "insufficient_credits" };
    if (wallet !== "ok") return { reason: "credits_unavailable" };
    let shared: { url: string; done: () => Promise<void> } | null = null;
    if (req.mode === "edit") {
      shared = reference ? await deps.shareReference(input.tenant_id, new Uint8Array(reference)).catch(() => null) : null;
      if (!shared) return { reason: "generation_failed" };
    }
    try {
      const prompt = req.mode === "edit" ? imageEditPrompt(req.text) : siteImageModelPrompt(req.text, {});
      const gen = await deps
        .generate(task, { prompt, aspect_ratio: aspect, ...(shared ? { reference_url: shared.url } : {}) })
        .catch((e: unknown) => ({ ok: false as const, reason: "vendor_error" as MediaFailReason, error: String((e as Error)?.message ?? e) }));
      if (!gen.ok) {
        logImage(input, req.mode, 0, gen.reason);
        return { reason: gen.reason === "not_configured" || gen.reason === "out_of_credits" ? "not_configured" : "generation_failed" };
      }
      cost = gen.cost_usd;
      model = gen.model;
      bytes = await deps.download(gen.url, MAX_DOWNLOAD_BYTES).catch(() => null);
      if (!bytes) {
        logImage(input, req.mode, cost, "download_failed");
        return { reason: "download_failed" };
      }
    } finally {
      await shared?.done().catch(() => undefined);
    }
    if (alpha && reference && bytes) {
      const merged = await compositeMasked(reference, bytes, alpha).catch(() => null);
      if (!merged) {
        logImage(input, req.mode, cost, "convert_failed");
        return { reason: "convert_failed" };
      }
      bytes = new Uint8Array(merged);
    }
  }
  const webp = await toWebpVariants(bytes, aspect);
  if (!webp || webp.variants.length === 0) {
    logImage(input, req.mode, cost, "convert_failed");
    return { reason: "convert_failed" };
  }
  logImage(input, req.mode, cost, null);
  const charge = task && model !== DEV_STUB_MODEL ? { task, cost_usd: cost > 0 ? cost : estimate } : null;
  return { request: req, file, oldPaths, entry, aspect, variants: webp.variants, model, cost_usd: cost, charge, markerRaw };
}

export function imagePlan(prepared: PreparedImage, outcome: { value: ImageReplaceOutcome | null }): (sandbox: SiteSandbox) => Promise<DirectChangePlan> {
  return async (sandbox) => {
    const markerRaw = await readText(sandbox, SITE_IMAGE_MARKER);
    if (markerRaw === undefined || markerRaw !== prepared.markerRaw) return { reason: "changed" };
    const marker = parseImageMarker(markerRaw);
    if (!marker) return { reason: "marker_unreadable" };
    const refs = await filesReferencing(sandbox, prepared.oldPaths);
    if (refs === null) return { reason: "sandbox_read_failed" };
    if (refs.length === 0) return { reason: "not_in_source" };

    const listing = await sandbox.listFiles(`${SITE_REPO_DIR}/${SITE_IMAGE_DIR}`).catch(() => [] as string[]);
    const taken = new Set<string>(marker.images.map((e) => e.slug));
    for (const p of listing) {
      const name = p.split("/").pop() ?? "";
      const m = /^([a-z0-9][a-z0-9-]*?)-\d+\.webp$/.exec(name);
      if (m) taken.add(m[1]!);
      taken.add(name.replace(/\.[a-z0-9]+$/i, ""));
    }
    const slug = nextSlug(prepared.entry?.slug ?? prepared.file.replace(/\.[a-z0-9]+$/i, ""), taken);
    if (!SLUG_RE.test(slug)) return { reason: "bad_request" };
    const made = prepared.variants.map((v) => ({ ...v, url: `${SITE_IMAGE_URL_DIR}/${slug}-${v.width}.webp` }));
    const large = made[0]!;
    const srcset = made.map((v) => `${v.url} ${v.width}w`).join(", ");

    const mapping = new Map<string, string>();
    prepared.oldPaths.forEach((p, i) => mapping.set(p, (made[i] ?? made[made.length - 1]!).url));
    const sources: Array<{ path: string; content: string }> = [];
    for (const p of refs) {
      const raw = await sandbox.readFile(`${SITE_REPO_DIR}/${p}`).catch(() => null);
      if (raw === null) return { reason: "sandbox_read_failed" };
      sources.push({ path: p, content: typeof raw === "string" ? raw : raw.toString("utf8") });
    }
    const changed = rewriteImageRefs(sources, mapping);
    if (changed.length === 0) return { reason: "not_in_source" };
    const places = changed.reduce((n, c) => n + countRefs(c.before, mapping), 0);

    const nextMarker: Marker = {
      version: 1,
      generated: marker.generated,
      images: [
        ...marker.images,
        {
          slug,
          src: large.url,
          srcset,
          width: large.width,
          height: large.height,
          alt: prepared.entry?.alt?.trim() || "Photo",
          aspect: prepared.aspect,
          model: prepared.model,
          created_at: new Date().toISOString(),
          source: prepared.request.mode === "url" ? "link" : "edit",
        },
      ],
    };
    const files: DirectChangeFile[] = [
      ...made.map((v) => ({ path: `public${v.url}`, before: null, after: Buffer.from(v.data).toString("base64"), encoding: "base64" as const })),
      ...changed.map((c) => ({ path: c.path, before: c.before, after: c.after })),
      { path: SITE_IMAGE_MARKER, before: markerRaw, after: `${JSON.stringify(nextMarker, null, 2)}\n` },
    ];
    outcome.value = { src: large.url, srcset, places };
    const label = prepared.request.mode !== "edit" ? "Replaced a photo" : prepared.request.mask ? "Edited part of a photo with AI" : "Edited a photo with AI";
    return { files, label };
  };
}

function countRefs(content: string, mapping: ReadonlyMap<string, string>): number {
  let n = 0;
  for (const from of mapping.keys()) {
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    n += (content.match(new RegExp(`${BEFORE_TOKEN}${esc}${AFTER_TOKEN}`, "g")) ?? []).length;
  }
  return n;
}

function logImage(input: { tenant_id: string; site_id: string }, mode: ImageReplaceMode, cost: number, skipped: string | null): void {
  void logEvent({
    level: skipped ? "warn" : "info",
    source: "site-images",
    code: "site_images.replaced",
    tenant_id: input.tenant_id,
    meta: { mode, site_id: input.site_id, cost_usd: Math.round(cost * 10000) / 10000, ...(skipped ? { skipped_reason: skipped } : {}) },
  });
}

export function imageReplaceMessage(reason: string): string {
  if (reason === "insufficient_credits") return "Not enough credits for this photo. Top up to make it. Nothing was run or charged.";
  if (reason === "credits_unavailable") return "We couldn't read your credit balance, so nothing was run or charged. Try again in a minute.";
  if (reason === "not_configured") return "AI photos are unavailable right now. Try again later, or paste a photo address.";
  if (reason === "download_failed") return "We couldn't get that photo. Check the address is a public https image and try again.";
  if (reason === "generation_failed" || reason === "convert_failed") return "That photo didn't come out. Try again, maybe with different words.";
  if (reason === "mask_empty") return "Brush over the part of the photo to change first. Nothing was run or charged.";
  if (reason === "mask_unreadable") return "We couldn't read the brushed area. Brush it again and retry. Nothing was run or charged.";
  if (reason === "not_a_site_image" || reason === "not_in_source" || reason === "image_missing") {
    return "This photo can't be swapped here. Ask for the change in the chat.";
  }
  return "";
}
