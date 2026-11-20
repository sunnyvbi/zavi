
export type VideoGenIntent = "talking_head" | "cinematic" | "social" | "animate";

export type ModelDescriptor = {
  model: string;
  category: "audios" | "images" | "videos";
  pollCeiling: { attempts: number; delayMs: number };
  reveal: boolean;
  creditEst: number;
};

const SLOW_POLL = { attempts: 90, delayMs: 5_000 };
const MED_POLL = { attempts: 80, delayMs: 4_000 };
const FAST_POLL = { attempts: 40, delayMs: 3_000 };

export const MODEL_DESCRIPTORS: Record<string, ModelDescriptor> = {
  seedance_2_0: { model: "seedance_2_0", category: "videos", pollCeiling: MED_POLL, reveal: true, creditEst: 72 },
  seedance_2_0_mini: { model: "seedance_2_0_mini", category: "videos", pollCeiling: FAST_POLL, reveal: true, creditEst: 22 },
  sync_so: { model: "sync_so", category: "videos", pollCeiling: MED_POLL, reveal: false, creditEst: 20 },
  marketing_studio_video: { model: "marketing_studio_video", category: "videos", pollCeiling: SLOW_POLL, reveal: true, creditEst: 40 },
  veo3_1: { model: "veo3_1", category: "videos", pollCeiling: SLOW_POLL, reveal: false, creditEst: 70 },
  cinematic_studio_3_0: { model: "cinematic_studio_3_0", category: "videos", pollCeiling: SLOW_POLL, reveal: false, creditEst: 60 },
  kling3_0_turbo: { model: "kling3_0_turbo", category: "videos", pollCeiling: FAST_POLL, reveal: false, creditEst: 15 },
  minimax_hailuo: { model: "minimax_hailuo", category: "videos", pollCeiling: FAST_POLL, reveal: false, creditEst: 20 },
};

const INTENT_MODELS: Record<Exclude<VideoGenIntent, "animate">, { default: string; premium: string }> = {
  talking_head: { default: "seedance_2_0", premium: "marketing_studio_video" },
  cinematic: { default: "seedance_2_0", premium: "veo3_1" },
  social: { default: "seedance_2_0_mini", premium: "kling3_0_turbo" },
};

export function submitPathFor(d: ModelDescriptor): string {
  return `/developer/v2alpha/${d.category}/${d.model}/generations`;
}

export function routeIntent(intent: VideoGenIntent, opts?: { premium?: boolean }): ModelDescriptor {
  if (intent === "animate") throw new Error("generative-models: animate runs only on the media router");
  const row = INTENT_MODELS[intent] ?? INTENT_MODELS.talking_head;
  const modelId = opts?.premium ? row.premium : row.default;
  const d = MODEL_DESCRIPTORS[modelId];
  if (!d) throw new Error(`generative-models: no descriptor for '${modelId}' (intent '${intent}')`);
  return d;
}
