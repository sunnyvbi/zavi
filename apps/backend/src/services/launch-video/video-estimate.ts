
import { estimateCost } from "@/services/media-router/router";
import { isFlatJobPricingOn } from "@/services/billing/flat-pricing";
import { billedMediaUsdFor } from "@/services/billing/job-prices";
import { CREDIT_USD } from "@/services/agents/credits";
import type { MediaTask } from "@/services/media-router/types";
import { narrowAspect, SPEAKING_WORDS_PER_SECOND, spokenSeconds, type GenerativeVideoIntake } from "./generative-video-intake";

export const DEFAULT_CLIP_SECONDS = 8;
export const SEEDANCE_MAX_SPEECH_SECONDS = 30;
export const SEEDANCE_MIN_CLIP_SECONDS = 4;

export type RoutedVideoPlan = {
  task: MediaTask;
  clipSeconds: number;
  estimateUsd: number;
};

export function routedVideoPlan(intake: GenerativeVideoIntake): RoutedVideoPlan {
  const aspect = narrowAspect(intake.aspect_ratio);
  const talkingHead = intake.intent === "talking_head";
  const speech = spokenSeconds(intake.script);
  const task: MediaTask = talkingHead
    ? intake.avatar_tier === "standard"
      ? "video.talking_head_standard"
      : speech <= SEEDANCE_MAX_SPEECH_SECONDS
      ? "video.talking_head"
      : "video.talking_head_long"
    : intake.intent === "cinematic"
      ? "video.cinematic"
      : intake.intent === "animate"
        ? "video.animate"
        : "video.social";
  const clipSeconds =
    task === "video.talking_head" ? Math.max(SEEDANCE_MIN_CLIP_SECONDS, speech) : speech;
  const estimateUsd = talkingHead
    ? estimateCost("image.photo", { aspect_ratio: aspect }) +
      estimateCost("audio.voiceover", { text: intake.script ?? "" }) +
      estimateCost(task, { duration_s: clipSeconds })
    : estimateCost(task, { duration_s: DEFAULT_CLIP_SECONDS });
  return { task, clipSeconds, estimateUsd };
}

async function billedLegsUsd(intake: GenerativeVideoIntake): Promise<number[]> {
  const { task, clipSeconds } = routedVideoPlan(intake);
  const legs: Array<[MediaTask, number]> =
    intake.intent === "talking_head"
      ? [
          ...(intake.portrait_path ? [] : [["image.photo", estimateCost("image.photo", { aspect_ratio: narrowAspect(intake.aspect_ratio) })] as [MediaTask, number]]),
          ["audio.voiceover", estimateCost("audio.voiceover", { text: intake.script ?? "" })],
          [task, estimateCost(task, { duration_s: clipSeconds })],
        ]
      : [[task, estimateCost(task, { duration_s: DEFAULT_CLIP_SECONDS })]];
  const flatOn = await isFlatJobPricingOn();
  return legs.map(([legTask, usd]) => billedMediaUsdFor(legTask, usd, flatOn));
}

function legCredits(usd: number): number {
  if (!(usd > 0)) return 0;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(usd));
  if (!m) return Math.ceil(usd / CREDIT_USD);
  const frac = m[2] ?? "";
  const scaled = BigInt(m[1] + frac) * 400n;
  const unit = 10n ** BigInt(frac.length);
  return Number((scaled + unit - 1n) / unit);
}

export function videoCreditsOf(usd: number): number {
  return Math.round(usd / CREDIT_USD);
}

export async function billedVideoCredits(intake: GenerativeVideoIntake): Promise<number> {
  return (await billedLegsUsd(intake)).reduce((sum, usd) => sum + legCredits(usd), 0);
}

export async function billedVideoUsd(intake: GenerativeVideoIntake): Promise<number> {
  return ((await billedVideoCredits(intake)) * 25) / 10000;
}

export const STARTER_SCRIPT_MIN_WORDS = 20;
export const STARTER_SCRIPT_MAX_WORDS = 70;
export const STARTER_SCRIPT_MAX_CHARS = 600;

function starterIntake(): GenerativeVideoIntake {
  const words = Array.from({ length: STARTER_SCRIPT_MAX_WORDS }, () => "w").join(" ");
  const script = words + "w".repeat(Math.max(0, STARTER_SCRIPT_MAX_CHARS - words.length));
  return { prompt: "starter", intent: "talking_head", premium: false, aspect_ratio: "9:16", script };
}

export function starterVideoEstimateUsd(): number {
  return routedVideoPlan(starterIntake()).estimateUsd;
}

export async function starterVideoCredits(): Promise<number> {
  return billedVideoCredits(starterIntake());
}

export function voiceoverSeconds(script: string): number {
  const words = script.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.floor(words / SPEAKING_WORDS_PER_SECOND));
}
