
import { noteChatgptWriteAttempt } from "./write-tracking";
import { ExpectedToolError } from "@/services/tools/types";
import { CHATGPT_ADS_API_BASE, CHATGPT_ADS_TIMEOUT_MS } from "./constants";

export type ChatgptAdsQuery = Record<string, string | number | string[] | undefined>;

function buildUrl(path: string, query?: ChatgptAdsQuery): string {
  const url = new URL(`${CHATGPT_ADS_API_BASE}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(`${k}[]`, item);
    else url.searchParams.append(k, String(v));
  }
  return url.toString();
}

export function lifetimeTooSmall(status: number, body: string): ExpectedToolError | null {
  if (status !== 400 || !/lifetime/i.test(body) || !/(minimum|at least|too (low|small)|greater than|below)/i.test(body)) return null;
  const m = /(?:minimum(?: of| is)?|at least|greater than(?: or equal to)?)\s*(?:USD\s*)?\$?\s?([\d,]+(?:\.\d+)?)/i.exec(body);
  let min = m ? Number(m[1].replace(/,/g, "")) : NaN;
  if (Number.isFinite(min) && min >= 100_000) min = min / 1e6;
  const stated = Number.isFinite(min) && min > 0;
  return new ExpectedToolError("chatgpt_ads_lifetime_too_small", `ChatGPT refused this lifetime total as too small${stated ? ` (its minimum is $${min.toFixed(2)})` : ""}. Nothing was created.`, stated ? { min_usd: min } : {});
}

function httpError(status: number, body: string): never {
  const small = lifetimeTooSmall(status, body);
  if (small) throw small;
  if (status === 403 && body.includes("Conversion bidding is not enabled")) throw new ExpectedToolError("chatgpt_ads_conversion_unavailable", "Conversion bidding is not enabled on Zavi’s advertiser account. Zavi must request access from OpenAI.");
  if (status === 401 || status === 403) {
    throw new ExpectedToolError(
      "chatgpt_ads_forbidden",
      `OpenAI Ads API rejected the platform key (HTTP ${status}). The key is missing, revoked, or ` +
        "scoped to a different ad account. This is a Zavi-side credential problem: report the read " +
        "as failed, never as zero spend.",
      { status },
    );
  }
  throw new ExpectedToolError(
    "chatgpt_ads_http_error",
    `OpenAI Ads API returned HTTP ${status}. The request could not be completed. Refresh before retrying.`,
    { status },
  );
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ExpectedToolError(
      "chatgpt_ads_bad_response",
      "OpenAI Ads API returned a body that is not JSON, so nothing could be read from it.",
    );
  }
}

export async function chatgptAdsGet<T>(
  apiKey: string,
  path: string,
  query?: ChatgptAdsQuery,
): Promise<T> {
  const resp = await fetch(buildUrl(path, query), {
    redirect: "error",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(CHATGPT_ADS_TIMEOUT_MS),
  });
  const text = await resp.text();
  if (!resp.ok) httpError(resp.status, text);
  return parseJson<T>(text);
}

export async function chatgptAdsPost<T>(
  apiKey: string,
  path: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<T> {
  const url = buildUrl(path);
  const encoded = JSON.stringify(body);
  noteChatgptWriteAttempt();
  const resp = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: encoded,
    signal: AbortSignal.timeout(CHATGPT_ADS_TIMEOUT_MS),
  });
  const text = await resp.text();
  if (!resp.ok) httpError(resp.status, text);
  return parseJson<T>(text);
}
