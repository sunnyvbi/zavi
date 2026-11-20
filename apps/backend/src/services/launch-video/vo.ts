
import {
  generatePlatformTts,
  isPlatformTtsAvailable,
  PLATFORM_TTS_UNAVAILABLE_REASON,
  type TtsFailureReason,
} from "./platform-higgsfield";
import { downloadMedia, estimateCost, generateMedia, isMediaRouterEnabled } from "@/services/media-router/router";
import { canAffordMedia, type PendingCharge } from "@/services/media-router/charge";

export type { TtsFailureReason };

const ROUTER_VOICE = "Brian";
const VO_TASK = "audio.voiceover" as const;

const TTS_VARIANT = "elevenlabs";
const DEFAULT_VOICE_ID = "573e5163-59b3-4926-aab1-951ef2985f81";

export type BeatAudio = { ext: string; bytes: Uint8Array };

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

const VO_CONCURRENCY = 4;

export type VoInput = {
  tenant_id: string;
  run_id: string;
  beats: Array<{ vo?: { srtText?: string } }>;
  voiceId?: string;
  voiceType?: "preset" | "element";
  variant?: string;
};

export type VoSynthesis = {
  audio: Map<number, BeatAudio>;
  blocked: TtsFailureReason | null;
  blockedError: string | null;
  pendingCharges: PendingCharge[];
};

export async function synthesizeBeatVo(input: VoInput): Promise<VoSynthesis> {
  const out = new Map<number, BeatAudio>();
  const pendingCharges: PendingCharge[] = [];

  const jobs: number[] = [];
  for (let i = 0; i < input.beats.length; i++) {
    if (input.beats[i]?.vo?.srtText?.trim()) jobs.push(i);
  }
  if (jobs.length === 0) return { audio: out, blocked: null, blockedError: null, pendingCharges };

  const routed = await isMediaRouterEnabled();

  if (!routed && !isPlatformTtsAvailable()) {
    console.warn(
      `[launch-video/vo] voiceover UNAVAILABLE — rendering silent for all ${jobs.length} narrated beat(s) ` +
        `(run ${input.run_id}): HIGGSFIELD_API_KEY not set`,
    );
    return { audio: out, blocked: "not_configured", blockedError: "HIGGSFIELD_API_KEY not set", pendingCharges };
  }

  const textAt = (i: number): string => input.beats[i]!.vo!.srtText!.trim();

  const probe = await synthesizeOne(input, jobs[0], textAt(jobs[0]), routed);
  if (probe.audio) out.set(jobs[0], probe.audio);
  if (probe.charge) pendingCharges.push(probe.charge);
  if (probe.blocked) {
    console.warn(
      `[launch-video/vo] voiceover UNAVAILABLE — rendering silent for all ${jobs.length} narrated beat(s) ` +
        `(run ${input.run_id}): ${probe.error ?? PLATFORM_TTS_UNAVAILABLE_REASON}`,
    );
    return { audio: out, blocked: probe.blocked, blockedError: probe.error, pendingCharges };
  }

  let next = 1;
  let blocked: TtsFailureReason | null = null;
  let blockedError: string | null = null;
  async function worker(): Promise<void> {
    while (true) {
      const j = next++;
      if (j >= jobs.length) return;
      const i = jobs[j];
      try {
        const r = await synthesizeOne(input, i, textAt(i), routed);
        if (r.audio) out.set(i, r.audio);
        if (r.charge) pendingCharges.push(r.charge);
        if (r.blocked && !blocked) {
          blocked = r.blocked;
          blockedError = r.error;
        }
      } catch (e) {
        console.warn(`[launch-video/vo] beat ${i} VO failed (silent fallback): ${(e as Error).message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(VO_CONCURRENCY, jobs.length - 1) }, () => worker()));

  return out.size > 0
    ? { audio: out, blocked: null, blockedError: null, pendingCharges }
    : { audio: out, blocked, blockedError, pendingCharges };
}

type OneBeatResult = {
  audio: BeatAudio | null;
  blocked: TtsFailureReason | null;
  error: string | null;
  charge: PendingCharge | null;
};

async function synthesizeOne(input: VoInput, beatIndex: number, text: string, routed: boolean): Promise<OneBeatResult> {
  if (routed) {
    if (!(await canAffordMedia(input.tenant_id, estimateCost(VO_TASK, { text })))) {
      return { audio: null, blocked: null, error: "insufficient credits", charge: null };
    }
    const r = await generateMedia(VO_TASK, { text, voice: ROUTER_VOICE });
    if (!r.ok) {
      const blocked: TtsFailureReason | null =
        r.reason === "not_configured" ? "not_configured" : r.reason === "out_of_credits" ? "vendor_wallet_exhausted" : null;
      if (!blocked) console.warn(`[launch-video/vo] TTS failed for beat ${beatIndex} (silent): ${r.error}`);
      return { audio: null, blocked, error: r.error, charge: null };
    }
    const bytes = await downloadMedia(r.url, MAX_AUDIO_BYTES, 30_000);
    if (!bytes) return { audio: null, blocked: null, error: "audio download failed", charge: null };
    return {
      audio: { ext: r.mime === "audio/wav" ? "wav" : extFromUrl(r.url), bytes },
      blocked: null,
      error: null,
      charge: {
        tenant_id: input.tenant_id,
        run_id: input.run_id,
        key: `${input.run_id}:lv-vo:${input.variant ?? "v0"}:${beatIndex}`,
        cost_usd: r.cost_usd,
        task: VO_TASK,
        model: r.model,
      },
    };
  }

  const res = await generatePlatformTts({
    variant: TTS_VARIANT,
    voice_type: input.voiceType ?? "preset",
    voice_id: input.voiceId || DEFAULT_VOICE_ID,
    prompt: text,
  });
  if (!res.ok) {
    const blocked =
      res.reason === "credential_rejected" ||
      res.reason === "not_configured" ||
      res.reason === "vendor_wallet_exhausted"
        ? res.reason
        : null;
    if (!blocked) console.warn(`[launch-video/vo] TTS failed for beat ${beatIndex} (silent): ${res.error}`);
    return { audio: null, blocked, error: res.error, charge: null };
  }
  const bytes = await downloadAudio(res.audioUrl);
  if (!bytes) return { audio: null, blocked: null, error: "audio download failed", charge: null };
  return { audio: { ext: extFromUrl(res.audioUrl), bytes }, blocked: null, error: null, charge: null };
}

async function downloadAudio(url: string): Promise<Uint8Array | null> {
  try {
    const resp = await fetch(url, { method: "GET", signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) {
      console.warn(`[launch-video/vo] audio download HTTP ${resp.status}`);
      return null;
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_AUDIO_BYTES) {
      console.warn(`[launch-video/vo] audio size out of range: ${buf.byteLength}`);
      return null;
    }
    return buf;
  } catch (e) {
    console.warn(`[launch-video/vo] audio download failed: ${(e as Error).message}`);
    return null;
  }
}

function extFromUrl(url: string): string {
  const m = url.match(/\.(wav|mp3|m4a|aac|ogg)(?:\?|$)/i);
  return m ? m[1].toLowerCase() : "mp3";
}

export type VoState =
  | "none_authored"
  | "voiced"
  | "unavailable"
  | "failed";

export type VoDisclosure = {
  state: VoState;
  silent: boolean;
  notice: string | null;
};

export function describeVoOutcome(input: {
  authoredVoBeats: number;
  voicedBeats: number;
  ttsBlocked: TtsFailureReason | null;
}): VoDisclosure {
  if (input.authoredVoBeats <= 0) return { state: "none_authored", silent: false, notice: null };
  if (input.voicedBeats > 0) return { state: "voiced", silent: false, notice: null };
  if (input.ttsBlocked) {
    return {
      state: "unavailable",
      silent: true,
      notice:
        "This video has no voiceover. The visuals are fine, but the narration couldn't be " +
        "generated on this run: voiceover is temporarily unavailable because of a configuration issue on " +
        "our side, and we're working on it. Retrying won't add narration until that's sorted — I'll let " +
        "you know as soon as voiceover is back.",
    };
  }
  return {
    state: "failed",
    silent: true,
    notice:
      "This video has no voiceover. The narration I wrote failed to render, so the file " +
      "above is silent. The visuals are fine. Ask me to retry if you want the voiceover.",
  };
}
