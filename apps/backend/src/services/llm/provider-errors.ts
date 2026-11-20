
import type { Provider } from "@/services/llm/models";

export type ProviderErrorKind =
  | "authentication"
  | "context_length"
  | "rate_limit"
  | "server_error"
  | "network_error"
  | "endpoint_not_found"
  | "credits_exhausted"
  | "request_failed"
  | "unknown";

export type ClassifiedProviderError = {
  kind: ProviderErrorKind;
  provider: Provider;
  retryDelayMs: number | null;
  message: string;
};

type RawErrorish = {
  status?: number;
  statusCode?: number;
  code?: string | number;
  message?: string;
  headers?: Record<string, string> | undefined;
  error?: { message?: string; type?: string } | undefined;
};

function readStatus(e: RawErrorish): number | null {
  const s = e.status ?? e.statusCode;
  return typeof s === "number" ? s : null;
}

function readRetryAfterMs(e: RawErrorish): number | null {
  const h = e.headers?.["retry-after"] ?? e.headers?.["Retry-After"];
  if (!h) return null;
  const secs = Number(h);
  return Number.isFinite(secs) ? Math.round(secs * 1000) : null;
}

const NETWORK_ERROR_RE =
  /econnreset|etimedout|enotfound|socket hang up|fetch failed|network|premature close|invalid response body|response body.*terminated|und_err_socket|connection error|request timed out/;

export function classifyProviderError(
  err: unknown,
  provider: Provider,
): ClassifiedProviderError {
  const e = (err ?? {}) as RawErrorish;
  const message = e.message ?? e.error?.message ?? String(err);
  const lower = message.toLowerCase();
  const status = readStatus(e);
  const retryDelayMs = readRetryAfterMs(e);

  const out = (kind: ProviderErrorKind): ClassifiedProviderError => ({
    kind,
    provider,
    retryDelayMs,
    message,
  });

  if (status === 401 || status === 403) return out("authentication");
  if (status === 429) {
    if (/quota|credit|billing|insufficient|exhaust/.test(lower))
      return out("credits_exhausted");
    return out("rate_limit");
  }
  if (status === 404) return out("endpoint_not_found");
  if (status !== null && status >= 500) return out("server_error");

  if (/context length|context window|maximum context|too many tokens|prompt is too long/.test(lower))
    return out("context_length");

  if (status === null && NETWORK_ERROR_RE.test(lower)) return out("network_error");

  if (/quota|credit|billing|insufficient_quota|exhaust/.test(lower))
    return out("credits_exhausted");
  if (/api key|authentication|unauthorized|invalid_api_key/.test(lower))
    return out("authentication");

  if (status !== null && status >= 400) return out("request_failed");
  return out("unknown");
}

export function isRetryableSameModel(kind: ProviderErrorKind): boolean {
  return kind === "rate_limit" || kind === "server_error" || kind === "network_error";
}

export function shouldTryFallbackProvider(kind: ProviderErrorKind): boolean {
  switch (kind) {
    case "rate_limit":
    case "server_error":
    case "network_error":
    case "endpoint_not_found":
    case "credits_exhausted":
      return true;
    case "authentication":
    case "context_length":
    case "request_failed":
    case "unknown":
      return false;
  }
}
