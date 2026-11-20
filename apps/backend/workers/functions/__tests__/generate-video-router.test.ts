import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const routerMocks = vi.hoisted(() => ({
  isMediaRouterEnabled: vi.fn(),
  submitMedia: vi.fn(),
  pollMediaOnce: vi.fn(),
  cancelMedia: vi.fn(),
  generateMedia: vi.fn(),
  estimateCost: vi.fn(),
  costForJob: vi.fn(),
  downloadMedia: vi.fn(),
}));
const logMocks = vi.hoisted(() => ({ logEvent: vi.fn() }));
const { track } = vi.hoisted(() => ({ track: vi.fn() }));
const flatPricing = vi.hoisted(() => ({ on: false }));
vi.mock("@/services/billing/flat-pricing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/billing/flat-pricing")>()),
  isFlatJobPricingOn: async () => flatPricing.on,
}));
vi.mock("@/services/analytics/mixpanel", () => ({ track }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: (...a: unknown[]) => logMocks.logEvent(...a) }));
const chargeMocks = vi.hoisted(() => ({ canAffordMedia: vi.fn(), checkAffordMedia: vi.fn(), flushCharges: vi.fn() }));
const meterMock = vi.hoisted(() => ({ meterPlatformGeneration: vi.fn() }));
const legacyMocks = vi.hoisted(() => ({ submitGeneration: vi.fn(), pollGenerationOnce: vi.fn() }));
const deliveryMocks = vi.hoisted(() => ({ uploadFileToThread: vi.fn(), callSlackTool: vi.fn(), deliverArtifactToThread: vi.fn() }));

vi.mock("@/services/media-router/router", () => routerMocks);
const captured = vi.hoisted(() => ({ handlers: new Map<string, (ctx: unknown) => Promise<unknown>>() }));
vi.mock("../../client", () => ({
  inngest: {
    createFunction: (_cfg: unknown, trigger: { event?: string }, fn: (ctx: unknown) => Promise<unknown>) => {
      if (trigger?.event) captured.handlers.set(trigger.event, fn);
      return { id: trigger?.event ?? "fn" };
    },
    send: vi.fn(),
  },
}));
vi.mock("@/services/agents/_render-launch-video-flag-check", () => ({ isGenerativeVideoEnabled: vi.fn(async () => true) }));
vi.mock("@/services/media-router/charge", () => chargeMocks);
vi.mock("@/services/mcp/higgsfield-meter", () => meterMock);
vi.mock("@/services/launch-video/platform-higgsfield", () => ({
  ...legacyMocks,
  generatePlatformImage: vi.fn(),
  isPlatformHiggsfieldConfigured: vi.fn(() => true),
}));
vi.mock("@/services/tools/slack/upload_file", () => ({ uploadFileToThread: deliveryMocks.uploadFileToThread }));
vi.mock("@/services/mcp/internal/slack", () => ({ callSlackTool: deliveryMocks.callSlackTool }));
vi.mock("@/services/agents/deliver-artifact-to-thread", () => ({ deliverArtifactToThread: deliveryMocks.deliverArtifactToThread }));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn(() => makeSb()) }));
const finishMocks = vi.hoisted(() => ({ runFinishPass: vi.fn(), getBoolSetting: vi.fn() }));
vi.mock("@/services/launch-video/finish-pass", () => ({ runFinishPass: finishMocks.runFinishPass }));
vi.mock("@/services/settings", () => ({ getBoolSetting: finishMocks.getBoolSetting }));
const signMocks = vi.hoisted(() => ({ signOwnImageForVendor: vi.fn() }));
const gateMocks = vi.hoisted(() => ({ isChannelLockedStrict: vi.fn(async () => false), channelPlanLock: vi.fn(async () => null), runPayload: { value: null as Record<string, unknown> | null } }));
vi.mock("@/services/channels/lock", () => ({ isChannelLockedStrict: gateMocks.isChannelLockedStrict }));
vi.mock("@/services/growth/preview-plan", () => ({ channelPlanLock: gateMocks.channelPlanLock }));
vi.mock("@/services/chat-images/sign-own-image", () => signMocks);
const lookMocks = vi.hoisted(() => ({ lookAtPortraitUrl: vi.fn() }));
vi.mock("@/services/video-studio/photo-look", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/video-studio/photo-look")>()),
  lookAtPortraitUrl: lookMocks.lookAtPortraitUrl,
}));

import { NonRetriableError } from "inngest";
import { ANIMATE_IMAGE_TTL_SECONDS, notifyGenerateVideoFailure, runRoutedVideo, runVideoFlow, videoIntentKey } from "../generate-video";
import type { GenerativeVideoIntake } from "@/services/launch-video/generative-video-intake";
import { mediaSlotHash } from "@/services/media-router/keys";
import type { VideoDeliveryTarget } from "@/services/launch-video/delivery-target";

type JobRow = { tenant_id: string; run_id: string; meter_key: string; model: string; job_id: string | null; status: string; result_url?: string | null; error?: string | null; created_at?: string; pending_charges?: unknown };

const shared = vi.hoisted(() => ({ jobs: null as null | unknown[], ledger: [] as Array<{ tenant_id: string; kind: string; media_key: string }>, clock: { t: 0 } }));

function listTable(rows: () => Record<string, unknown>[]) {
  const f: Array<(r: Record<string, unknown>) => boolean> = [];
  const q: Record<string, unknown> = {
    select: () => q,
    eq: (k: string, v: unknown) => {
      f.push((r) => r[k] === v);
      return q;
    },
    in: (k: string, vs: unknown[]) => {
      f.push((r) => vs.includes(r[k]));
      return q;
    },
    gte: () => q,
    then: (res: (v: { data: unknown[]; error: null }) => unknown) => Promise.resolve({ data: rows().filter((r) => f.every((p) => p(r))), error: null }).then(res),
  };
  return q;
}

function makeSb() {
  const jobs: JobRow[] = (shared.jobs as JobRow[] | null) ?? [];
  const artifacts: Record<string, unknown>[] = [];
  const uploads: { bucket: string; path: string; bytes: number }[] = [];
  const removed: string[] = [];
  const stored: Array<{ name: string; metadata: { size: number } }> = [];

  const jobsTable = () => {
    let f: Partial<JobRow> = {};
    const match = () => jobs.filter((r) => Object.entries(f).every(([k, v]) => (r as Record<string, unknown>)[k] === v));
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (k: string, v: string) => {
        (f as Record<string, unknown>)[k] = v;
        return api;
      },
      maybeSingle: async () => ({ data: match()[0] ?? null, error: null }),
      then: (res: (v: { data: JobRow[]; error: null }) => unknown) => Promise.resolve({ data: match(), error: null }).then(res),
      upsert: async (row: JobRow, opts?: { ignoreDuplicates?: boolean }) => {
        const i = jobs.findIndex((r) => r.run_id === row.run_id && r.meter_key === row.meter_key);
        if (i >= 0 && opts?.ignoreDuplicates) return { error: null };
        if (i >= 0) jobs[i] = { ...jobs[i], ...row };
        else jobs.push({ created_at: new Date(Date.now() + shared.clock.t++).toISOString(), ...row });
        return { error: null };
      },
      update: (patch: Partial<JobRow>) => {
        const upd: Record<string, unknown> = {
          eq: (k: string, v: string) => {
            (f as Record<string, unknown>)[k] = v;
            return upd;
          },
          then: (res: (v: { error: null }) => unknown) => {
            for (const r of jobs) if (Object.entries(f).every(([k, v]) => (r as Record<string, unknown>)[k] === v)) Object.assign(r, patch);
            return Promise.resolve({ error: null }).then(res);
          },
        };
        return upd;
      },
    };
    return api;
  };

  return {
    _jobs: jobs,
    _artifacts: artifacts,
    _uploads: uploads,
    _removed: removed,
    _stored: stored,
    from: (t: string) => {
      if (t === "generative_video_jobs") return jobsTable();
      if (t === "agent_runs") {
        const q = {
          select: () => q,
          eq: () => q,
          gte: () => q,
          maybeSingle: async () => ({ data: { tenant_id: TENANT, payload: gateMocks.runPayload.value }, error: null }),
          then: (res: (v: { data: unknown[]; error: null }) => unknown) => Promise.resolve({ data: [], error: null }).then(res),
        };
        return q;
      }
      if (t === "channel_actions" || t === "channel_action_events") return listTable(() => []);
      if (t === "tenant_credit_ledger") return listTable(() => shared.ledger);
      if (t === "run_artifacts") {
        return {
          upsert: async (row: Record<string, unknown>) => {
            artifacts.push(row);
            return { error: null };
          },
          update: (patch: Record<string, unknown>) => {
            const f: Record<string, unknown> = {};
            const q = {
              eq: (k: string, v: unknown) => {
                f[k] = v;
                return q;
              },
              then: (resolve: (v: { error: null }) => unknown) => {
                for (const r of artifacts) if (Object.entries(f).every(([k, v]) => r[k] === v)) Object.assign(r, patch);
                return Promise.resolve({ error: null }).then(resolve);
              },
            };
            return q;
          },
        };
      }
      throw new Error(`unexpected table ${t}`);
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, buf: Buffer) => {
          uploads.push({ bucket, path, bytes: buf.byteLength });
          return { error: null };
        },
        download: async (_path: string) => ({ data: new Blob([new Uint8Array([1, 2, 3, 4])]), error: null }),
        createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://storage.test/get/${path}` }, error: null }),
        createSignedUploadUrl: async (path: string) => ({ data: { signedUrl: `https://storage.test/put/${path}` }, error: null }),
        list: async (_dir: string, opts?: { search?: string }) => ({ data: stored.filter((o) => !opts?.search || o.name.includes(opts.search)), error: null }),
        remove: async (paths: string[]) => {
          removed.push(...paths);
          return { data: [], error: null };
        },
      }),
    },
  };
}

type Sb = ReturnType<typeof makeSb>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const step = { run: (_n: string, fn: () => unknown) => Promise.resolve(fn()) } as any;
const TENANT = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";
const chatTarget: VideoDeliveryTarget = { kind: "chat", thread_id: "thr_1" };
const slackTarget: VideoDeliveryTarget = { kind: "slack", channel_id: "C1", thread_ts: "1.0", team_id: "T1" };

const intake = (over: Partial<GenerativeVideoIntake> = {}): GenerativeVideoIntake =>
  ({ prompt: "a founder explaining Zavi", intent: "talking_head", premium: false, script: "Hi, I'm Sam and this is Zavi.", ...over }) as GenerativeVideoIntake;

const drive = (sb: Sb, over: Partial<GenerativeVideoIntake> = {}, target: VideoDeliveryTarget = chatTarget) =>
  runRoutedVideo(
    step,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sb as any,
    { tenant_id: TENANT, run_id: RUN, intake: intake(over), target, logger: { warn: vi.fn() } },
    { pollDelayMs: 0, maxPolls: 3 },
  );

const PORTRAIT = { ok: true as const, url: "https://cdn.fal/p.png", vendor: "fal" as const, model: "seedream", cost_usd: 0.0675 };
const VOICE = { ok: true as const, url: "https://cdn.fal/v.mp3", vendor: "fal" as const, model: "eleven-v3", cost_usd: 0.02 };
const JOB = { vendor: "fal" as const, model: "bytedance/seedance-2.5/reference-to-video", id: "job-1", status_url: "https://q/s", response_url: "https://q/r" };

beforeEach(() => {
  vi.clearAllMocks();
  shared.jobs = null;
  shared.ledger = [];
  routerMocks.cancelMedia.mockResolvedValue("requested");
  meterMock.meterPlatformGeneration.mockResolvedValue({ decision: "charged", idempotency_key: "k" });
  chargeMocks.canAffordMedia.mockResolvedValue(true);
  chargeMocks.checkAffordMedia.mockResolvedValue("ok");
  chargeMocks.flushCharges.mockResolvedValue(undefined);
  finishMocks.getBoolSetting.mockResolvedValue(true);
  finishMocks.runFinishPass.mockResolvedValue({ ok: true, duration_s: 3.6, bytes: 999 });
  routerMocks.estimateCost.mockReturnValue(1);
  routerMocks.generateMedia.mockImplementation(async (task: string) => (task === "image.photo" ? PORTRAIT : VOICE));
  routerMocks.submitMedia.mockResolvedValue({ ok: true, job: JOB });
  routerMocks.pollMediaOnce.mockResolvedValue({ state: "done", url: "https://cdn.fal/out.mp4", duration_s: 12 });
  routerMocks.costForJob.mockImplementation((_j: unknown, _r: unknown, done: { duration_s?: number }) => (done.duration_s ?? 0) * 0.5);
  routerMocks.downloadMedia.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
});

describe("chat render waits for a slow vendor", () => {
  it("delivers a talking head that fal finishes after the old 10-minute poll limit instead of discarding a paid video", async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      routerMocks.isMediaRouterEnabled.mockResolvedValue(true);
      routerMocks.pollMediaOnce.mockImplementation(async () => {
        polls++;
        return polls <= 150 ? { state: "pending" } : { state: "done", url: "https://cdn.fal/out.mp4", duration_s: 12 };
      });
      const handler = captured.handlers.get("video.generate.requested")!;
      expect(handler).toBeTypeOf("function");
      let settled = false;
      const run = handler({
        event: { data: { run_id: RUN, tenant_id: TENANT, intake: intake(), delivery_target: chatTarget } },
        step,
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }).finally(() => {
        settled = true;
      });
      for (let i = 0; i < 400 && !settled; i++) await vi.advanceTimersByTimeAsync(5_000);
      const r = await run;
      expect(polls).toBe(151);
      expect(r).toMatchObject({ ok: true });
      expect(routerMocks.cancelMedia).not.toHaveBeenCalled();
      expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
      const bodies = deliveryMocks.deliverArtifactToThread.mock.calls.map((c) => (c[0] as { body: string }).body);
      expect(bodies.some((b) => /took too long/.test(b))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runRoutedVideo — talking head", () => {
  it("a standard-tier talking head routes to the standard avatar task whatever its length", async () => {
    const sb = makeSb();
    const long = Array.from({ length: 90 }, (_, i) => `word${i}`).join(" ");
    await drive(sb, { avatar_tier: "standard", script: long });
    expect(routerMocks.submitMedia.mock.calls[0][0]).toBe("video.talking_head_standard");
  });

  it("portrait → voice → video (≤30s speech); ALL charges flushed ONCE, after delivery", async () => {
    const sb = makeSb();
    const r = await drive(sb);
    expect(r).toMatchObject({ ok: true });

    expect(routerMocks.generateMedia.mock.calls[0][0]).toBe("image.photo");
    expect(routerMocks.generateMedia.mock.calls[1][0]).toBe("audio.voiceover");
    expect(routerMocks.generateMedia.mock.calls[1][1]).toEqual({ text: intake().script, voice: "Brian", voice_stability: 0.3, voice_timestamps: true });
    expect(routerMocks.generateMedia.mock.calls[0][1].prompt).toContain("a founder explaining Zavi");
    expect(routerMocks.generateMedia.mock.calls[0][1].prompt).toContain("Hands out of frame");
    expect(routerMocks.submitMedia).toHaveBeenCalledTimes(1);
    const [task, req] = routerMocks.submitMedia.mock.calls[0];
    expect(task).toBe("video.talking_head");
    expect(req).toMatchObject({ image_url: PORTRAIT.url, audio_url: VOICE.url, aspect_ratio: "16:9" });
    expect(req.duration_s).toBe(4);

    expect(sb._artifacts).toHaveLength(1);
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
    const pending = chargeMocks.flushCharges.mock.calls[0][0] as { key: string; cost_usd: number }[];
    expect(pending.map((p) => p.key)).toEqual([`${RUN}:gen-image:0`, `${RUN}:gen-vo:0`, `${RUN}:gen-video:0`]);
    expect(pending[0].cost_usd).toBe(PORTRAIT.cost_usd);
    expect(pending[1].cost_usd).toBe(VOICE.cost_usd);
    expect(routerMocks.costForJob).toHaveBeenCalledWith(JOB, expect.anything(), { duration_s: 4 });
    expect(pending[2].cost_usd).toBe(2);
  });

  it("the voice follows the portrait that came back, not the gender the card asked for", async () => {
    lookMocks.lookAtPortraitUrl.mockResolvedValueOnce({ has_person: true, gender: "male" });
    await drive(makeSb(), { presenter_gender: "female", voice: "Jessica" });
    expect(lookMocks.lookAtPortraitUrl).toHaveBeenCalledWith(PORTRAIT.url);
    expect(routerMocks.generateMedia.mock.calls[0][1].prompt).toContain("a woman");
    expect(routerMocks.generateMedia.mock.calls[1][1]).toMatchObject({ voice: "Chris" });
  });

  it("a portrait that cannot be read keeps the card's voice and still makes the video", async () => {
    lookMocks.lookAtPortraitUrl.mockResolvedValueOnce(null);
    await drive(makeSb(), { presenter_gender: "female", voice: "Sarah" });
    expect(routerMocks.generateMedia.mock.calls[1][1]).toMatchObject({ voice: "Sarah" });
    expect(routerMocks.submitMedia).toHaveBeenCalled();
  });

  it("a named presenter gets a portrait and a voice of the same gender", async () => {
    const sb = makeSb();
    await drive(sb, { presenter_gender: "female", voice: "Brian" });
    expect(routerMocks.generateMedia.mock.calls[0][1].prompt).toContain("a woman");
    expect(routerMocks.generateMedia.mock.calls[1][1]).toMatchObject({ voice: "Jessica" });

    routerMocks.generateMedia.mockClear();
    await drive(makeSb(), { presenter_gender: "male", voice: "Will" });
    expect(routerMocks.generateMedia.mock.calls[0][1].prompt).toContain("a man");
    expect(routerMocks.generateMedia.mock.calls[1][1]).toMatchObject({ voice: "Will" });
  });

  it("a very short script is quoted, requested and billed at fal's 4s floor", async () => {
    const sb = makeSb();
    routerMocks.pollMediaOnce.mockResolvedValue({ state: "done", url: "https://cdn.fal/out.mp4" });
    await drive(sb, { script: "Hi there" });
    expect(routerMocks.submitMedia.mock.calls[0][0]).toBe("video.talking_head");
    expect(routerMocks.submitMedia.mock.calls[0][1].duration_s).toBe(4);
    expect(routerMocks.costForJob).toHaveBeenCalledWith(JOB, expect.anything(), { duration_s: 4 });
  });

  it("a script over 30s of speech routes to video.talking_head_long", async () => {
    const sb = makeSb();
    await drive(sb, { script: Array(100).fill("word").join(" ") });
    expect(routerMocks.submitMedia.mock.calls[0][0]).toBe("video.talking_head_long");
    expect(routerMocks.submitMedia.mock.calls[0][1].duration_s).toBe(41);
  });

  it("bills the SHORTER clip when the vendor under-delivers (cap is one-sided)", async () => {
    routerMocks.pollMediaOnce.mockResolvedValue({ state: "done", url: "https://cdn.fal/out.mp4", duration_s: 2 });
    const sb = makeSb();
    await drive(sb);
    expect(routerMocks.costForJob).toHaveBeenCalledWith(JOB, expect.anything(), { duration_s: 2 });
  });

  it("duration falls back to the script length when the vendor omits it", async () => {
    routerMocks.pollMediaOnce.mockResolvedValue({ state: "done", url: "https://cdn.fal/out.mp4" });
    const sb = makeSb();
    await drive(sb, { script: Array(50).fill("word").join(" ") });
    expect(routerMocks.costForJob).toHaveBeenCalledWith(JOB, expect.anything(), { duration_s: 21 });
  });

  it("the whole chain is priced in ONE affordability pre-check", async () => {
    const sb = makeSb();
    routerMocks.estimateCost.mockImplementation((t: string) => (t === "image.photo" ? 0.07 : t === "audio.voiceover" ? 0.02 : 2.2));
    await drive(sb);
    expect(chargeMocks.checkAffordMedia).toHaveBeenCalledTimes(1);
    expect(chargeMocks.checkAffordMedia).toHaveBeenCalledWith(TENANT, ((28 + 8 + 880) * 25) / 10000);
  });
});

describe("runRoutedVideo — nothing undelivered is ever charged", () => {
  it("video fails after portrait + voice succeeded → nothing is charged and the copy says so truthfully", async () => {
    routerMocks.pollMediaOnce.mockResolvedValue({ state: "failed", reason: "vendor_error", error: "boom" });
    const sb = makeSb();
    const r = await drive(sb);
    expect(r).toMatchObject({ skipped: "video_failed" });
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
    expect(sb._artifacts).toHaveLength(0);
    const body = deliveryMocks.deliverArtifactToThread.mock.calls[0][0].body as string;
    expect(body).toBe("Sorry, the video generation didn't complete. You were not charged for it.");
  });

  it("a content-policy refusal says the model declined, and still charges nothing", async () => {
    routerMocks.pollMediaOnce.mockResolvedValue({ state: "failed", reason: "refused", error: "policy" });
    const sb = makeSb();
    await drive(sb, { intent: "cinematic", script: undefined });
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
    expect(deliveryMocks.deliverArtifactToThread.mock.calls[0][0].body).toBe(
      "Sorry, the video model declined this request under its content policy. You were not charged for it.",
    );
  });

  it("a talking head the vendor can't do yet says exactly that", async () => {
    routerMocks.pollMediaOnce.mockResolvedValue({ state: "failed", reason: "not_configured", error: "no key" });
    const sb = makeSb();
    await drive(sb);
    expect(deliveryMocks.deliverArtifactToThread.mock.calls[0][0].body).toBe(
      "Sorry, talking-head videos aren't available yet. You were not charged for it.",
    );
  });

  it("a talking head the model refuses in chat says so, without a Try again button chat does not have", async () => {
    routerMocks.pollMediaOnce.mockResolvedValue({ state: "failed", reason: "refused", error: "fal result 422: content_policy_violation" });
    const sb = makeSb();
    const r = await drive(sb);
    expect(r).toMatchObject({ skipped: "video_failed" });
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
    const body = deliveryMocks.deliverArtifactToThread.mock.calls[0][0].body as string;
    expect(body).toBe("Sorry, the video model turned down the AI presenter it was given. You were not charged for it.");
    expect(body).not.toMatch(/available yet|Try again/);
  });

  it("a talking head the model refuses in Slack never points at a Try again button", async () => {
    routerMocks.pollMediaOnce.mockResolvedValue({ state: "failed", reason: "refused", error: "fal result 422: content_policy_violation" });
    deliveryMocks.callSlackTool.mockResolvedValue({ ok: true });
    await drive(makeSb(), {}, slackTarget);
    const texts = deliveryMocks.callSlackTool.mock.calls.map((c) => (c[2] as { text?: string }).text ?? "");
    const failure = texts.find((t) => t.includes("turned down the AI presenter"));
    expect(failure).toBe("Sorry, the video model turned down the AI presenter it was given. You were not charged for it.");
    for (const t of texts) expect(t).not.toMatch(/Try again/);
  });

  it("a five-video batch render that fal finishes at minute eight still lands on the card", async () => {
    const { CHANNEL_VIDEO_MAX_POLLS, VIDEO_POLLS_PER_STEP } = await import("../generate-video");
    let polls = 0;
    routerMocks.pollMediaOnce.mockImplementation(async () =>
      ++polls < 100 ? { state: "pending" } : { state: "done", url: "https://cdn.fal/out.mp4", duration_s: 20 },
    );
    const names: string[] = [];
    const recording = { run: (n: string, fn: () => unknown) => (names.push(n), Promise.resolve(fn())) } as any;
    const sb = makeSb();
    const r = await runRoutedVideo(
      recording,
      sb as any,
      { tenant_id: TENANT, run_id: RUN, intake: intake(), target: chatTarget, logger: { warn: vi.fn() } },
      { pollDelayMs: 0, maxPolls: CHANNEL_VIDEO_MAX_POLLS },
    );
    expect(r).toMatchObject({ ok: true });
    expect(polls).toBe(100);
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
    expect(names.filter((n) => n.startsWith("poll-routed-gen-video-0"))).toEqual(["poll-routed-gen-video-0", "poll-routed-gen-video-0-1"]);
    expect(CHANNEL_VIDEO_MAX_POLLS * 5).toBeGreaterThanOrEqual(12 * 60);
    expect(VIDEO_POLLS_PER_STEP * 5).toBeLessThanOrEqual(5 * 60);
  });

  it("gives up after exactly the ceiling, across steps, and says it took too long", async () => {
    let polls = 0;
    routerMocks.pollMediaOnce.mockImplementation(async () => (polls++, { state: "pending" }));
    const sb = makeSb();
    const r = await runRoutedVideo(
      step,
      sb as any,
      { tenant_id: TENANT, run_id: RUN, intake: intake(), target: chatTarget, logger: { warn: vi.fn() } },
      { pollDelayMs: 0, maxPolls: 150, pollsPerStep: 60 },
    );
    expect(r).toMatchObject({ skipped: "video_failed" });
    expect(polls).toBe(150);
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
  });

  it("a poll that never finishes says it took too long", async () => {
    routerMocks.pollMediaOnce.mockResolvedValue({ state: "pending" });
    const sb = makeSb();
    const r = await drive(sb, { intent: "social", script: undefined });
    expect(r).toMatchObject({ skipped: "video_failed" });
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
    expect(deliveryMocks.deliverArtifactToThread.mock.calls[0][0].body).toBe(
      "Sorry, the video took too long to generate. You were not charged for it.",
    );
  });

  it("an empty VENDOR wallet is reported as our outage, never as the customer's limit", async () => {
    routerMocks.pollMediaOnce.mockResolvedValue({ state: "failed", reason: "out_of_credits", error: "403 Exhausted balance" });
    const sb = makeSb();
    await drive(sb, { intent: "social", script: undefined });
    const body = deliveryMocks.deliverArtifactToThread.mock.calls[0][0].body as string;
    expect(body).toContain("temporarily unavailable on our side");
    expect(logMocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", code: "video_vendor_out_of_credits", tenant_id: TENANT }),
    );
    expect(body).toContain("not a limit on your workspace");
    expect(body).not.toMatch(/top up/i);
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
  });

  it("a fal 402 out-of-credits submit logs http_status 402 with unchanged founder copy and no charge", async () => {
    routerMocks.submitMedia.mockResolvedValue({ ok: false, reason: "out_of_credits", error: "fal submit 402: Exhausted balance", http_status: 402 });
    await drive(makeSb(), { intent: "social", script: undefined });
    const call = logMocks.logEvent.mock.calls.map((c) => c[0]).find((e) => e.code === "video_vendor_out_of_credits");
    expect(call.meta).toEqual({ failure_class: "vendor_out_of_credits", http_status: 402 });
    expect(deliveryMocks.deliverArtifactToThread.mock.calls[0][0].body).toBe(
      "Sorry, video generation is temporarily unavailable on our side. The team has been alerted, and this is not a limit on your workspace. You were not charged for it.",
    );
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
  });

  it("an out-of-credits failure with no known status logs http_status null, not a made-up number", async () => {
    routerMocks.pollMediaOnce.mockResolvedValue({ state: "failed", reason: "out_of_credits", error: "Exhausted balance" });
    await drive(makeSb(), { intent: "social", script: undefined });
    const call = logMocks.logEvent.mock.calls.map((c) => c[0]).find((e) => e.code === "video_vendor_out_of_credits");
    expect(call.meta).toEqual({ failure_class: "vendor_out_of_credits", http_status: null });
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
  });

  describe("the vendor's real HTTP status reaches the out-of-credits alert on every leg", () => {
    let serialised: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      serialised = vi.spyOn(step, "run").mockImplementation(async (_n: unknown, fn: unknown) => JSON.parse(JSON.stringify((await (fn as () => unknown)()) ?? null)));
    });
    afterEach(() => serialised.mockRestore());
    const alerts = () => logMocks.logEvent.mock.calls.map((c) => c[0]).filter((e) => e.code === "video_vendor_out_of_credits");
    const EMPTY = { ok: false as const, reason: "out_of_credits" as const, error: "fal result 402: Exhausted balance", vendor: "fal" as const, model: "eleven-v3", http_status: 402 };

    it("an empty wallet on the voiceover after a generated portrait logs http_status 402, submits no video and charges nothing", async () => {
      routerMocks.generateMedia.mockImplementation(async (task: string) => (task === "image.photo" ? PORTRAIT : EMPTY));
      const r = await drive(makeSb());
      expect(r).toMatchObject({ skipped: "voice_failed" });
      expect(alerts()).toHaveLength(1);
      expect(alerts()[0].meta).toEqual({ failure_class: "vendor_out_of_credits", http_status: 402 });
      expect(routerMocks.submitMedia).not.toHaveBeenCalled();
      expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
    });

    it("an empty wallet on the voiceover for an uploaded photo logs http_status 402", async () => {
      signMocks.signOwnImageForVendor.mockResolvedValue("https://storage.test/get/woman.jpg");
      routerMocks.generateMedia.mockResolvedValue(EMPTY);
      const r = await drive(makeSb(), { portrait_path: `${TENANT}/woman.jpg`, presenter_gender: "female" });
      expect(r).toMatchObject({ skipped: "voice_failed" });
      expect(alerts()).toHaveLength(1);
      expect(alerts()[0].meta).toEqual({ failure_class: "vendor_out_of_credits", http_status: 402 });
      expect(routerMocks.submitMedia).not.toHaveBeenCalled();
      expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
    });

    it("an empty wallet on the portrait logs http_status 402 and never asks for a voiceover", async () => {
      routerMocks.generateMedia.mockResolvedValueOnce({ ...EMPTY, model: "seedream" });
      const r = await drive(makeSb());
      expect(r).toMatchObject({ skipped: "portrait_failed" });
      expect(routerMocks.generateMedia).toHaveBeenCalledTimes(1);
      expect(alerts()[0].meta).toEqual({ failure_class: "vendor_out_of_credits", http_status: 402 });
      expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
    });

    it("an empty wallet reported by a video poll logs http_status 402 through the serialised poll step", async () => {
      routerMocks.pollMediaOnce.mockResolvedValue({ state: "failed", reason: "out_of_credits", error: "fal status 402: Exhausted balance", http_status: 402 });
      const sb = makeSb();
      const r = await drive(sb, { intent: "social", script: undefined });
      expect(r).toMatchObject({ skipped: "video_failed" });
      expect(alerts()).toHaveLength(1);
      expect(alerts()[0].meta).toEqual({ failure_class: "vendor_out_of_credits", http_status: 402 });
      expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
    });
  });

  it("portrait fails → no voice call, no submit, no charge", async () => {
    routerMocks.generateMedia.mockResolvedValueOnce({ ok: false, reason: "refused", error: "policy" });
    const sb = makeSb();
    await drive(sb);
    expect(routerMocks.generateMedia).toHaveBeenCalledTimes(1);
    expect(routerMocks.submitMedia).not.toHaveBeenCalled();
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
  });

  it("with flat pricing on, a Create chat presenter video is checked against and quoted at the 450 credits it is charged", async () => {
    flatPricing.on = true;
    try {
      routerMocks.estimateCost.mockImplementation((t: string) => (t === "image.photo" ? 0.07 : t === "audio.voiceover" ? 0.02 : 2.15));
      chargeMocks.checkAffordMedia.mockResolvedValue("short");
      const r = await drive(makeSb(), { avatar_tier: "standard" });
      expect(r).toMatchObject({ skipped: "insufficient_credits" });
      expect(chargeMocks.checkAffordMedia).toHaveBeenCalledTimes(1);
      expect(chargeMocks.checkAffordMedia.mock.calls[0][1]).toBeCloseTo(1.125, 9);
      const body = deliveryMocks.deliverArtifactToThread.mock.calls[0][0].body as string;
      expect(body).toContain("about 450 credits");
      expect(body).not.toContain("896");
    } finally {
      flatPricing.on = false;
    }
  });

  it("cannot afford the whole chain → refused before any vendor call", async () => {
    chargeMocks.checkAffordMedia.mockResolvedValue("short");
    const sb = makeSb();
    const r = await drive(sb);
    expect(r).toMatchObject({ skipped: "insufficient_credits" });
    expect(routerMocks.generateMedia).not.toHaveBeenCalled();
    expect(routerMocks.submitMedia).not.toHaveBeenCalled();
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
    const body = deliveryMocks.deliverArtifactToThread.mock.calls[0][0].body as string;
    expect(body).toContain("1,200 credits");
  });

  it("a run resuming across this deploy replays a MEMOIZED boolean, not a string", async () => {
    const memoStep = {
      run: (n: string, fn: () => unknown) => (n === "afford-media" ? Promise.resolve(true) : Promise.resolve(fn())),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const sb = makeSb();
    const r = await runRoutedVideo(
      memoStep,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sb as any,
      { tenant_id: TENANT, run_id: RUN, intake: intake(), target: chatTarget, logger: { warn: vi.fn() } },
      { pollDelayMs: 0, maxPolls: 3 },
    );
    expect(r).toMatchObject({ ok: true });
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
  });

  it("wallet read FAILS → refuses without claiming the customer is short", async () => {
    chargeMocks.checkAffordMedia.mockResolvedValue("unknown");
    const sb = makeSb();
    const r = await drive(sb);
    expect(r).toMatchObject({ skipped: "afford_check_unavailable" });
    expect(routerMocks.generateMedia).not.toHaveBeenCalled();
    expect(routerMocks.submitMedia).not.toHaveBeenCalled();
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
    const body = deliveryMocks.deliverArtifactToThread.mock.calls[0][0].body as string;
    expect(body).not.toMatch(/top up/i);
    expect(body).not.toMatch(/\d[\d,]*\s+credits/);
  });

  it("the meter failing closed stops the run before the vendor call", async () => {
    meterMock.meterPlatformGeneration.mockResolvedValue({ decision: "meter_error", idempotency_key: "k", error: "db down" });
    const sb = makeSb();
    await expect(drive(sb)).rejects.toThrow(/meter_error/);
    await expect(drive(makeSb())).rejects.toBeInstanceOf(NonRetriableError);
    expect(routerMocks.generateMedia).not.toHaveBeenCalled();
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
  });
});

describe("runRoutedVideo — crash-safe resume + delivery", () => {
  it("submit persists the JobRef as JSON; a retry resumes without resubmitting", async () => {
    const sb = makeSb();
    await drive(sb);
    const row = sb._jobs.find((r) => r.meter_key === `${RUN}:gen-video:0`)!;
    expect(JSON.parse(row.job_id!)).toMatchObject(JOB);
    expect(row.model).toBe(JOB.model);

    routerMocks.submitMedia.mockClear();
    routerMocks.pollMediaOnce.mockClear();
    await drive(sb);
    expect(routerMocks.submitMedia).not.toHaveBeenCalled();
    expect(routerMocks.pollMediaOnce).toHaveBeenCalledWith(expect.objectContaining(JOB));
  });

  it("ALWAYS uploads the mp4 to launch-video-artifacts — a Slack run's artifact row never holds a vendor URL", async () => {
    const sb = makeSb();
    await drive(sb, {}, slackTarget);
    expect(sb._uploads).toEqual([{ bucket: "launch-video-artifacts", path: `${TENANT}/${RUN}/talking_head-${RUN.slice(0, 8)}.mp4`, bytes: 4 }]);
    expect(sb._artifacts[0]).toMatchObject({ bucket: "launch-video-artifacts", storage_path: `${TENANT}/${RUN}/talking_head-${RUN.slice(0, 8)}.mp4` });
    expect(String(sb._artifacts[0].storage_path)).not.toContain("http");
    expect(deliveryMocks.uploadFileToThread).toHaveBeenCalledTimes(1);
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
    expect(sb._artifacts[0].slack_delivered).toBe(true);
  });

  it("a download that returns nothing is a failure, not a charge", async () => {
    routerMocks.downloadMedia.mockResolvedValue(null);
    const sb = makeSb();
    await expect(drive(sb)).rejects.toThrow();
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
  });
});

describe("runRoutedVideo — the finish pass", () => {
  const WORDS: Array<[string, number, number]> = [["Hi,", 0.1, 0.3], ["I'm", 0.35, 0.5], ["Sam", 0.55, 0.9], ["and", 1.0, 1.2], ["this", 1.25, 1.5], ["is", 1.55, 1.7], ["Zavi.", 1.75, 2.2]];
  const spoken = () => routerMocks.generateMedia.mockImplementation(async (task: string) => (task === "image.photo" ? PORTRAIT : { ...VOICE, words: WORDS }));
  const RAW = `${TENANT}/${RUN}/talking_head-${RUN.slice(0, 8)}.mp4`;
  const EDITED = `${TENANT}/${RUN}/edited-talking_head-${RUN.slice(0, 8)}.mp4`;

  it("a 9:16 talking head with word timings is delivered as the edited file, at the same price", async () => {
    spoken();
    const sb = makeSb();
    const r = await drive(sb, { aspect_ratio: "9:16", hook: "Hi, I'm Sam" });
    expect(r).toMatchObject({ ok: true });

    expect(sb._uploads).toEqual([{ bucket: "launch-video-artifacts", path: RAW, bytes: 4 }]);
    const pass = finishMocks.runFinishPass.mock.calls[0][0];
    expect(pass).toMatchObject({ tenant_id: TENANT, words: WORDS, hook: "Hi, I'm Sam", rawUrl: `https://storage.test/get/${RAW}`, uploadUrl: `https://storage.test/put/${EDITED}` });
    expect(sb._artifacts[0]).toMatchObject({ storage_path: EDITED, bytes: 999, mime: "video/mp4" });

    const withPass = routerMocks.costForJob.mock.calls.map((c) => c[2]);
    vi.clearAllMocks();
    finishMocks.getBoolSetting.mockResolvedValue(false);
    meterMock.meterPlatformGeneration.mockResolvedValue({ decision: "charged", idempotency_key: "k" });
    chargeMocks.checkAffordMedia.mockResolvedValue("ok");
    await drive(makeSb(), { aspect_ratio: "9:16", hook: "Hi, I'm Sam" });
    expect(routerMocks.costForJob.mock.calls.map((c) => c[2])).toEqual(withPass);
  });

  it("a failed pass never fails the video: the raw copy is delivered and charged as before", async () => {
    spoken();
    finishMocks.runFinishPass.mockResolvedValue({ ok: false, reason: "encode", detail: "boom" });
    const sb = makeSb();
    const r = await drive(sb, { aspect_ratio: "9:16" });
    expect(r).toMatchObject({ ok: true });
    expect(sb._artifacts[0]).toMatchObject({ storage_path: RAW, bytes: 4 });
    expect(sb._removed).toEqual([]);
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
    expect(logMocks.logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "video_finish_pass_skipped", meta: { failure_class: "encode" } }));
  });

  it("a pass that throws is still only a skipped edit", async () => {
    spoken();
    finishMocks.runFinishPass.mockRejectedValue(new Error("sandbox exploded"));
    const sb = makeSb();
    await expect(drive(sb, { aspect_ratio: "9:16" })).resolves.toMatchObject({ ok: true });
    expect(sb._artifacts[0]).toMatchObject({ storage_path: RAW });
  });

  it("does not run when switched off", async () => {
    spoken();
    finishMocks.getBoolSetting.mockResolvedValue(false);
    await drive(makeSb(), { aspect_ratio: "9:16" });
    await drive(makeSb(), { intent: "cinematic", script: undefined, aspect_ratio: "16:9" });
    expect(finishMocks.runFinishPass).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<GenerativeVideoIntake>]>([
    ["a 16:9 talking head", { aspect_ratio: "16:9" }],
    ["a 9:16 cinematic clip", { intent: "cinematic", script: undefined, aspect_ratio: "9:16" }],
    ["a 16:9 cinematic clip", { intent: "cinematic", script: undefined, aspect_ratio: "16:9" }],
    ["a square social clip", { intent: "social", script: undefined, aspect_ratio: "1:1" }],
  ])("%s skips the finish pass and is delivered as the raw file, with no label burned in", async (_label, over) => {
    spoken();
    const sb = makeSb();
    await expect(drive(sb, over)).resolves.toMatchObject({ ok: true });
    expect(finishMocks.runFinishPass).not.toHaveBeenCalled();
    expect(String(sb._artifacts[0].storage_path)).not.toContain("/edited-");
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
  });

  it("a 9:16 talking head gets the full edit with no label option", async () => {
    spoken();
    await drive(makeSb(), { aspect_ratio: "9:16" });
    expect(finishMocks.runFinishPass).toHaveBeenCalledTimes(1);
    expect(finishMocks.runFinishPass.mock.calls[0][0]).not.toHaveProperty("labelOnly");
  });

  it("a voiceover with no word timings still gets the pass, with no words", async () => {
    routerMocks.generateMedia.mockImplementation(async (task: string) => (task === "image.photo" ? PORTRAIT : VOICE));
    const sb = makeSb();
    await drive(sb, { aspect_ratio: "9:16" });
    expect(finishMocks.runFinishPass.mock.calls[0][0]).toMatchObject({ words: [] });
    expect(sb._artifacts[0]).toMatchObject({ storage_path: EDITED });
  });

  it("a replay whose vendor URL has expired reuses the copy already in our bucket", async () => {
    spoken();
    routerMocks.downloadMedia.mockResolvedValue(null);
    const sb = makeSb();
    sb._stored.push({ name: `talking_head-${RUN.slice(0, 8)}.mp4`, metadata: { size: 4321 } });
    finishMocks.runFinishPass.mockResolvedValue({ ok: false, reason: "encode" });
    const r = await drive(sb, { aspect_ratio: "9:16" });
    expect(r).toMatchObject({ ok: true });
    expect(sb._uploads).toEqual([]);
    expect(sb._artifacts[0]).toMatchObject({ storage_path: RAW, bytes: 4321 });
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
  });
});

describe("runVideoFlow — the kill switch", () => {
  const flow = (sb: Sb) =>
    runVideoFlow(
      step,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sb as any,
      { tenant_id: TENANT, run_id: RUN, intake: intake(), target: chatTarget, logger: { warn: vi.fn() } },
      { pollDelayMs: 0, maxPolls: 3 },
    );

  it("switch OFF runs the legacy path (submitGeneration), never submitMedia", async () => {
    routerMocks.isMediaRouterEnabled.mockResolvedValue(false);
    legacyMocks.submitGeneration.mockResolvedValue({ ok: false, error: "no key" });
    const sb = makeSb();
    await expect(flow(sb)).rejects.toThrow();
    expect(legacyMocks.submitGeneration).toHaveBeenCalled();
    expect(routerMocks.submitMedia).not.toHaveBeenCalled();
    expect(routerMocks.generateMedia).not.toHaveBeenCalled();
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
  });

  it("switch ON runs the routed path, never submitGeneration", async () => {
    routerMocks.isMediaRouterEnabled.mockResolvedValue(true);
    const sb = makeSb();
    await flow(sb);
    expect(routerMocks.submitMedia).toHaveBeenCalled();
    expect(legacyMocks.submitGeneration).not.toHaveBeenCalled();
  });
});

describe("runRoutedVideo — a retried delivery counts one video, not two", () => {
  it("re-running the deliver step after a thrown delivery sends one media_generated", async () => {
    const sb = makeSb();
    let attempts = 0;
    const retryingStep = {
      run: async (_n: string, fn: () => unknown) => {
        for (let i = 0; ; i++) {
          try {
            return await fn();
          } catch (e) {
            if (i >= 1) throw e;
          }
        }
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    deliveryMocks.deliverArtifactToThread.mockImplementation(async () => {
      attempts++;
      if (attempts === 1) throw new Error("thread delivery blipped");
    });

    track.mockReset();
    await runRoutedVideo(
      retryingStep,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sb as any,
      { tenant_id: TENANT, run_id: RUN, intake: intake(), target: chatTarget, logger: { warn: vi.fn() } },
      { pollDelayMs: 0, maxPolls: 3 },
    );

    expect(attempts).toBe(2);
    const generated = track.mock.calls.filter((c) => c[0] === "media_generated");
    expect(generated).toHaveLength(1);
    expect(generated[0][1]).toMatchObject({ media: "video", kind: "talking_head" });
  });
});

describe("animate: a user's image becomes the first frame", () => {
  const IMAGE = `${TENANT}/9b2f0d.jpg`;
  const SIGNED = "https://storage.test/get/signed-image.jpg";
  const animate = { intent: "animate" as const, script: undefined, prompt: "steam rises from the cup", image_path: IMAGE };

  beforeEach(() => {
    signMocks.signOwnImageForVendor.mockResolvedValue(SIGNED);
    routerMocks.submitMedia.mockResolvedValue({ ok: true, job: { ...JOB, model: "bytedance/seedance-2.5/image-to-video" } });
    routerMocks.pollMediaOnce.mockResolvedValue({ state: "done", url: "https://cdn.fal/out.mp4", duration_s: 8 });
  });

  it("submits video.animate with a freshly signed link to the image, makes no portrait or voice, and charges once after delivery", async () => {
    const sb = makeSb();
    const r = await drive(sb, animate);
    expect(r).toMatchObject({ ok: true });
    expect(routerMocks.generateMedia).not.toHaveBeenCalled();
    expect(signMocks.signOwnImageForVendor).toHaveBeenCalledWith(TENANT, IMAGE, ANIMATE_IMAGE_TTL_SECONDS);
    expect(ANIMATE_IMAGE_TTL_SECONDS).toBeGreaterThanOrEqual(60 * 60);
    expect(routerMocks.submitMedia).toHaveBeenCalledTimes(1);
    const [task, req] = routerMocks.submitMedia.mock.calls[0];
    expect(task).toBe("video.animate");
    expect(req).toMatchObject({ image_url: SIGNED, prompt: "steam rises from the cup", duration_s: 8 });
    expect(sb._artifacts).toHaveLength(1);
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
    const pending = chargeMocks.flushCharges.mock.calls[0][0] as { key: string; task: string }[];
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ key: `${RUN}:gen-video:0`, task: "video.animate" });
  });

  it("a retry that finds the stored job resumes it without signing or submitting again", async () => {
    const sb = makeSb();
    await (sb.from("generative_video_jobs") as { upsert: (row: Record<string, unknown>) => Promise<unknown> }).upsert({ tenant_id: TENANT, run_id: RUN, meter_key: `${RUN}:gen-video:0`, model: JOB.model, job_id: JSON.stringify(JOB), status: "pending" });
    await drive(sb, animate);
    expect(signMocks.signOwnImageForVendor).not.toHaveBeenCalled();
    expect(routerMocks.submitMedia).not.toHaveBeenCalled();
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
  });

  it("an image that cannot be signed stops before fal, charges nothing and asks for a re-upload", async () => {
    signMocks.signOwnImageForVendor.mockRejectedValue(new Error("That image is not in this workspace. Upload it again."));
    const sb = makeSb();
    const r = await drive(sb, animate);
    expect(r).toEqual({ skipped: "video_failed" });
    expect(routerMocks.submitMedia).not.toHaveBeenCalled();
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
    expect(deliveryMocks.deliverArtifactToThread.mock.calls[0][0].body).toContain("the image could not be read. Upload it again");
  });

  it("two cards with different images never share a render key, and keys of videos without an image are unchanged", () => {
    const base = intake({ intent: "animate", script: undefined, prompt: "p", image_path: `${TENANT}/a.jpg` });
    const other = { ...base, image_path: `${TENANT}/b.jpg` };
    expect(videoIntentKey(base)).not.toBe(videoIntentKey(other));
    const plain = intake({ intent: "cinematic", script: undefined, prompt: "p" });
    expect(videoIntentKey(plain)).toBe(mediaSlotHash("v1", "cinematic", "p", "", "16:9", "0"));
  });
});

describe("the founder's own photo as the presenter", () => {
  const PHOTO = `${TENANT}/woman.jpg`;
  const SIGNED = "https://storage.test/get/woman.jpg";
  beforeEach(() => {
    signMocks.signOwnImageForVendor.mockResolvedValue(SIGNED);
  });

  it("makes no portrait, records the voice, sends the signed photo to the avatar model, and charges voice and video only", async () => {
    const sb = makeSb();
    const r = await drive(sb, { portrait_path: PHOTO, presenter_gender: "female" });
    expect(r).toMatchObject({ ok: true });
    expect(routerMocks.generateMedia.mock.calls.map((c) => c[0])).toEqual(["audio.voiceover"]);
    expect(signMocks.signOwnImageForVendor).toHaveBeenCalledWith(TENANT, PHOTO, ANIMATE_IMAGE_TTL_SECONDS);
    const [task, req] = routerMocks.submitMedia.mock.calls[0];
    expect(task).toBe("video.talking_head");
    expect(req).toMatchObject({ image_url: SIGNED, audio_url: VOICE.url });
    const pending = chargeMocks.flushCharges.mock.calls[0][0] as { key: string }[];
    expect(pending.map((p) => p.key)).toEqual([`${RUN}:gen-vo:0`, `${RUN}:gen-video:0`]);
  });

  it("an animation the model refuses for showing a real person says how to get a presenter video instead", async () => {
    routerMocks.pollMediaOnce.mockResolvedValue({ state: "failed", reason: "refused", error: "likeness" });
    await drive(makeSb(), { intent: "animate", script: undefined, prompt: "p", image_path: PHOTO });
    expect(deliveryMocks.deliverArtifactToThread.mock.calls[0][0].body).toContain("will not animate photos of real people");
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
  });
});

describe("a queued chat render re-checks the channel right before paid work", () => {
  const fire = () =>
    captured.handlers.get("video.generate.requested")!({
      event: { data: { run_id: RUN, tenant_id: TENANT, intake: intake(), delivery_target: chatTarget } },
      step,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    });
  beforeEach(() => {
    routerMocks.isMediaRouterEnabled.mockResolvedValue(true);
    gateMocks.isChannelLockedStrict.mockResolvedValue(false);
    gateMocks.channelPlanLock.mockResolvedValue(null);
  });

  it("a studio render queued before staff locked the channel makes nothing and spends nothing", async () => {
    gateMocks.runPayload.value = { stage: "video-studio-render" };
    gateMocks.isChannelLockedStrict.mockResolvedValue(true);
    try {
      expect(await fire()).toEqual({ skipped: "studio_blocked" });
      expect(routerMocks.generateMedia).not.toHaveBeenCalled();
      expect(routerMocks.submitMedia).not.toHaveBeenCalled();
      expect(meterMock.meterPlatformGeneration).not.toHaveBeenCalled();
      expect(deliveryMocks.deliverArtifactToThread.mock.calls[0][0].body).toContain("switched off");
    } finally {
      gateMocks.runPayload.value = null;
    }
  });

  it("a studio render whose video was switched off after it queued makes nothing, even on a replay that remembers the earlier flag check", async () => {
    const flag = await import("@/services/agents/_render-launch-video-flag-check");
    const memo = new Map<string, unknown>([["flag-check", true]]);
    const memoStep = { run: async (n: string, fn: () => unknown) => (memo.has(n) ? memo.get(n) : (memo.set(n, await fn()), memo.get(n))) };
    vi.mocked(flag.isGenerativeVideoEnabled).mockResolvedValue(false);
    gateMocks.runPayload.value = { stage: "video-studio-render" };
    try {
      const r = await captured.handlers.get("video.generate.requested")!({
        event: { data: { run_id: RUN, tenant_id: TENANT, intake: intake(), delivery_target: chatTarget } },
        step: memoStep,
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      });
      expect(r).toEqual({ skipped: "studio_blocked" });
      expect(routerMocks.submitMedia).not.toHaveBeenCalled();
    } finally {
      gateMocks.runPayload.value = null;
      vi.mocked(flag.isGenerativeVideoEnabled).mockResolvedValue(true);
    }
  });

  it("a studio render whose workspace lost the plan makes nothing", async () => {
    gateMocks.runPayload.value = { stage: "video-studio-render" };
    gateMocks.channelPlanLock.mockResolvedValue({ required_tier: "starter" } as never);
    try {
      expect(await fire()).toEqual({ skipped: "studio_blocked" });
      expect(routerMocks.submitMedia).not.toHaveBeenCalled();
    } finally {
      gateMocks.runPayload.value = null;
    }
  });

  it("a Zavi chat render asked for after staff locked the channel makes nothing and spends nothing", async () => {
    gateMocks.isChannelLockedStrict.mockResolvedValue(true);
    expect(await fire()).toEqual({ skipped: "channel_blocked" });
    expect(routerMocks.generateMedia).not.toHaveBeenCalled();
    expect(routerMocks.submitMedia).not.toHaveBeenCalled();
    expect(meterMock.meterPlatformGeneration).not.toHaveBeenCalled();
    expect(deliveryMocks.deliverArtifactToThread.mock.calls[0][0].body).toContain("switched off");
  });

  it("a Slack render for a workspace below Starter makes nothing and spends nothing", async () => {
    gateMocks.channelPlanLock.mockResolvedValue({ required_tier: "starter" } as never);
    const r = await captured.handlers.get("video.generate.requested")!({
      event: { data: { run_id: RUN, tenant_id: TENANT, intake: intake(), channel_id: "C1", thread_ts: "1.1" } },
      step,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    });
    expect(r).toEqual({ skipped: "channel_blocked" });
    expect(routerMocks.generateMedia).not.toHaveBeenCalled();
    expect(routerMocks.submitMedia).not.toHaveBeenCalled();
  });

  it("a Zavi chat render on an entitled, unlocked workspace still renders", async () => {
    await fire();
    expect(routerMocks.submitMedia).toHaveBeenCalledTimes(1);
  });
});

describe("pass-3 worker fixes", () => {
  beforeEach(() => {
    routerMocks.isMediaRouterEnabled.mockResolvedValue(true);
    gateMocks.isChannelLockedStrict.mockResolvedValue(false);
    gateMocks.channelPlanLock.mockResolvedValue(null);
  });

  it("an Inngest retry after staff lock the channel re-checks the lock instead of replaying the old allowed answer", async () => {
    const memo = new Map<string, unknown>();
    const memoStep = { run: async (n: string, fn: () => unknown) => (memo.has(n) ? memo.get(n) : (memo.set(n, await fn()), memo.get(n))) };
    const fire = () =>
      captured.handlers.get("video.generate.requested")!({
        event: { data: { run_id: RUN, tenant_id: TENANT, intake: intake(), delivery_target: chatTarget } },
        step: memoStep,
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      });
    gateMocks.runPayload.value = { stage: "video-studio-render" };
    routerMocks.submitMedia.mockRejectedValueOnce(new Error("network blip"));
    try {
      await expect(fire()).rejects.toThrow("network blip");
      gateMocks.isChannelLockedStrict.mockResolvedValue(true);
      expect(await fire()).toEqual({ skipped: "studio_blocked" });
      expect(routerMocks.submitMedia).toHaveBeenCalledTimes(1);
    } finally {
      gateMocks.runPayload.value = null;
    }
  });

  it("a studio render that finds video switched off says so in the chat instead of staying on rendering", async () => {
    const flag = await import("@/services/agents/_render-launch-video-flag-check");
    vi.mocked(flag.isGenerativeVideoEnabled).mockResolvedValueOnce(false);
    gateMocks.runPayload.value = { stage: "video-studio-render" };
    try {
      const r = await captured.handlers.get("video.generate.requested")!({
        event: { data: { run_id: RUN, tenant_id: TENANT, intake: intake(), delivery_target: chatTarget } },
        step,
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      });
      expect(r).toEqual({ skipped: "flag_off" });
      expect(deliveryMocks.deliverArtifactToThread.mock.calls[0][0].body).toContain("switched off");
    } finally {
      gateMocks.runPayload.value = null;
    }
  });
});

describe("final pass fixes", () => {
  beforeEach(() => {
    routerMocks.isMediaRouterEnabled.mockResolvedValue(true);
    gateMocks.isChannelLockedStrict.mockResolvedValue(false);
    gateMocks.channelPlanLock.mockResolvedValue(null);
  });

  it("a studio replay whose video was already submitted finishes and bills even after staff lock the channel", async () => {
    gateMocks.runPayload.value = { stage: "video-studio-render" };
    gateMocks.isChannelLockedStrict.mockResolvedValue(true);
    const sb = makeSb();
    await (sb.from("generative_video_jobs") as { upsert: (row: Record<string, unknown>) => Promise<unknown> }).upsert({ tenant_id: TENANT, run_id: RUN, meter_key: `${RUN}:gen-video:0`, model: JOB.model, job_id: JSON.stringify(JOB), status: "pending" });
    const sbMod = await import("@/services/supabase");
    vi.mocked(sbMod.serviceClient).mockReturnValueOnce(sb as never);
    try {
      const r = await captured.handlers.get("video.generate.requested")!({
        event: { data: { run_id: RUN, tenant_id: TENANT, intake: intake(), delivery_target: chatTarget } },
        step,
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      });
      expect(r).not.toEqual({ skipped: "studio_blocked" });
      expect(routerMocks.submitMedia).not.toHaveBeenCalled();
      expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
    } finally {
      gateMocks.runPayload.value = null;
    }
  });
});

describe("a chat or Slack video's name in the Library and on download", () => {
  const VALID_SHAPE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[a-z0-9._-]+$/;

  it("a Slack video is posted and filed under its hook, and the delivered mark still finds its row", async () => {
    const sb = makeSb();
    await drive(sb, { hook: "Stop paying for empty shifts" }, slackTarget);
    const name = "Stop paying for empty shifts.mp4";
    expect(deliveryMocks.uploadFileToThread.mock.calls[0][0]).toMatchObject({ filename: name, title: name });
    expect(sb._artifacts).toHaveLength(1);
    expect(sb._artifacts[0]).toMatchObject({ filename: name, slack_delivered: true, storage_path: `${TENANT}/${RUN}/talking_head-${RUN.slice(0, 8)}.mp4` });
    expect(String(sb._artifacts[0].storage_path)).toMatch(VALID_SHAPE);
  });

  it("a chat video without a hook is filed under the first line of its script", async () => {
    const sb = makeSb();
    await drive(sb, { script: "Hi, I'm Sam and this is Zavi. It runs the rota for you." });
    expect(sb._artifacts[0].filename).toBe("Hi, I'm Sam and this is Zavi.mp4");
    expect(String(sb._artifacts[0].storage_path)).toMatch(VALID_SHAPE);
    expect(deliveryMocks.deliverArtifactToThread).toHaveBeenCalledTimes(1);
  });

  it("the legacy rail files a Slack video under a readable name and still marks it delivered", async () => {
    routerMocks.isMediaRouterEnabled.mockResolvedValue(false);
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const sb = makeSb();
      sb._jobs.push({ tenant_id: TENANT, run_id: RUN, meter_key: `${RUN}:gen-video:0`, model: "m", job_id: "j", status: "completed", result_url: "https://cdn.vendor/out.mp4" });
      await runVideoFlow(
        step,
        sb as unknown as Parameters<typeof runVideoFlow>[1],
        { tenant_id: TENANT, run_id: RUN, intake: intake({ intent: "cinematic", script: undefined, prompt: "A sunrise over the harbour, slow pan" }), target: slackTarget, logger: { warn: vi.fn() } },
        { pollDelayMs: 0, maxPolls: 3 },
      );
      const name = "A sunrise over the harbour, slow pan.mp4";
      expect(deliveryMocks.uploadFileToThread.mock.calls[0][0]).toMatchObject({ filename: name, title: name });
      expect(sb._artifacts).toHaveLength(1);
      expect(sb._artifacts[0]).toMatchObject({ filename: name, slack_delivered: true });
      expect(String(sb._artifacts[0].filename)).not.toMatch(/cinematic-/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("chat and Slack videos asked at the same time share one wallet", () => {
  const RUN_B = "33333333-3333-3333-3333-333333333333";
  const RUN_C = "44444444-4444-4444-4444-444444444444";
  const COST = ((28 + 8 + 880) * 25) / 10000;
  const wallet = (balance: number) =>
    chargeMocks.checkAffordMedia.mockImplementation(async (_t: string, usd: number) => (usd <= balance + 1e-9 ? "ok" : "short"));
  const ask = (run_id: string, target: VideoDeliveryTarget) =>
    runRoutedVideo(
      step,
      makeSb() as unknown as Parameters<typeof runRoutedVideo>[1],
      { tenant_id: TENANT, run_id, intake: intake(), target, logger: { warn: vi.fn() } },
      { pollDelayMs: 0, maxPolls: 3 },
    );

  beforeEach(() => {
    shared.jobs = [];
    routerMocks.estimateCost.mockImplementation((t: string) => (t === "image.photo" ? 0.07 : t === "audio.voiceover" ? 0.02 : 2.2));
  });

  it("two videos started together on a wallet that pays for one: one is made, the other is refused before any vendor spend", async () => {
    wallet(COST * 1.5);
    const [a, b] = await Promise.all([ask(RUN, chatTarget), ask(RUN_B, slackTarget)]);
    expect([a, b].filter((r) => "skipped" in r && r.skipped === "insufficient_credits")).toHaveLength(1);
    expect([a, b].filter((r) => "ok" in r && r.ok)).toHaveLength(1);
    expect(routerMocks.submitMedia).toHaveBeenCalledTimes(1);
    expect(routerMocks.generateMedia).toHaveBeenCalledTimes(2);
    const asked = chargeMocks.checkAffordMedia.mock.calls.map((c) => c[1] as number).sort((x, y) => x - y);
    expect(asked[0]).toBeCloseTo(COST, 9);
    expect(asked[1]).toBeCloseTo(COST * 2, 9);
  });

  it("three at once on a wallet that pays for two: exactly two are made", async () => {
    wallet(COST * 2.5);
    const out = await Promise.all([ask(RUN, chatTarget), ask(RUN_B, chatTarget), ask(RUN_C, slackTarget)]);
    expect(out.filter((r) => "ok" in r && r.ok)).toHaveLength(2);
    expect(routerMocks.submitMedia).toHaveBeenCalledTimes(2);
  });

  it("a finished or refused video stops holding money, so the next one is checked on its own cost", async () => {
    wallet(COST * 1.5);
    expect(await ask(RUN, chatTarget)).toMatchObject({ ok: true });
    shared.ledger.push({ tenant_id: TENANT, kind: "media", media_key: `${RUN}:gen-video:0` });
    expect(await ask(RUN_B, chatTarget)).toMatchObject({ ok: true });
    wallet(COST * 0.5);
    expect(await ask(RUN_C, chatTarget)).toMatchObject({ skipped: "insufficient_credits" });
    const holds = (shared.jobs as JobRow[]).filter((r) => r.model === "video-hold");
    expect(holds).toHaveLength(3);
    expect(holds.every((r) => r.status === "completed")).toBe(true);
    wallet(COST * 1.5);
    expect(await ask("55555555-5555-5555-5555-555555555555", chatTarget)).toMatchObject({ ok: true });
    expect(chargeMocks.checkAffordMedia.mock.calls.at(-1)![1]).toBeCloseTo(COST, 9);
  });

  it("a delivered video whose charge has not landed keeps holding its cost", async () => {
    wallet(COST * 1.5);
    chargeMocks.flushCharges.mockRejectedValueOnce(new Error("ledger down"));
    await ask(RUN, chatTarget).catch(() => undefined);
    const owed = (shared.jobs as JobRow[]).find((r) => r.meter_key === `${RUN}:gen-video:0`);
    expect(owed?.pending_charges).toBeTruthy();
    expect(await ask(RUN_B, chatTarget)).toMatchObject({ skipped: "insufficient_credits" });
    expect(chargeMocks.checkAffordMedia.mock.calls.at(-1)![1]).toBeCloseTo(COST * 2, 9);
  });

  it("a video whose render threw until Inngest gave up stops holding money once onFailure runs", async () => {
    wallet(COST * 1.5);
    routerMocks.submitMedia.mockRejectedValueOnce(new Error("vendor exploded"));
    await expect(ask(RUN, chatTarget)).rejects.toThrow(/vendor exploded/);
    const held = () => (shared.jobs as JobRow[]).find((r) => r.meter_key === `${RUN}:video-hold`);
    expect(held()?.status).toBe("pending");
    expect(await ask(RUN_B, chatTarget)).toMatchObject({ skipped: "insufficient_credits" });
    expect(routerMocks.submitMedia).toHaveBeenCalledTimes(1);

    const empty = () => {
      const q: Record<string, unknown> = { select: () => q, eq: () => q, like: () => q, contains: () => q, limit: async () => ({ data: [], error: null }) };
      return q;
    };
    const sb = makeSb();
    const failSb = { from: (t: string) => (t === "run_artifacts" || t === "agent_thread_messages" ? empty() : sb.from(t)) };
    deliveryMocks.deliverArtifactToThread.mockResolvedValue(true);
    await notifyGenerateVideoFailure({ run_id: RUN, delivery_target: chatTarget }, failSb as never);
    expect(deliveryMocks.deliverArtifactToThread.mock.calls.filter((c) => c[0].run_id === RUN)).toHaveLength(1);
    expect(held()?.status).toBe("completed");

    expect(await ask(RUN_C, chatTarget)).toMatchObject({ ok: true });
    expect(chargeMocks.checkAffordMedia.mock.calls.at(-1)![1]).toBeCloseTo(COST, 9);
  });

  it("an unreadable hold refuses the video instead of guessing the wallet", async () => {
    wallet(COST * 10);
    (shared.jobs as JobRow[]).push({ tenant_id: TENANT, run_id: RUN_C, meter_key: `${RUN_C}:video-hold`, model: "video-hold", job_id: "not json", status: "pending", created_at: new Date(0).toISOString() });
    (shared.jobs as JobRow[])[0].created_at = new Date(Date.now() - 60_000).toISOString();
    expect(await ask(RUN, chatTarget)).toMatchObject({ skipped: "afford_check_unavailable" });
    expect(routerMocks.generateMedia).not.toHaveBeenCalled();
  });
});
