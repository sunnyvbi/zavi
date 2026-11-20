
import { describe, it, expect, vi, beforeEach } from "vitest";

const resolveKit = vi.fn();
const delivered = vi.fn();

vi.mock("@/services/brand/resolve-brand-kit", async () => {
  const actual = await vi.importActual<typeof import("@/services/brand/resolve-brand-kit")>(
    "@/services/brand/resolve-brand-kit",
  );
  return { ...actual, resolveBrandKit: (t: string) => resolveKit(t) };
});

vi.mock("@/services/reports/deliver-image", async () => {
  const sharp = (await import("sharp")).default;
  return {
    deliverImage: async (ctx: any, input: any) => {
      delivered(input);
      const plate = await sharp({
        create: { width: 1080, height: 1350, channels: 3, background: "#2f4858" },
      })
        .png()
        .toBuffer();
      const images: unknown[] = [];
      const skipped: unknown[] = [];
      for (let i = 0; i < input.prompts.length; i++) {
        try {
          const out = await ctx.transform(input.prompts[i].prompt === null ? null : plate, i);
          if (!out) skipped.push({ index: i, reason: "transform_failed" });
          else images.push({ artifact_id: `a${i}`, slot: i, filename: input.prompts[i].filename, bytes: out.bytes.length, cached: false });
        } catch (e) {
          skipped.push({ index: i, reason: "transform_failed", detail: String(e) });
        }
      }
      const typeset = input.prompts.filter((p: { prompt: string | null }) => p.prompt === null).length;
      return {
        images,
        generated: images.length - typeset,
        cached: 0,
        typeset,
        skipped,
        slack_ok: false,
      };
    },
  };
});

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        limit: async () => ({ data: [], error: null }),
      };
      return q;
    },
  }),
}));

const SCRAPED = {
  primary: "#027bff",
  accent: "#ff5a1f",
  bg: "#ffffff",
  text: "#191919",
  source: "scrape" as const,
  source_url: "https://upcar.ai",
  evidence: [{ hex: "#027bff", signal: "css_var_primary" as const, weight: 80 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveKit.mockResolvedValue(SCRAPED);
});

async function run(input: unknown) {
  const { deliverSocialImage } = await import("@/services/reports/deliver-social-image");
  return deliverSocialImage({ tenant_id: "t1", run_id: "r1" }, input as never);
}

describe("platePrompt", () => {
  it("appends the text-suppression tail so the model does not draw words", async () => {
    const { platePrompt } = await import("@/services/reports/deliver-social-image");
    const p = platePrompt("a silver sedan at golden hour", "block");
    expect(p).toContain("a silver sedan at golden hour");
    expect(p).toMatch(/No text, no letters, no numbers/);
    expect(p).toMatch(/no watermark/);
  });

  it("asks for negative space where each layout puts its type", async () => {
    const { platePrompt } = await import("@/services/reports/deliver-social-image");
    expect(platePrompt("x", "scrim")).toMatch(/lower third/i);
    expect(platePrompt("x", "dark")).toMatch(/dark, near-black/i);
  });
});

describe("deliverSocialImage", () => {
  const post = {
    plate_prompt: "a silver sedan at golden hour",
    layout: "block" as const,
    headline: "$25 OFF",
    badge: "CODE: HAPPYAUG25",
  };

  it("delivers a composited image and reports the hexes proven in its pixels", async () => {
    const r = await run({ posts: [post], aspect_ratio: "4:5" });
    expect(r.images).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
    expect(r.brand_verified[0].hexes).toContain("#027bff");
  });

  it("passes the SUPPRESSED prompt to the generator, never the raw one", async () => {
    await run({ posts: [post] });
    const passed = delivered.mock.calls[0][0].prompts[0].prompt;
    expect(passed).toMatch(/No text, no letters/);
  });

  it("reports source:'scrape' with the url and evidence so the agent can cite it", async () => {
    const r = await run({ posts: [post] });
    expect(r.brand.source).toBe("scrape");
    expect(r.brand.source_url).toBe("https://upcar.ai");
    expect(r.brand.evidence[0].signal).toBe("css_var_primary");
  });

  it("reports source:'default' honestly when the tenant's site could not be read", async () => {
    const { DEFAULT_BRAND_KIT } = await import("@/services/brand/resolve-brand-kit");
    resolveKit.mockResolvedValue(DEFAULT_BRAND_KIT);
    const r = await run({ posts: [post] });
    expect(r.brand.source).toBe("default");
    expect(r.brand.source_url).toBeNull();
  });

  it("names each file after its layout when the caller supplies none", async () => {
    const r = await run({
      posts: [
        { ...post, layout: "block" },
        { ...post, layout: "scrim" },
      ],
    });
    expect(r.images.map((i: { filename: string }) => i.filename)).toEqual([
      "social-1-block.png",
      "social-2-scrim.png",
    ]);
  });

  it("caps the batch at 3 concepts (each is a billed generation)", async () => {
    const { renderSocialImageInputSchema } = await import(
      "@/services/reports/deliver-social-image"
    );
    const four = { posts: [post, post, post, post] };
    expect(renderSocialImageInputSchema.safeParse(four).success).toBe(false);
    expect(renderSocialImageInputSchema.safeParse({ posts: [post] }).success).toBe(true);
  });

  it("applies zod defaults even when called directly, without the MCP facade", async () => {
    const r = await run({ posts: [{ plate_prompt: "a sedan", headline: "HI" }] });
    expect(r.images).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
  });

  it("defaults to the 4:5 Instagram feed aspect", async () => {
    const { renderSocialImageInputSchema } = await import(
      "@/services/reports/deliver-social-image"
    );
    const parsed = renderSocialImageInputSchema.parse({ posts: [post] });
    expect(parsed.aspect_ratio).toBe("4:5");
    expect(parsed.posts?.[0].layout).toBe("block");
  });
});

describe("carousel — panels are a sequence, not options", () => {
  const schema = async () =>
    (await import("@/services/reports/deliver-social-image")).renderSocialImageInputSchema;

  const panels = (n: number, photos = 1) =>
    Array.from({ length: n }, (_, i) => ({
      ...(i < photos ? { plate_prompt: `photo ${i}` } : {}),
      headline: `Slide ${i + 1}`,
    }));

  it("rejects a call that sends neither shape, and one that sends both", async () => {
    const s = await schema();
    expect(() => s.parse({})).toThrow();
    expect(() =>
      s.parse({ posts: [{ plate_prompt: "a" }], panels: panels(3) }),
    ).toThrow(/exactly one/i);
  });

  it("caps panels at 10 and photographic panels at 3", async () => {
    const s = await schema();
    expect(() => s.parse({ panels: panels(11, 1) })).toThrow();
    expect(() => s.parse({ panels: panels(8, 4) })).toThrow(/at most 3 may/i);
    expect(() => s.parse({ panels: panels(8, 4) })).toThrow(/pure-type cards/i);
    expect(s.parse({ panels: panels(10, 3) }).panels).toHaveLength(10);
  });

  it("bills only the photographic panels — 7 slides, 1 generation", async () => {
    const r = await run({ panels: panels(7, 1) });
    expect(r.mode).toBe("carousel");
    expect(r.images).toHaveLength(7);
    expect(r.generated).toBe(1);
    expect(r.typeset).toBe(6);
    const sent = delivered.mock.calls[0][0].prompts;
    expect(sent.filter((p: { prompt: string | null }) => p.prompt === null)).toHaveLength(6);
  });

  it("names panels in running order so the file list IS the posting order", async () => {
    const r = await run({ panels: panels(7, 1) });
    expect(r.images.map((i) => i.filename)).toEqual([
      "carousel-01-of-07.png",
      "carousel-02-of-07.png",
      "carousel-03-of-07.png",
      "carousel-04-of-07.png",
      "carousel-05-of-07.png",
      "carousel-06-of-07.png",
      "carousel-07-of-07.png",
    ]);
  });

  it("proves the brand hex landed on EVERY panel, photographic or not", async () => {
    const r = await run({ panels: panels(7, 1) });
    expect(r.brand_verified).toHaveLength(7);
    for (const v of r.brand_verified) {
      expect(v.hexes).toContain(SCRAPED.primary);
    }
    expect(r.brand_verified[6].filename).toBe("carousel-07-of-07.png");
  });

  it("uses one shared layout across the set unless a panel overrides it", async () => {
    const s = await schema();
    expect(s.parse({ panels: panels(3) }).carousel_layout).toBe("dark");
    const r = await run({ panels: panels(3), carousel_layout: "scrim" });
    expect(r.images).toHaveLength(3);
  });

  it("still runs the original `posts` shape unchanged, with no counter", async () => {
    const r = await run({ posts: [{ plate_prompt: "a sedan", headline: "HI" }] });
    expect(r.mode).toBe("options");
    expect(r.images[0].filename).toBe("social-1-block.png");
    expect(r.generated).toBe(1);
    expect(r.typeset).toBe(0);
  });
});
