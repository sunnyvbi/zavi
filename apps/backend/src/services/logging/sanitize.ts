
function messageOf(e: unknown): string {
  if (e == null) return "unknown error";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message || e.name || "error";
  if (typeof e === "object") {
    const o = e as Record<string, unknown>;
    const code = typeof o.code === "string" ? o.code : "";
    const msg =
      typeof o.message === "string"
        ? o.message
        : typeof o.error === "string"
          ? o.error
          : "";
    if (code && msg) return `${code}: ${msg}`;
    return msg || code || "error";
  }
  return String(e);
}

function compactUpstreamError(s: string): string {
  if (!/<!DOCTYPE html|<html[\s>]/i.test(s)) return s;

  const title = s
    .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/\s+/g, " ")
    .trim();
  const status =
    title?.match(/\b([45]\d{2})\b/)?.[1] ?? s.match(/\b(5\d{2}|4\d{2})\b/)?.[1];

  const parts = [
    "upstream returned an HTML error page",
    status ? `HTTP ${status}` : null,
    title ? `“${title.slice(0, 120)}”` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function looksLikeInfraUnreachable(e: unknown): boolean {
  let s: string;
  try {
    s = messageOf(e);
  } catch {
    return false;
  }
  return (
    /<!DOCTYPE html|<html[\s>]/i.test(s) ||
    /\b(50[234]|52[234])\b/.test(s) ||
    /connection timed out|connect timeout|timed out/i.test(s) ||
    /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(
      s,
    ) ||
    /\b08[0-9A-Z]{3}\b|\b57P03\b/.test(s)
  );
}

export function sanitizeErrorMessage(e: unknown): string {
  let s: string;
  try {
    s = compactUpstreamError(messageOf(e));
  } catch {
    return "error (unprintable)";
  }
  return (
    s
      .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "‹conn›")
      .replace(/[\w.-]+:[^\s:@/]+@[\w.-]+/g, "‹conn›")
      .replace(
        /\b(?:pass(?:word)?|pwd|user(?:\s?id|name)?|uid|host|server|data\s*source|database|initial\s*catalog)\s*=\s*[^;'"\s]+/gi,
        "‹conn›",
      )
      .replace(/\bsk-[A-Za-z0-9-]{6,}\b/g, "‹secret›")
      .replace(
        /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
        "‹secret›",
      )
      .slice(0, 500)
  );
}

export const sanitizeDiscoveryError = sanitizeErrorMessage;
