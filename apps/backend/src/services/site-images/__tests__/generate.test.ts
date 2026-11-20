import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));

import { logEvent } from "@/services/logging/logEvent";
import {
  generateSiteImages,
  MAX_IMAGES_PER_RUN,
  MAX_IMAGES_PER_SITE,
  resetSiteImageRunCounts,
  SITE_IMAGE_MARKER,
  siteImageModelPrompt,
  toWebpVariants,
  type SiteImageDeps,
  type SiteImageRequest,
} from "../generate";
import type { MediaAspect, MediaTask } from "@/services/media-router/types";

const ROOT = "/home/user/repo";

async function png(width: number, height: number): Promise<Uint8Array> {
  const buf = await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 60 } } }).png().toBuffer();
  return new Uint8Array(buf);
}

type Fake = SiteImageDeps & {
  files: Map<string, Uint8Array | string>;
  generated: Array<{ task: MediaTask; prompt: string; aspect: MediaAspect }>;
};

function fakeDeps(
  opts: { configured?: boolean; failSlugs?: string[]; failReason?: "vendor_error" | "refused"; source?: { w: number; h: number } } = {},
): Fake {
  const files = new Map<string, Uint8Array | string>();
  const generated: Fake["generated"] = [];
  return {
    files,
    generated,
    configured: async () => opts.configured ?? true,
    async generate(task, prompt, aspect) {
      generated.push({ task, prompt, aspect });
      if ((opts.failSlugs ?? []).some((s) => prompt.includes(s))) return { ok: false, reason: opts.failReason ?? "vendor_error", error: "boom" };
      return { ok: true, url: `https://cdn.example/${generated.length}.png`, cost_usd: 0.0675, model: "seedream" };
    },
    download: async () => png(opts.source?.w ?? 2048, opts.source?.h ?? 1152),
    readText: async (p) => {
      const v = files.get(p);
      return typeof v === "string" ? v : null;
    },
    exists: async (p) => {
      const v = files.get(p);
      return v !== undefined && (typeof v === "string" ? v.length : v.byteLength) > 0;
    },
    present: async (p) => files.has(p),
    writeBytes: async (p, b) => void files.set(p, b),
    writeText: async (p, t) => void files.set(p, t),
  };
}

const req = (slug: string, aspect: SiteImageRequest["aspect"], prompt: string, alt = `photo of ${slug}`): SiteImageRequest => ({
  slug,
  aspect,
  prompt,
  alt,
});

const BAKERY = req("hero", "16:9", "warm bakery counter with fresh sourdough loaves at dawn");
const DENTIST = req("clinic", "4:5", "bright modern dental treatment room with soft daylight");
const PHOTOGRAPHER = req("portfolio", "1:1", "photographer's studio with a camera on a tripod and softbox lights");

beforeEach(() => {
  resetSiteImageRunCounts();
  vi.mocked(logEvent).mockClear();
});

describe("generateSiteImages", () => {
  it("writes each image as webp at two widths, records it in the marker and tracks the cost", async () => {
    const d = fakeDeps();
    const r = await generateSiteImages({ tenant_id: "t1", run_id: "r1", repoRoot: ROOT, images: [BAKERY, DENTIST, PHOTOGRAPHER] }, d);

    expect(r.skipped).toEqual([]);
    expect(r.images.map((i) => i.slug)).toEqual(["hero", "clinic", "portfolio"]);
    expect(r.cost_usd).toBeCloseTo(0.2025, 4);
    const hero = r.images[0]!;
    expect(hero).toMatchObject({ src: "/images/hero-1600.webp", width: 1600, height: 900, reused: false });
    expect(hero.srcset).toBe("/images/hero-1600.webp 1600w, /images/hero-800.webp 800w");
    expect(r.images[1]).toMatchObject({ width: 960, height: 1200 });
    expect(r.images[2]).toMatchObject({ width: 960, height: 960 });

    const large = d.files.get(`${ROOT}/public/images/hero-1600.webp`) as Uint8Array;
    const meta = await sharp(large).metadata();
    expect(meta).toMatchObject({ format: "webp", width: 1600, height: 900 });
    expect(d.files.has(`${ROOT}/public/images/hero-800.webp`)).toBe(true);

    const marker = JSON.parse(d.files.get(`${ROOT}/${SITE_IMAGE_MARKER}`) as string);
    expect(marker.images.map((m: { slug: string }) => m.slug)).toEqual(["hero", "clinic", "portfolio"]);
    expect(d.generated.map((g) => g.task)).toEqual(["image.hero", "image.photo", "image.photo"]);
    expect(vi.mocked(logEvent).mock.calls[0]![0]).toMatchObject({ source: "site-images", meta: { count: 3, cost_usd: 0.2025 } });
  });

  it("reuses an image already in the repo for free (a retry or fix pass never pays twice)", async () => {
    const d = fakeDeps();
    await generateSiteImages({ tenant_id: "t1", run_id: "r1", repoRoot: ROOT, images: [BAKERY] }, d);
    const again = await generateSiteImages({ tenant_id: "t1", run_id: "r2", repoRoot: ROOT, images: [BAKERY, DENTIST] }, d);
    expect(d.generated).toHaveLength(2);
    expect(again.images.find((i) => i.slug === "hero")).toMatchObject({ reused: true });
    expect(again.cost_usd).toBeCloseTo(0.0675, 4);
    const marker = JSON.parse(d.files.get(`${ROOT}/${SITE_IMAGE_MARKER}`) as string);
    expect(marker.images.map((m: { slug: string }) => m.slug)).toEqual(["hero", "clinic"]);
  });

  it("regenerates a listed image whose files are gone", async () => {
    const d = fakeDeps();
    await generateSiteImages({ tenant_id: "t1", run_id: "r1", repoRoot: ROOT, images: [BAKERY] }, d);
    d.files.delete(`${ROOT}/public/images/hero-800.webp`);
    const r = await generateSiteImages({ tenant_id: "t1", run_id: "r1", repoRoot: ROOT, images: [BAKERY] }, d);
    expect(r.images[0]).toMatchObject({ reused: false });
    expect(d.generated).toHaveLength(2);
  });

  it("is fail-soft: a failed image is skipped, the rest land", async () => {
    const d = fakeDeps({ failSlugs: ["dental"] });
    const r = await generateSiteImages({ tenant_id: "t1", run_id: "r1", repoRoot: ROOT, images: [BAKERY, DENTIST] }, d);
    expect(r.images.map((i) => i.slug)).toEqual(["hero"]);
    expect(r.skipped).toEqual([{ slug: "clinic", reason: "vendor_error", detail: "boom" }]);
  });

  it("with no image model, writes no image and records only that photos were asked for", async () => {
    const d = fakeDeps({ configured: false });
    const r = await generateSiteImages({ tenant_id: "t1", run_id: "r1", repoRoot: ROOT, images: [BAKERY] }, d);
    expect(r.images).toEqual([]);
    expect(r.skipped[0]).toMatchObject({ reason: "not_configured" });
    expect([...d.files.keys()]).toEqual([`${ROOT}/${SITE_IMAGE_MARKER}`]);
    expect(JSON.parse(d.files.get(`${ROOT}/${SITE_IMAGE_MARKER}`) as string)).toEqual({ version: 1, generated: 0, images: [] });
    expect(d.generated).toHaveLength(0);
  });

  it("fails closed on an empty marker or one without a valid count", async () => {
    for (const bad of ["", JSON.stringify({ version: 1, images: [] }), JSON.stringify({ version: 1, generated: -3, images: [] })]) {
      const d = fakeDeps();
      d.files.set(`${ROOT}/${SITE_IMAGE_MARKER}`, bad);
      const r = await generateSiteImages({ tenant_id: "t1", run_id: `bad-${bad.length}`, repoRoot: ROOT, images: [BAKERY] }, d);
      expect(r.skipped[0]).toMatchObject({ reason: "marker_unreadable" });
      expect(d.generated).toHaveLength(0);
    }
  });

  it("caps new images per run and per call; only an unbilled failure gives its slot back", async () => {
    const d = fakeDeps();
    const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => req(`${prefix}-${i}`, "1:1", `a product shot number ${prefix} ${i}`));
    const first = await generateSiteImages({ tenant_id: "t1", run_id: "r1", repoRoot: ROOT, images: many("a", 5) }, d);
    expect(first.images).toHaveLength(4);
    expect(first.skipped).toEqual([expect.objectContaining({ slug: "a-4", reason: "run_cap_reached" })]);
    const second = await generateSiteImages({ tenant_id: "t1", run_id: "r1", repoRoot: ROOT, images: many("b", 4) }, d);
    expect(second.images).toHaveLength(MAX_IMAGES_PER_RUN - 4);
    expect(second.skipped.filter((s) => s.reason === "run_cap_reached")).toHaveLength(2);
    const other = await generateSiteImages({ tenant_id: "t1", run_id: "r2", repoRoot: ROOT, images: many("c", 1) }, d);
    expect(other.images).toHaveLength(1);

    const refused = fakeDeps({ failSlugs: ["broken"], failReason: "refused" });
    await generateSiteImages({ tenant_id: "t1", run_id: "r3", repoRoot: ROOT, images: many("broken", 4) }, refused);
    const after = await generateSiteImages({ tenant_id: "t1", run_id: "r3", repoRoot: ROOT, images: many("ok", 4) }, refused);
    expect(after.images).toHaveLength(4);

    const erroring = fakeDeps({ failSlugs: ["broken"] });
    await generateSiteImages({ tenant_id: "t1", run_id: "r4", repoRoot: ROOT, images: many("broken", 4) }, erroring);
    const later = await generateSiteImages({ tenant_id: "t1", run_id: "r4", repoRoot: ROOT, images: many("ok", 4) }, erroring);
    expect(later.images).toHaveLength(MAX_IMAGES_PER_RUN - 4);
  });

  it("caps generated images per site across runs, counted in the repo's marker", async () => {
    const d = fakeDeps();
    const batch = (run: string, n: number) =>
      generateSiteImages({ tenant_id: "t1", run_id: run, repoRoot: ROOT, images: Array.from({ length: n }, (_, i) => req(`${run}-${i}`, "1:1", `a garden shed photo ${run} ${i}`)) }, d);
    await batch("a", 4);
    await batch("b", 4);
    await batch("c", 4);
    const over = await batch("d", 2);
    expect(over.images).toHaveLength(0);
    expect(over.skipped.map((s) => s.reason)).toEqual(["site_cap_reached", "site_cap_reached"]);
    expect(JSON.parse(d.files.get(`${ROOT}/${SITE_IMAGE_MARKER}`) as string).generated).toBe(MAX_IMAGES_PER_SITE);
  });

  it("photos the founder added in the editor (paid edits, links) never use up the build's free cap", async () => {
    const d = fakeDeps();
    const editor = Array.from({ length: 14 }, (_, i) => ({
      slug: `edit-${i}`,
      src: `/images/edit-${i}-960.webp`,
      srcset: `/images/edit-${i}-960.webp 960w`,
      width: 960,
      height: 960,
      alt: "photo",
      aspect: "1:1",
      source: i % 2 ? "edit" : "link",
    }));
    d.files.set(`${ROOT}/${SITE_IMAGE_MARKER}`, JSON.stringify({ version: 1, generated: 2, images: editor }));
    const out = await generateSiteImages({ tenant_id: "t1", run_id: "r-free", repoRoot: ROOT, images: [req("garden", "1:1", "a garden shed in morning light")] }, d);
    expect(out.images.map((i) => i.slug)).toEqual(["garden"]);
    expect(JSON.parse(d.files.get(`${ROOT}/${SITE_IMAGE_MARKER}`) as string).generated).toBe(3);
  });

  it("serializes calls on one run so parallel calls keep each other's marker entries", async () => {
    const d = fakeDeps();
    await Promise.all([
      generateSiteImages({ tenant_id: "t1", run_id: "r1", repoRoot: ROOT, images: [BAKERY] }, d),
      generateSiteImages({ tenant_id: "t1", run_id: "r1", repoRoot: ROOT, images: [DENTIST] }, d),
    ]);
    const marker = JSON.parse(d.files.get(`${ROOT}/${SITE_IMAGE_MARKER}`) as string);
    expect(marker.images.map((m: { slug: string }) => m.slug).sort()).toEqual(["clinic", "hero"]);
  });

  it("refuses a duplicate slug in one call", async () => {
    const d = fakeDeps();
    const r = await generateSiteImages({ tenant_id: "t1", run_id: "r1", repoRoot: ROOT, images: [BAKERY, { ...BAKERY, prompt: "another bakery photo here" }] }, d);
    expect(r.images).toHaveLength(1);
    expect(r.skipped).toEqual([{ slug: "hero", reason: "duplicate_slug" }]);
  });

  it("fails closed on a marker it cannot read: no vendor call, the site cap is never bypassed", async () => {
    const d = fakeDeps();
    d.files.set(`${ROOT}/${SITE_IMAGE_MARKER}`, "{not json");
    const r = await generateSiteImages({ tenant_id: "t1", run_id: "r1", repoRoot: ROOT, images: [BAKERY] }, d);
    expect(r.images).toHaveLength(0);
    expect(r.skipped[0]).toMatchObject({ reason: "marker_unreadable" });
    expect(d.generated).toHaveLength(0);
  });

  it("reserves the site slots before any vendor call; a failed reservation spends nothing", async () => {
    const d = fakeDeps();
    const order: string[] = [];
    const gen = d.generate;
    d.generate = async (...a) => {
      order.push("generate");
      return gen(...a);
    };
    d.writeText = async (p, t) => {
      order.push("marker");
      d.files.set(p, t);
    };
    await generateSiteImages({ tenant_id: "t1", run_id: "r1", repoRoot: ROOT, images: [BAKERY] }, d);
    expect(order[0]).toBe("marker");

    const broken = fakeDeps();
    broken.writeText = async () => {
      throw new Error("disk full");
    };
    const r = await generateSiteImages({ tenant_id: "t1", run_id: "r2", repoRoot: ROOT, images: [BAKERY] }, broken);
    expect(r.images).toHaveLength(0);
    expect(broken.generated).toHaveLength(0);
  });
});

describe("toWebpVariants", () => {
  it("never upscales a small source and keeps one file when both widths collapse", async () => {
    const out = await toWebpVariants(await png(400, 400), "1:1");
    expect(out?.variants.map((v) => [v.width, v.height])).toEqual([[400, 400]]);
  });

  it("returns null for bytes that are not an image", async () => {
    expect(await toWebpVariants(new Uint8Array([1, 2, 3]), "16:9")).toBeNull();
  });
});

describe("siteImageModelPrompt", () => {
  it("keeps the subject and forbids text and logos", () => {
    const p = siteImageModelPrompt("  a florist   arranging peonies ");
    expect(p.startsWith("a florist arranging peonies.")).toBe(true);
    expect(p).toMatch(/no logos/);
  });
});
