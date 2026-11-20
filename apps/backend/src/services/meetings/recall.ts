
export type TranscriptSegment = {
  speaker: string;
  text: string;
  start_s: number | null;
};

export type RecallBot = {
  id: string;
  status_code: string | null;
  transcript_download_url: string | null;
  recording_count: number;
  ended: boolean;
  ended_at: string | null;
  end_sub_code: string | null;
};

export type ReconcileVerdict = "ready" | "rendering" | "no_recording" | "stale" | "in_progress";

const NO_RECORDING_GRACE_MS = 10 * 60 * 1000;

const GENERIC_REASONS = new Set(["no_recording", "transcript_stuck", "fatal"]);

export function asRecallSubCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return /^[a-z][a-z0-9_]{0,63}$/.test(v) ? v : null;
}

export function noRecordingReason(remoteEndSubCode: string | null, storedError: string | null): string {
  const remote = asRecallSubCode(remoteEndSubCode);
  if (remote && !GENERIC_REASONS.has(remote)) return remote;
  const stored = asRecallSubCode(storedError);
  if (stored && !GENERIC_REASONS.has(stored)) return stored;
  return "no_recording";
}

export function classifyForReconcile(
  bot: Pick<RecallBot, "transcript_download_url" | "recording_count" | "ended">,
  age_since_call_ms: number,
  render_deadline_ms: number = 30 * 60 * 1000,
): ReconcileVerdict {
  if (bot.transcript_download_url) return "ready";
  if (!bot.ended) return "in_progress";
  if (bot.recording_count === 0) {
    return age_since_call_ms > NO_RECORDING_GRACE_MS ? "no_recording" : "in_progress";
  }
  return age_since_call_ms > render_deadline_ms ? "stale" : "rendering";
}

const DEFAULT_REGION = "us-west-2";

function baseUrl(): string {
  const region = process.env.RECALL_REGION || DEFAULT_REGION;
  return `https://${region}.recall.ai`;
}

export class RecallHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RecallHttpError";
  }
}

export function recallConfigured(): boolean {
  return Boolean(process.env.RECALL_API_KEY);
}

async function recallFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const key = process.env.RECALL_API_KEY;
  if (!key) throw new Error("RECALL_API_KEY unset");
  return fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Token ${key}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

export async function createBot(input: {
  meeting_url: string;
  bot_name: string;
  join_at?: string;
  consent_message: string;
  metadata: Record<string, string>;
}): Promise<{ id: string }> {
  const res = await recallFetch("/api/v1/bot/", {
    method: "POST",
    body: JSON.stringify({
      meeting_url: input.meeting_url,
      bot_name: input.bot_name,
      ...(input.join_at ? { join_at: input.join_at } : {}),
      metadata: input.metadata,
      recording_config: {
        transcript: { provider: { recallai_streaming: {} } },
      },
      chat: {
        on_bot_join: { send_to: "everyone", message: input.consent_message },
      },
      automatic_leave: {
        waiting_room_timeout: 600,
        noone_joined_timeout: 900,
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`recall create bot ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as { id: string };
  return { id: json.id };
}

export async function getBot(provider_bot_id: string): Promise<RecallBot> {
  const res = await recallFetch(`/api/v1/bot/${provider_bot_id}/`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new RecallHttpError(res.status, `recall get bot ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    id: string;
    status_changes?: Array<{ code?: string; created_at?: string; sub_code?: string | null }>;
    recordings?: Array<{
      media_shortcuts?: {
        transcript?: { data?: { download_url?: string | null } | null } | null;
      } | null;
    }>;
  };
  const changes = json.status_changes ?? [];
  const lastStatus = changes.length > 0 ? (changes[changes.length - 1].code ?? null) : null;
  const recordings = json.recordings ?? [];
  let downloadUrl: string | null = null;
  for (const rec of recordings) {
    const url = rec.media_shortcuts?.transcript?.data?.download_url;
    if (url) {
      downloadUrl = url;
      break;
    }
  }
  const terminal = [...changes].reverse().find((c) => c.code === "done" || c.code === "fatal");
  const ended = Boolean(terminal);
  const lastWith = (code: string) => [...changes].reverse().find((c) => c.code === code);
  const endChange = lastWith("fatal") ?? lastWith("call_ended");
  return {
    id: json.id,
    status_code: lastStatus,
    transcript_download_url: downloadUrl,
    recording_count: recordings.length,
    ended,
    ended_at: terminal?.created_at ?? null,
    end_sub_code: asRecallSubCode(endChange?.sub_code),
  };
}

export async function fetchTranscript(
  download_url: string,
): Promise<TranscriptSegment[]> {
  const res = await fetch(download_url);
  if (!res.ok) throw new Error(`recall transcript download ${res.status}`);
  const raw = (await res.json()) as unknown;
  return normalizeTranscript(raw);
}

export function normalizeTranscript(raw: unknown): TranscriptSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptSegment[] = [];
  for (const item of raw) {
    const seg = item as {
      participant?: { name?: string | null } | null;
      speaker?: string | null;
      words?: Array<{
        text?: string;
        start_timestamp?: { relative?: number } | number | null;
      }> | null;
      text?: string;
    };
    const speaker =
      (seg.participant?.name ?? seg.speaker ?? "").trim() || "Unknown";
    let text = "";
    let start: number | null = null;
    if (Array.isArray(seg.words) && seg.words.length > 0) {
      text = seg.words
        .map((w) => (typeof w.text === "string" ? w.text : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const first = seg.words[0]?.start_timestamp;
      if (typeof first === "number") start = first;
      else if (first && typeof first.relative === "number") start = first.relative;
    } else if (typeof seg.text === "string") {
      text = seg.text.trim();
    }
    if (text) out.push({ speaker, text, start_s: start });
  }
  return out;
}

export function transcriptToText(segments: TranscriptSegment[]): string {
  return segments.map((s) => `${s.speaker}: ${s.text}`).join("\n");
}

export function asTranscriptText(transcript: TranscriptSegment[] | string): string {
  return typeof transcript === "string" ? transcript : transcriptToText(transcript);
}

export type CancelBotOutcome = "deleted" | "removed" | "gone" | "in_call";

const IN_CALL_CODES = new Set([
  "in_call_not_recording",
  "in_call_recording",
  "recording_permission_allowed",
  "recording_permission_denied",
]);

export async function cancelBot(
  provider_bot_id: string,
  opts: { leaveIfInCall: boolean },
): Promise<CancelBotOutcome> {
  const del = await recallFetch(`/api/v1/bot/${provider_bot_id}/`, { method: "DELETE" });
  if (del.ok) return "deleted";
  if (del.status === 404) return "gone";
  if (del.status !== 405) {
    const body = await del.text().catch(() => "");
    throw new Error(`recall delete bot ${del.status}: ${body.slice(0, 300)}`);
  }
  if (!opts.leaveIfInCall) {
    const bot = await getBot(provider_bot_id);
    if (bot.ended || bot.status_code === "call_ended") return "gone";
    if (bot.status_code && IN_CALL_CODES.has(bot.status_code)) return "in_call";
  }
  const leave = await recallFetch(`/api/v1/bot/${provider_bot_id}/leave_call/`, { method: "POST" });
  if (leave.ok) return "removed";
  if (leave.status === 404) return "gone";
  const body = await leave.text().catch(() => "");
  const after = await getBot(provider_bot_id).catch(() => null);
  if (after && (after.ended || after.status_code === "call_ended")) return "gone";
  throw new Error(`recall leave call ${leave.status}: ${body.slice(0, 300)}`);
}

export async function deleteBotMedia(provider_bot_id: string): Promise<void> {
  const res = await recallFetch(`/api/v1/bot/${provider_bot_id}/delete_media/`, {
    method: "POST",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new RecallHttpError(res.status, `recall delete media ${res.status}: ${body.slice(0, 300)}`);
  }
}
