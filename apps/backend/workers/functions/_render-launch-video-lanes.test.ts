import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PUBLIC_LANE_KEY,
  PUBLIC_RENDER_CONCURRENCY,
  renderLaneKeys,
} from "./_render-launch-video-lanes";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

describe("renderLaneKeys — authed (slack) lane", () => {
  it("keys on the raw tenant_id, exactly as the pre-change CEL key did", () => {
    expect(renderLaneKeys({ run_id: "r1", tenant_id: TENANT_A }).tenant_lane_key).toBe(TENANT_A);
    expect(renderLaneKeys({ run_id: "r2", tenant_id: TENANT_A, delivery: "slack" }).tenant_lane_key).toBe(TENANT_A);
  });

  it("two runs for the SAME tenant share the limit-1 bucket (serialized)", () => {
    const a = renderLaneKeys({ run_id: "r1", tenant_id: TENANT_A });
    const b = renderLaneKeys({ run_id: "r2", tenant_id: TENANT_A });
    expect(a.tenant_lane_key).toBe(b.tenant_lane_key);
  });

  it("different tenants get different buckets (never serialized against each other)", () => {
    expect(renderLaneKeys({ run_id: "r1", tenant_id: TENANT_A }).tenant_lane_key).not.toBe(
      renderLaneKeys({ run_id: "r2", tenant_id: TENANT_B }).tenant_lane_key,
    );
  });

  it("its PUBLIC-lane key is unique per run, so the public limit never binds it", () => {
    const a = renderLaneKeys({ run_id: "r1", tenant_id: TENANT_A });
    const b = renderLaneKeys({ run_id: "r2", tenant_id: TENANT_A });
    expect(a.public_lane_key).not.toBe(b.public_lane_key);
    expect(a.public_lane_key).not.toBe(PUBLIC_LANE_KEY);
  });

  it("a missing tenant_id falls back to a PER-RUN key, never an empty/shared one", () => {
    const a = renderLaneKeys({ run_id: "r1" });
    const b = renderLaneKeys({ run_id: "r2", tenant_id: "" });
    expect(a.tenant_lane_key).not.toBe("");
    expect(b.tenant_lane_key).not.toBe("");
    expect(a.tenant_lane_key).not.toBe(b.tenant_lane_key);
  });
});

describe("renderLaneKeys — public (web) lane: THE defect this fixes", () => {
  it("EVERY public job shares ONE constant bucket, even with distinct fresh shell tenants", () => {
    const jobs = Array.from({ length: 200 }, (_, i) =>
      renderLaneKeys({
        run_id: `job-${i}`,
        job_id: `job-${i}`,
        delivery: "web",
        tenant_id: `shell-${i}`,
      }),
    );
    const buckets = new Set(jobs.map((j) => j.public_lane_key));
    expect(buckets.size).toBe(1);
    expect([...buckets][0]).toBe(PUBLIC_LANE_KEY);
  });

  it("its TENANT-lane key is unique per job, so the limit-1 constraint never binds it", () => {
    const a = renderLaneKeys({ run_id: "j1", job_id: "j1", delivery: "web", tenant_id: "shell-1" });
    const b = renderLaneKeys({ run_id: "j2", job_id: "j2", delivery: "web", tenant_id: "shell-2" });
    expect(a.tenant_lane_key).not.toBe(b.tenant_lane_key);
  });

  it("falls back to run_id when job_id is absent (run_id == job_id on this path)", () => {
    expect(renderLaneKeys({ run_id: "j9", delivery: "web" }).tenant_lane_key).toBe("job:j9");
  });
});

describe("renderLaneKeys — the two lanes never collapse into one bucket", () => {
  it("no slack key can ever equal a web key (disjoint key spaces)", () => {
    const slack = renderLaneKeys({ run_id: "r1", tenant_id: TENANT_A });
    const web = renderLaneKeys({ run_id: "j1", job_id: "j1", delivery: "web", tenant_id: TENANT_A });
    expect(slack.tenant_lane_key).not.toBe(web.tenant_lane_key);
    expect(slack.public_lane_key).not.toBe(web.public_lane_key);
  });

  it("a slack run whose run_id collides with a web job_id still gets distinct buckets", () => {
    const slack = renderLaneKeys({ run_id: "same", tenant_id: TENANT_A });
    const web = renderLaneKeys({ run_id: "same", job_id: "same", delivery: "web", tenant_id: TENANT_A });
    expect(slack.tenant_lane_key).not.toBe(web.tenant_lane_key);
    expect(slack.public_lane_key).not.toBe(web.public_lane_key);
  });

  it("every key is a non-empty string on every shape of input", () => {
    const inputs = [
      { run_id: "r" },
      { run_id: "r", tenant_id: null },
      { run_id: "r", delivery: "slack" as const },
      { run_id: "r", delivery: "web" as const },
      { run_id: "r", delivery: "web" as const, job_id: null },
    ];
    for (const i of inputs) {
      const k = renderLaneKeys(i);
      expect(k.tenant_lane_key.length).toBeGreaterThan(0);
      expect(k.public_lane_key.length).toBeGreaterThan(0);
    }
  });
});

describe("PUBLIC_RENDER_CONCURRENCY — the costed bound", () => {
  it("is a small positive integer, far below the 200/day cap", () => {
    expect(Number.isInteger(PUBLIC_RENDER_CONCURRENCY)).toBe(true);
    expect(PUBLIC_RENDER_CONCURRENCY).toBeGreaterThan(0);
    expect(PUBLIC_RENDER_CONCURRENCY).toBeLessThanOrEqual(10);
  });
});

const h = vi.hoisted(() => ({
  flushCharges: vi.fn(async () => {}),
  synthesizeBeatVo: vi.fn(),
  generateBeatMedia: vi.fn(),
  renderLaunchVideoAspects: vi.fn(),
  upload: vi.fn(async (): Promise<{ error: { message: string } | null }> => ({ error: null })),
}));

vi.mock("../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => {
  const row: Record<string, unknown> = {
    agent_runs: { data: { tenant_id: "11111111-1111-1111-1111-111111111111" }, error: null },
  };
  const chain = (result: unknown): Record<string, unknown> => {
    const p: Record<string, unknown> = {};
    for (const k of ["select", "eq", "in", "update", "order", "limit"]) p[k] = () => p;
    p.maybeSingle = async () => result;
    p.upsert = async () => ({ error: null });
    p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
    return p;
  };
  return {
    serviceClient: () => ({
      from: (t: string) => chain(row[t] ?? { data: null, error: null }),
      storage: { from: () => ({ upload: h.upload }) },
    }),
  };
});
vi.mock("@/services/agents/_render-launch-video-flag-check", () => ({ isRenderLaunchVideoEnabled: async () => true }));
vi.mock("@/services/launch-video/vo", () => ({
  synthesizeBeatVo: (...a: unknown[]) => h.synthesizeBeatVo(...a),
  describeVoOutcome: () => ({ state: "none_authored", silent: false, notice: null }),
}));
vi.mock("@/services/launch-video/media", () => ({ generateBeatMedia: (...a: unknown[]) => h.generateBeatMedia(...a) }));
vi.mock("@/services/launch-video/render", () => {
  class LaunchVideoRenderError extends Error {
    code: string;
    constructor(code: string, msg: string) {
      super(msg);
      this.code = code;
    }
  }
  return { renderLaunchVideoAspects: (...a: unknown[]) => h.renderLaunchVideoAspects(...a), LaunchVideoRenderError };
});
vi.mock("@/services/launch-video/capture-bridge", () => ({
  captureProductStill: async () => ({ ok: false, reason: "no url" }),
  resolveCaptureTarget: () => null,
  stripImagePromptAt: () => {},
  captureImageFor: () => ({ beatIndex: 0, itemIndex: null, filename: "c.png", bytes: new Uint8Array([1]) }),
}));
vi.mock("@/services/tools/slack/upload_file", () => ({ uploadFileToThread: vi.fn(async () => {}) }));
vi.mock("@/services/agents/deliver-artifact-to-thread", () => ({ deliverArtifactToThread: vi.fn(async () => true) }));
vi.mock("@/services/mcp/internal/slack", () => ({ callSlackTool: vi.fn(async () => {}) }));
vi.mock("@/services/agents/handoff-intent", () => ({ logHandoffIntent: vi.fn(async () => {}) }));
vi.mock("./_render-launch-video-web", () => ({ handleWebLaunchVideoRender: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/services/media-router/charge", () => ({ flushCharges: (...a: unknown[]) => h.flushCharges(...(a as [])) }));

import { renderLaunchVideoHandler, type RenderLaunchVideoCtx } from "./render-launch-video";

const VO_CHARGE = { tenant_id: "t", run_id: "r1", key: "r1:lv-vo:A:0", cost_usd: 0.01, task: "audio.voiceover", model: "eleven" };
const IMG_CHARGE = { tenant_id: "t", run_id: "r1", key: "r1:lv-image:A:0:hero", cost_usd: 0.06, task: "image.hero", model: "seedream" };

const INTAKE = {
  product_name: "Acme",
  one_liner: "Introducing Acme — the fastest way to ship.",
  url: "https://acme.test",
  audience: "founders",
  tone: "clean",
  features: [{ title: "Ships code", detail: "Opens a pull request you can review." }],
  cta_text: "Try Acme",
  cta_url: "https://acme.test",
};

function ctx(over: Partial<RenderLaunchVideoCtx["event"]["data"]> = {}): RenderLaunchVideoCtx {
  return {
    event: {
      data: {
        run_id: "r1",
        intake: INTAKE,
        delivery_target: { kind: "chat", thread_id: "th1" },
        ...over,
      },
    },
    step: { run: async <T,>(_n: string, fn: () => T | Promise<T>) => fn() },
    logger: { info: () => {}, warn: () => {} },
  };
}

describe("render-launch-video — media credits settle only after a delivered render", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.upload.mockResolvedValue({ error: null });
    h.synthesizeBeatVo.mockResolvedValue({ audio: new Map(), blocked: null, blockedError: null, pendingCharges: [VO_CHARGE] });
    h.generateBeatMedia.mockResolvedValue({ images: [], videos: [], creditsSpent: 1, log: [], pendingCharges: [IMG_CHARGE] });
    h.renderLaunchVideoAspects.mockResolvedValue({ results: [{ aspect: "16:9", bytes: new Uint8Array([1, 2]), voicedBeats: 0 }] });
  });

  it("charges BOTH the voiceover and the media, once, after the artifacts are written", async () => {
    await renderLaunchVideoHandler(ctx());
    expect(h.flushCharges).toHaveBeenCalledTimes(1);
    expect(h.flushCharges).toHaveBeenCalledWith([VO_CHARGE, IMG_CHARGE]);
  });

  it("A FAILED RENDER CHARGES NOTHING — the customer never got a video", async () => {
    h.renderLaunchVideoAspects.mockRejectedValue(new Error("sandbox died"));
    await expect(renderLaunchVideoHandler(ctx())).rejects.toThrow();
    expect(h.flushCharges).not.toHaveBeenCalled();
  });

  it("a failed ARTIFACT WRITE charges nothing either (the file is not reachable)", async () => {
    h.upload.mockResolvedValue({ error: { message: "bucket down" } });
    await expect(renderLaunchVideoHandler(ctx())).rejects.toThrow();
    expect(h.flushCharges).not.toHaveBeenCalled();
  });

  it("nothing generated → no empty charge call", async () => {
    h.synthesizeBeatVo.mockResolvedValue({ audio: new Map(), blocked: null, blockedError: null, pendingCharges: [] });
    h.generateBeatMedia.mockResolvedValue({ images: [], videos: [], creditsSpent: 0, log: [], pendingCharges: [] });
    await renderLaunchVideoHandler(ctx());
    expect(h.flushCharges).not.toHaveBeenCalled();
  });

  it("the VARIANT is passed to VO, so variant B's narration is billed on its own key", async () => {
    await renderLaunchVideoHandler(
      ctx({ intake: { ...INTAKE, scripts: [{ one_liner: "Acme, now with receipts you can show." }] } }),
    );
    const variants = h.synthesizeBeatVo.mock.calls.map((c) => (c[0] as { variant?: string }).variant);
    expect(variants).toEqual(["A", "B"]);
    expect(h.flushCharges).toHaveBeenCalledTimes(2);
  });

  it("multi-variant: a SECOND variant that fails to render settles nothing at all", async () => {
    h.renderLaunchVideoAspects
      .mockResolvedValueOnce({ results: [{ aspect: "16:9", bytes: new Uint8Array([1]), voicedBeats: 0 }] })
      .mockRejectedValueOnce(new Error("sandbox died"));
    await expect(
      renderLaunchVideoHandler(ctx({ intake: { ...INTAKE, scripts: [{ one_liner: "Acme, now with receipts you can show." }] } })),
    ).rejects.toThrow();
    expect(h.flushCharges).not.toHaveBeenCalled();
  });
});
