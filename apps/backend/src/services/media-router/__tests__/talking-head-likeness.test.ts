import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { submitMedia, pollMediaOnce, estimateCost } from "../router";
import { routedVideoPlan } from "@/services/launch-video/video-estimate";
import { costToCredits } from "@/services/agents/credits";

const QUEUE = "https://queue.fal.run";
const LIKENESS_REFUSAL = JSON.stringify({
  detail: [
    {
      loc: ["body", "image_urls"],
      msg: "The images or videos provided may contain likenesses of real people or other private information that cannot be processed.",
      type: "content_policy_violation",
    },
  ],
});

type Submitted = { model: string; body: Record<string, unknown> };

function fakeFal(submitted: Submitted[]) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (b: unknown, status = 200) =>
      new Response(typeof b === "string" ? b : JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (init?.method === "POST") {
      const model = url.slice(QUEUE.length + 1);
      const id = `req-${submitted.length}`;
      submitted.push({ model, body: JSON.parse(String(init.body)) });
      return json({ request_id: id, status_url: `${QUEUE}/${model}/requests/${id}/status`, response_url: `${QUEUE}/${model}/requests/${id}` });
    }
    const m = url.match(/^https:\/\/queue\.fal\.run\/(.+)\/requests\/(req-\d+)(\/status)?$/);
    if (!m) return json({ detail: "unknown url" }, 404);
    if (m[3]) return json({ status: "COMPLETED" });
    const sub = submitted[Number(m[2].slice(4))];
    if (sub.model.startsWith("bytedance/seedance-2.5/reference-to-video") && Array.isArray(sub.body.image_urls)) {
      return json(LIKENESS_REFUSAL, 422);
    }
    return json({ video: { url: "https://v3b.fal.media/files/out.mp4", content_type: "video/mp4" }, duration: 20 });
  });
}

const PORTRAIT = "https://v3b.fal.media/files/portrait.png";
const VOICE = "https://v3b.fal.media/files/voice.mp3";
const SCRIPT =
  "Here's a finished cake, message on top. Why the twenty-four hour rule? Nothing's sitting in a case. You pick size, flavor, filling and your message, we bake it for your day. Order a day ahead, then collect it or have it delivered. That's the whole trick.";

describe("AI UGC talking head: a generated photoreal portrait reaches a model that accepts a human face", () => {
  const submitted: Submitted[] = [];
  beforeEach(() => {
    submitted.length = 0;
    process.env.FAL_KEY = "k:s";
    vi.stubGlobal("fetch", fakeFal(submitted));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FAL_KEY;
  });

  it("a 20-second script renders to a video instead of the fal likeness refusal", async () => {
    const plan = routedVideoPlan({ prompt: "AI presenter beside a cake", intent: "talking_head", premium: false, aspect_ratio: "9:16", script: SCRIPT });
    expect(plan.task).toBe("video.talking_head");

    const s = await submitMedia(plan.task, { image_url: PORTRAIT, audio_url: VOICE, duration_s: plan.clipSeconds, aspect_ratio: "9:16" });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    const p = await pollMediaOnce(s.job);
    expect(p).toEqual({ state: "done", url: "https://v3b.fal.media/files/out.mp4", mime: "video/mp4", duration_s: 20 });

    expect(submitted).toHaveLength(1);
    expect(submitted[0].body).not.toHaveProperty("image_urls");
    expect(submitted[0].body).toMatchObject({ image_url: PORTRAIT, audio_url: VOICE });
  });

  it("the price on the card is the price of the model that actually renders it", () => {
    const plan = routedVideoPlan({ prompt: "AI presenter beside a cake", intent: "talking_head", premium: false, aspect_ratio: "9:16", script: SCRIPT });
    const videoLeg = estimateCost("video.talking_head", { duration_s: plan.clipSeconds });
    expect(videoLeg).toBeCloseTo(0.115 * plan.clipSeconds, 6);
    expect(costToCredits(plan.estimateUsd)).toBeLessThan(2_000);
  });
});
