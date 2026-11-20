
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ client: null as unknown, authored: null as unknown }));

vi.mock("@/services/supabase", () => ({ serviceClient: () => H.client }));
vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(async (k: string) => k === "launch_video_public_enabled"),
}));
vi.mock("@/services/launch-video-public/caps", () => ({
  checkCaps: vi.fn(async () => ({ allowed: true })),
  checkAttemptCap: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/services/launch-video-public/captcha", () => ({
  verifyTurnstile: vi.fn(async () => ({ ok: true })),
  turnstileSiteKey: vi.fn(() => null),
}));
vi.mock("@/services/launch-video-public/authoring", () => ({
  authorIntake: vi.fn(async () => ({ ok: true, intake: H.authored })),
  moderateForm: vi.fn(async () => ({ allowed: true, reason: "ok" })),
}));
vi.mock("@/services/launch-video-public/store", () => ({
  createJob: vi.fn(async () => ({ id: "job-1" })),
  generateClientSecret: vi.fn(() => "secret"),
  hashSecret: vi.fn(() => "hashed"),
  hashIp: vi.fn(() => "iphash"),
}));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn(async () => undefined) } }));

import { launchVideoPublicGenerate } from "../launch-video-generate";
import { createJob } from "@/services/launch-video-public/store";
import { TARGET_SECONDS } from "@/services/launch-video-public/compose";

const BASE = {
  product_name: "Okara",
  one_liner: "An AI CMO that runs your marketing.",
  url: "https://okara.ai",
  audience: "B2B SaaS founders",
  tone: "clean",
  cta_text: "Start free",
  cta_url: "https://okara.ai",
};

const feature = (n: number) => ({ title: `Capability ${n}`, detail: `What capability ${n} does.` });

function mkRes() {
  const res = {
    statusCode: 0,
    body: null as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res as unknown as import("express").Response & { statusCode: number; body: any };
}

const req = () =>
  ({
    ip: "1.2.3.4",
    socket: { remoteAddress: "1.2.3.4" },
    body: { email: "founder@okara.ai", ...BASE, features: "a\nb\nc" },
  }) as unknown as import("express").Request;

beforeEach(() => {
  vi.clearAllMocks();
  H.client = { rpc: vi.fn(async () => ({ data: "tenant-1", error: null })) };
});

describe("the minimum-length floor", () => {
  it("refuses thin material and itemises what would fix it", async () => {
    H.authored = { ...BASE, features: [feature(1), feature(2), feature(3)] };
    const res = mkRes();
    await launchVideoPublicGenerate(req(), res);

    expect(res.statusCode).toBe(422);
    expect(res.body.error.code).toBe("insufficient_material");
    expect(res.body.error.target_seconds).toBe(TARGET_SECONDS);
    expect(res.body.error.seconds).toBeLessThan(TARGET_SECONDS);
    expect(res.body.error.missing.length).toBeGreaterThan(0);
    expect(res.body.error.missing.every((m: any) => m.label && m.seconds > 0)).toBe(true);
    expect(createJob).not.toHaveBeenCalled();
  });

  it("renders rich material and preserves only validated attribution outside the model input", async () => {
    H.authored = {
      ...BASE,
      problem: "Marketing headcount is the first thing a small team cannot afford.",
      features: Array.from({ length: 10 }, (_, i) => feature(i + 1)),
      product_surface: {
        header: { title: "Your channels" },
        items: [
          { title: "SEO", chips: ["12 posts"] },
          { title: "LinkedIn", chips: ["daily"] },
        ],
      },
      metrics: [{ stat: "10+", label: "marketing agents" }],
      proof: { stat: "3x", label: "more content shipped" },
      coverage: { regions: ["US", "UK", "India"] },
    };
    const res = mkRes();
    const request = req();
    request.body.attribution = { from: "filter-coffee", utm_source: "newsletter", token: "must-not-persist", referrer_host: "https://invalid.test/path" };
    await launchVideoPublicGenerate(request, res);

    const input = vi.mocked(createJob).mock.calls[0]?.[0];
    expect(input?.form_input).toMatchObject({ signup_attribution: { from: "filter-coffee", utm_source: "newsletter" } });
    expect((input?.form_input as Record<string, unknown>).signup_attribution).toEqual({ from: "filter-coffee", utm_source: "newsletter" });
    const { authorIntake, moderateForm } = await import("@/services/launch-video-public/authoring");
    expect(JSON.stringify(vi.mocked(authorIntake).mock.calls)).not.toContain("filter-coffee");
    expect(JSON.stringify(vi.mocked(moderateForm).mock.calls)).not.toContain("filter-coffee");
    expect(res.body?.error ?? null).toBeNull();
    expect(createJob).toHaveBeenCalled();
    const stored = (createJob as any).mock.calls[0][0].intake;
    expect(Array.isArray(stored.scenes)).toBe(true);
    const frames = stored.scenes.reduce((s: number, x: any) => s + (x.duration_frames ?? 0), 0);
    expect(frames / 30).toBeGreaterThanOrEqual(TARGET_SECONDS);
  });
});

describe("a bad draft from the author", () => {
  it("retries once, so one bad roll of the model does not reach the visitor", async () => {
    const { authorIntake } = await import("@/services/launch-video-public/authoring");
    H.authored = { ...BASE, features: [feature(1), feature(2), feature(3)] };
    (authorIntake as any).mockResolvedValueOnce({ ok: false, error: "author_no_json" });
    const res = mkRes();
    await launchVideoPublicGenerate(req(), res);

    expect(authorIntake).toHaveBeenCalledTimes(2);
    expect(res.body.error.code).toBe("insufficient_material");
  });

  it("owns a second failure, logs why, and spends nothing", async () => {
    const { authorIntake } = await import("@/services/launch-video-public/authoring");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    (authorIntake as any)
      .mockResolvedValueOnce({ ok: false, error: "author_schema:features" })
      .mockResolvedValueOnce({ ok: false, error: "author_schema:features" });
    const res = mkRes();
    await launchVideoPublicGenerate(req(), res);

    expect(authorIntake).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.flat().join(" ")).toContain("author_schema:features");
    log.mockRestore();
    expect(res.statusCode).toBe(422);
    expect(res.body.error.code).toBe("author_failed");
    expect(res.body.error.message).not.toMatch(/more detail/i);
    expect(createJob).not.toHaveBeenCalled();
  });

  it("does not retry an outage: the credential failover already walked every seat", async () => {
    const { authorIntake } = await import("@/services/launch-video-public/authoring");
    (authorIntake as any).mockResolvedValueOnce({ ok: false, error: "author_llm_error:429 rate_limit_error" });
    const res = mkRes();
    await launchVideoPublicGenerate(req(), res);

    expect(authorIntake).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe("authoring_unavailable");
  });
});
