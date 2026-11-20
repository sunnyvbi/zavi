import { describe, it, expect } from "vitest";
import { MEDIA_TASKS } from "../types";
import { ROUTES } from "../table";
import { PRICES, priceUsd } from "../prices";

describe("media-router prices", () => {
  it("every enabled or alternate table entry has a price row", () => {
    for (const t of MEDIA_TASKS) for (const e of ROUTES[t]) expect(PRICES[`${e.vendor}:${e.model}`], `${e.vendor}:${e.model}`).toBeDefined();
  });
  it("prices a flat image", () => {
    expect(priceUsd({ vendor: "fal", model: "bytedance/seedream/v5/pro/text-to-image", enabled: true }, {}, {})).toBe(0.0675);
  });
  it("an 8s Seedance 2.5 clip ≈ $3.78", () => {
    expect(priceUsd({ vendor: "fal", model: "bytedance/seedance-2.5/text-to-video", enabled: true }, { duration_s: 8 }, {})).toBeCloseTo(3.784, 3);
  });
  it("prices video by delivered seconds, falling back to requested seconds", () => {
    const e = { vendor: "fal" as const, model: "fal-ai/bytedance/omnihuman/v1.5", enabled: true };
    expect(priceUsd(e, { duration_s: 5 }, { duration_s: 7.5 })).toBeCloseTo(1.2, 5);
    expect(priceUsd(e, { duration_s: 5 }, {})).toBeCloseTo(0.8, 5);
  });
  it("prices TTS by characters", () => {
    const e = { vendor: "fal" as const, model: "fal-ai/elevenlabs/tts/eleven-v3", enabled: true };
    expect(priceUsd(e, { text: "x".repeat(500) }, {})).toBeCloseTo(0.05, 5);
    const v4 = { vendor: "fal" as const, model: "elevenlabs/tts/eleven-v4", enabled: true };
    expect(priceUsd(v4, { text: "x".repeat(500) }, {})).toBeCloseTo(0.04, 5);
  });
  it("Higgsfield subscription rail costs the customer nothing (legacy behaviour)", () => {
    expect(priceUsd({ vendor: "higgsfield", model: "gpt_image_2_5", enabled: false }, {}, {})).toBe(0);
  });
  it("an unknown model throws instead of charging zero", () => {
    expect(() => priceUsd({ vendor: "fal", model: "nope", enabled: true }, {}, {})).toThrow(/no price/);
  });

  it("video prices match the resolution the fal adapter actually requests", async () => {
    const { buildFalInput } = await import("../vendors/fal");
    const cases = [
      { model: "alibaba/wan-3.0/text-to-video", resolution: "720p", usd: 0.1 },
      { model: "google/gemini-omni-flash/v1.1/text-to-video", resolution: "720p", usd: 0.1 },
      { model: "minimax/h3/image-to-video", resolution: "768P", usd: 0.06 },
      { model: "veed/fabric-1.0", resolution: "720p", usd: 0.15 },
    ] as const;
    for (const c of cases) {
      const input = buildFalInput(c.model, { prompt: "p", image_url: "https://i", audio_url: "https://a", duration_s: 5 });
      expect(input.resolution, c.model).toBe(c.resolution);
      expect(PRICES[`fal:${c.model}`].usd, c.model).toBe(c.usd);
    }
  });

  it("seedream requests stay inside the $0.0675 area tier", async () => {
    const { buildFalInput } = await import("../vendors/fal");
    const CHEAP_TIER_MAX_PX = 1536 * 1536;
    const SEEDREAM_MIN_PX = 1024 * 1024;
    for (const aspect of ["1:1", "4:5", "9:16", "16:9"] as const) {
      const input = buildFalInput("bytedance/seedream/v5/pro/text-to-image", { prompt: "p", aspect_ratio: aspect });
      const size = input.image_size as { width: number; height: number };
      expect(typeof size, aspect).toBe("object");
      const px = size.width * size.height;
      expect(px, `${aspect} too big for the cheap tier`).toBeLessThanOrEqual(CHEAP_TIER_MAX_PX);
      expect(px, `${aspect} below fal's minimum`).toBeGreaterThanOrEqual(SEEDREAM_MIN_PX);
      expect(size.width % 16, `${aspect} width`).toBe(0);
      expect(size.height % 16, `${aspect} height`).toBe(0);
    }
    expect(PRICES["fal:bytedance/seedream/v5/pro/text-to-image"].usd).toBe(0.0675);
  });
});
