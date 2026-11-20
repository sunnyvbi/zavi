import { describe, it, expect } from "vitest";
import { intakeToVideoBrief, launchVideoIntakeSchema } from "../brief-mapper";
import { resolveCaptureTarget, captureImageFor } from "../capture-bridge";
import {
  applyHookPack,
  resolveScriptVariants,
  capVariantsForAspects,
  MAX_VIDEO_OUTPUTS,
} from "../script-variants";

function socialIntake(over: Record<string, unknown> = {}) {
  return launchVideoIntakeSchema.parse({
    product_name: "Upcar",
    one_liner: "Rent a car from real local hosts",
    url: "https://upcar.ai",
    video_type: "social",
    platform: "tiktok",
    audience: "renters and car owners",
    tone: "bold",
    features: [
      { title: "Instant booking", detail: "Book a car in under 30 seconds." },
      { title: "Real local hosts", detail: "Rent from people in your city." },
    ],
    cta_text: "Try it",
    cta_url: "https://upcar.ai",
    ...over,
  });
}

describe("social capture routing (real-UI still → social 9:16 hook beat)", () => {
  it("a social (9:16) brief exposes the hook beat as the capture target, and a captured still injects there", () => {
    const brief = intakeToVideoBrief(socialIntake());

    expect(brief.aspect).toBe("9:16");

    const target = resolveCaptureTarget(brief);
    expect(target).toEqual({ beatIndex: 0, itemIndex: null });
    expect(brief.beats[target!.beatIndex].kind).toBe("hook");

    const png = Buffer.from("PNGDATA-real-first-screen");
    const img = captureImageFor(target!, png, "A");
    expect(img).toMatchObject({ beatIndex: 0, itemIndex: null, filename: "capture_A.png" });
    expect(Buffer.from(img.bytes).equals(png)).toBe(true);
  });

  it("every clip in a social PACK still targets its own hook beat for the shared capture", () => {
    const packed = applyHookPack(socialIntake({ hook_pack: ["Hook A", "Hook B", "Hook C"] }));
    const variants = resolveScriptVariants(packed);
    for (const v of variants) {
      const brief = intakeToVideoBrief(v.intake);
      expect(brief.aspect).toBe("9:16");
      expect(resolveCaptureTarget(brief)).toEqual({ beatIndex: 0, itemIndex: null });
    }
  });
});

describe("social pack compounding (hook_pack → K distinct 9:16 variants)", () => {
  it("expands hook_pack into one variant per DISTINCT hook, each with its own one_liner", () => {
    const packed = applyHookPack(socialIntake({ hook_pack: ["Hook one", "Hook two", "Hook three"] }));
    const variants = resolveScriptVariants(packed);

    expect(variants).toHaveLength(3);
    expect(variants.map((v) => v.label)).toEqual(["A", "B", "C"]);
    expect(variants.map((v) => v.intake.one_liner)).toEqual(["Hook one", "Hook two", "Hook three"]);
    for (const v of variants) {
      expect(v.intake.video_type).toBe("social");
      expect(v.intake.platform).toBe("tiktok");
      expect(v.intake.cta_url).toBe("https://upcar.ai");
    }

    const { kept, capped } = capVariantsForAspects(variants, 1);
    expect(kept).toHaveLength(3);
    expect(capped).toBe(false);
  });

  it("is capped by MAX_VIDEO_OUTPUTS (6 clips at 9:16; a 2-aspect fan-out trims the pack)", () => {
    const packed = applyHookPack(socialIntake({ hook_pack: ["h1", "h2", "h3", "h4", "h5", "h6"] }));
    const variants = resolveScriptVariants(packed);
    expect(variants).toHaveLength(6);

    const single = capVariantsForAspects(variants, 1);
    expect(single.kept).toHaveLength(MAX_VIDEO_OUTPUTS);
    expect(single.capped).toBe(false);

    const two = capVariantsForAspects(variants, 2);
    expect(two.capped).toBe(true);
    expect(two.kept).toHaveLength(3);
  });

  it("dedupes hooks case-insensitively and no-ops below 2 distinct (single render)", () => {
    const intake = socialIntake({ hook_pack: ["Same hook", "same hook"] });
    expect(applyHookPack(intake)).toBe(intake);
    expect(resolveScriptVariants(applyHookPack(intake))).toHaveLength(1);
  });

  it("hand-authored `scripts` win — hook_pack is ignored when scripts are present", () => {
    const intake = socialIntake({ hook_pack: ["a", "b"], scripts: [{ one_liner: "manual variant B" }] });
    expect(applyHookPack(intake)).toBe(intake);
    const variants = resolveScriptVariants(intake);
    expect(variants.map((v) => v.intake.one_liner)).toEqual([
      "Rent a car from real local hosts",
      "manual variant B",
    ]);
  });

  it("no-ops entirely when there is no hook_pack (launch/single path byte-identical)", () => {
    const intake = socialIntake();
    expect(applyHookPack(intake)).toBe(intake);
    expect(resolveScriptVariants(applyHookPack(intake))).toHaveLength(1);
  });
});
