import { describe, it, expect } from "vitest";
import { MEDIA_TASKS } from "../types";
import { ROUTES, activeRoute } from "../table";

describe("media-router table", () => {
  it("has a non-empty row for every task", () => {
    for (const t of MEDIA_TASKS) expect(ROUTES[t]?.length, t).toBeGreaterThan(0);
  });
  it("first entry of every row is enabled and is fal (Ravi 2026-09-19)", () => {
    for (const t of MEDIA_TASKS) {
      expect(ROUTES[t][0].enabled, t).toBe(true);
      expect(ROUTES[t][0].vendor, t).toBe("fal");
    }
  });
  it("never routes to Sora (API shut down 2026-09-24)", () => {
    for (const t of MEDIA_TASKS) for (const e of ROUTES[t]) expect(e.model.toLowerCase()).not.toContain("sora");
  });
  it("Higgsfield is present only as a disabled image alternate", () => {
    const hf = MEDIA_TASKS.flatMap((t) => ROUTES[t].filter((e) => e.vendor === "higgsfield").map((e) => ({ t, e })));
    expect(hf.length).toBeGreaterThan(0);
    for (const { t, e } of hf) {
      expect(t.startsWith("image.")).toBe(true);
      expect(e.enabled).toBe(false);
    }
  });
  it("activeRoute returns the first ENABLED entry", () => {
    expect(activeRoute("image.photo")).toEqual(ROUTES["image.photo"][0]);
    expect(activeRoute("video.talking_head").model).toBe("fal-ai/kling-video/ai-avatar/v2/pro");
    expect(activeRoute("video.talking_head_long").model).toBe("fal-ai/kling-video/ai-avatar/v2/pro");
  });
  it("pins the approved active models (OpenArt #1 per use case, 2026-09-19)", () => {
    expect(activeRoute("image.photo").model).toBe("bytedance/seedream/v5/pro/text-to-image");
    expect(activeRoute("image.plate").model).toBe("bytedance/seedream/v5/pro/text-to-image");
    expect(activeRoute("image.hero").model).toBe("bytedance/seedream/v5/pro/text-to-image");
    expect(activeRoute("image.text").model).toBe("openai/gpt-image-2.5/sunburst/text-to-image");
    expect(activeRoute("image.edit").model).toBe("openai/gpt-image-2.5/flare/edit");
    expect(activeRoute("image.vector").model).toBe("fal-ai/recraft/v4.1/text-to-vector");
    expect(activeRoute("image.draft").model).toBe("fal-ai/flux-2/klein/4b");
    for (const t of ["video.broll", "video.cinematic", "video.social"] as const) expect(activeRoute(t).model).toBe("bytedance/seedance-2.5/text-to-video");
    expect(activeRoute("video.animate").model).toBe("bytedance/seedance-2.5/image-to-video");
    expect(activeRoute("video.edit").model).toBe("alibaba/wan-3.0/reference-to-video");
    expect(activeRoute("audio.voiceover").model).toBe("elevenlabs/tts/eleven-v4");
  });
});
