
import sharp from "sharp";
import { z } from "zod";
import { logEvent } from "@/services/logging/logEvent";
import type { MediaAspect, MediaFailReason, MediaTask } from "@/services/media-router/types";

import { SITE_IMAGE_DIR, SITE_IMAGE_MARKER, SITE_IMAGE_URL_DIR } from "./constants";

export { SITE_IMAGE_DIR, SITE_IMAGE_MARKER, SITE_IMAGE_URL_DIR };
export const MAX_IMAGES_PER_CALL = 4;
export const MAX_IMAGES_PER_RUN = 6;
export const MAX_IMAGES_PER_SITE = 12;
const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;
const WEBP_QUALITY = 72;

export const SITE_IMAGE_ASPECTS = ["16:9", "4:5", "1:1"] as const;
export type SiteImageAspect = (typeof SITE_IMAGE_ASPECTS)[number];

export const SITE_IMAGE_WIDTHS: Record<SiteImageAspect, readonly [number, number]> = {
  "16:9": [1600, 800],
  "4:5": [960, 480],
  "1:1": [960, 480],
};

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const SITE_IMAGE_ROLES = ["hero", "service", "product", "people", "gallery", "supporting"] as const;
export type SiteImageRole = (typeof SITE_IMAGE_ROLES)[number];
export type SiteImageFocal = { x: number; y: number };

export const siteImageRequestSchema = z.object({
  slug: z
    .string()
    .regex(SLUG, "lowercase letters, digits and dashes, starting with a letter or digit, at most 40 characters"),
  prompt: z.string().min(10).max(600),
  alt: z.string().min(3).max(200),
  aspect: z.enum(SITE_IMAGE_ASPECTS).default("16:9"),
  role: z.enum(SITE_IMAGE_ROLES).optional(),
  placement: z.string().max(120).optional(),
  overlay: z.boolean().optional(),
  focal: z.object({ x: z.number(), y: z.number() }).optional(),
  style: z.string().max(300).optional(),
});
export type SiteImageRequest = z.infer<typeof siteImageRequestSchema>;

export type SiteImage = {
  slug: string;
  src: string;
  srcset: string;
  width: number;
  height: number;
  alt: string;
  aspect: SiteImageAspect;
  focal?: SiteImageFocal;
  reused: boolean;
};

export type SiteImageSkipReason =
  | MediaFailReason
  | "run_cap_reached"
  | "site_cap_reached"
  | "duplicate_slug"
  | "download_failed"
  | "convert_failed"
  | "write_failed"
  | "marker_unreadable";

export type SiteImagesResult = {
  images: SiteImage[];
  skipped: Array<{ slug: string; reason: SiteImageSkipReason; detail?: string }>;
  cost_usd: number;
  note?: string;
};

type MarkerEntry = Omit<SiteImage, "reused"> & { model?: string; created_at?: string };
type Marker = { version: 1; generated: number; images: MarkerEntry[] };

export type SiteImageDeps = {
  configured: (task: MediaTask) => Promise<boolean>;
  generate: (task: MediaTask, prompt: string, aspect: MediaAspect) => Promise<
    { ok: true; url: string; cost_usd: number; model: string } | { ok: false; reason: MediaFailReason; error: string }
  >;
  download: (url: string, maxBytes: number) => Promise<Uint8Array | null>;
  readText: (path: string) => Promise<string | null>;
  exists: (path: string) => Promise<boolean>;
  present: (path: string) => Promise<boolean>;
  writeBytes: (path: string, bytes: Uint8Array) => Promise<void>;
  writeText: (path: string, text: string) => Promise<void>;
};

export type GenerateSiteImagesInput = {
  tenant_id: string;
  run_id: string;
  repoRoot: string;
  images: SiteImageRequest[];
};

export const NO_PHOTO_NOTE =
  "No photo landed. Do not call this tool again for these pictures: build the no-image layout and keep going. " +
  "With the starter's sections, leave `image` out (Hero falls back to its centered layout, Features alternating shows an icon panel, CTA split becomes the banner, Gallery drops it). " +
  "Never ship a placeholder: no box labelled \"image\" or \"photo\", no image icon standing in for a photo, no grey empty frame. The publish check fails a home page that shows one.";

const runCounts = new Map<string, number>();

export function resetSiteImageRunCounts(): void {
  runCounts.clear();
  runLocks.clear();
}

export function clampFocal(raw: unknown): SiteImageFocal | undefined {
  const f = raw as { x?: unknown; y?: unknown } | null | undefined;
  if (!f || typeof f.x !== "number" || typeof f.y !== "number" || !Number.isFinite(f.x) || !Number.isFinite(f.y)) return undefined;
  const pct = (n: number) => Math.min(100, Math.max(0, Math.round(n)));
  return { x: pct(f.x), y: pct(f.y) };
}

export type SiteImageArtDirection = {
  role?: SiteImageRole;
  placement?: string;
  overlay?: boolean;
  focal?: SiteImageFocal;
  style?: string;
};

const DEFAULT_PHOTO_STYLE = "Professional editorial photograph for a business website, natural light, realistic detail";

const ROLE_COMPOSITION: Record<SiteImageRole, string> = {
  hero: "A wide establishing view with one clear focal point.",
  service: "The service being done, hands and tools in sharp focus.",
  product: "The product alone on a clean, uncluttered background, centred and fully in frame.",
  people: "Faces in the upper third, eyes sharp, nobody cropped at the joints; candid, not posed for the camera.",
  gallery: "One strong subject that still reads as a small thumbnail.",
  supporting: "A quiet detail of the place or the craft that sets the mood.",
};

function oneLine(raw: string | undefined, max: number): string {
  return (raw ?? "").replace(/\s+/g, " ").trim().slice(0, max).replace(/[.\s]+$/, "");
}

export function siteImageModelPrompt(prompt: string, art: SiteImageArtDirection = {}): string {
  const subject = oneLine(prompt, 600);
  const focal = clampFocal(art.focal);
  const placement = oneLine(art.placement, 120);
  const composition = [
    art.role ? ROLE_COMPOSITION[art.role] : "",
    placement ? `Composition: ${placement}.` : "",
    art.overlay ? "Keep the subject to one side with calm, even negative space on the other side, where a headline will sit over the photo." : "",
    focal ? `The main subject sits about ${focal.x}% across and ${focal.y}% down the frame.` : "",
  ].filter(Boolean);
  const style = oneLine(art.style, 300) || DEFAULT_PHOTO_STYLE;
  return [
    `${subject}.`,
    ...composition,
    `${style}.`,
    "No text, no words, no letters, no logos, no watermarks, no brand marks, no recognizable real or famous people, not in the style of a named artist.",
  ].join(" ");
}

export function siteImageTask(aspect: SiteImageAspect): MediaTask {
  return aspect === "16:9" ? "image.hero" : "image.photo";
}

function fileName(slug: string, width: number): string {
  return `${slug}-${width}.webp`;
}

function parseMarker(raw: string | null): Marker | null {
  if (raw === null) return { version: 1, generated: 0, images: [] };
  try {
    const v = JSON.parse(raw) as { images?: unknown; generated?: unknown };
    if (!v || typeof v !== "object" || !Array.isArray(v.images)) return null;
    const images = Array.isArray(v?.images)
      ? (v.images as unknown[]).filter(
          (e): e is MarkerEntry =>
            !!e &&
            typeof e === "object" &&
            typeof (e as MarkerEntry).slug === "string" &&
            SLUG.test((e as MarkerEntry).slug) &&
            typeof (e as MarkerEntry).src === "string" &&
            typeof (e as MarkerEntry).srcset === "string" &&
            typeof (e as MarkerEntry).alt === "string" &&
            Number.isFinite((e as MarkerEntry).width) &&
            Number.isFinite((e as MarkerEntry).height) &&
            (SITE_IMAGE_ASPECTS as readonly string[]).includes((e as MarkerEntry).aspect),
        ).map((e) => {
          const { focal: rawFocal, ...rest } = e;
          const focal = clampFocal(rawFocal);
          return focal ? { ...rest, focal } : rest;
        })
      : [];
    if (typeof v.generated !== "number" || !Number.isFinite(v.generated) || v.generated < 0) return null;
    const generated = Math.floor(v.generated);
    const free = images.filter((e) => (e as { source?: unknown }).source === undefined).length;
    return { version: 1, generated: Math.max(generated, free), images };
  } catch {
    return null;
  }
}

export function focalCropRegion(
  srcW: number,
  srcH: number,
  aspect: SiteImageAspect,
  focal: SiteImageFocal,
): { left: number; top: number; width: number; height: number } {
  const [ratioW, ratioH] = aspect.split(":").map(Number) as [number, number];
  const f = clampFocal(focal) ?? { x: 50, y: 50 };
  let width = srcW;
  let height = Math.round((srcW * ratioH) / ratioW);
  if (height > srcH) {
    height = srcH;
    width = Math.min(srcW, Math.round((srcH * ratioW) / ratioH));
  }
  const left = Math.min(srcW - width, Math.max(0, Math.round((srcW * f.x) / 100 - width / 2)));
  const top = Math.min(srcH - height, Math.max(0, Math.round((srcH * f.y) / 100 - height / 2)));
  return { left, top, width, height };
}

export function focalInCrop(
  srcW: number,
  srcH: number,
  region: { left: number; top: number; width: number; height: number },
  focal: SiteImageFocal,
): SiteImageFocal {
  const f = clampFocal(focal) ?? { x: 50, y: 50 };
  const pct = (at: number, start: number, size: number) => (size > 0 ? ((at - start) / size) * 100 : 50);
  return clampFocal({ x: pct((srcW * f.x) / 100, region.left, region.width), y: pct((srcH * f.y) / 100, region.top, region.height) }) ?? { x: 50, y: 50 };
}

export async function toWebpVariants(
  bytes: Uint8Array,
  aspect: SiteImageAspect,
  focal?: SiteImageFocal,
): Promise<{ variants: Array<{ width: number; height: number; data: Uint8Array }>; focal?: SiteImageFocal } | null> {
  try {
    const [ratioW, ratioH] = aspect.split(":").map(Number) as [number, number];
    const meta = await sharp(bytes).metadata();
    const turned = (meta.orientation ?? 1) >= 5;
    const fullW = (turned ? meta.height : meta.width) ?? 0;
    const fullH = (turned ? meta.width : meta.height) ?? 0;
    const region = focal && fullW > 0 && fullH > 0 ? focalCropRegion(fullW, fullH, aspect, focal) : null;
    const srcW = region ? region.width : meta.width ?? 0;
    if (!(srcW > 0)) return null;
    const variants: Array<{ width: number; height: number; data: Uint8Array }> = [];
    for (const target of SITE_IMAGE_WIDTHS[aspect]) {
      const width = Math.min(target, srcW);
      const height = Math.round((width * ratioH) / ratioW);
      const base = sharp(bytes).rotate();
      const data = await (region ? base.extract(region) : base)
        .resize({ width, height, fit: "cover", position: "attention", withoutEnlargement: false })
        .webp({ quality: WEBP_QUALITY, effort: 4 })
        .toBuffer();
      variants.push({ width, height, data: new Uint8Array(data) });
    }
    if (variants.length === 2 && variants[0]!.width === variants[1]!.width) variants.pop();
    return region && focal ? { variants, focal: focalInCrop(fullW, fullH, region, focal) } : { variants };
  } catch {
    return null;
  }
}

const runLocks = new Map<string, Promise<unknown>>();

export function generateSiteImages(input: GenerateSiteImagesInput, deps: SiteImageDeps): Promise<SiteImagesResult> {
  const key = input.tenant_id;
  const prev = runLocks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => generateUnlocked(input, deps));
  runLocks.set(key, next);
  void next
    .finally(() => {
      if (runLocks.get(key) === next) runLocks.delete(key);
    })
    .catch(() => undefined);
  return next;
}

async function readMarker(deps: SiteImageDeps, path: string): Promise<string | null> {
  if (!(await deps.present(path))) return null;
  const raw = await deps.readText(path);
  if (raw === null) throw new Error("marker exists but could not be read");
  return raw;
}

function writeMarker(deps: SiteImageDeps, path: string, marker: Marker): Promise<void> {
  return deps.writeText(path, `${JSON.stringify(marker, null, 2)}\n`);
}

const UNBILLED: ReadonlySet<SiteImageSkipReason> = new Set<SiteImageSkipReason>(["not_configured", "refused", "out_of_credits"]);

async function generateUnlocked(input: GenerateSiteImagesInput, deps: SiteImageDeps): Promise<SiteImagesResult> {
  const root = input.repoRoot.replace(/\/+$/, "");
  const markerPath = `${root}/${SITE_IMAGE_MARKER}`;
  const result: SiteImagesResult = { images: [], skipped: [], cost_usd: 0 };
  let marker: Marker | null;
  let markerExisted = false;
  try {
    const raw = await readMarker(deps, markerPath);
    markerExisted = raw !== null;
    marker = parseMarker(raw);
  } catch {
    marker = null;
  }
  if (!marker) {
    for (const req of input.images) {
      result.skipped.push({ slug: req.slug, reason: "marker_unreadable", detail: `${SITE_IMAGE_MARKER} is not readable; nothing was generated` });
    }
    return finish(input, result, 0);
  }
  const seen = new Set<string>();
  const fresh: SiteImageRequest[] = [];

  for (const req of input.images.slice(0, MAX_IMAGES_PER_CALL)) {
    if (seen.has(req.slug)) {
      result.skipped.push({ slug: req.slug, reason: "duplicate_slug" });
      continue;
    }
    seen.add(req.slug);
    const prior = marker.images.find((m) => m.slug === req.slug);
    if (prior) {
      const files = prior.srcset.split(",").map((s) => s.trim().split(/\s+/)[0] ?? "").filter(Boolean);
      const present = files.length > 0 && (await Promise.all(files.map((f) => deps.exists(`${root}/public${f}`).catch(() => false)))).every(Boolean);
      if (present) {
        const focal = clampFocal(prior.focal);
        result.images.push({
          slug: prior.slug,
          src: prior.src,
          srcset: prior.srcset,
          width: prior.width,
          height: prior.height,
          alt: prior.alt,
          aspect: prior.aspect,
          ...(focal ? { focal } : {}),
          reused: true,
        });
        continue;
      }
    }
    fresh.push(req);
  }
  for (const req of input.images.slice(MAX_IMAGES_PER_CALL)) {
    result.skipped.push({ slug: req.slug, reason: "run_cap_reached", detail: `at most ${MAX_IMAGES_PER_CALL} images per call` });
  }

  const createdAt = new Date().toISOString();

  const used = runCounts.get(input.run_id) ?? 0;
  const runLeft = Math.max(0, MAX_IMAGES_PER_RUN - used);
  const siteLeft = Math.max(0, MAX_IMAGES_PER_SITE - marker.generated);
  const ready = await Promise.all(fresh.map((r) => deps.configured(siteImageTask(r.aspect)).catch(() => false)));
  const available: SiteImageRequest[] = [];
  fresh.forEach((r, i) => {
    if (ready[i]) available.push(r);
    else result.skipped.push({ slug: r.slug, reason: "not_configured" });
  });
  const allowed = Math.min(runLeft, siteLeft);
  const toMake = available.slice(0, allowed);
  for (const req of available.slice(allowed)) {
    result.skipped.push(
      siteLeft <= runLeft
        ? { slug: req.slug, reason: "site_cap_reached", detail: `this site already has ${MAX_IMAGES_PER_SITE} generated images; reuse them` }
        : { slug: req.slug, reason: "run_cap_reached", detail: `at most ${MAX_IMAGES_PER_RUN} new images per build` },
    );
  }
  if (toMake.length) {
    try {
      await writeMarker(deps, markerPath, { ...marker, generated: marker.generated + toMake.length });
    } catch (e) {
      for (const req of toMake) {
        result.skipped.push({ slug: req.slug, reason: "write_failed", detail: `could not reserve: ${(e as Error).message.slice(0, 120)}` });
      }
      return finish(input, result, 0);
    }
    runCounts.set(input.run_id, used + toMake.length);
  }

  const made = await Promise.all(
    toMake.map(async (req): Promise<{ image: SiteImage; cost: number; model: string } | { slug: string; reason: SiteImageSkipReason; detail?: string; cost?: number }> => {
      const task = siteImageTask(req.aspect);
      let gen: Awaited<ReturnType<SiteImageDeps["generate"]>>;
      try {
        gen = await deps.generate(task, siteImageModelPrompt(req.prompt, req), req.aspect);
      } catch (e) {
        gen = { ok: false, reason: "vendor_error", error: (e as Error).message };
      }
      if (!gen.ok) return { slug: req.slug, reason: gen.reason, detail: gen.error.slice(0, 160) };
      const cost = gen.cost_usd;
      const bytes = await deps.download(gen.url, MAX_DOWNLOAD_BYTES).catch(() => null);
      if (!bytes) return { slug: req.slug, reason: "download_failed", cost };
      const landed = await landImage(deps, root, req, bytes);
      if (!("image" in landed)) return { slug: req.slug, ...landed, cost };
      const image = landed.image;
      return { image, cost, model: gen.model };
    }),
  );

  const newEntries: MarkerEntry[] = [];
  let unbilled = 0;
  const addCost = (c: number | undefined) => {
    result.cost_usd += typeof c === "number" && Number.isFinite(c) && c > 0 ? c : 0;
  };
  for (const m of made) {
    if ("image" in m) {
      result.images.push(m.image);
      addCost(m.cost);
      const { reused: _reused, ...entry } = m.image;
      newEntries.push({ ...entry, model: m.model, created_at: createdAt });
    } else {
      const { cost, ...skip } = m;
      addCost(cost);
      if (UNBILLED.has(m.reason)) unbilled++;
      result.skipped.push(skip);
    }
  }
  if (unbilled > 0) runCounts.set(input.run_id, Math.max(0, (runCounts.get(input.run_id) ?? 0) - unbilled));
  const billed = toMake.length - unbilled;

  if (toMake.length === 0 && !markerExisted) {
    await writeMarker(deps, markerPath, marker).catch(() => undefined);
  }
  if (toMake.length > 0) {
    const added = newEntries;
    const merged: Marker = {
      version: 1,
      generated: marker.generated + billed,
      images: [...marker.images.filter((m) => !added.some((n) => n.slug === m.slug)), ...added],
    };
    try {
      await writeMarker(deps, markerPath, merged);
    } catch {
    }
  }
  return finish(input, result, newEntries.length);
}

async function landImage(
  deps: SiteImageDeps,
  root: string,
  req: SiteImageRequest,
  bytes: Uint8Array,
): Promise<{ image: SiteImage } | { reason: SiteImageSkipReason; detail?: string }> {
  const webp = await toWebpVariants(bytes, req.aspect, clampFocal(req.focal));
  if (!webp || webp.variants.length === 0) return { reason: "convert_failed" };
  try {
    for (const v of webp.variants) {
      await deps.writeBytes(`${root}/${SITE_IMAGE_DIR}/${fileName(req.slug, v.width)}`, v.data);
    }
  } catch (e) {
    return { reason: "write_failed", detail: (e as Error).message.slice(0, 160) };
  }
  const large = webp.variants[0]!;
  return {
    image: {
      slug: req.slug,
      src: `${SITE_IMAGE_URL_DIR}/${fileName(req.slug, large.width)}`,
      srcset: webp.variants.map((v) => `${SITE_IMAGE_URL_DIR}/${fileName(req.slug, v.width)} ${v.width}w`).join(", "),
      width: large.width,
      height: large.height,
      alt: req.alt.trim(),
      aspect: req.aspect,
      ...(webp.focal ? { focal: webp.focal } : {}),
      reused: false,
    },
  };
}

function finish(input: GenerateSiteImagesInput, result: SiteImagesResult, added: number): SiteImagesResult {
  result.cost_usd = Math.round(result.cost_usd * 10000) / 10000;
  if (result.images.length === 0) {
    result.note = NO_PHOTO_NOTE;
  }
  void logEvent({
    level: result.skipped.length > 0 ? "warn" : "info",
    source: "site-images",
    code: "site_images.generated",
    tenant_id: input.tenant_id,
    run_id: input.run_id,
    meta: {
      requested: input.images.length,
      count: added,
      cap: MAX_IMAGES_PER_RUN,
      cost_usd: result.cost_usd,
      ...(result.skipped[0]
        ? { skipped_reason: result.skipped[0].reason, skipped_reasons: result.skipped.map((x, i) => `${i + 1}:${x.reason}`).join(",") }
        : {}),
    },
  });
  return result;
}
