import { describe, it, expect } from "vitest";
import { joinChannelStates } from "@/services/channels/state";
import { costToCredits } from "@/services/agents/credits";
import { routedVideoPlan } from "@/services/launch-video/video-estimate";
import { generatedVideoProposeTool } from "@/services/tools/generated-video/propose_video";
import { assembleChannels } from "../list";

const twentySecondScript = Array.from({ length: 48 }, (_, i) => (i % 2 ? "fresh" : "cake")).join(" ");
const scriptOf = (words: number, chars: number) => {
  const base = Array.from({ length: words }, () => "w").join(" ");
  return base + "w".repeat(Math.max(0, chars - base.length));
};
const cardCredits = (script: string) =>
  costToCredits(routedVideoPlan({ prompt: "p", intent: "talking_head", premium: false, aspect_ratio: "9:16", script }).estimateUsd);
const proposal = (script: string) => ({
  format: "explainer",
  hook: "h",
  script,
  scene: "s",
  presenter_gender: "female" as const,
  caption: "c",
  objection: "o",
});

describe("GET /api/channels prices one AI UGC video before any card exists", () => {
  const out = assembleChannels({
    linked: new Set<string>(),
    latestRun: new Map(),
    runsAvailable: true,
    now: Date.parse("2026-10-01T12:00:00Z"),
    staleMs: 7_200_000,
    states: joinChannelStates([{ channel_slug: "generated_video" }]),
  });

  it("is never below what any script the starter tool accepts can be charged", () => {
    const row = out.find((c) => c.channel_slug === "generated_video")!;
    const schema = generatedVideoProposeTool.input_schema;
    const worst = [scriptOf(70, 600), scriptOf(70, 139), scriptOf(20, 600), twentySecondScript];
    for (const script of worst) {
      expect(schema.safeParse(proposal(script)).success).toBe(true);
      expect(row.video_credits_each!).toBeGreaterThanOrEqual(cardCredits(script));
    }
    expect(row.video_credits_each).toBe(cardCredits(scriptOf(70, 600)));
    expect(row.video_credits_each!).toBeGreaterThan(cardCredits(twentySecondScript));
  });

  it("the starter tool refuses a script longer than the quote covers", () => {
    const schema = generatedVideoProposeTool.input_schema;
    expect(schema.safeParse(proposal(scriptOf(70, 601))).success).toBe(false);
    expect(schema.safeParse(proposal(scriptOf(71, 300))).success).toBe(false);
  });

  it("is the OmniHuman price, not the Seedance one that refused every portrait", () => {
    const row = out.find((c) => c.channel_slug === "generated_video")!;
    expect(row.video_credits_each).toBeLessThan(2_000);
  });

  it("is null on every other channel", () => {
    for (const c of out) if (c.channel_slug !== "generated_video") expect(c.video_credits_each).toBeNull();
  });
});
