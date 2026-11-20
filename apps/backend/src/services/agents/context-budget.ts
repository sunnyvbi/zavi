
export const RESUME_TRANSCRIPT_WARN_TOKENS = 120_000;

const CHARS_PER_TOKEN = 4;

export interface ResumeTranscriptSize {
  entries: number;
  chars: number;
  approxTokens: number;
  overWarn: boolean;
}

export function measureResumeTranscript(
  entries: unknown,
): ResumeTranscriptSize {
  const arr = Array.isArray(entries) ? entries : [];
  let chars = 0;
  for (const e of arr) {
    try {
      chars += JSON.stringify(e)?.length ?? 0;
    } catch {
    }
  }
  const approxTokens = Math.round(chars / CHARS_PER_TOKEN);
  return {
    entries: arr.length,
    chars,
    approxTokens,
    overWarn: approxTokens > RESUME_TRANSCRIPT_WARN_TOKENS,
  };
}

export function shouldSkipDurableResume(size: ResumeTranscriptSize): boolean {
  return size.overWarn;
}

const CONTEXT_LENGTH_MARKERS: readonly string[] = [
  "prompt is too long",
  "context_length_exceeded",
  "maximum context length",
  "context window",
  "input length and max_tokens exceed",
  "reduce the length of the messages",
  "too many total tokens",
];

export function isContextLengthError(err: unknown): boolean {
  const s =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : err == null
          ? ""
          : String(err);
  if (!s) return false;
  const lc = s.toLowerCase();
  return CONTEXT_LENGTH_MARKERS.some((m) => lc.includes(m));
}
