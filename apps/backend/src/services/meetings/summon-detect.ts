
import { isSupportedMeetingUrl } from "./url";

const MEETING_URL_RE =
  /https?:\/\/(?:[a-z0-9-]+\.)*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com)\/[^\s>|]+/i;

const INTENT_RE =
  /\b(join|record|notetak\w*|note[- ]take\w*|capture|attend|sit in|take notes?)\b/i;

export function detectSummon(rawText: string): string | null {
  const text = rawText ?? "";
  const m = MEETING_URL_RE.exec(text);
  if (!m) return null;
  const url = m[0];
  if (!isSupportedMeetingUrl(url)) return null;

  if (INTENT_RE.test(text)) return url;

  const residue = text
    .replace(/<@[A-Z0-9]+>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(MEETING_URL_RE, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  const words = residue.length === 0 ? 0 : residue.split(/\s+/).length;
  return words <= 4 ? url : null;
}
