
import { createHash } from "node:crypto";
import { serviceClient } from "@/services/supabase";
import {
  meterPlatformGeneration,
  type PlatformGenerationSurface,
} from "@/services/mcp/higgsfield-meter";
import { generatePlatformVideo } from "./platform-higgsfield";
import {
  cacheModelTag,
  downloadMedia,
  estimateCost,
  generateMedia,
  isMediaRouterEnabled,
  routeImage,
} from "@/services/media-router/router";
import { canAffordMedia, type PendingCharge } from "@/services/media-router/charge";
import type { MediaTask } from "@/services/media-router/types";
import type { VideoBrief } from "./brief-mapper";

const MEDIA_BUCKET = "launch-video-media";
const CACHE_PREFIX = "cache";
const DEFAULT_BUDGET_CREDITS = 150;
const IMAGE_CREDIT_EST = 1;
const VIDEO_CREDIT_EST = 30;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
const ASPECT = "16:9";
const BROLL_SECONDS = 6;
const IMAGE_TASK: MediaTask = "image.hero";
const VIDEO_TASK: MediaTask = "video.broll";

export type GeneratedImage = {
  beatIndex: number;
  itemIndex: number | null;
  filename: string;
  bytes: Uint8Array;
};

export type GeneratedVideo = {
  beatIndex: number;
  filename: string;
  bytes: Uint8Array;
};

export type MediaResult = {
  images: GeneratedImage[];
  videos: GeneratedVideo[];
  creditsSpent: number;
  log: string[];
  pendingCharges: PendingCharge[];
};

export type MediaDeps = {
  generateImage: (
    prompt: string,
  ) => Promise<{ ok: true; imageUrl: string; credits?: number; cost_usd?: number; model?: string } | { ok: false; error: string }>;
  generateVideo: (
    prompt: string,
  ) => Promise<{ ok: true; videoUrl: string; credits?: number; cost_usd?: number; model?: string } | { ok: false; error: string }>;
  cacheGet: (key: string) => Promise<Uint8Array | null>;
  cachePut: (key: string, bytes: Uint8Array, contentType: string) => Promise<void>;
  download: (url: string) => Promise<Uint8Array | null>;
  canAfford: (cost_usd: number) => Promise<boolean>;
};

type ImageJob = { beatIndex: number; itemIndex: number | null; prompt: string };
type VideoJob = { beatIndex: number; prompt: string };

function collectImageJobs(brief: VideoBrief): ImageJob[] {
  const jobs: ImageJob[] = [];
  brief.beats.forEach((b, beatIndex) => {
    if (b.kind === "hook" && b.imagePrompt?.trim()) jobs.push({ beatIndex, itemIndex: null, prompt: b.imagePrompt.trim() });
    if (b.kind === "productui") {
      b.items.forEach((it, itemIndex) => {
        if (it.imagePrompt?.trim()) jobs.push({ beatIndex, itemIndex, prompt: it.imagePrompt.trim() });
      });
    }
  });
  return jobs;
}

function collectVideoJobs(brief: VideoBrief): VideoJob[] {
  const jobs: VideoJob[] = [];
  brief.beats.forEach((b, beatIndex) => {
    if (b.kind === "broll" && b.videoPrompt?.trim()) jobs.push({ beatIndex, prompt: b.videoPrompt.trim() });
  });
  return jobs;
}

export function hashOf(tenantId: string, modelTag: string, prompt: string): string {
  return createHash("sha256").update(`${tenantId}|${modelTag}|${prompt}`).digest("hex").slice(0, 24);
}

export type MediaMeterCtx = {
  tenant_id?: string | null;
  run_id?: string | null;
  variant?: string;
};

export async function generateBeatMedia(
  brief: VideoBrief,
  opts?: { budgetCredits?: number } & MediaMeterCtx,
  deps: MediaDeps = defaultDeps(opts ?? {}),
): Promise<MediaResult> {
  const budget = opts?.budgetCredits ?? DEFAULT_BUDGET_CREDITS;
  const meterCtx: MediaMeterCtx = {
    tenant_id: opts?.tenant_id,
    run_id: opts?.run_id,
    variant: opts?.variant,
  };
  const images: GeneratedImage[] = [];
  const videos: GeneratedVideo[] = [];
  const log: string[] = [];
  const state = { creditsSpent: 0, pendingCharges: [] as PendingCharge[] };
  const memo = new Map<string, Uint8Array>();

  const cacheTenant = meterCtx.tenant_id ?? "none";
  const imageTag = await cacheModelTag(IMAGE_TASK);
  const videoTag = await cacheModelTag(VIDEO_TASK);
  const routed = await isMediaRouterEnabled();
  const imageEstimateUsd = routed ? estimateCost(IMAGE_TASK, { aspect_ratio: ASPECT }) : 0;
  const videoEstimateUsd = routed ? estimateCost(VIDEO_TASK, { aspect_ratio: ASPECT, duration_s: BROLL_SECONDS }) : 0;

  for (const job of collectImageJobs(brief)) {
    const hash = hashOf(cacheTenant, imageTag, job.prompt);
    const key = `img_${hash}.png`;
    const label = `image beat ${job.beatIndex}/${job.itemIndex ?? "hero"}`;
    const bytes = await resolveAsset({
      label,
      hash,
      key,
      contentType: "image/png",
      maxBytes: MAX_IMAGE_BYTES,
      est: IMAGE_CREDIT_EST,
      budget,
      state,
      memo,
      log,
      deps,
      meterCtx,
      surface: "lv-image",
      meterIndex: `${meterCtx.variant ?? "v0"}:${job.beatIndex}:${job.itemIndex ?? "hero"}`,
      task: IMAGE_TASK,
      estimateUsd: imageEstimateUsd,
      generate: () =>
        deps
          .generateImage(job.prompt)
          .then((r) => (r.ok ? { ok: true as const, url: r.imageUrl, credits: r.credits, cost_usd: r.cost_usd, model: r.model } : r)),
    });
    if (bytes) images.push({ beatIndex: job.beatIndex, itemIndex: job.itemIndex, filename: key, bytes });
  }

  for (const job of collectVideoJobs(brief)) {
    const hash = hashOf(cacheTenant, videoTag, job.prompt);
    const key = `vid_${hash}.mp4`;
    const label = `b-roll beat ${job.beatIndex}`;
    const bytes = await resolveAsset({
      label,
      hash,
      key,
      contentType: "video/mp4",
      maxBytes: MAX_VIDEO_BYTES,
      est: VIDEO_CREDIT_EST,
      budget,
      state,
      memo,
      log,
      deps,
      meterCtx,
      surface: "lv-video",
      meterIndex: `${meterCtx.variant ?? "v0"}:${job.beatIndex}`,
      task: VIDEO_TASK,
      estimateUsd: videoEstimateUsd,
      generate: () =>
        deps
          .generateVideo(job.prompt)
          .then((r) => (r.ok ? { ok: true as const, url: r.videoUrl, credits: r.credits, cost_usd: r.cost_usd, model: r.model } : r)),
    });
    if (bytes) videos.push({ beatIndex: job.beatIndex, filename: key, bytes });
  }

  return { images, videos, creditsSpent: state.creditsSpent, log, pendingCharges: state.pendingCharges };
}

async function resolveAsset(args: {
  label: string;
  hash: string;
  key: string;
  contentType: string;
  maxBytes: number;
  est: number;
  budget: number;
  state: { creditsSpent: number; pendingCharges: PendingCharge[] };
  memo: Map<string, Uint8Array>;
  log: string[];
  deps: MediaDeps;
  meterCtx: MediaMeterCtx;
  surface: PlatformGenerationSurface;
  meterIndex: string;
  task: MediaTask;
  estimateUsd: number;
  generate: () => Promise<{ ok: true; url: string; credits?: number; cost_usd?: number; model?: string } | { ok: false; error: string }>;
}): Promise<Uint8Array | null> {
  const { label, hash, key, contentType, maxBytes, est, budget, state, memo, log, deps, meterCtx, surface, meterIndex, task, estimateUsd, generate } =
    args;

  const memoed = memo.get(key);
  if (memoed) {
    log.push(`${label}: reuse (same-render) ${hash}`);
    return memoed;
  }

  try {
    const cached = await deps.cacheGet(key);
    if (cached && cached.byteLength > 0) {
      memo.set(key, cached);
      log.push(`${label}: cache hit ${hash} (0cr)`);
      return cached;
    }
  } catch (e) {
    log.push(`${label}: cache read failed (continuing): ${(e as Error).message}`);
  }

  if (state.creditsSpent + est > budget) {
    log.push(`${label}: BUDGET CAP (${state.creditsSpent}+${est}>${budget}cr) — degrade to fallback`);
    return null;
  }

  const gate = await meterPlatformGeneration({
    tenant_id: meterCtx.tenant_id,
    run_id: meterCtx.run_id,
    surface,
    index: meterIndex,
  });
  if (gate.decision !== "charged") {
    log.push(
      `${label}: METER ${gate.decision}${gate.error ? ` (${gate.error})` : ""} — degrade to fallback`,
    );
    return null;
  }

  if (!(await deps.canAfford(estimateUsd))) {
    log.push(`${label}: insufficient credits — degrade to fallback`);
    return null;
  }

  let res: { ok: true; url: string; credits?: number; cost_usd?: number; model?: string } | { ok: false; error: string };
  try {
    res = await generate();
  } catch (e) {
    log.push(`${label}: generate threw (degrade): ${(e as Error).message}`);
    return null;
  }
  if (!res.ok) {
    log.push(`${label}: generate failed (degrade): ${res.error}`);
    return null;
  }

  state.creditsSpent += res.credits ?? est;

  let bytes: Uint8Array | null = null;
  try {
    bytes = await deps.download(res.url);
  } catch (e) {
    log.push(`${label}: download threw (degrade, ${state.creditsSpent}cr): ${(e as Error).message}`);
    return null;
  }
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    log.push(`${label}: bad bytes (degrade, ${state.creditsSpent}cr)`);
    return null;
  }

  if (res.cost_usd && res.cost_usd > 0 && meterCtx.tenant_id && meterCtx.run_id) {
    state.pendingCharges.push({
      tenant_id: meterCtx.tenant_id,
      run_id: meterCtx.run_id,
      key: `${meterCtx.run_id}:${surface}:${meterIndex}`,
      cost_usd: res.cost_usd,
      task,
      model: res.model ?? "unknown",
    });
  }

  memo.set(key, bytes);
  try {
    await deps.cachePut(key, bytes, contentType);
  } catch (e) {
    log.push(`${label}: cache write failed (non-fatal): ${(e as Error).message}`);
  }
  log.push(`${label}: generated ${hash} (+${res.credits ?? est}cr → ${state.creditsSpent})`);
  return bytes;
}

function defaultDeps(meterCtx: MediaMeterCtx): MediaDeps {
  return {
    generateImage: async (prompt) => {
      const r = await routeImage(IMAGE_TASK, { prompt, aspect_ratio: ASPECT });
      return r.ok ? { ok: true as const, imageUrl: r.imageUrl, cost_usd: r.cost_usd, model: r.model } : { ok: false as const, error: r.error };
    },
    generateVideo: async (prompt) => {
      if (!(await isMediaRouterEnabled())) {
        return generatePlatformVideo({ prompt, aspect_ratio: ASPECT, duration: BROLL_SECONDS, resolution: "720p", generate_audio: false });
      }
      const r = await generateMedia(VIDEO_TASK, { prompt, aspect_ratio: ASPECT, duration_s: BROLL_SECONDS });
      return r.ok ? { ok: true as const, videoUrl: r.url, cost_usd: r.cost_usd, model: r.model } : { ok: false as const, error: r.error };
    },
    canAfford: (usd) => (meterCtx.tenant_id ? canAffordMedia(meterCtx.tenant_id, usd) : Promise.resolve(false)),
    cacheGet: async (key) => {
      try {
        const sb = serviceClient();
        const { data, error } = await sb.storage.from(MEDIA_BUCKET).download(`${CACHE_PREFIX}/${key}`);
        if (error || !data) return null;
        const buf = new Uint8Array(await data.arrayBuffer());
        return buf.byteLength > 0 ? buf : null;
      } catch {
        return null;
      }
    },
    cachePut: async (key, bytes, contentType) => {
      const sb = serviceClient();
      await sb.storage.from(MEDIA_BUCKET).upload(`${CACHE_PREFIX}/${key}`, Buffer.from(bytes), { contentType, upsert: true });
    },
    download: (url) => downloadMedia(url, MAX_VIDEO_BYTES),
  };
}
