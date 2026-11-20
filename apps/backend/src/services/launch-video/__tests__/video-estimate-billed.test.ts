import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/billing/flat-pricing", () => ({ isFlatJobPricingOn: async () => false }));
const legs = vi.hoisted(() => ({ photo: 0.0655, voice: 0.0105, video: 0.5055 }));
vi.mock("@/services/media-router/router", () => ({
  estimateCost: (task: string) => (task === "image.photo" ? legs.photo : task === "audio.voiceover" ? legs.voice : legs.video),
}));

import { billedVideoCredits, billedVideoUsd, videoCreditsOf } from "../video-estimate";
import { costToCredits } from "@/services/agents/credits";

describe("billedVideoUsd in vendor-cost mode", () => {
  const intake = { prompt: "p", intent: "talking_head", premium: false, aspect_ratio: "9:16", script: "hello there friends" } as never;

  it("checks the wallet for exactly the per-leg credits the charge takes", async () => {
    Object.assign(legs, { photo: 0.0655, voice: 0.0105, video: 0.5055 });
    const credits = await billedVideoCredits(intake);
    expect(credits).toBe(235);
    expect(costToCredits(await billedVideoUsd(intake))).toBe(credits);
  });

  it("reads a leg the way the charge RPC does: its JSON decimal, in exact numeric", async () => {
    Object.assign(legs, { photo: 0.07, voice: 0.02, video: 0.115 * 5 });
    expect(await billedVideoCredits(intake)).toBe(28 + 8 + 231);
    expect(videoCreditsOf(await billedVideoUsd(intake))).toBe(28 + 8 + 231);
  });
});
