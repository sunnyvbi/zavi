import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const world = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  seq: 0,
  failUpserts: {} as Record<string, number>,
}));

const fal = vi.hoisted(() => ({
  jobs: new Map<string, "pending" | "done" | "failed">(),
  cancelHonoured: false,
  submits: [] as string[],
  legDelayMs: 0,
  finishDelayMs: 0,
  legSeq: 0,
}));

const routerMocks = vi.hoisted(() => ({
  isMediaRouterEnabled: vi.fn(async () => true),
  submitMedia: vi.fn(),
  pollMediaOnce: vi.fn(),
  cancelMedia: vi.fn(),
  generateMedia: vi.fn(),
  estimateCost: vi.fn(() => 1),
  costForJob: vi.fn(),
  downloadMedia: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
}));
const chargeMocks = vi.hoisted(() => ({ canAffordMedia: vi.fn(), checkAffordMedia: vi.fn(async () => "ok"), flushCharges: vi.fn(async (_charges: Array<{ key: string }>) => undefined) }));
const meterMock = vi.hoisted(() => ({ meterPlatformGeneration: vi.fn(async () => ({ decision: "charged", idempotency_key: "k" })) }));
const finishMocks = vi.hoisted(() => ({ runFinishPass: vi.fn(), getBoolSetting: vi.fn(async () => false) }));
const captured = vi.hoisted(() => ({ handlers: new Map<string, (ctx: unknown) => Promise<unknown>>() }));

const db = vi.hoisted(() => {
  const field = (r: Row, k: string): unknown => {
    if (k.includes("->>")) {
      const [col, path] = k.split("->>");
      const v = r[col]?.[path];
      return v == null ? null : String(v);
    }
    return r[k];
  };
  const clone = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const nowIso = () => new Date(Date.now()).toISOString();
  const conflictCols = (spec?: string) => (spec ?? "id").split(",").map((s) => s.trim());
  const make = (inject: Row = {}) => ({
    from(name: string) {
      const rows = (world.tables[name] ??= []);
      const filters: Array<(r: Row) => boolean> = [];
      let order: { k: string; asc: boolean } | null = null;
      let lim: number | null = null;
      let single: "single" | "maybe" | null = null;
      let op: { kind: "select" } | { kind: "update"; patch: Row } | { kind: "insert"; rows: Row[] } = { kind: "select" };
      const finish = (out: Row[]) => {
        const data = out.map((r) => clone(r));
        if (single === "single") return { data: data[0] ?? null, error: data[0] ? null : { message: "no row" } };
        if (single === "maybe") return { data: data[0] ?? null, error: null };
        return { data, error: null };
      };
      const exec = () => {
        if (op.kind === "insert") {
          const out = op.rows.map((r) => {
            const row = { id: `00000000-0000-4000-8000-${String(++world.seq).padStart(12, "0")}`, created_at: nowIso(), ...inject, ...clone(r) };
            rows.push(row);
            return row;
          });
          return finish(out);
        }
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        if (op.kind === "update") {
          for (const r of hit) Object.assign(r, clone(op.patch));
          return finish(hit);
        }
        let out = [...hit];
        if (order) {
          const { k, asc } = order;
          out.sort((a, b) => String(a[k] ?? "").localeCompare(String(b[k] ?? "")) * (asc ? 1 : -1));
        }
        if (lim != null) out = out.slice(0, lim);
        return finish(out);
      };
      const q: Row = {
        select: () => q,
        eq: (k: string, v: unknown) => (filters.push((r) => field(r, k) === v), q),
        is: (k: string, v: unknown) => (filters.push((r) => (field(r, k) ?? null) === v), q),
        in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(field(r, k))), q),
        or: (spec: string) => {
          const alts = spec.split(",").map((part) => {
            const m = /^(.+)\.eq\.(.+)$/.exec(part);
            if (!m) throw new Error(`fake db: unsupported or clause ${part}`);
            return (r: Row) => field(r, m[1]) === m[2];
          });
          filters.push((r) => alts.some((f) => f(r)));
          return q;
        },
        gte: (k: string, v: string) => (filters.push((r) => String(field(r, k) ?? "") >= v), q),
        lt: (k: string, v: string) => (filters.push((r) => String(field(r, k) ?? "") < v), q),
        not: (k: string, op: string, v: unknown) => (filters.push((r) => !(op === "is" && (field(r, k) ?? null) === v)), q),
        like: (k: string, pat: string) => {
          const re = new RegExp(`^${pat.split("%").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
          filters.push((r) => re.test(String(field(r, k) ?? "")));
          return q;
        },
        contains: (k: string, obj: Row) => (filters.push((r) => Object.entries(obj).every(([kk, vv]) => r[k]?.[kk] === vv)), q),
        order: (k: string, o?: { ascending?: boolean }) => ((order = { k, asc: o?.ascending !== false }), q),
        limit: (n: number) => ((lim = n), q),
        maybeSingle: async () => ((single = "maybe"), exec()),
        single: async () => ((single = "single"), exec()),
        insert: (r: Row | Row[]) => ((op = { kind: "insert", rows: Array.isArray(r) ? r : [r] }), q),
        update: (patch: Row) => ((op = { kind: "update", patch }), q),
        upsert: async (row: Row, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
          if (world.failUpserts[name]) {
            world.failUpserts[name]--;
            return { error: { message: `${name} write failed` } };
          }
          const cols = conflictCols(opts?.onConflict);
          const i = rows.findIndex((x) => cols.every((c) => x[c] === row[c]));
          if (i >= 0) {
            if (!opts?.ignoreDuplicates) Object.assign(rows[i], clone(row));
          } else rows.push({ created_at: nowIso(), updated_at: nowIso(), ...inject, ...clone(row) });
          return { error: null };
        },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(exec()).then(res, rej),
      };
      return q;
    },
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        list: async () => ({ data: [], error: null }),
        remove: async () => ({ data: [], error: null }),
        download: async () => ({ data: new Blob([new Uint8Array([1])]), error: null }),
        createSignedUrl: async (p: string) => ({ data: { signedUrl: `https://storage.test/get/${p}` }, error: null }),
        createSignedUploadUrl: async (p: string) => ({ data: { signedUrl: `https://storage.test/put/${p}` }, error: null }),
      }),
    },
  });
  return { make };
});

const flatPricing = vi.hoisted(() => ({ on: false }));
vi.mock("@/services/billing/flat-pricing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/billing/flat-pricing")>()),
  isFlatJobPricingOn: async () => flatPricing.on,
}));
vi.mock("@/services/supabase", () => ({ serviceClient: () => db.make() }));
vi.mock("@/services/tenant-client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  asTenantId: (t: string) => t,
  tenantClient: (t: string) => db.make({ tenant_id: t }),
}));
vi.mock("@/services/media-router/router", () => routerMocks);
vi.mock("@/services/media-router/charge", () => chargeMocks);
vi.mock("@/services/mcp/higgsfield-meter", () => meterMock);
vi.mock("@/services/launch-video/finish-pass", () => ({ runFinishPass: finishMocks.runFinishPass }));
vi.mock("@/services/settings", () => ({ getBoolSetting: finishMocks.getBoolSetting }));
vi.mock("@/services/agents/_render-launch-video-flag-check", () => ({ isGenerativeVideoEnabled: vi.fn(async () => true) }));
vi.mock("@/services/channels/lock", () => ({ isChannelLockedStrict: vi.fn(async () => false) }));
vi.mock("@/services/growth/preview-plan", () => ({ channelPlanLock: vi.fn(async () => null) }));
vi.mock("@/services/notifications/push-fanout", () => ({ notifyThreadOwner: vi.fn(async () => undefined) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
const alertMock = vi.hoisted(() => ({ alert: vi.fn(async () => undefined) }));
vi.mock("@/services/logging/alert", () => alertMock);
vi.mock("@/services/analytics/mixpanel", () => ({ track: vi.fn() }));
vi.mock("@/services/tools/slack/upload_file", () => ({ uploadFileToThread: vi.fn() }));
vi.mock("@/services/mcp/internal/slack", () => ({ callSlackTool: vi.fn() }));
vi.mock("@/services/chat-images/sign-own-image", () => ({ signOwnImageForVendor: vi.fn(), checkOwnImageForVendor: vi.fn() }));
vi.mock("@/services/video-studio/photo-look", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/video-studio/photo-look")>()),
  lookAtPortraitUrl: vi.fn(async () => null),
}));
vi.mock("@/services/launch-video/platform-higgsfield", () => ({
  submitGeneration: vi.fn(),
  pollGenerationOnce: vi.fn(),
  generatePlatformImage: vi.fn(),
  isPlatformHiggsfieldConfigured: vi.fn(() => true),
}));
vi.mock("../../client", () => ({
  inngest: {
    createFunction: (_cfg: unknown, trigger: { event?: string }, fn: (ctx: unknown) => Promise<unknown>) => {
      if (trigger?.event) captured.handlers.set(trigger.event, fn);
      return { id: trigger?.event ?? "fn" };
    },
    send: vi.fn(),
  },
}));

import { IN_FLIGHT_WINDOW_MS, inFlightCardVideoUsd, inFlightVideoUsd, notifyGenerateVideoFailure, STUDIO_IN_FLIGHT_WINDOW_MS } from "../generate-video";
import { CHARGE_SETTLE_ABANDON_MS, CHARGE_SETTLE_GRACE_MS, runVideoChargeSettleSlot, settleUnchargedVideos } from "../video-charge-settle";
import { costToCredits } from "@/services/agents/credits";
import { routedVideoPlan } from "@/services/launch-video/video-estimate";
import { GENERATED_VIDEO_RENDER_CLASS } from "@/services/channels/generated-video-render";
import type { GenerativeVideoIntake } from "@/services/launch-video/generative-video-intake";
import { supabaseStudioStore } from "@/services/video-studio/store";
import { buildStudioView, RENDER_QUEUE_MAX_MS, RENDER_STALL_MS, REQUEUED_KIND, retryStudioRender, sendStudioMessage, type StudioDeps } from "@/services/video-studio/studio";
import { CHANNEL_VIDEO_MAX_POLLS, FINISH_BUDGET_MS, MEDIA_LEG_MAX_POLLS, MEDIA_LEG_POLL_DELAY_MS, VIDEO_POLL_DELAY_MS } from "@/services/launch-video/render-budget";
import { logEvent } from "@/services/logging/logEvent";
import { signOwnImageForVendor } from "@/services/chat-images/sign-own-image";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const DRAFT_REPLY = JSON.stringify({
  reply: "Making a 9:16 presenter video.",
  intent: "talking_head",
  aspect_ratio: "9:16",
  visual: "A woman in her late 20s in a bright bathroom.",
  script: "Meet the serum that layers under makeup without pilling, so your skin looks calm by noon and stays that way all day long.",
  hook: "Meet the serum.",
  presenter_gender: "female",
  image_path: null,
});

type Evt = { id: string; name: string; data: Record<string, unknown> };
const step = { run: (_n: string, fn: () => unknown) => Promise.resolve(fn()) };
const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };

function studio(nowOffsetMs: () => number = () => 0) {
  const events: Evt[] = [];
  const deps: StudioDeps = {
    store: supabaseStudioStore(TENANT),
    draft: { complete: async () => DRAFT_REPLY },
    business: async () => null,
    videoEnabled: async () => true,
    routerEnabled: async () => true,
    tier: async () => ({ allowed: true, required_tier: "starter" }),
    send: async (e) => {
      events.push(e);
      return { ids: [e.id] };
    },
    channelLocked: async () => false,
    now: () => Date.now() + nowOffsetMs(),
  };
  return { deps, events };
}

function startWorker(evt: Evt): { promise: Promise<unknown>; settled: () => boolean } {
  const handler = captured.handlers.get("video.generate.requested")!;
  let done = false;
  const promise = handler({ event: { data: evt.data }, step, logger }).finally(() => {
    done = true;
  });
  return { promise, settled: () => done };
}

async function advanceUntil(cond: () => boolean, stepMs = 5_000, max = 20_000) {
  for (let i = 0; i < max && !cond(); i++) await vi.advanceTimersByTimeAsync(stepMs);
}

async function runWorker(evt: Evt) {
  const w = startWorker(evt);
  await advanceUntil(w.settled);
  return w.promise;
}

const rows = (t: string) => world.tables[t] ?? [];
const paidFalVideoJobs = () => new Set(fal.submits);
const flushedKeys = () => chargeMocks.flushCharges.mock.calls.flatMap((c) => (c[0] as Array<{ key: string }>).map((x) => x.key));
const videoArtifacts = () => rows("run_artifacts").filter((r) => String(r.mime).startsWith("video/"));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-19T10:00:00Z"));
  world.tables = {};
  world.seq = 0;
  world.failUpserts = {};
  fal.jobs.clear();
  fal.submits.length = 0;
  fal.cancelHonoured = false;
  fal.legDelayMs = 0;
  fal.finishDelayMs = 0;
  fal.legSeq = 0;
  chargeMocks.flushCharges.mockReset();
  chargeMocks.flushCharges.mockImplementation(async (_charges: Array<{ key: string }>) => undefined);
  routerMocks.generateMedia.mockReset();
  routerMocks.generateMedia.mockImplementation(async (task: string, _req: unknown, opts?: { resume?: unknown; onSubmitted?: (j: unknown) => Promise<void> }) => {
    const model = task === "image.photo" ? "seedream" : "eleven-v3";
    const job = { vendor: "fal", model, id: `leg-${++fal.legSeq}`, status_url: "https://queue.fal.run/l/status", response_url: "https://queue.fal.run/l" };
    if (!opts?.resume) await opts?.onSubmitted?.(job);
    if (fal.legDelayMs) await new Promise((r) => setTimeout(r, fal.legDelayMs));
    return task === "image.photo"
      ? { ok: true, url: "https://cdn.fal/p.png", vendor: "fal", model, cost_usd: 0.07 }
      : { ok: true, url: "https://cdn.fal/v.mp3", vendor: "fal", model, cost_usd: 0.02 };
  });
  routerMocks.submitMedia.mockReset();
  routerMocks.submitMedia.mockImplementation(async () => {
    const id = `vid-${fal.submits.length + 1}`;
    fal.submits.push(id);
    fal.jobs.set(id, "pending");
    return { ok: true, job: { vendor: "fal", model: "bytedance/seedance", id, status_url: `https://queue.fal.run/${id}/status`, response_url: `https://queue.fal.run/${id}` } };
  });
  routerMocks.pollMediaOnce.mockReset();
  routerMocks.pollMediaOnce.mockImplementation(async (job: { id: string }) => {
    const s = fal.jobs.get(job.id);
    if (s === "done") return { state: "done", url: `https://cdn.fal/${job.id}.mp4`, duration_s: 9 };
    if (s === "failed") return { state: "failed", reason: "vendor_error", error: "fal status CANCELLED" };
    return { state: "pending" };
  });
  routerMocks.cancelMedia.mockReset();
  routerMocks.cancelMedia.mockImplementation(async (job: { id: string }) => {
    if (fal.cancelHonoured) fal.jobs.set(job.id, "failed");
    return "requested";
  });
  routerMocks.costForJob.mockImplementation((job: { model: string }, _r: unknown, done: { duration_s?: number }) =>
    job.model === "seedream" ? 0.07 : job.model === "eleven-v3" ? 0.02 : (done.duration_s ?? 0) * 0.5,
  );
  finishMocks.getBoolSetting.mockResolvedValue(false);
  finishMocks.runFinishPass.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

async function firstRender(s: ReturnType<typeof studio>) {
  const out = await sendStudioMessage(s.deps, { tenant_id: TENANT, user_id: USER, text: "ugc ad for our serum" });
  const runA = (out.render as { run_id: string }).run_id;
  return { out, runA, evtA: s.events[0] };
}

describe("Try again clicks that lose the race leave no run rows behind", () => {
  it("three racing Try again clicks on one failed video write one new agent_runs row, the one the rendering message and the worker use", async () => {
    const s = studio();
    const { out, runA, evtA } = await firstRender(s);
    await runWorker(evtA);

    const results = await Promise.allSettled([1, 2, 3].map(() => retryStudioRender(s.deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id, thread_id: out.thread_id })));
    const won = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    expect(won).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.status)).toEqual([409, 409]);

    const runs = rows("agent_runs").filter((r) => r.agent_slug === "generated_video");
    expect(runs.map((r) => r.id).sort()).toEqual([runA, won[0].run_id].sort());
    expect(runs.find((r) => r.id === won[0].run_id)).toMatchObject({ tenant_id: TENANT, enqueued_by: USER, payload: { retry_of: runA, draft_message_id: out.reply.id } });
    const rendering = rows("agent_thread_messages").filter((m) => m.meta?.kind === "video_studio_rendering").map((m) => m.agent_run_id);
    expect(rendering.sort()).toEqual(runs.map((r) => r.id).sort());
    expect(rows("agent_thread_messages").find((m) => m.id === out.reply.id)?.meta.render_run_id).toBe(won[0].run_id);
    expect(s.events.map((e) => e.data.run_id)).toEqual([runA, won[0].run_id]);
  });
});

describe("Try again after a timed-out chat render never pays fal twice", () => {
  it("a fal job still running when the worker gave up is collected by Try again: one fal video job, one charge, the presenter legs not re-bought", async () => {
    const s = studio();
    const { out, runA, evtA } = await firstRender(s);

    const a = await runWorker(evtA);
    expect(a).toMatchObject({ skipped: "video_failed" });
    expect(paidFalVideoJobs()).toEqual(new Set(["vid-1"]));
    expect(routerMocks.cancelMedia).toHaveBeenCalledTimes(1);
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
    const failure = rows("agent_thread_messages").find((m) => m.meta?.source_run_id === runA && m.meta?.kind === "generative_video_failed");
    expect(failure?.body).toMatch(/took too long/);
    expect(failure?.meta).not.toHaveProperty("code");
    const failedThread = rows("agent_thread_messages").filter((m) => m.thread_id === out.thread_id) as never[];
    expect(buildStudioView(out.thread_id, failedThread, []).renders[runA]).toMatchObject({ status: "failed", code: null });

    fal.jobs.set("vid-1", "done");

    const retry = await retryStudioRender(s.deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id, thread_id: out.thread_id });
    const b = await runWorker(s.events[1]);

    expect(routerMocks.submitMedia).toHaveBeenCalledTimes(1);
    expect(paidFalVideoJobs()).toEqual(new Set(["vid-1"]));
    expect(routerMocks.generateMedia).toHaveBeenCalledTimes(2);
    expect(b).toMatchObject({ ok: true });
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
    expect(flushedKeys()).toEqual([`${retry.run_id}:gen-image:0`, `${retry.run_id}:gen-vo:0`, `${retry.run_id}:gen-video:0`]);
    expect(videoArtifacts().map((r) => r.run_id)).toEqual([retry.run_id]);
    expect(rows("agent_runs").find((r) => r.id === retry.run_id)?.payload).toMatchObject({ retry_of: runA, draft_message_id: out.reply.id });
  });

  it("a fal job that is still rendering when Try again lands is waited for, not bought again", async () => {
    const s = studio();
    const { out, evtA } = await firstRender(s);
    await runWorker(evtA);

    await retryStudioRender(s.deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id, thread_id: out.thread_id });
    let polls = 0;
    const base = routerMocks.pollMediaOnce.getMockImplementation()!;
    routerMocks.pollMediaOnce.mockImplementation(async (job: { id: string }) => {
      if (++polls === 30) fal.jobs.set("vid-1", "done");
      return base(job);
    });
    const b = await runWorker(s.events[1]);

    expect(paidFalVideoJobs()).toEqual(new Set(["vid-1"]));
    expect(b).toMatchObject({ ok: true });
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
  });

  it("a second Try again after the adopted job timed out again still collects the first fal job", async () => {
    const s = studio();
    const { out, evtA } = await firstRender(s);
    await runWorker(evtA);
    const r1 = await retryStudioRender(s.deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id, thread_id: out.thread_id });
    await runWorker(s.events[1]);
    expect(rows("agent_thread_messages").some((m) => m.meta?.source_run_id === r1.run_id && m.meta?.kind === "generative_video_failed")).toBe(true);

    fal.jobs.set("vid-1", "done");
    await retryStudioRender(s.deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id, thread_id: out.thread_id });
    const c = await runWorker(s.events[2]);

    expect(paidFalVideoJobs()).toEqual(new Set(["vid-1"]));
    expect(c).toMatchObject({ ok: true });
    expect(routerMocks.generateMedia).toHaveBeenCalledTimes(2);
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
  });

  it("when fal confirms the old job is cancelled, Try again buys exactly one new job and marks the old one failed", async () => {
    fal.cancelHonoured = true;
    const s = studio();
    const { out, runA, evtA } = await firstRender(s);
    await runWorker(evtA);
    await retryStudioRender(s.deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id, thread_id: out.thread_id });
    fal.cancelHonoured = false;
    routerMocks.pollMediaOnce.mockImplementation(async (job: { id: string }) =>
      job.id === "vid-1" ? { state: "failed", reason: "vendor_error", error: "fal status CANCELLED" } : { state: "done", url: `https://cdn.fal/${job.id}.mp4`, duration_s: 9 },
    );
    const b = await runWorker(s.events[1]);

    expect(b).toMatchObject({ ok: true });
    expect(paidFalVideoJobs()).toEqual(new Set(["vid-1", "vid-2"]));
    expect(rows("generative_video_jobs").find((r) => r.meter_key === `${runA}:gen-video:0`)?.status).toBe("failed");
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
  });
});

describe("a slow render is never called stalled while the worker can still deliver it", () => {
  it("the stall line sits past the worker's slowest legal render: both presenter legs, every poll and the whole finish pass", async () => {
    fal.legDelayMs = MEDIA_LEG_MAX_POLLS * MEDIA_LEG_POLL_DELAY_MS;
    finishMocks.getBoolSetting.mockResolvedValue(true);
    finishMocks.runFinishPass.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, FINISH_BUDGET_MS));
      return { ok: false, reason: "timeout" };
    });
    let polls = 0;
    routerMocks.pollMediaOnce.mockImplementation(async (job: { id: string }) =>
      ++polls < CHANNEL_VIDEO_MAX_POLLS ? { state: "pending" } : { state: "done", url: `https://cdn.fal/${job.id}.mp4`, duration_s: 9 },
    );
    let deliveredAt = 0;
    const artifactsBefore = () => videoArtifacts().length;
    const s = studio();
    const { out, runA, evtA } = await firstRender(s);
    const startedAt = Date.now();
    const w = startWorker(evtA);
    await advanceUntil(() => {
      if (!deliveredAt && artifactsBefore() > 0) deliveredAt = Date.now();
      return w.settled();
    });
    expect(await w.promise).toMatchObject({ ok: true });
    expect(polls).toBe(CHANNEL_VIDEO_MAX_POLLS);
    expect(deliveredAt - startedAt).toBeGreaterThanOrEqual((CHANNEL_VIDEO_MAX_POLLS - 1) * VIDEO_POLL_DELAY_MS + 2 * MEDIA_LEG_MAX_POLLS * MEDIA_LEG_POLL_DELAY_MS + FINISH_BUDGET_MS);

    const thread = rows("agent_thread_messages").filter((m) => m.thread_id === out.thread_id) as never[];
    expect(buildStudioView(out.thread_id, thread, [], deliveredAt).renders[runA].status).toBe("rendering");
    expect(RENDER_STALL_MS).toBeGreaterThan(deliveredAt - startedAt);
  });
});

describe("a render past the worker's maximum with no video and no failure can be retried without paying twice", () => {
  it("a lost run that starts after Try again spends nothing: one fal job, one set of presenter legs, one charge", async () => {
    const s = studio(() => RENDER_QUEUE_MAX_MS + 1_000);
    const { out, evtA } = await firstRender(s);

    const retry = await retryStudioRender(s.deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id, thread_id: out.thread_id });
    fal.jobs.set("vid-1", "done");
    routerMocks.pollMediaOnce.mockImplementation(async (job: { id: string }) => ({ state: "done", url: `https://cdn.fal/${job.id}.mp4`, duration_s: 9 }));
    const b = await runWorker(s.events[1]);
    expect(b).toMatchObject({ ok: true });

    const a = await runWorker(evtA);
    expect(routerMocks.submitMedia).toHaveBeenCalledTimes(1);
    expect(routerMocks.generateMedia).toHaveBeenCalledTimes(2);
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ skipped: "lease_lost" });
    expect(flushedKeys().every((k) => k.startsWith(retry.run_id))).toBe(true);
    expect(videoArtifacts().map((r) => r.run_id)).toEqual([retry.run_id]);
  });

  it("a run still polling fal when Try again lands hands its job to the new attempt and neither delivers nor charges it", async () => {
    let offset = 0;
    const s = studio(() => offset);
    const { out, runA, evtA } = await firstRender(s);
    const a = startWorker(evtA);
    await advanceUntil(() => routerMocks.pollMediaOnce.mock.calls.length >= 5);
    expect(paidFalVideoJobs()).toEqual(new Set(["vid-1"]));

    offset = RENDER_STALL_MS + 1_000;
    const retry = await retryStudioRender(s.deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id, thread_id: out.thread_id });
    const b = startWorker(s.events[1]);
    await vi.advanceTimersByTimeAsync(20_000);
    fal.jobs.set("vid-1", "done");
    await advanceUntil(() => a.settled() && b.settled());

    const [ra, rb] = [await a.promise, await b.promise];
    expect(routerMocks.submitMedia).toHaveBeenCalledTimes(1);
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
    expect(routerMocks.cancelMedia).not.toHaveBeenCalled();
    expect(ra).toMatchObject({ skipped: "lease_lost" });
    expect(rb).toMatchObject({ ok: true });
    expect(flushedKeys().every((k) => k.startsWith(retry.run_id))).toBe(true);
    expect(videoArtifacts().map((r) => r.run_id)).toEqual([retry.run_id]);
    expect(rows("agent_thread_messages").some((m) => m.meta?.source_run_id === runA)).toBe(false);
  });
});

function inngestRetries(evt: Evt) {
  const memo = new Map<string, unknown>();
  const memoStep = {
    run: async (n: string, fn: () => unknown) => {
      if (memo.has(n)) return memo.get(n);
      const v = await fn();
      memo.set(n, v);
      return v;
    },
  };
  const handler = captured.handlers.get("video.generate.requested")!;
  return async (): Promise<{ ok: true; value: unknown } | { ok: false; error: Error }> => {
    let done = false;
    const p = handler({ event: { data: evt.data }, step: memoStep, logger })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: Error) => ({ ok: false as const, error }),
      )
      .finally(() => {
        done = true;
      });
    await advanceUntil(() => done);
    return p;
  };
}

const finishedAtOnce = () =>
  routerMocks.pollMediaOnce.mockImplementation(async (job: { id: string }) => ({ state: "done", url: `https://cdn.fal/${job.id}.mp4`, duration_s: 9 }));
const deliveryPosts = (run_id: string) => rows("agent_thread_messages").filter((m) => m.meta?.source_run_id === run_id && m.meta?.kind === "generative_video");

describe("a studio chat render is charged once, and only after the video is in the chat", () => {
  it("the charge flushes after the video row and the chat post exist, exactly once, for this run's own legs", async () => {
    finishedAtOnce();
    const seenAtFlush: Array<{ artifacts: number; posts: number }> = [];
    const s = studio();
    const { runA, evtA } = await firstRender(s);
    chargeMocks.flushCharges.mockImplementation(async () => {
      seenAtFlush.push({ artifacts: videoArtifacts().filter((r) => r.run_id === runA).length, posts: deliveryPosts(runA).length });
    });

    expect(await runWorker(evtA)).toMatchObject({ ok: true });
    expect(seenAtFlush).toEqual([{ artifacts: 1, posts: 1 }]);
    expect(flushedKeys()).toEqual([`${runA}:gen-image:0`, `${runA}:gen-vo:0`, `${runA}:gen-video:0`]);
  });

  it("a chat delivery that fails charges nothing; Inngest's retry delivers it and charges once, without paying fal again", async () => {
    finishedAtOnce();
    world.failUpserts.run_artifacts = 1;
    const s = studio();
    const { runA, evtA } = await firstRender(s);
    const attempt = inngestRetries(evtA);

    const first = await attempt();
    expect(first.ok).toBe(false);
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
    expect(videoArtifacts()).toHaveLength(0);

    const second = await attempt();
    expect(second).toMatchObject({ ok: true, value: { ok: true } });
    expect(routerMocks.submitMedia).toHaveBeenCalledTimes(1);
    expect(routerMocks.generateMedia).toHaveBeenCalledTimes(2);
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
    expect(flushedKeys()).toEqual([`${runA}:gen-image:0`, `${runA}:gen-vo:0`, `${runA}:gen-video:0`]);
    expect(videoArtifacts().map((r) => r.run_id)).toEqual([runA]);
    expect(deliveryPosts(runA)).toHaveLength(1);
  });

  it("a charge that errors after delivery is retried with the same keys and never re-delivers the video", async () => {
    finishedAtOnce();
    const s = studio();
    const { runA, evtA } = await firstRender(s);
    chargeMocks.flushCharges.mockRejectedValueOnce(new Error("charge_media_credits_batch timed out"));
    const attempt = inngestRetries(evtA);

    expect((await attempt()).ok).toBe(false);
    expect(await attempt()).toMatchObject({ ok: true });
    const [a, b] = chargeMocks.flushCharges.mock.calls.map((c) => (c[0] as Array<{ key: string }>).map((x) => x.key));
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(2);
    expect(b).toEqual(a);
    expect(routerMocks.submitMedia).toHaveBeenCalledTimes(1);
    expect(deliveryPosts(runA)).toHaveLength(1);
    expect(videoArtifacts()).toHaveLength(1);
  });

  it("a Try again that lands while the old run is delivering: the old run's video is charged once, the new run neither delivers nor charges", async () => {
    finishedAtOnce();
    let offset = 0;
    const s = studio(() => offset);
    const { out, runA, evtA } = await firstRender(s);
    const { notifyThreadOwner } = await import("@/services/notifications/push-fanout");
    let retryRun: string | null = null;
    vi.mocked(notifyThreadOwner).mockImplementationOnce(async () => {
      videoArtifacts().forEach((r) => (r.mime = "pending/x"));
      offset = RENDER_STALL_MS + 1_000;
      retryRun = (await retryStudioRender(s.deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id, thread_id: out.thread_id })).run_id;
      rows("run_artifacts").forEach((r) => (r.mime = "video/mp4"));
      return undefined as never;
    });

    expect(await runWorker(evtA)).toMatchObject({ ok: true });
    expect(retryRun).toBeTruthy();
    expect(await runWorker(s.events[1])).toMatchObject({ skipped: "already_delivered" });
    expect(flushedKeys().every((k) => k.startsWith(runA))).toBe(true);
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
    expect(videoArtifacts().map((r) => r.run_id)).toEqual([runA]);
    expect(rows("generative_video_jobs").find((r) => r.meter_key === `${retryRun}:gen-video:0`)?.pending_charges ?? null).toBeNull();
    expect(rows("agent_thread_messages").find((m) => m.id === out.reply.id)?.meta.render_run_id).toBe(runA);
    offset = 2 * RENDER_STALL_MS;
    await expect(retryStudioRender(s.deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id, thread_id: out.thread_id })).rejects.toMatchObject({ status: 409 });
  });
});

describe("the finish pass on a 9:16 studio presenter video", () => {
  it("runs on the chat path with the draft's hook, and the edited file is what the chat gets, at the same price", async () => {
    finishedAtOnce();
    finishMocks.getBoolSetting.mockResolvedValue(true);
    finishMocks.runFinishPass.mockResolvedValue({ ok: true, bytes: 999, duration_s: 9 });
    const s = studio();
    const { runA, evtA } = await firstRender(s);

    expect(await runWorker(evtA)).toMatchObject({ ok: true });
    expect(finishMocks.getBoolSetting).toHaveBeenCalledWith("ugc_video_finish_pass_enabled", TENANT);
    expect(finishMocks.runFinishPass).toHaveBeenCalledTimes(1);
    expect(finishMocks.runFinishPass.mock.calls[0][0]).toMatchObject({ tenant_id: TENANT, hook: "Meet the serum.", videoSeconds: 9 });
    const [art] = videoArtifacts();
    expect(art).toMatchObject({ run_id: runA, bytes: 999 });
    expect(String(art.storage_path)).toContain(`/${runA}/edited-talking_head-`);
    expect(flushedKeys()).toEqual([`${runA}:gen-image:0`, `${runA}:gen-vo:0`, `${runA}:gen-video:0`]);
  });

  it("a finish pass that fails still delivers the raw video, charges it once, logs the skip, and the chat shows it as done", async () => {
    finishedAtOnce();
    finishMocks.getBoolSetting.mockResolvedValue(true);
    finishMocks.runFinishPass.mockResolvedValue({ ok: false, reason: "encode", detail: "ffmpeg exited 1" });
    const s = studio();
    const { out, runA, evtA } = await firstRender(s);

    expect(await runWorker(evtA)).toMatchObject({ ok: true });
    const [art] = videoArtifacts();
    expect(String(art.storage_path)).not.toContain("edited-");
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logEvent)).toHaveBeenCalledWith(expect.objectContaining({ code: "video_finish_pass_skipped", run_id: runA, meta: { failure_class: "encode" } }));
    const thread = rows("agent_thread_messages").filter((m) => m.thread_id === out.thread_id) as never[];
    const arts = videoArtifacts().map((r) => ({ id: r.id, run_id: r.run_id, filename: r.filename })) as never[];
    expect(buildStudioView(out.thread_id, thread, arts).renders[runA].status).toBe("done");
  });
});

describe("an attached photo reaches the right render, end to end", () => {
  const PHOTO = `${TENANT}/woman.jpg`;
  const SIGNED = "https://storage.test/signed/woman.jpg";

  it("a photo of a person becomes the presenter: no AI portrait is bought, the signed photo goes to the avatar model, voice and video are charged", async () => {
    finishedAtOnce();
    vi.mocked(signOwnImageForVendor).mockResolvedValue(SIGNED);
    const s = studio();
    s.deps.lookAtPhoto = async () => ({ has_person: true, gender: "female" });
    const out = await sendStudioMessage(s.deps, { tenant_id: TENANT, user_id: USER, text: "a presenter video about our serum", image_path: PHOTO });
    const run = (out.render as { run_id: string }).run_id;

    expect(await runWorker(s.events[0])).toMatchObject({ ok: true });
    expect(routerMocks.generateMedia.mock.calls.map((c) => c[0])).toEqual(["audio.voiceover"]);
    expect(vi.mocked(signOwnImageForVendor)).toHaveBeenCalledWith(TENANT, PHOTO, expect.any(Number));
    const [task, req] = routerMocks.submitMedia.mock.calls[0] as [string, Record<string, unknown>];
    expect(task).toMatch(/^video\.talking_head/);
    expect(req).toMatchObject({ image_url: SIGNED });
    expect(flushedKeys()).toEqual([`${run}:gen-vo:0`, `${run}:gen-video:0`]);
  });

  it("a photo with no person is animated from that photo: no portrait, no voice, one charge for the video", async () => {
    finishedAtOnce();
    vi.mocked(signOwnImageForVendor).mockResolvedValue(SIGNED);
    const s = studio();
    s.deps.lookAtPhoto = async () => ({ has_person: false, gender: null });
    const out = await sendStudioMessage(s.deps, { tenant_id: TENANT, user_id: USER, text: "slow push in on the jar", image_path: PHOTO });
    const run = (out.render as { run_id: string }).run_id;

    expect(await runWorker(s.events[0])).toMatchObject({ ok: true });
    expect(routerMocks.generateMedia).not.toHaveBeenCalled();
    const [task, req] = routerMocks.submitMedia.mock.calls[0] as [string, Record<string, unknown>];
    expect(task).toBe("video.animate");
    expect(req).toMatchObject({ image_url: SIGNED });
    expect(flushedKeys()).toEqual([`${run}:gen-video:0`]);
  });
});

type ChargeItem = { tenant_id: string; key: string; cost_usd: number };
type Wallet = { credits: number; failCharges: boolean; chargeAttempts: number };

function useWallet(credits: number): Wallet {
  const w: Wallet = { credits, failCharges: false, chargeAttempts: 0 };
  (chargeMocks.checkAffordMedia as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (_t: string, usd: number) =>
    w.credits >= costToCredits(usd) ? "ok" : "short",
  );
  (chargeMocks.flushCharges as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (items: ChargeItem[]) => {
    w.chargeAttempts++;
    if (w.failCharges) throw new Error(`media charge failed for ${items.length} of ${items.length} item(s); retry`);
    const ledger = (world.tables.tenant_credit_ledger ??= []);
    for (const it of items) {
      if (!(it.cost_usd > 0) || ledger.some((r) => r.media_key === it.key)) continue;
      ledger.push({ tenant_id: it.tenant_id, kind: "media", media_key: it.key });
      w.credits -= costToCredits(it.cost_usd);
    }
  });
  return w;
}

function restoreWallet() {
  (chargeMocks.checkAffordMedia as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => "ok");
  (chargeMocks.flushCharges as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => undefined);
  alertMock.alert.mockClear();
}

const ledgerKeys = () => rows("tenant_credit_ledger").map((r) => r.media_key as string).sort();
const estimateOf = (evt: Evt) => routedVideoPlan(evt.data.intake as GenerativeVideoIntake).estimateUsd;
const CARD = "aaaaaaaa-0000-4000-8000-000000000001";
const CLAIM = "cccccccc-0000-4000-8000-000000000003";
const cardTarget = { kind: "channel_action" as const, action_id: CARD, claim_id: CLAIM };

function seedCard(intake: unknown, approvedAt: number) {
  (world.tables.channel_actions ??= []).push({
    id: CARD,
    tenant_id: TENANT,
    exec_class: GENERATED_VIDEO_RENDER_CLASS,
    exec_status: "dispatching",
    exec_claim_id: CLAIM,
    exec_payload: { intake },
    executed_at: null,
  });
  (world.tables.channel_action_events ??= []).push({ tenant_id: TENANT, action_id: CARD, event: "approved", at: new Date(approvedAt).toISOString() });
}

const allJobsDone = () => {
  for (const id of fal.jobs.keys()) fal.jobs.set(id, "done");
};
const pollDoneAtOnce = () =>
  routerMocks.pollMediaOnce.mockImplementation(async (job: { id: string }) => ({ state: "done", url: `https://cdn.fal/${job.id}.mp4`, duration_s: 9 }));

describe("renders racing for one tenant's wallet", () => {
  afterEach(restoreWallet);

  it("two chat tabs with a balance for one: exactly one render is bought and charged, the other is refused before any paid call", async () => {
    const s = studio();
    const a = await sendStudioMessage(s.deps, { tenant_id: TENANT, user_id: USER, text: "ugc ad for our serum", new_thread: true });
    vi.advanceTimersByTime(1_000);
    const b = await sendStudioMessage(s.deps, { tenant_id: TENANT, user_id: USER, text: "ugc ad for our serum", new_thread: true });
    const runA = (a.render as { run_id: string }).run_id;
    const runB = (b.render as { run_id: string }).run_id;
    const w = useWallet(costToCredits(estimateOf(s.events[0])));

    const wa = startWorker(s.events[0]);
    const wb = startWorker(s.events[1]);
    await vi.advanceTimersByTimeAsync(20_000);
    allJobsDone();
    await advanceUntil(() => wa.settled() && wb.settled());

    expect(await wa.promise).toMatchObject({ ok: true });
    expect(await wb.promise).toMatchObject({ skipped: "insufficient_credits" });
    expect(routerMocks.submitMedia).toHaveBeenCalledTimes(1);
    expect(routerMocks.generateMedia).toHaveBeenCalledTimes(2);
    expect(w.chargeAttempts).toBe(1);
    expect(ledgerKeys()).toHaveLength(3);
    expect(videoArtifacts().map((r) => r.run_id)).toEqual([runA]);
    expect(ledgerKeys().every((k) => k.startsWith(`${runA}:`))).toBe(true);
    const refusal = rows("agent_thread_messages").find((m) => m.meta?.source_run_id === runB && m.meta?.kind === "generative_video_failed");
    expect(refusal?.body).toMatch(/credits/);
    expect(refusal?.meta?.code).toBe("insufficient_credits");
    const threadB = rows("agent_thread_messages").filter((m) => m.thread_id === b.thread_id) as never[];
    expect(buildStudioView(b.thread_id, threadB, []).renders[runB]).toMatchObject({ status: "failed", code: "insufficient_credits" });
    const threadA = rows("agent_thread_messages").filter((m) => m.thread_id === a.thread_id) as never[];
    const artsA = videoArtifacts().map((r) => ({ id: r.id, run_id: r.run_id, filename: r.filename })) as never[];
    expect(buildStudioView(a.thread_id, threadA, artsA).renders[runA].code).toBeUndefined();
  });

  it("a card approved before a chat render holds its estimate: the chat render is refused and buys nothing", async () => {
    const s = studio();
    const { evtA } = await firstRender(s);
    seedCard(evtA.data.intake, Date.now() - 60_000);
    useWallet(costToCredits(estimateOf(evtA)));

    expect(await runWorker(evtA)).toMatchObject({ skipped: "insufficient_credits" });
    expect(routerMocks.submitMedia).not.toHaveBeenCalled();
    expect(routerMocks.generateMedia).not.toHaveBeenCalled();
  });

  it("a chat render started before a card is counted against the card; one started after it is not", async () => {
    const s = studio();
    const { evtA } = await firstRender(s);

    seedCard(evtA.data.intake, Date.now() + 60_000);
    expect(await inFlightCardVideoUsd(db.make() as never, TENANT, cardTarget)).toBeCloseTo(estimateOf(evtA), 6);

    world.tables.channel_action_events = [{ tenant_id: TENANT, action_id: CARD, event: "approved", at: new Date(Date.now() - 60_000).toISOString() }];
    expect(await inFlightCardVideoUsd(db.make() as never, TENANT, cardTarget)).toBe(0);
  });

  it("a chat render that was charged, or that ended without a video, holds nothing", async () => {
    const s = studio();
    const { runA, evtA } = await firstRender(s);
    seedCard(evtA.data.intake, Date.now() + 60_000);
    expect(await inFlightCardVideoUsd(db.make() as never, TENANT, cardTarget)).toBeGreaterThan(0);

    world.tables.tenant_credit_ledger = [{ tenant_id: TENANT, kind: "media", media_key: `${runA}:gen-video:0` }];
    expect(await inFlightCardVideoUsd(db.make() as never, TENANT, cardTarget)).toBe(0);

    world.tables.tenant_credit_ledger = [];
    world.tables.agent_thread_messages.push({ tenant_id: TENANT, thread_id: "t", body: "Sorry", meta: { source_run_id: runA, kind: "generative_video_failed" } });
    expect(await inFlightCardVideoUsd(db.make() as never, TENANT, cardTarget)).toBe(0);
  });
});

describe("a chat or Slack video asked for outside the studio holds its cost against a card", () => {
  it("is counted while it is being made and ahead of the card, and not once it is charged, done, or asked after the card", async () => {
    const intakeOf = { prompt: "a founder explaining Zavi", intent: "talking_head", premium: false, script: "Hi, I'm Sam and this is Zavi." };
    seedCard(intakeOf, Date.now() - 60_000);
    const hold = {
      tenant_id: TENANT,
      run_id: "dddddddd-0000-4000-8000-000000000009",
      meter_key: "dddddddd-0000-4000-8000-000000000009:video-hold",
      model: "video-hold",
      job_id: JSON.stringify({ usd: 2.29 }),
      status: "pending",
      created_at: new Date(Date.now() - 120_000).toISOString(),
    };
    (world.tables.generative_video_jobs ??= []).push(hold);
    expect(await inFlightCardVideoUsd(db.make() as never, TENANT, cardTarget)).toBeCloseTo(2.29, 9);

    world.tables.tenant_credit_ledger = [{ tenant_id: TENANT, kind: "media", media_key: `${hold.run_id}:gen-video:0` }];
    expect(await inFlightCardVideoUsd(db.make() as never, TENANT, cardTarget)).toBe(0);
    world.tables.tenant_credit_ledger = [];

    hold.status = "completed";
    expect(await inFlightCardVideoUsd(db.make() as never, TENANT, cardTarget)).toBe(0);
    hold.status = "pending";

    hold.created_at = new Date(Date.now()).toISOString();
    expect(await inFlightCardVideoUsd(db.make() as never, TENANT, cardTarget)).toBe(0);
  });
});

describe("a delivered chat video whose charge keeps failing", () => {
  afterEach(restoreWallet);

  const pendingRow = (run: string) => rows("generative_video_jobs").find((r) => r.meter_key === `${run}:gen-video:0`);
  const onFailure = (run: string, evt: Evt) => notifyGenerateVideoFailure({ run_id: run, delivery_target: evt.data.delivery_target as never }, db.make() as never);

  it("is recorded before delivery, pages ops, and is charged exactly once by the settle sweep after every retry failed", async () => {
    const w = useWallet(1_000_000);
    w.failCharges = true;
    pollDoneAtOnce();
    const s = studio();
    const { runA, evtA } = await firstRender(s);

    const run = startWorker(evtA);
    const outcome = run.promise.then(
      () => null,
      (e: Error) => e,
    );
    await advanceUntil(run.settled);
    expect((await outcome)?.message).toMatch(/media charge failed/);
    expect(videoArtifacts().map((r) => r.run_id)).toEqual([runA]);
    const recorded = pendingRow(runA)?.pending_charges as Array<{ key: string; delivery: string }>;
    expect(recorded.map((c) => c.key).sort()).toEqual([`${runA}:gen-image:0`, `${runA}:gen-video:0`, `${runA}:gen-vo:0`]);
    expect(recorded.every((c) => c.delivery === "chat")).toBe(true);

    await expect(onFailure(runA, evtA)).rejects.toThrow(/media charge failed/);
    expect(alertMock.alert).toHaveBeenCalledWith(expect.objectContaining({ code: "video_charge_unsettled", tenant_id: TENANT }));
    expect(ledgerKeys()).toEqual([]);
    expect(rows("agent_thread_messages").some((m) => m.meta?.source_run_id === runA && m.meta?.kind === "generative_video_failed")).toBe(false);

    expect((await settleUnchargedVideos(db.make() as never, Date.now())).checked).toBe(0);

    vi.setSystemTime(Date.now() + CHARGE_SETTLE_GRACE_MS + 60_000);
    expect(await settleUnchargedVideos(db.make() as never, Date.now())).toMatchObject({ checked: 1, failed: 1, settled: 0 });
    expect(ledgerKeys()).toEqual([]);
    expect(pendingRow(runA)?.pending_charges).toBeTruthy();

    const before = w.credits;
    w.failCharges = false;
    expect(await settleUnchargedVideos(db.make() as never, Date.now())).toMatchObject({ checked: 1, settled: 1 });
    expect(ledgerKeys()).toEqual([`${runA}:gen-image:0`, `${runA}:gen-video:0`, `${runA}:gen-vo:0`]);
    expect(before - w.credits).toBe(costToCredits(0.07) + costToCredits(0.02) + costToCredits(4.5));
    expect(pendingRow(runA)?.pending_charges).toBeNull();

    const attempts = w.chargeAttempts;
    expect((await settleUnchargedVideos(db.make() as never, Date.now())).checked).toBe(0);
    await onFailure(runA, evtA);
    expect(w.chargeAttempts).toBe(attempts);
    expect(ledgerKeys()).toHaveLength(3);
  });

  it("a charge that lands on the first try leaves nothing for the sweep to charge again", async () => {
    const w = useWallet(1_000_000);
    pollDoneAtOnce();
    const s = studio();
    const { runA, evtA } = await firstRender(s);
    expect(await runWorker(evtA)).toMatchObject({ ok: true });
    expect(pendingRow(runA)?.pending_charges).toBeNull();

    vi.setSystemTime(Date.now() + CHARGE_SETTLE_GRACE_MS + 60_000);
    expect((await settleUnchargedVideos(db.make() as never, Date.now())).checked).toBe(0);
    expect(w.chargeAttempts).toBe(1);
    expect(ledgerKeys()).toHaveLength(3);
  });

  it("a delivered video is charged even when 150 older records are stuck waiting ahead of it", async () => {
    const w = useWallet(1_000_000);
    const at = Date.now();
    const jobs = (world.tables.generative_video_jobs ??= []);
    for (let i = 0; i < 150; i++) {
      const run = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      jobs.push({
        tenant_id: TENANT,
        run_id: run,
        meter_key: `${run}:gen-video:0`,
        model: "m",
        status: "completed",
        pending_charges: [{ tenant_id: TENANT, run_id: run, key: `${run}:gen-video:0`, cost_usd: 1, task: "video.talking_head", model: "m", delivery: "chat" }],
        updated_at: new Date(at + i).toISOString(),
      });
    }
    const paid = "44444444-4444-4444-8444-444444444444";
    jobs.push({
      tenant_id: TENANT,
      run_id: paid,
      meter_key: `${paid}:gen-video:0`,
      model: "m",
      status: "completed",
      pending_charges: [{ tenant_id: TENANT, run_id: paid, key: `${paid}:gen-video:0`, cost_usd: 4.5, task: "video.talking_head", model: "m", delivery: "chat" }],
      updated_at: new Date(at + 10_000).toISOString(),
    });
    (world.tables.run_artifacts ??= []).push({ id: "art-paid", tenant_id: TENANT, run_id: paid, mime: "video/mp4", filename: "v.mp4" });

    vi.setSystemTime(at + CHARGE_SETTLE_GRACE_MS + 60_000);
    const r = await settleUnchargedVideos(db.make() as never, Date.now());
    expect(r).toMatchObject({ settled: 1, waiting: 150 });
    expect(ledgerKeys()).toEqual([`${paid}:gen-video:0`]);
    expect(w.chargeAttempts).toBe(1);
  });

  it("never charges a render whose video was not delivered, and drops its record once it can no longer be delivered", async () => {
    const w = useWallet(1_000_000);
    const run = "33333333-3333-4333-8333-333333333333";
    const at = Date.now();
    (world.tables.generative_video_jobs ??= []).push({
      tenant_id: TENANT,
      run_id: run,
      meter_key: `${run}:gen-video:0`,
      model: "bytedance/seedance",
      status: "completed",
      pending_charges: [{ tenant_id: TENANT, run_id: run, key: `${run}:gen-video:0`, cost_usd: 4.5, task: "video.talking_head", model: "m", delivery: "chat" }],
      updated_at: new Date(at).toISOString(),
    });

    vi.setSystemTime(at + CHARGE_SETTLE_GRACE_MS + 60_000);
    expect(await settleUnchargedVideos(db.make() as never, Date.now())).toMatchObject({ checked: 1, waiting: 1, settled: 0 });
    vi.setSystemTime(at + CHARGE_SETTLE_ABANDON_MS + 60_000);
    expect(await settleUnchargedVideos(db.make() as never, Date.now())).toMatchObject({ checked: 1, abandoned: 1, settled: 0 });
    expect(w.chargeAttempts).toBe(0);
    expect(ledgerKeys()).toEqual([]);
    expect(pendingRow(run)?.pending_charges).toBeNull();
  });

  it("the sweep runs in the first ten minutes of each hour and never throws into its host", async () => {
    const settle = vi.fn(async () => ({ checked: 0, settled: 0, already: 0, waiting: 0, abandoned: 0, failed: 0 }));
    expect(await runVideoChargeSettleSlot(new Date("2026-10-19T10:05:00Z"), settle)).toMatchObject({ checked: 0 });
    expect(await runVideoChargeSettleSlot(new Date("2026-10-19T10:15:00Z"), settle)).toBe("skipped");
    expect(settle).toHaveBeenCalledTimes(1);
    expect(await runVideoChargeSettleSlot(new Date("2026-10-19T11:00:00Z"), async () => Promise.reject(new Error("db down")))).toBe("failed");
  });
});

describe("what a tenant already has in flight before a new studio video is asked for", () => {
  const OTHER = "99999999-9999-4999-8999-999999999999";
  const QUEUED = "aaaaaaaa-0000-4000-8000-000000000011";
  const STALE = "aaaaaaaa-0000-4000-8000-000000000012";
  const FOREIGN = "aaaaaaaa-0000-4000-8000-000000000013";
  const cardIntake = { prompt: "a founder explaining Zavi", intent: "talking_head", premium: false, script: "Hi, I'm Sam and this is Zavi." };

  const card = (id: string, tenant_id: string, approvedAt: number) => {
    (world.tables.channel_actions ??= []).push({ id, tenant_id, exec_class: GENERATED_VIDEO_RENDER_CLASS, exec_status: "queued", exec_claim_id: null, exec_payload: { intake: cardIntake }, executed_at: null });
    (world.tables.channel_action_events ??= []).push({ tenant_id, action_id: id, event: "approved", at: new Date(approvedAt).toISOString() });
  };
  const hold = (run_id: string, tenant_id: string, usd: number, createdAt: number, status = "pending") =>
    (world.tables.generative_video_jobs ??= []).push({ tenant_id, run_id, meter_key: `${run_id}:video-hold`, model: "video-hold", job_id: JSON.stringify({ usd }), status, created_at: new Date(createdAt).toISOString() });
  const draftOf = (run: string) => rows("agent_thread_messages").find((m) => m.meta?.render_run_id === run)!;
  const runRow = (run: string) => rows("agent_runs").find((r) => r.id === run)!;

  async function seedTenant() {
    const s = studio();
    const render = async (tenant_id: string, text: string, deps = s.deps) => {
      vi.advanceTimersByTime(1_000);
      const out = await sendStudioMessage(deps, { tenant_id, user_id: USER, text, new_thread: true });
      return (out.render as { run_id: string }).run_id;
    };
    const rendering = await render(TENANT, "ugc ad for our serum");
    const charged = await render(TENANT, "ugc ad for our cleanser");
    const superseded = await render(TENANT, "ugc ad for our toner");
    const old = await render(TENANT, "ugc ad for our mask");
    const failed = await render(TENANT, "ugc ad for our balm");
    const foreign = await render(OTHER, "ugc ad for their serum", { ...studio().deps, store: supabaseStudioStore(OTHER) });
    expect(new Set([rendering, charged, superseded, old, failed, foreign]).size).toBe(6);
    expect(runRow(foreign).tenant_id).toBe(OTHER);

    world.tables.tenant_credit_ledger = [{ tenant_id: TENANT, kind: "media", media_key: `${charged}:gen-video:0` }];
    draftOf(superseded).meta.render_run_id = "eeeeeeee-0000-4000-8000-000000000099";
    runRow(old).enqueued_at = new Date(Date.now() - STUDIO_IN_FLIGHT_WINDOW_MS - 60_000).toISOString();
    world.tables.agent_thread_messages.push({ tenant_id: TENANT, thread_id: draftOf(failed).thread_id, body: "Sorry", meta: { source_run_id: failed, kind: "generative_video_failed" } });

    card(QUEUED, TENANT, Date.now() + 60_000);
    card(STALE, TENANT, Date.now() - IN_FLIGHT_WINDOW_MS - 60_000);
    card(FOREIGN, OTHER, Date.now() - 60_000);
    hold("dddddddd-0000-4000-8000-000000000001", TENANT, 1.25, Date.now() - 120_000);
    hold("dddddddd-0000-4000-8000-000000000002", TENANT, 7, Date.now() - 120_000, "completed");
    hold("dddddddd-0000-4000-8000-000000000003", TENANT, 11, Date.now() - STUDIO_IN_FLIGHT_WINDOW_MS - 60_000);
    hold("dddddddd-0000-4000-8000-000000000004", OTHER, 13, Date.now() - 120_000);
    return { s, rendering, charged, superseded, old, failed, foreign };
  }

  it("counts the one rendering chat video, the one queued card and the one pending hold, at their exact cost, and nothing charged, replaced, failed, stale or another tenant's", async () => {
    const { s } = await seedTenant();
    const chat = estimateOf(s.events[0]);
    const cardUsd = routedVideoPlan(cardIntake as GenerativeVideoIntake).estimateUsd;
    expect(chat).toBeGreaterThan(0);
    expect(cardUsd).toBeGreaterThan(0);
    expect(s.events.every((e) => estimateOf(e) === chat)).toBe(true);

    expect(await inFlightVideoUsd(db.make() as never, TENANT, Date.now())).toBeCloseTo(chat + cardUsd + 1.25, 9);
    expect(await inFlightVideoUsd(db.make() as never, OTHER, Date.now())).toBeCloseTo(chat + cardUsd + 13, 9);
  });

  it("each excluded row costs exactly its own price once the reason it was excluded goes away", async () => {
    const { s, charged, superseded, old, failed } = await seedTenant();
    const chat = estimateOf(s.events[0]);
    const cardUsd = routedVideoPlan(cardIntake as GenerativeVideoIntake).estimateUsd;
    const base = chat + cardUsd + 1.25;
    const now = () => inFlightVideoUsd(db.make() as never, TENANT, Date.now());
    expect(await now()).toBeCloseTo(base, 9);

    world.tables.tenant_credit_ledger = [];
    expect(await now()).toBeCloseTo(base + chat, 9);
    world.tables.tenant_credit_ledger = [{ tenant_id: TENANT, kind: "media", media_key: `${charged}:gen-video:0` }];

    rows("agent_thread_messages").find((m) => m.meta?.render_run_id === "eeeeeeee-0000-4000-8000-000000000099")!.meta.render_run_id = superseded;
    expect(await now()).toBeCloseTo(base + chat, 9);
    draftOf(superseded).meta.render_run_id = "eeeeeeee-0000-4000-8000-000000000099";

    const oldAt = runRow(old).enqueued_at;
    runRow(old).enqueued_at = new Date(Date.now() - 60_000).toISOString();
    expect(await now()).toBeCloseTo(base + chat, 9);
    runRow(old).enqueued_at = oldAt;

    world.tables.agent_thread_messages = rows("agent_thread_messages").filter((m) => !(m.meta?.kind === "generative_video_failed" && m.meta?.source_run_id === failed));
    expect(await now()).toBeCloseTo(base + chat, 9);
  });

  it("a render whose enqueue failed and was then requeued holds its cost again, until it fails for real", async () => {
    const { s, failed } = await seedTenant();
    const chat = estimateOf(s.events[0]);
    const base = chat + routedVideoPlan(cardIntake as GenerativeVideoIntake).estimateUsd + 1.25;
    const now = () => inFlightVideoUsd(db.make() as never, TENANT, Date.now());
    const thread_id = draftOf(failed).thread_id;
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();

    const failure = rows("agent_thread_messages").find((m) => m.meta?.kind === "generative_video_failed" && m.meta?.source_run_id === failed)!;
    failure.meta.code = "enqueue_failed";
    failure.created_at = at(-30_000);
    expect(await now()).toBeCloseTo(base, 9);

    world.tables.agent_thread_messages.push({ tenant_id: TENANT, thread_id, body: "Rendering", created_at: at(-20_000), meta: { kind: REQUEUED_KIND, source_run_id: failed } });
    expect(await now()).toBeCloseTo(base + chat, 9);

    world.tables.agent_thread_messages.push({ tenant_id: TENANT, thread_id, body: "Sorry", created_at: at(-10_000), meta: { source_run_id: failed, kind: "generative_video_failed", code: "render_failed" } });
    expect(await now()).toBeCloseTo(base, 9);
  });
});
