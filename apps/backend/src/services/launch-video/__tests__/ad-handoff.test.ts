import { describe, it, expect } from "vitest";
import {
  placementForAspect,
  buildAdDraftHandoff,
  adArtifactHandoffMeta,
} from "../ad-handoff";
import {
  intakeToVideoBrief,
  type LaunchVideoIntake,
  type Aspect,
} from "../brief-mapper";
import { resolveCaptureTarget, captureImageFor } from "../capture-bridge";

const adIntake: LaunchVideoIntake = {
  product_name: "Upcar",
  one_liner: "Rent the perfect car from local hosts.",
  url: "https://upcar.ai",
  capture_url: "https://upcar.ai",
  audience: "people who need a car for the weekend",
  tone: "bold",
  features: [
    { title: "Book in two minutes", detail: "Find a car near you and reserve it instantly." },
    { title: "Real local hosts", detail: "Thousands of cars from real people in your city." },
    { title: "Fully insured", detail: "Every trip covered end to end." },
  ],
  cta_text: "Start your trip",
  cta_url: "https://upcar.ai",
  video_type: "ad",
};

describe("ad real-UI capture → hero beat (test a)", () => {
  it("an ad brief has a hook beat and NO productui beat", () => {
    const brief = intakeToVideoBrief(adIntake);
    expect(brief.beats.some((b) => b.kind === "hook")).toBe(true);
    expect(brief.beats.some((b) => b.kind === "productui")).toBe(false);
  });

  it("resolveCaptureTarget points the captured still at the ad's HOOK HERO (full-bleed, itemIndex null)", () => {
    const brief = intakeToVideoBrief(adIntake);
    const target = resolveCaptureTarget(brief);
    expect(target).not.toBeNull();
    const hookIdx = brief.beats.findIndex((b) => b.kind === "hook");
    expect(target).toEqual({ beatIndex: hookIdx, itemIndex: null });
  });

  it("captureImageFor injects the captured PNG bytes at that hero beat (replaces a Higgsfield still)", () => {
    const brief = intakeToVideoBrief(adIntake);
    const target = resolveCaptureTarget(brief)!;
    const png = Buffer.from("real-ui-screenshot-bytes");
    const img = captureImageFor(target, png, "A");
    expect(img.beatIndex).toBe(target.beatIndex);
    expect(img.itemIndex).toBeNull();
    expect(img.bytes).toBe(png);
    expect(img.filename).toBe("capture_A.png");
  });
});

describe("ad DRAFT handoff never goes live (test b)", () => {
  const outputs = [
    { aspect: "9:16" as Aspect, label: "A" },
    { aspect: "1:1" as Aspect, label: "A" },
    { aspect: "16:9" as Aspect, label: "B" },
  ];

  it("buildAdDraftHandoff always emits status=draft + live=false", () => {
    const h = buildAdDraftHandoff({ videoType: "ad", outputs, multiVariant: true });
    expect(h).not.toBeNull();
    expect(h!.status).toBe("draft");
    expect(h!.live).toBe(false);
    expect(h!.target_agent_slug).toBe("performance-marketer");
    expect(JSON.stringify(h)).not.toContain('"live":true');
  });

  it("tags each creative with its native Meta placement + filename (variant token when multi-variant)", () => {
    const h = buildAdDraftHandoff({ videoType: "ad", outputs, multiVariant: true })!;
    expect(h.assets).toEqual([
      { filename: "video-A-9x16.mp4", aspect: "9:16", variant: "A", placement: "reels_stories" },
      { filename: "video-A-1x1.mp4", aspect: "1:1", variant: "A", placement: "feed" },
      { filename: "video-B-16x9.mp4", aspect: "16:9", variant: "B", placement: "feed" },
    ]);
  });

  it("single-variant render carries NO variant token in the filename", () => {
    const h = buildAdDraftHandoff({
      videoType: "ad",
      outputs: [{ aspect: "9:16", label: "A" }],
      multiVariant: false,
    })!;
    expect(h.assets[0]).toEqual({
      filename: "video-9x16.mp4",
      aspect: "9:16",
      variant: null,
      placement: "reels_stories",
    });
  });

  it("returns null for a NON-ad video_type (handoff is ad-specific)", () => {
    for (const vt of ["launch", "explainer", "social", "story", "promo", "testimonial"] as const) {
      expect(buildAdDraftHandoff({ videoType: vt, outputs, multiVariant: true })).toBeNull();
    }
  });

  it("returns null for an ad that produced zero outputs (nothing to hand off)", () => {
    expect(buildAdDraftHandoff({ videoType: "ad", outputs: [], multiVariant: false })).toBeNull();
  });

  it("adArtifactHandoffMeta (the per-row stamp) is also draft + live:false", () => {
    const meta = adArtifactHandoffMeta("9:16", "A");
    expect(meta.ad_draft_handoff.status).toBe("draft");
    expect(meta.ad_draft_handoff.live).toBe(false);
    expect(meta.ad_draft_handoff.placement).toBe("reels_stories");
    expect(meta.ad_draft_handoff.target_agent_slug).toBe("performance-marketer");
    expect(JSON.stringify(meta)).not.toContain('"live":true');
  });
});

describe("placementForAspect", () => {
  it("maps 9:16 → reels_stories, 1:1 & 16:9 → feed", () => {
    expect(placementForAspect("9:16")).toBe("reels_stories");
    expect(placementForAspect("1:1")).toBe("feed");
    expect(placementForAspect("16:9")).toBe("feed");
  });
});
