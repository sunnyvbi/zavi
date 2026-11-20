import { ExpectedToolError } from "@/services/tools/types";
import { PINTEREST_ADS_API_BASE } from "./constants";

const MAX_PAGES = 20;

export async function pinterestAdsGet<T>(
  accessToken: string,
  path: string,
  params: URLSearchParams = new URLSearchParams(),
): Promise<T> {
  if (!/^[a-z_]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path)) {
    throw new ExpectedToolError("pinterest_ads_bad_path", "pinterest_ads: invalid API resource path");
  }
  const url = new URL(path, PINTEREST_ADS_API_BASE);
  url.search = params.toString();
  const resp = await fetch(url.href, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    throw new ExpectedToolError(
      resp.status === 401 || resp.status === 403 ? "pinterest_ads_forbidden" : "pinterest_ads_http_error",
      `Pinterest Ads API HTTP ${resp.status}.${
        resp.status === 403
          ? " Check app Trial/Standard access, ads:read scope and ad-account permissions; reauthorizing alone may not help."
          : ""
      }`,
    );
  }
  try {
    return (await resp.json()) as T;
  } catch {
    throw new ExpectedToolError("pinterest_ads_bad_response", "Pinterest Ads API returned non-JSON.");
  }
}

export async function pinterestCollect<T>(
  accessToken: string,
  path: string,
  params: URLSearchParams = new URLSearchParams(),
  limit = 500,
): Promise<T[]> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let bookmark: string | null | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const p = new URLSearchParams(params);
    if (bookmark) p.set("bookmark", bookmark);
    const data = await pinterestAdsGet<{ items?: T[]; bookmark?: string | null }>(accessToken, path, p);
    rows.push(...(data.items ?? []).slice(0, Math.max(0, limit - rows.length)));
    bookmark = data.bookmark;
    if (rows.length >= limit || !bookmark || seen.has(bookmark)) return rows;
    seen.add(bookmark);
  }
  return rows;
}
