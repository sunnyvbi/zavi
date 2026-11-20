import { logEvent } from "@/services/logging/logEvent";

const API_BASE = ((): string => {
  const b = (process.env.HIGGSFIELD_API_BASE || "https://platform.higgsfield.ai").replace(/\/+$/, "");
  return b.startsWith("https://") ? b : "https://platform.higgsfield.ai";
})();

const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_PATH = (id: string) => `/requests/${id}/status`;
const TERMINAL_OK = new Set(["completed", "succeeded", "success", "done"]);
const TERMINAL_BAD = new Set(["failed", "nsfw", "cancelled", "canceled", "error"]);

export type TtsParams = {
  variant: string;
  voice_type: "preset" | "element";
  voice_id: string;
  prompt: string;
};
export type TtsResult =
  | { ok: true; audioUrl: string; credits?: number }
  | { ok: false; error: string; reason: TtsFailureReason };

export type ImageParams = {
  prompt: string;
  aspect_ratio?: string;
  resolution?: string;
  start_image?: { id: string; type: string };
};
export type ImageResult =
  | { ok: true; imageUrl: string; credits?: number; jobId?: string }
  | { ok: false; error: string; reason?: GenerationFailureReason };

export type VideoParams = {
  prompt: string;
  aspect_ratio?: string;
  duration?: number;
  resolution?: string;
  generate_audio?: boolean;
  start_image?: { id: string; type: string };
};
export type VideoResult =
  | { ok: true; videoUrl: string; credits?: number; jobId?: string }
  | { ok: false; error: string; reason?: GenerationFailureReason };

export async function isPlatformHiggsfieldConfigured(): Promise<boolean> {
  const mcp = await import("./platform-higgsfield-mcp");
  return mcp.isPlatformMcpConfigured().catch(() => false);
}

function authHeaders(): Record<string, string> {
  const key = (process.env.HIGGSFIELD_API_KEY || "").trim();
  return {
    Authorization: `Key ${key}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

export type GenerationFailureReason = "vendor_wallet_exhausted" | "credential_rejected" | "vendor_error";

export function classifyGenerationFailure(status: number, body: string): GenerationFailureReason {
  if (/not_enough_credits|insufficient_credit/i.test(body || "")) return "vendor_wallet_exhausted";
  if (status === 401 || status === 403) return "credential_rejected";
  return "vendor_error";
}

export type SubmitOk = { ok: true; jobId: string };
export type SubmitErr = { ok: false; error: string; reason?: GenerationFailureReason };
export type PollOk = { ok: true; resultUrl: string; credits?: number; jobId: string };
export type PollPending = { ok: false; pending: true };
export type PollErr = { ok: false; error: string; pending?: false; reason?: GenerationFailureReason };

export async function submitGeneration(
  submitPath: string,
  params: Record<string, unknown>,
): Promise<SubmitOk | SubmitErr> {
  if (!(process.env.HIGGSFIELD_API_KEY || "").trim()) {
    return { ok: false, error: "HIGGSFIELD_API_KEY not set" };
  }
  try {
    const res = await fetch(`${API_BASE}${submitPath}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      const reason = classifyGenerationFailure(res.status, text);
      if (reason === "vendor_wallet_exhausted") {
        void logEvent({
          level: "error",
          source: "platform-higgsfield",
          code: "higgsfield.vendor_wallet_exhausted",
          message:
            "ZAVI's Higgsfield Developer-API wallet is out of credits (403 not_enough_credits) — " +
            "every platform generation is degrading to a placeholder. This is OUR vendor wallet, " +
            "NOT a customer's Zavi credit balance; never surface it to a customer as a credit " +
            "problem of theirs. The paid Higgsfield subscription funds a DIFFERENT wallet reachable " +
            "only over mcp.higgsfield.ai, so topping up this one is not the intended fix.",
          meta: { failure_class: reason, http_status: res.status },
        });
      }
      return { ok: false, error: `submit ${res.status}: ${redact(text).slice(0, 240)}`, reason };
    }
    const json = JSON.parse(text) as { request_id?: string; id?: string; job_id?: string };
    const id = json.request_id || json.id || json.job_id;
    if (!id) return { ok: false, error: `submit ok but no request id: ${redact(text).slice(0, 160)}` };
    return { ok: true, jobId: id };
  } catch (e) {
    return { ok: false, error: `submit failed: ${redact((e as Error).message)}` };
  }
}

function extractResultUrl(job: Record<string, unknown>): string | undefined {
  const images = job.images as Array<{ url?: string }> | undefined;
  if (Array.isArray(images) && images[0]?.url) return images[0].url;
  const video = job.video as { url?: string } | undefined;
  if (video?.url) return video.url;
  const audio = job.audio as { url?: string } | undefined;
  if (audio?.url) return audio.url;
  const legacy = job.result_url;
  return typeof legacy === "string" ? legacy : undefined;
}

export async function pollGenerationOnce(jobId: string): Promise<PollOk | PollPending | PollErr> {
  try {
    const res = await fetch(`${API_BASE}${POLL_PATH(jobId)}`, {
      method: "GET",
      headers: authHeaders(),
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        return {
          ok: false,
          error: `poll ${res.status}: ${redact(text).slice(0, 160)}`,
          reason: classifyGenerationFailure(res.status, text),
        };
      }
      return { ok: false, pending: true };
    }
    const job = JSON.parse(text) as Record<string, unknown>;
    const status = (typeof job.status === "string" ? job.status : "").toLowerCase();
    if (TERMINAL_OK.has(status)) {
      const url = extractResultUrl(job);
      if (url) return { ok: true, resultUrl: url, credits: typeof job.credits === "number" ? job.credits : undefined, jobId };
      return { ok: false, error: "job completed but no result url" };
    }
    if (TERMINAL_BAD.has(status)) return { ok: false, error: `job ${status}` };
    return { ok: false, pending: true };
  } catch {
    return { ok: false, pending: true };
  }
}

const TTS_API_BASE = ((): string => {
  const b = (process.env.HIGGSFIELD_TTS_API_BASE || "https://fnf.higgsfield.ai").replace(/\/+$/, "");
  return b.startsWith("https://") ? b : "https://fnf.higgsfield.ai";
})();
const SUBMIT_PATH_TTS = "/developer/v2alpha/audios/text2speech_v2/generations";
const TTS_POLL_PATH = (id: string) => `/developer/v2alpha/jobs/${id}`;
const TTS_POLL_ATTEMPTS = 20;
const TTS_POLL_DELAY_MS = 2_500;

export type TtsFailureReason =
  | "not_configured"
  | "credential_rejected"
  | "vendor_wallet_exhausted"
  | "vendor_error";

export const PLATFORM_TTS_UNAVAILABLE_REASON =
  "higgsfield TTS endpoint exists but the platform credential is rejected by the host that serves it: " +
  `POST ${TTS_API_BASE}${SUBMIT_PATH_TTS} returns 401 "Invalid or expired token" for HIGGSFIELD_API_KEY ` +
  "(verified 2026-08-31; the same key is accepted on api.higgsfield.ai and platform.higgsfield.ai, and our " +
  "own account generated 11 text2speech_v2/elevenlabs clips through that endpoint the same day). " +
  "Re-issue a key valid for that host and voiceover resumes with no code change.";

type TtsSubmitOk = { ok: true; jobId: string };
type TtsFail = { ok: false; error: string; reason: TtsFailureReason };
type TtsPollOk = { ok: true; resultUrl: string; credits?: number };
type TtsPollPending = { ok: false; pending: true };

function ttsReasonForStatus(status: number, body = ""): TtsFailureReason {
  return classifyGenerationFailure(status, body);
}

async function submitTts(params: TtsParams): Promise<TtsSubmitOk | TtsFail> {
  try {
    const res = await fetch(`${TTS_API_BASE}${SUBMIT_PATH_TTS}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ params }),
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        error: `TTS submit ${res.status}: ${redact(text).slice(0, 240)}`,
        reason: ttsReasonForStatus(res.status, text),
      };
    }
    const json = JSON.parse(text) as { id?: string; job_id?: string; request_id?: string };
    const id = json.id || json.job_id || json.request_id;
    if (!id) {
      return { ok: false, error: `TTS submit ok but no job id: ${redact(text).slice(0, 160)}`, reason: "vendor_error" };
    }
    return { ok: true, jobId: id };
  } catch (e) {
    return { ok: false, error: `TTS submit failed: ${redact((e as Error).message)}`, reason: "vendor_error" };
  }
}

async function pollTtsOnce(jobId: string): Promise<TtsPollOk | TtsPollPending | TtsFail> {
  try {
    const res = await fetch(`${TTS_API_BASE}${TTS_POLL_PATH(jobId)}`, {
      method: "GET",
      headers: authHeaders(),
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        return {
          ok: false,
          error: `TTS poll ${res.status}: ${redact(text).slice(0, 160)}`,
          reason: ttsReasonForStatus(res.status, text),
        };
      }
      return { ok: false, pending: true };
    }
    const job = JSON.parse(text) as Record<string, unknown>;
    const status = (typeof job.status === "string" ? job.status : "").toLowerCase();
    if (TERMINAL_OK.has(status)) {
      const url = extractResultUrl(job);
      if (url) return { ok: true, resultUrl: url, credits: typeof job.credits === "number" ? job.credits : undefined };
      return { ok: false, error: "TTS job completed but no result url", reason: "vendor_error" };
    }
    if (TERMINAL_BAD.has(status)) return { ok: false, error: `TTS job ${status}`, reason: "vendor_error" };
    return { ok: false, pending: true };
  } catch {
    return { ok: false, pending: true };
  }
}

export async function generatePlatformTts(params: TtsParams): Promise<TtsResult> {
  if (!(process.env.HIGGSFIELD_API_KEY || "").trim()) {
    return { ok: false, error: "HIGGSFIELD_API_KEY not set", reason: "not_configured" };
  }
  const submitted = await submitTts(params);
  if (!submitted.ok) return submitted;
  for (let attempt = 0; attempt < TTS_POLL_ATTEMPTS; attempt++) {
    await sleep(TTS_POLL_DELAY_MS);
    const r = await pollTtsOnce(submitted.jobId);
    if (r.ok) return { ok: true, audioUrl: r.resultUrl, credits: r.credits };
    if (!("pending" in r)) return r;
  }
  return { ok: false, error: "TTS job poll timeout", reason: "vendor_error" };
}

export function isPlatformTtsAvailable(): boolean {
  return (process.env.HIGGSFIELD_API_KEY || "").trim().length > 0;
}

export async function generatePlatformImage(params: ImageParams): Promise<ImageResult> {
  const mcp = await import("./platform-higgsfield-mcp");
  try {
    const r = await mcp.generateMcpImage({
      prompt: params.prompt,
      aspect_ratio: params.aspect_ratio ?? "1:1",
    });
    return r.ok
      ? { ok: true, imageUrl: r.url, credits: r.credits, jobId: r.jobId }
      : { ok: false, error: r.error, reason: r.reason };
  } catch (e) {
    return { ok: false, error: `higgsfield MCP unavailable: ${(e as Error).message}`, reason: "vendor_error" };
  }
}

export async function generatePlatformVideo(_params: VideoParams): Promise<VideoResult> {
  if (!(process.env.HIGGSFIELD_API_KEY || "").trim()) {
    return { ok: false, error: "HIGGSFIELD_API_KEY not set" };
  }
  return { ok: false, error: "higgsfield b-roll video pending platform-API migration (2026-07-23)" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function redact(s: string): string {
  const key = (process.env.HIGGSFIELD_API_KEY || "").trim();
  let out = s || "";
  if (key) out = out.split(key).join("«redacted»");
  return out;
}
