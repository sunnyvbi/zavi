import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { z } from "zod";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));

import {
  SITE_IMAGE_MARKER,
  SITE_IMAGE_ROLES,
  clampFocal,
  focalCropRegion,
  focalInCrop,
  generateSiteImages,
  resetSiteImageRunCounts,
  siteImageModelPrompt,
  siteImageRequestSchema,
  toWebpVariants,
  type SiteImageDeps,
} from "../generate";
import { siteImagesPromptFragment } from "../prompt";
import { siteImagesToolInput } from "../sandbox-tool";
import { PLAN_IMAGE_ASPECTS, PLAN_IMAGE_ROLES } from "@/services/sites/design-brief";
import { SITE_IMAGE_ASPECTS } from "../generate";

const ROOT = "/home/user/repo";
const count = (hay: string, needle: string | RegExp) => hay.split(needle).length - 1;

async function sourceWithRedRightEdge(): Promise<Uint8Array> {
  const red = await sharp({ create: { width: 320, height: 900, channels: 3, background: { r: 230, g: 20, b: 20 } } }).png().toBuffer();
  const buf = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 128, g: 128, b: 128 } } })
    .composite([{ input: red, left: 1280, top: 0 }])
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

async function redShare(webp: Uint8Array): Promise<number> {
  const { data, info } = await sharp(webp).raw().toBuffer({ resolveWithObject: true });
  let red = 0;
  for (let i = 0; i < data.length; i += info.channels) if (data[i]! > 180 && data[i + 1]! < 80) red++;
  return red / (info.width * info.height);
}

function fakeDeps(source: () => Promise<Uint8Array>) {
  const files = new Map<string, Uint8Array | string>();
  const prompts: string[] = [];
  const deps: SiteImageDeps = {
    configured: async () => true,
    async generate(_task, prompt) {
      prompts.push(prompt);
      return { ok: true, url: `https://cdn.example/${prompts.length}.png`, cost_usd: 0.05, model: "seedream" };
    },
    download: () => source(),
    readText: async (p) => {
      const v = files.get(p);
      return typeof v === "string" ? v : null;
    },
    exists: async (p) => files.has(p),
    present: async (p) => files.has(p),
    writeBytes: async (p, b) => void files.set(p, b),
    writeText: async (p, t) => void files.set(p, t),
  };
  return { deps, files, prompts };
}

beforeEach(() => resetSiteImageRunCounts());

describe("siteImageModelPrompt art direction", () => {
  it("an overlay photo keeps the subject to one side with calm space for the headline", () => {
    const p = siteImageModelPrompt("a dentist with a patient in a bright surgery", { role: "hero", overlay: true, placement: "subject right, copy left", focal: { x: 72, y: 30 } });
    expect(p).toMatch(/subject to one side with calm, even negative space on the other side/);
    expect(p).toContain("Composition: subject right, copy left.");
    expect(p).toContain("72% across and 30% down");
  });

  it("a product sits centred on a clean background; people keep faces in the upper third", () => {
    expect(siteImageModelPrompt("a ceramic mug", { role: "product" })).toMatch(/clean, uncluttered background, centred/);
    expect(siteImageModelPrompt("a ceramic mug", { role: "product" })).not.toMatch(/upper third|negative space/);
    expect(siteImageModelPrompt("a barber at work", { role: "people" })).toMatch(/Faces in the upper third/);
    expect(siteImageModelPrompt("a barber at work", { role: "people" })).not.toMatch(/centred and fully in frame|negative space/);
  });

  it("the brief's style replaces the fixed editorial tail instead of being stacked on it", () => {
    const style = "moody low-key light, deep teal shadows, shot on 35mm film";
    const p = siteImageModelPrompt("a cocktail bar at night", { style });
    expect(p).not.toMatch(/natural light|editorial photograph/i);
    expect(count(p, style)).toBe(1);
    expect(count(p, /No text, no words/)).toBe(1);
  });

  it("with no style it keeps exactly one default style line and the safety tail", () => {
    const p = siteImageModelPrompt("a florist arranging peonies.", {});
    expect(count(p, /editorial photograph/i)).toBe(1);
    expect(count(p, /No text, no words/)).toBe(1);
    expect(p.startsWith("a florist arranging peonies. ")).toBe(true);
    expect(p).not.toMatch(/room for a headline|negative space/);
  });

  it("ignores a broken focal point and clamps an out-of-range one", () => {
    expect(siteImageModelPrompt("a desk", { focal: { x: Number.NaN, y: 2 } })).not.toMatch(/across/);
    expect(siteImageModelPrompt("a desk", { focal: { x: 180, y: -4 } })).toContain("100% across and 0% down");
    expect(clampFocal({ x: 33.4, y: 66.6 })).toEqual({ x: 33, y: 67 });
  });
});

describe("focal crop", () => {
  it("maps the focal point to a crop window inside the source", () => {
    expect(focalCropRegion(1600, 900, "4:5", { x: 90, y: 50 })).toEqual({ left: 880, top: 0, width: 720, height: 900 });
    expect(focalCropRegion(1600, 900, "4:5", { x: 10, y: 50 })).toEqual({ left: 0, top: 0, width: 720, height: 900 });
    expect(focalCropRegion(1600, 900, "4:5", { x: 50, y: 50 })).toEqual({ left: 440, top: 0, width: 720, height: 900 });
    expect(focalCropRegion(900, 1600, "16:9", { x: 50, y: 20 })).toEqual({ left: 0, top: 67, width: 900, height: 506 });
    expect(focalCropRegion(1000, 1000, "1:1", { x: 0, y: 100 })).toEqual({ left: 0, top: 0, width: 1000, height: 1000 });
  });

  it("the written crop follows the focal point, not the saliency guess", async () => {
    const src = await sourceWithRedRightEdge();
    const right = await toWebpVariants(src, "4:5", { x: 95, y: 50 });
    const left = await toWebpVariants(src, "4:5", { x: 5, y: 50 });
    expect(right!.variants.map((v) => [v.width, v.height])).toEqual([[720, 900], [480, 600]]);
    expect(await redShare(right!.variants[0]!.data)).toBeGreaterThan(0.35);
    expect(await redShare(left!.variants[0]!.data)).toBeLessThan(0.01);
    expect(await redShare(left!.variants[1]!.data)).toBeLessThan(0.01);
  });
});

describe("the tool carries art direction end to end", () => {
  it("sends the composed prompt, crops on the focal point and returns and records the focal", async () => {
    const { deps, files, prompts } = fakeDeps(sourceWithRedRightEdge);
    const out = await generateSiteImages(
      {
        tenant_id: "t1",
        run_id: "r1",
        repoRoot: ROOT,
        images: [
          siteImageRequestSchema.parse({
            slug: "hero",
            prompt: "a dentist with a patient",
            alt: "A dentist with a patient",
            aspect: "4:5",
            role: "hero",
            overlay: true,
            focal: { x: 140, y: 50 },
            style: "bright daylight, soft teal",
          }),
        ],
      },
      deps,
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/negative space/);
    expect(prompts[0]).toContain("bright daylight, soft teal.");
    expect(prompts[0]).not.toMatch(/natural light/);
    expect(out.images[0]!.focal).toEqual({ x: 100, y: 50 });
    expect(await redShare(files.get(`${ROOT}/public/images/hero-720.webp`) as Uint8Array)).toBeGreaterThan(0.35);
    const marker = JSON.parse(files.get(`${ROOT}/${SITE_IMAGE_MARKER}`) as string);
    expect(marker.images[0].focal).toEqual({ x: 100, y: 50 });
    const again = await generateSiteImages({ tenant_id: "t1", run_id: "r2", repoRoot: ROOT, images: [siteImageRequestSchema.parse({ slug: "hero", prompt: "a dentist with a patient", alt: "A dentist" })] }, deps);
    expect(again.images[0]).toMatchObject({ reused: true, focal: { x: 100, y: 50 } });
    expect(prompts).toHaveLength(1);
  });

  it("a request without art direction keeps the old prompt shape and the attention crop", async () => {
    const { deps, prompts } = fakeDeps(sourceWithRedRightEdge);
    const out = await generateSiteImages({ tenant_id: "t2", run_id: "r3", repoRoot: ROOT, images: [siteImageRequestSchema.parse({ slug: "plain", prompt: "a quiet waiting room", alt: "Waiting room" })] }, deps);
    expect(out.images[0]).not.toHaveProperty("focal");
    expect(prompts[0]).toMatch(/^a quiet waiting room\. Professional editorial photograph/);
  });

  it("the schema rejects an unknown role and the MCP input still converts to JSON schema", () => {
    expect(siteImageRequestSchema.safeParse({ slug: "a", prompt: "a long enough prompt", alt: "alt", role: "billboard" }).success).toBe(false);
    expect(siteImageRequestSchema.safeParse({ slug: "a", prompt: "a long enough prompt", alt: "alt", focal: { x: "1", y: 2 } }).success).toBe(false);
    const json = JSON.stringify(z.toJSONSchema(z.object(siteImagesToolInput)));
    for (const key of ["role", "placement", "overlay", "focal", "style"]) expect(json).toContain(`"${key}"`);
  });

  it("the tool's roles and aspects are the plan's", () => {
    expect([...SITE_IMAGE_ROLES]).toEqual([...PLAN_IMAGE_ROLES]);
    expect([...SITE_IMAGE_ASPECTS]).toEqual([...PLAN_IMAGE_ASPECTS]);
  });
});

describe("siteImagesPromptFragment", () => {
  it("has the builder pass art direction and the brief's style, and hand image objects to sections", () => {
    const f = siteImagesPromptFragment({ subjects: ["a dentist with a patient"], style: "bright daylight" });
    expect(f).toContain("`placement`, `overlay` and `focal`");
    expect(f).toContain("`style` set to the Style line");
    expect(f).toContain("`{src, srcset, width, height, alt, focal}` as the section's `image`");
    expect(f).toMatch(/never an image URL from another site/);
    expect(f).toMatch(/founder's own photos \(those first; a generated photo is never presented as the business's real staff, products or customers\)/);
    expect(f).not.toMatch(/—/);
  });

  it("without a planned style it never asks for one, and no-photos stays photo-free", () => {
    expect(siteImagesPromptFragment(null)).not.toContain("`style` set");
    expect(siteImagesPromptFragment({ subjects: ["a desk"], style: "" })).not.toContain("`style` set");
    expect(siteImagesPromptFragment({ subjects: [], style: "x" })).not.toMatch(/focal|placement/);
  });
});

async function sourceWithDot(w: number, h: number, at: { x: number; y: number }): Promise<Uint8Array> {
  const dot = await sharp({ create: { width: 24, height: 24, channels: 3, background: { r: 230, g: 20, b: 20 } } }).png().toBuffer();
  const left = Math.min(w - 24, Math.max(0, Math.round((w * at.x) / 100) - 12));
  const top = Math.min(h - 24, Math.max(0, Math.round((h * at.y) / 100) - 12));
  return new Uint8Array(await sharp({ create: { width: w, height: h, channels: 3, background: { r: 128, g: 128, b: 128 } } }).composite([{ input: dot, left, top }]).png().toBuffer());
}

async function redCentroid(webp: Uint8Array): Promise<{ x: number; y: number }> {
  const { data, info } = await sharp(webp).raw().toBuffer({ resolveWithObject: true });
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i]! > 180 && data[i + 1]! < 80) {
      const px = (i / info.channels) % info.width;
      const py = Math.floor(i / info.channels / info.width);
      sx += px;
      sy += py;
      n++;
    }
  }
  return { x: ((sx / n + 0.5) / info.width) * 100, y: ((sy / n + 0.5) / info.height) * 100 };
}

describe("the focal point is remapped into the cropped image", () => {
  const remap = (w: number, h: number, aspect: "16:9" | "1:1" | "4:5", f: { x: number; y: number }) => focalInCrop(w, h, focalCropRegion(w, h, aspect, f), f);

  it("4:3 source cropped to 16:9 keeps x and moves y into the band", () => {
    expect(remap(1200, 900, "16:9", { x: 50, y: 50 })).toEqual({ x: 50, y: 50 });
    expect(remap(1200, 900, "16:9", { x: 90, y: 10 })).toEqual({ x: 90, y: 13 });
    expect(remap(1200, 900, "16:9", { x: 0, y: 100 })).toEqual({ x: 0, y: 100 });
    expect(remap(1200, 900, "16:9", { x: 30, y: 30 })).toEqual({ x: 30, y: 40 });
    expect(remap(1200, 900, "16:9", { x: 30, y: 60 })).toEqual({ x: 30, y: 50 });
    expect(remap(1200, 900, "16:9", { x: 30, y: 80 })).toEqual({ x: 30, y: 73 });
  });

  it("4:3 source cropped to 1:1 keeps y and moves x into the window", () => {
    expect(remap(1200, 900, "1:1", { x: 50, y: 50 })).toEqual({ x: 50, y: 50 });
    expect(remap(1200, 900, "1:1", { x: 90, y: 50 })).toEqual({ x: 87, y: 50 });
    expect(remap(1200, 900, "1:1", { x: 10, y: 50 })).toEqual({ x: 13, y: 50 });
    expect(remap(1200, 900, "1:1", { x: 100, y: 0 })).toEqual({ x: 100, y: 0 });
    expect(remap(1200, 900, "1:1", { x: 0, y: 100 })).toEqual({ x: 0, y: 100 });
  });

  it("the returned focal is where the subject really is in the written file", async () => {
    for (const [aspect, f] of [["1:1", { x: 90, y: 50 }], ["16:9", { x: 30, y: 80 }], ["4:5", { x: 15, y: 40 }]] as const) {
      const out = await toWebpVariants(await sourceWithDot(1200, 900, f), aspect, f);
      const seen = await redCentroid(out!.variants[0]!.data);
      expect(Math.abs(out!.focal!.x - seen.x), `${aspect} x`).toBeLessThanOrEqual(2);
      expect(Math.abs(out!.focal!.y - seen.y), `${aspect} y`).toBeLessThanOrEqual(2);
    }
  });

  it("generate returns and records the remapped focal, not the source one", async () => {
    const { deps, files } = fakeDeps(() => sourceWithDot(1200, 900, { x: 90, y: 50 }));
    const out = await generateSiteImages({ tenant_id: "t-remap", run_id: "r-remap", repoRoot: ROOT, images: [siteImageRequestSchema.parse({ slug: "sq", prompt: "a dentist with a patient", alt: "A dentist", aspect: "1:1", focal: { x: 90, y: 50 } })] }, deps);
    expect(out.images[0]!.focal).toEqual({ x: 87, y: 50 });
    expect(JSON.parse(files.get(`${ROOT}/${SITE_IMAGE_MARKER}`) as string).images[0].focal).toEqual({ x: 87, y: 50 });
  });
});

describe("a reused image's focal comes from the marker validated", () => {
  it("drops a junk focal, clamps an out-of-range one and returns no marker-only fields", async () => {
    const { deps, files, prompts } = fakeDeps(sourceWithRedRightEdge);
    const entry = (slug: string, focal: unknown) => ({ slug, src: `/images/${slug}-960.webp`, srcset: `/images/${slug}-960.webp 960w`, width: 960, height: 960, alt: slug, aspect: "1:1", focal, model: "seedream", created_at: "2026-10-01T00:00:00.000Z" });
    const junk: Array<[string, unknown]> = [["a", { x: "50", y: 20 }], ["b", { x: 500, y: -3 }], ["c", "center"], ["d", null], ["e", { x: 12.6, y: 40 }], ["f", { y: 3 }]];
    files.set(`${ROOT}/${SITE_IMAGE_MARKER}`, JSON.stringify({ version: 1, generated: junk.length, images: junk.map(([slug, f]) => entry(slug, f)) }));
    for (const [slug] of junk) files.set(`${ROOT}/public/images/${slug}-960.webp`, new Uint8Array([1]));
    const ask = (slugs: string[], run: string) => generateSiteImages({ tenant_id: "t-junk", run_id: run, repoRoot: ROOT, images: slugs.map((slug) => siteImageRequestSchema.parse({ slug, prompt: "a quiet waiting room", alt: "Waiting room" })) }, deps);
    const out = { images: [...(await ask(["a", "b", "c"], "r-junk-1")).images, ...(await ask(["d", "e", "f"], "r-junk-2")).images] };
    expect(prompts).toHaveLength(0);
    expect(out.images).toHaveLength(junk.length);
    const bySlug = Object.fromEntries(out.images.map((i) => [i.slug, i]));
    expect(out.images.every((i) => i.reused)).toBe(true);
    expect(bySlug.a).not.toHaveProperty("focal");
    expect(bySlug.b!.focal).toEqual({ x: 100, y: 0 });
    expect(bySlug.c).not.toHaveProperty("focal");
    expect(bySlug.d).not.toHaveProperty("focal");
    expect(bySlug.e!.focal).toEqual({ x: 13, y: 40 });
    expect(bySlug.f).not.toHaveProperty("focal");
    for (const img of out.images) {
      expect(img).not.toHaveProperty("model");
      expect(img).not.toHaveProperty("created_at");
    }
  });
});
