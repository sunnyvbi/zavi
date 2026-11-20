
import { ExpectedToolError } from "@/services/tools/types";

export type AdReadErrorKind = "auth" | "rate_limited" | "vendor_error" | "timeout" | "unknown";

export class AdAccountLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdAccountLostError";
  }
}

const META_RATE_CODES = new Set([4, 17, 32, 341, 613]);
const isMetaBucCode = (c: number) => c >= 80000 && c <= 80014;
const TIKTOK_RATE_CODES = new Set([40100, 40133]);
const TIKTOK_AUTH_CODES = new Set([40102, 40105]);
const NETWORK_TIMEOUT_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function httpStatus(e: unknown, text: string): number | null {
  if (e && typeof e === "object") {
    const meta = e instanceof ExpectedToolError ? e.meta ?? {} : {};
    const s = num(meta.http_status) ?? num((e as { status?: unknown }).status) ?? num((e as { statusCode?: unknown }).statusCode);
    if (s !== null && s >= 100 && s < 600) return s;
  }
  const m =
    /\bHTTP\s*(\d{3})\b/i.exec(text) ??
    /\b(?:failed|error)\s*:?\s*(\d{3})\b/i.exec(text) ??
    /"?status(?:_code|Code)?"?\s*[:=]\s*(\d{3})\b/i.exec(text);
  return m ? Number(m[1]) : null;
}

function vendorCode(e: unknown, text: string): number | null {
  if (e instanceof ExpectedToolError) {
    const g = num(e.meta?.graph_code);
    if (g !== null) return g;
  }
  const m = /"code"\s*:\s*(\d+)/.exec(text) ?? /\bcode\s+(\d{5})\b/i.exec(text);
  return m ? Number(m[1]) : null;
}

function isTimeout(e: unknown, text: string): boolean {
  for (let cur: unknown = e, depth = 0; cur && typeof cur === "object" && depth < 4; depth++) {
    const name = (cur as { name?: unknown }).name;
    const code = (cur as { code?: unknown }).code;
    if (name === "TimeoutError" || name === "AbortError") return true;
    if (typeof code === "string" && (NETWORK_TIMEOUT_CODES.has(code) || /_timeout$/.test(code))) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return /did not respond within|timed? ?out\b|DEADLINE_EXCEEDED/i.test(text);
}

export function classifyAdReadError(e: unknown): AdReadErrorKind {
  const text = String((e as Error)?.message ?? e ?? "");
  if (isTimeout(e, text)) return "timeout";

  const code = e instanceof ExpectedToolError ? e.code : "";
  if (/_(token_revoked|token_expired|token_invalid|unauthenticated|permission_revoked|connection_stopped|not_connected)$/.test(code)) return "auth";
  if (/_rate_limited$/.test(code) || code === "meta_ads_busy") return "rate_limited";
  if (/_bad_response$/.test(code)) return "vendor_error";

  const vendor = vendorCode(e, text);
  if (vendor !== null) {
    if (vendor === 190 || TIKTOK_AUTH_CODES.has(vendor)) return "auth";
    if (META_RATE_CODES.has(vendor) || isMetaBucCode(vendor) || TIKTOK_RATE_CODES.has(vendor)) return "rate_limited";
    if (vendor === 1 || vendor === 2 || (vendor >= 50000 && vendor < 60000)) return "vendor_error";
  }
  if (e instanceof ExpectedToolError && e.meta?.is_transient === true) return "vendor_error";

  const status = httpStatus(e, text);
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 408) return "timeout";
  if (status !== null && status >= 500) return "vendor_error";

  if (/RESOURCE_EXHAUSTED|rate.?limit|too many requests/i.test(text)) return "rate_limited";
  if (/\b(UNAVAILABLE|INTERNAL)\b/.test(text)) return "vendor_error";
  if (/UNAUTHORI[SZ]ED|UNAUTHENTICATED|invalid_token|invalid_grant|token (?:has )?(?:expired|been revoked)|revoked|cannot be verified|\breconnect\b/i.test(text)) return "auth";
  return "unknown";
}

export function isRetryableAdReadKind(k: AdReadErrorKind): boolean {
  return k === "rate_limited" || k === "vendor_error" || k === "timeout";
}
