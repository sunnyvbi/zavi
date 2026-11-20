import { ExpectedToolError } from "@/services/tools/types";
import { SPOTIFY_ADS_API_BASE } from "./constants";

export async function spotifyAdsGet<T>(
  accessToken: string,
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  if (!/^[a-z_]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path)) {
    throw new ExpectedToolError("spotify_ads_bad_path", "spotify_ads: invalid API resource path");
  }
  const url = new URL(path, SPOTIFY_ADS_API_BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url.href, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    throw new ExpectedToolError(
      resp.status === 401 || resp.status === 403 ? "spotify_ads_forbidden" : "spotify_ads_http_error",
      `Spotify Ads API HTTP ${resp.status}.${
        resp.status === 403
          ? " Check Ads API terms acceptance / allowlisting and ad-account permissions; reauthorizing alone may not help."
          : ""
      }`,
    );
  }
  try {
    return (await resp.json()) as T;
  } catch {
    throw new ExpectedToolError("spotify_ads_bad_response", "Spotify Ads API returned non-JSON.");
  }
}
