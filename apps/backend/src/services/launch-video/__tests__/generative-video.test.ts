import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { routeIntent, submitPathFor, MODEL_DESCRIPTORS } from "@/services/launch-video/generative-models";
import {
  classifyVideoIntent,
  generativeVideoIntakeSchema,
  narrowAspect,
  spokenSeconds,
  TALKING_HEAD_MAX_WORDS,
  TALKING_HEAD_MIN_WORDS,
} from "@/services/launch-video/generative-video-intake";
import { isGenerativeVideoEnabled } from "@/services/agents/_render-launch-video-flag-check";
import { submitGeneration, pollGenerationOnce } from "@/services/launch-video/platform-higgsfield";

describe("generative-models router (curated intent→model map)", () => {
  it("routes talking_head → seedance_2_0 by default, marketing_studio_video on premium", () => {
    expect(routeIntent("talking_head").model).toBe("seedance_2_0");
    expect(routeIntent("talking_head", { premium: true }).model).toBe("marketing_studio_video");
  });
  it("routes cinematic → seedance_2_0 / veo3_1, social → seedance_2_0_mini / kling3_0_turbo", () => {
    expect(routeIntent("cinematic").model).toBe("seedance_2_0");
    expect(routeIntent("cinematic", { premium: true }).model).toBe("veo3_1");
    expect(routeIntent("social").model).toBe("seedance_2_0_mini");
    expect(routeIntent("social", { premium: true }).model).toBe("kling3_0_turbo");
  });
  it("builds the confirmed generic REST path /developer/v2alpha/{category}/{model}/generations", () => {
    expect(submitPathFor(MODEL_DESCRIPTORS.seedance_2_0)).toBe("/developer/v2alpha/videos/seedance_2_0/generations");
    expect(submitPathFor(MODEL_DESCRIPTORS.sync_so)).toBe("/developer/v2alpha/videos/sync_so/generations");
  });
  it("marks the seedance-family models as reveal:true (ip_detected → reveal_generation)", () => {
    expect(MODEL_DESCRIPTORS.seedance_2_0.reveal).toBe(true);
    expect(MODEL_DESCRIPTORS.veo3_1.reveal).toBe(false);
  });
});

describe("intent classifier", () => {
  it("classifies a person-speaking request as talking_head", () => {
    expect(classifyVideoIntent("make a video of a founder speaking to camera")).toBe("talking_head");
    expect(classifyVideoIntent("a spokesperson recruitment video")).toBe("talking_head");
  });
  it("classifies cinematic + social", () => {
    expect(classifyVideoIntent("a cinematic wide shot of the coastline")).toBe("cinematic");
    expect(classifyVideoIntent("a quick tiktok reel")).toBe("social");
  });
  it("defaults ambiguous requests to the known-good talking_head path", () => {
    expect(classifyVideoIntent("something nice")).toBe("talking_head");
  });
});

describe("generative intake schema", () => {
  it("accepts a minimal talking_head request (prompt + intent + script)", () => {
    const r = generativeVideoIntakeSchema.safeParse({ prompt: "a super agent", intent: "talking_head", script: "Hi, I'm Sam and this is Upcar." });
    expect(r.success).toBe(true);
  });
  it("rejects an unknown intent", () => {
    const r = generativeVideoIntakeSchema.safeParse({ prompt: "x", intent: "hologram" });
    expect(r.success).toBe(false);
  });
  it("talking_head requires a script of at most 150 words", () => {
    const p = (v: object) => generativeVideoIntakeSchema.safeParse({ prompt: "p", ...v }).success;
    expect(p({ intent: "talking_head" })).toBe(false);
    expect(p({ intent: "talking_head", script: "   " })).toBe(false);
    expect(p({ intent: "talking_head", script: "Hi, I'm Sam and this is Upcar." })).toBe(true);
    expect(p({ intent: "talking_head", script: Array(TALKING_HEAD_MAX_WORDS).fill("w").join(" ") })).toBe(true);
    expect(p({ intent: "talking_head", script: Array(TALKING_HEAD_MAX_WORDS + 1).fill("w").join(" ") })).toBe(false);
    expect(p({ intent: "cinematic" })).toBe(true);
  });
  it("narrowAspect maps free-text aspect to the router union", () => {
    expect(narrowAspect("9:16")).toBe("9:16");
    expect(narrowAspect("1:1")).toBe("1:1");
    expect(narrowAspect("4:5")).toBe("4:5");
    expect(narrowAspect("16:9")).toBe("16:9");
    expect(narrowAspect(undefined)).toBe("16:9");
    expect(narrowAspect("21:9")).toBe("16:9");
  });
  it("spokenSeconds is words/2.5 + 1, UNCLAMPED (durationForScript's 4-15s clamp would misprice a long read)", () => {
    expect(spokenSeconds(Array(50).fill("w").join(" "))).toBe(21);
    expect(spokenSeconds(Array(100).fill("w").join(" "))).toBe(41);
    expect(spokenSeconds(Array(72).fill("w").join(" "))).toBe(30);
    expect(spokenSeconds(Array(73).fill("w").join(" "))).toBe(31);
    expect(spokenSeconds("Hi")).toBe(2);
  });
});

describe("isGenerativeVideoEnabled — default-ON posture", () => {
  const OLD = process.env.GENERATIVE_VIDEO_ENABLED;
  afterEach(() => {
    if (OLD === undefined) delete process.env.GENERATIVE_VIDEO_ENABLED;
    else process.env.GENERATIVE_VIDEO_ENABLED = OLD;
  });
  it("env kill switch =0 → OFF without a DB read", async () => {
    process.env.GENERATIVE_VIDEO_ENABLED = "0";
    expect(await isGenerativeVideoEnabled("t1", makeSb({ generative_video_disabled: false }))).toBe(false);
  });
  it("default (no config) → ON", async () => {
    delete process.env.GENERATIVE_VIDEO_ENABLED;
    expect(await isGenerativeVideoEnabled("t1", makeSb({}))).toBe(true);
  });
  it("per-tenant disable list → OFF for that tenant only", async () => {
    delete process.env.GENERATIVE_VIDEO_ENABLED;
    const sb = makeSb({ generative_video_disabled_tenants: ["t-bad"] });
    expect(await isGenerativeVideoEnabled("t-bad", sb)).toBe(false);
    expect(await isGenerativeVideoEnabled("t-ok", sb)).toBe(true);
  });
});

describe("platform-higgsfield split submit/poll (crash-safe)", () => {
  const OLD_KEY = process.env.HIGGSFIELD_API_KEY;
  beforeEach(() => {
    process.env.HIGGSFIELD_API_KEY = "k:s";
    process.env.HIGGSFIELD_USER_ID = "user_x";
    process.env.HIGGSFIELD_WORKSPACE_ID = "ws_x";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (OLD_KEY === undefined) delete process.env.HIGGSFIELD_API_KEY;
    else process.env.HIGGSFIELD_API_KEY = OLD_KEY;
    delete process.env.HIGGSFIELD_USER_ID;
    delete process.env.HIGGSFIELD_WORKSPACE_ID;
  });

  it("submitGeneration returns the vendor job id and does NOT poll", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(mkRes(200, { id: "job-123" }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await submitGeneration("/developer/v2alpha/videos/seedance_2_0/generations", { prompt: "x" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.jobId).toBe("job-123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pollGenerationOnce returns pending while running, resultUrl when terminal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mkRes(200, { status: "processing" })));
    const p1 = await pollGenerationOnce("job-123");
    expect(p1.ok).toBe(false);
    expect("pending" in p1 && p1.pending).toBe(true);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mkRes(200, { status: "completed", result_url: "https://x/y.mp4" })));
    const p2 = await pollGenerationOnce("job-123");
    expect(p2.ok).toBe(true);
    if (p2.ok) expect(p2.resultUrl).toBe("https://x/y.mp4");
  });

  it("pollGenerationOnce reports a terminal FAILURE (not pending) so the worker stops", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mkRes(200, { status: "failed" })));
    const p = await pollGenerationOnce("job-123");
    expect(p.ok).toBe(false);
    expect("pending" in p && p.pending === true).toBe(false);
    if (!p.ok && !("pending" in p && p.pending)) expect((p as { error: string }).error).toContain("failed");
  });
});

function mkRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeSb(blob: Record<string, unknown>): Parameters<typeof isGenerativeVideoEnabled>[1] {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({ data: { blob }, error: null }),
              };
            },
          };
        },
      };
    },
  } as unknown as Parameters<typeof isGenerativeVideoEnabled>[1];
}

describe("talking_head minimum script length (fal audio floor)", () => {
const ok = (script: string) => generativeVideoIntakeSchema.safeParse({ prompt: "p", intent: "talking_head", script }).success;
it("rejects a script too short to clear the 1.8s audio floor", () => {
  expect(ok("Hi there")).toBe(false);
  expect(ok("Try Upcar today")).toBe(false);
});
it("accepts a normal one-line script", () => {
  expect(ok("Upcar helps you rent your car out in minutes.")).toBe(true);
});
it("the boundary is exactly TALKING_HEAD_MIN_WORDS", () => {
  const words = (n: number) => Array(n).fill("word").join(" ");
  expect(ok(words(TALKING_HEAD_MIN_WORDS - 1))).toBe(false);
  expect(ok(words(TALKING_HEAD_MIN_WORDS))).toBe(true);
  expect(TALKING_HEAD_MIN_WORDS / 2.0).toBeGreaterThan(1.8);
});
});
