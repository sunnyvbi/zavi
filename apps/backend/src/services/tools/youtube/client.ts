
import { ExpectedToolError } from "@/services/tools/types";

const API_ROOT = "https://www.googleapis.com/youtube/v3";

export const MAX_SEARCH_RESULTS = 10;

export const MAX_SEARCHES_PER_RUN = 4;

const searchSpend = new Map<string, number>();

export function chargeSearchCall(runId: string | null | undefined): void {
  if (!runId) return;
  const spent = searchSpend.get(runId) ?? 0;
  if (spent >= MAX_SEARCHES_PER_RUN) {
    throw new ExpectedToolError(
      "youtube_search_budget_exhausted",
      `This run has already used its ${MAX_SEARCHES_PER_RUN} YouTube searches. The ` +
        "platform shares a 100-searches-per-day bucket across all customers, so the cap " +
        "is real. Work with the results you already have — do NOT report this as an " +
        "absence of data about the company, and do not estimate what another search " +
        "might have returned.",
    );
  }
  searchSpend.set(runId, spent + 1);
}

export function __resetSearchSpend(): void {
  searchSpend.clear();
}

export const MAX_STATS_IDS = 50;

export function youtubeApiKey(): string | null {
  const key = process.env.YOUTUBE_DATA_API_KEY?.trim();
  return key ? key : null;
}

export function requireYoutubeApiKey(): string {
  const key = youtubeApiKey();
  if (!key) {
    throw new ExpectedToolError(
      "youtube_api_key_missing",
      "No YouTube Data API key is configured, so YouTube itself cannot be read on this run: " +
        "no view counts, upload dates, subscriber counts, search results or channel lookups. " +
        "Say so plainly. Do NOT estimate a number, and do NOT describe who holds a query, which " +
        "formats or thumbnails dominate, or which brands are absent: web search returns pages " +
        "ABOUT a query, not the YouTube field. A channel lookup that failed here is could-not-" +
        "verify, never proof the company has no channel. The demand read (YouTube suggest) " +
        "does not need this key and still applies.",
    );
  }
  return key;
}

export async function youtubeGet(
  path: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = new URL(`${API_ROOT}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", requireYoutubeApiKey());

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new ExpectedToolError(
      "youtube_api_unreachable",
      `Could not reach the YouTube Data API: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (res.status === 403) {
    const body = await res.text().catch(() => "");
    const quota = /quota/i.test(body);
    throw new ExpectedToolError(
      quota ? "youtube_quota_exceeded" : "youtube_api_forbidden",
      quota
        ? "YouTube API quota is exhausted for today. This says nothing about the company's " +
          "channel — report the steps that did run and do not infer an absence from it."
        : `YouTube API rejected the key: ${body.slice(0, 300)}`,
    );
  }
  if (!res.ok) {
    throw new ExpectedToolError(
      "youtube_api_error",
      `YouTube Data API returned ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`,
    );
  }
  return (await res.json()) as Record<string, unknown>;
}

export function iso8601DurationToSeconds(iso: string): number | null {
  const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso);
  if (!m) return null;
  const [, d, h, min, s] = m;
  return (
    Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0)
  );
}
