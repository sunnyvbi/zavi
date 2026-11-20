import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { composeSocialImage, plateAspectFor, readableOn, SOCIAL_LAYOUTS } from "../compose";
import { verifyBrandPixels } from "../verify";
import { typesetLine, measureLine, wrapLines } from "../typeset";

const BRAND = { primary: "#027bff", accent: "#ff5a1f", bg: "#ffffff", text: "#191919" };

async function fakePlate(w = 1080, h = 1350): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: "#3b7a57" } })
    .png()
    .toBuffer();
}

describe("typeset", () => {
  it("produces real glyph outlines, not an empty path", () => {
    const r = typesetLine("$25 OFF", { fontSize: 120, weight: 800 });
    expect(r.d.length).toBeGreaterThan(200);
    expect(r.d).toMatch(/^M/);
    expect(r.width).toBeGreaterThan(100);
  });

  it("scales width with font size", () => {
    const a = measureLine("HELLO", { fontSize: 50 });
    const b = measureLine("HELLO", { fontSize: 100 });
    expect(b / a).toBeCloseTo(2, 1);
  });

  it("letter-spacing widens the run", () => {
    const tight = measureLine("HELLO", { fontSize: 60, letterSpacing: 0 });
    const loose = measureLine("HELLO", { fontSize: 60, letterSpacing: 0.2 });
    expect(loose).toBeGreaterThan(tight);
  });

  it("wraps to the given pixel width", () => {
    const lines = wrapLines("Do 10x more on your marketplace with the team you have", {
      fontSize: 64,
      maxWidth: 600,
    });
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(measureLine(l, { fontSize: 64 })).toBeLessThanOrEqual(600);
  });
});

describe("readableOn", () => {
  it("puts white on a dark brand and ink on a light one", () => {
    expect(readableOn("#027bff")).toBe("#ffffff");
    expect(readableOn("#ffd400")).toBe("#111111");
  });
});

describe("composeSocialImage", () => {
  it.each(SOCIAL_LAYOUTS)("renders layout %s at the right canvas size", async (layout) => {
    const { png } = await composeSocialImage({
      plate: await fakePlate(),
      layout,
      aspect: "4:5",
      tokens: BRAND,
      slots: { headline: "$25 OFF", sub: "ANY RENTAL", badge: "CODE: HAPPYAUG25", foot: "ENDS MON AUG 25" },
    });
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);
    expect(meta.format).toBe("png");
  });

  it("burns the real brand hex into the pixels (block layout paints the panel)", async () => {
    const { png, usedHexes } = await composeSocialImage({
      plate: await fakePlate(),
      layout: "block",
      aspect: "4:5",
      tokens: BRAND,
      slots: { headline: "$25 OFF", sub: "ANY RENTAL" },
    });
    expect(usedHexes).toContain("#027bff");
    const v = await verifyBrandPixels(png, ["#027bff"]);
    expect(v.ok).toBe(true);
    expect(v.found["#027bff"]).toBeGreaterThan(100_000);
  });

  it("verification FAILS for a hex that was never painted (the guard actually guards)", async () => {
    const { png } = await composeSocialImage({
      plate: await fakePlate(),
      layout: "block",
      aspect: "4:5",
      tokens: BRAND,
      slots: { headline: "HELLO" },
    });
    const v = await verifyBrandPixels(png, ["#288fff"]);
    expect(v.ok).toBe(false);
    expect(v.missing).toContain("#288fff");
  });

  it("renders with no plate at all (pure type card)", async () => {
    const { png } = await composeSocialImage({
      plate: null,
      layout: "dark",
      aspect: "1:1",
      tokens: BRAND,
      slots: { eyebrow: "NOW LIVE", headline: "Austin", badge: "BOOK TODAY" },
    });
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1080);
  });

  it("shrinks the whole stack instead of pushing the fine print off canvas", async () => {
    const long = await composeSocialImage({
      plate: await fakePlate(),
      layout: "block",
      aspect: "4:5",
      tokens: BRAND,
      slots: {
        headline: "This is a deliberately very long headline that will not fit at full size",
        sub: "And a subheading that is also much longer than anyone should really write here",
        badge: "CODE: VERYLONGCOUPONCODE2026",
        foot: "TERMS APPLY, ONE USE PER GUEST, VALID ON BOOKINGS MADE BY MON AUG 25",
      },
    });
    expect(long.textScale).toBeLessThan(1);
    const v = await verifyBrandPixels(long.png, ["#027bff"]);
    expect(v.ok).toBe(true);
  });

  it("an explicit | breaks the headline where the author asked", async () => {
    const piped = await composeSocialImage({
      plate: null,
      layout: "dark",
      aspect: "1:1",
      tokens: BRAND,
      slots: { headline: "TWO|LINES" },
    });
    const single = await composeSocialImage({
      plate: null,
      layout: "dark",
      aspect: "1:1",
      tokens: BRAND,
      slots: { headline: "TWO LINES" },
    });
    expect(piped.png.equals(single.png)).toBe(false);
  });

  it("only claims the brand hex when the layout actually paints it", async () => {
    const bare = await composeSocialImage({
      plate: await fakePlate(),
      layout: "scrim",
      aspect: "4:5",
      tokens: BRAND,
      slots: { headline: "Just a headline" },
    });
    expect(bare.usedHexes).not.toContain("#027bff");
    expect((await verifyBrandPixels(bare.png, bare.usedHexes)).ok).toBe(true);

    const withBadge = await composeSocialImage({
      plate: await fakePlate(),
      layout: "scrim",
      aspect: "4:5",
      tokens: BRAND,
      slots: { headline: "Just a headline", badge: "CODE: X" },
    });
    expect(withBadge.usedHexes).not.toContain("#027bff");
    expect(withBadge.usedHexes).toContain("#ff5a1f");
    expect((await verifyBrandPixels(withBadge.png, withBadge.usedHexes)).ok).toBe(true);

    const withEyebrow = await composeSocialImage({
      plate: await fakePlate(),
      layout: "scrim",
      aspect: "4:5",
      tokens: BRAND,
      slots: { eyebrow: "NEW IN AUSTIN", headline: "Just a headline" },
    });
    expect(withEyebrow.usedHexes).toContain("#027bff");
    expect((await verifyBrandPixels(withEyebrow.png, withEyebrow.usedHexes)).ok).toBe(true);
  });

  it("every claimed hex survives verification in every layout", async () => {
    for (const layout of SOCIAL_LAYOUTS) {
      const r = await composeSocialImage({
        plate: await fakePlate(),
        layout,
        aspect: "4:5",
        tokens: BRAND,
        slots: { eyebrow: "NEW", headline: "HELLO", badge: "CODE: X", foot: "TERMS" },
      });
      const v = await verifyBrandPixels(r.png, r.usedHexes);
      expect(v.missing, `${layout} claimed a hex it did not paint`).toEqual([]);
    }
  });

  it("paints the ACCENT as the badge pill in the photo layouts", async () => {
    for (const layout of ["scrim", "dark"] as const) {
      const r = await composeSocialImage({
        plate: await fakePlate(),
        layout,
        aspect: "4:5",
        tokens: BRAND,
        slots: { eyebrow: "NEW", headline: "HI", badge: "CODE: X" },
      });
      expect(r.usedHexes, `${layout} did not paint the accent`).toContain("#ff5a1f");
      expect((await verifyBrandPixels(r.png, ["#ff5a1f"])).ok).toBe(true);
    }
  });

  it("falls back to primary when the tenant has no usable accent", async () => {
    const r = await composeSocialImage({
      plate: await fakePlate(),
      layout: "dark",
      aspect: "4:5",
      tokens: { ...BRAND, accent: null },
      slots: { headline: "HI", badge: "CODE: X" },
    });
    expect(r.usedHexes).toContain("#027bff");
    expect((await verifyBrandPixels(r.png, ["#027bff"])).ok).toBe(true);
  });

  it("block keeps a contrasting pill on the brand panel, not a second brand hue", async () => {
    const r = await composeSocialImage({
      plate: await fakePlate(),
      layout: "block",
      aspect: "4:5",
      tokens: BRAND,
      slots: { headline: "HI", badge: "CODE: X" },
    });
    expect(r.usedHexes).not.toContain("#ff5a1f");
    expect((await verifyBrandPixels(r.png, r.usedHexes)).ok).toBe(true);
  });

  it("is deterministic — same inputs, byte-identical output", async () => {
    const plate = await fakePlate();
    const args = {
      plate,
      layout: "scrim" as const,
      aspect: "4:5" as const,
      tokens: BRAND,
      slots: { headline: "Same every time", badge: "CODE: STABLE" },
    };
    const a = await composeSocialImage(args);
    const b = await composeSocialImage(args);
    expect(a.png.equals(b.png)).toBe(true);
  });

  it("falls back to a sane primary rather than throwing on a junk hex", async () => {
    const { png, usedHexes } = await composeSocialImage({
      plate: null,
      layout: "block",
      aspect: "1:1",
      tokens: { primary: "not-a-colour" },
      slots: { headline: "OK" },
    });
    expect(usedHexes).toContain("#027bff");
    expect((await sharp(png).metadata()).width).toBe(1080);
  });

  describe("carousel", () => {
    const copy = {
      eyebrow: "ONE",
      headline: "Your first 30 days decide the year",
      sub: "Hosts who get 3 trips in month one stay active 4x longer.",
    };

    it("gives a plateless card the canvas instead of the under-photo strip", async () => {
      const withPhoto = await composeSocialImage({
        plate: await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#2f4858" } })
          .png()
          .toBuffer(),
        layout: "dark",
        aspect: "4:5",
        tokens: BRAND,
        slots: copy,
      });
      const plateless = await composeSocialImage({
        plate: null,
        layout: "dark",
        aspect: "4:5",
        tokens: BRAND,
        slots: copy,
      });
      expect(plateless.textScale).toBe(1);
      expect(plateless.textScale).toBeGreaterThan(withPhoto.textScale);
    });

    it("draws the n/N counter in the brand colour on every panel", async () => {
      const { png, usedHexes } = await composeSocialImage({
        plate: null,
        layout: "dark",
        aspect: "4:5",
        tokens: BRAND,
        slots: { headline: "No coloured slots here" },
        counter: { index: 3, total: 7 },
      });
      expect(usedHexes).toContain(BRAND.primary);
      const v = await verifyBrandPixels(png, [BRAND.primary]);
      expect(v.ok).toBe(true);
    });

    it("omits the counter for a single image, so a one-off post is not stamped 1/1", async () => {
      const solo = await composeSocialImage({
        plate: null,
        layout: "dark",
        aspect: "4:5",
        tokens: BRAND,
        slots: { headline: "Just one" },
        counter: { index: 1, total: 1 },
      });
      const none = await composeSocialImage({
        plate: null,
        layout: "dark",
        aspect: "4:5",
        tokens: BRAND,
        slots: { headline: "Just one" },
      });
      expect(solo.png.equals(none.png)).toBe(true);
    });

    it("renders the same copy identically across two panels of one carousel", async () => {
      const mk = (index: number) =>
        composeSocialImage({
          plate: null,
          layout: "dark",
          aspect: "4:5",
          tokens: BRAND,
          slots: { headline: "Identical body" },
          counter: { index, total: 7 },
        });
      const a = await mk(2);
      const b = await mk(3);
      expect(a.usedHexes.sort()).toEqual(b.usedHexes.sort());
      expect(a.textScale).toBe(b.textScale);
      expect(a.png.equals(b.png)).toBe(false);
    });
  });
});

describe("16:9 — YouTube thumbnails", () => {
  it("renders 1280x720 in every layout, with the brand colour verifiably in the pixels", async () => {
    for (const layout of SOCIAL_LAYOUTS) {
      const out = await composeSocialImage({
        layout,
        aspect: "16:9",
        tokens: BRAND,
        plate: await fakePlate(1280, 720),
        slots: { headline: "I listed my car in 9 minutes", eyebrow: "UPCAR", badge: "no cuts" },
      });
      const meta = await sharp(out.png).metadata();
      expect(meta.width, layout).toBe(1280);
      expect(meta.height, layout).toBe(720);
      const verdict = await verifyBrandPixels(out.png, out.usedHexes);
      expect(verdict.ok, `${layout}: ${JSON.stringify(verdict)}`).toBe(true);
    }
  });

  it("still renders landscape with no plate — a type-only thumbnail is valid", async () => {
    const out = await composeSocialImage({
      layout: "dark",
      aspect: "16:9",
      tokens: BRAND,
      plate: null,
      slots: { headline: "How to rent out your car", eyebrow: "UPCAR" },
    });
    const meta = await sharp(out.png).metadata();
    expect(meta.width).toBe(1280);
    expect(meta.height).toBe(720);
  });
});

describe("the 2:3 pin canvas", () => {
  it("renders a 1000x1500 pin and asks the vendor for a ratio it has", async () => {
    const out = await composeSocialImage({
      plate: null,
      layout: "block",
      aspect: "2:3",
      tokens: { primary: "#1f6f5c" },
      slots: { headline: "Linen runners for spring tables" },
    });
    const meta = await sharp(out.png).metadata();
    expect([meta.width, meta.height]).toEqual([1000, 1500]);
    expect(plateAspectFor("2:3")).toBe("4:5");
    expect(plateAspectFor("9:16")).toBe("9:16");
  });
});
