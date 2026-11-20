
import { z } from "zod";

export const GOOGLE_PAGESPEED_API_KEY_ENV = "GOOGLE_PAGESPEED_API_KEY";

export type GoogleApiUnavailable =
  | { kind: "not_configured"; env_var: string }
  | { kind: "rate_limited"; retry_after_seconds: number | null }
  | { kind: "http_error"; status: number; message: string }
  | { kind: "timeout"; timeout_ms: number }
  | { kind: "network_error"; message: string }
  | { kind: "malformed_response"; message: string };

export function isGoogleApiUnavailable(
  r: { kind: string },
): r is GoogleApiUnavailable {
  return (
    r.kind === "not_configured" ||
    r.kind === "rate_limited" ||
    r.kind === "http_error" ||
    r.kind === "timeout" ||
    r.kind === "network_error" ||
    r.kind === "malformed_response"
  );
}

export function readGoogleApiKey(): string | null {
  const raw = process.env[GOOGLE_PAGESPEED_API_KEY_ENV];
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

export function notConfigured(): GoogleApiUnavailable {
  return { kind: "not_configured", env_var: GOOGLE_PAGESPEED_API_KEY_ENV };
}

export function redactKey(text: string, key: string | null): string {
  if (!key) return text;
  return text.split(key).join("[redacted]");
}

const MAX_ERROR_BODY = 400;

const googleErrorSchema = z
  .object({
    error: z
      .object({
        message: z.string().optional().catch(undefined),
        status: z.string().optional().catch(undefined),
      })
      .optional()
      .catch(undefined),
  })
  .catch({});

function messageFromErrorBody(body: string): string {
  try {
    const parsed = googleErrorSchema.safeParse(JSON.parse(body));
    const msg = parsed.success ? parsed.data.error?.message : undefined;
    if (msg && msg.trim().length > 0) return msg.trim().slice(0, MAX_ERROR_BODY);
  } catch {
  }
  return body.trim().slice(0, MAX_ERROR_BODY);
}

export type GoogleJsonOk = { kind: "ok"; json: unknown; status: number };

export async function requestGoogleJson(opts: {
  url: string;
  key: string;
  timeoutMs: number;
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
}): Promise<GoogleJsonOk | GoogleApiUnavailable> {
  const { url, key, timeoutMs, method = "GET", body, signal } = opts;

  const withKey = new URL(url);
  withKey.searchParams.set("key", key);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onAbort = () => ac.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  let res: Response;
  try {
    res = await fetch(withKey.toString(), {
      method,
      signal: ac.signal,
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    if (ac.signal.aborted) return { kind: "timeout", timeout_ms: timeoutMs };
    const msg = e instanceof Error ? e.message : String(e);
    return { kind: "network_error", message: redactKey(msg, key) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  if (res.status === 429) {
    const header = res.headers.get("retry-after");
    const seconds = header !== null && /^\d+$/.test(header.trim()) ? Number(header.trim()) : null;
    return { kind: "rate_limited", retry_after_seconds: seconds };
  }

  if (!res.ok) {
    let raw = "";
    try {
      raw = await res.text();
    } catch {
      raw = "";
    }
    return {
      kind: "http_error",
      status: res.status,
      message: redactKey(messageFromErrorBody(raw), key),
    };
  }

  try {
    return { kind: "ok", json: await res.json(), status: res.status };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { kind: "malformed_response", message: redactKey(msg, key) };
  }
}
