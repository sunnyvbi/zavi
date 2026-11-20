
import { ExpectedToolError } from "@/services/tools/types";
import { tiktokAdsErrorCode } from "./errors";
import {
  TIKTOK_CODE_HINTS,
  tiktokAdsBaseUrl,
} from "./constants";

const TIMEOUT_MS = 20_000;

type Envelope<T> = {
  code: number;
  message: string;
  request_id?: string;
  data?: T;
};

export async function tiktokAdsGet<T>(
  accessToken: string,
  path: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  const query = search.size > 0 ? `?${search}` : "";
  const url = `${tiktokAdsBaseUrl()}/${path.replace(/^\/|\/$/g, "")}/${query}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "Access-Token": accessToken,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!resp.ok) {
    throw new ExpectedToolError(
      "tiktok_ads_http_error",
      `TikTok Ads API HTTP ${resp.status} for ${path} (check method and trailing slash).`,
    );
  }

  let envelope: Envelope<T>;
  try {
    envelope = (await resp.json()) as Envelope<T>;
  } catch {
    throw new ExpectedToolError("tiktok_ads_bad_response", "TikTok Ads API returned non-JSON.");
  }

  if (envelope.code !== 0) {
    const hint = TIKTOK_CODE_HINTS[envelope.code];
    throw new ExpectedToolError(
      tiktokAdsErrorCode(envelope.code),
      `TikTok Ads API error ${envelope.code}: ${envelope.message}${hint ? ` — ${hint}` : ""}`,
    );
  }
  return (envelope.data ?? ({} as T));
}
