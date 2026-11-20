
import { ExpectedToolError } from "@/services/tools/types";
import { SNAPCHAT_ADS_API_BASE } from "./constants";

const MAX_PAGES = 20;

type Envelope = {
  request_status?: string;
  request_id?: string;
  paging?: { next_link?: string };
  [plural: string]: unknown;
};

function ok(status?: string): boolean {
  return (status ?? "").toUpperCase() === "SUCCESS";
}

async function getOne(accessToken: string, url: URL): Promise<Envelope> {
  if (url.origin !== "https://adsapi.snapchat.com" || !url.pathname.startsWith("/v1/")) {
    throw new ExpectedToolError("snapchat_ads_bad_url", "snapchat_ads: refusing off-host URL");
  }
  const resp = await fetch(url.href, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    throw new ExpectedToolError(
      resp.status === 401 || resp.status === 403 ? "snapchat_ads_forbidden" : "snapchat_ads_http_error",
      `Snapchat Ads API HTTP ${resp.status}.${
        resp.status === 403
          ? " Check app approval and the user's ad-account permissions; reconnecting alone may not help."
          : ""
      }`,
    );
  }
  let json: Envelope;
  try {
    json = (await resp.json()) as Envelope;
  } catch {
    throw new ExpectedToolError("snapchat_ads_bad_response", "Snapchat Ads API returned non-JSON.");
  }
  if (!ok(json.request_status)) {
    throw new ExpectedToolError(
      "snapchat_ads_error",
      `Snapchat Ads API request failed${json.request_id ? ` [request_id: ${json.request_id}]` : ""}.`,
    );
  }
  return json;
}

export async function snapchatCollection<T>(
  accessToken: string,
  path: string,
  plural: string,
  singular: string,
  params: Record<string, string> = {},
  limit = 500,
  strict = false,
): Promise<T[]> {
  let url = new URL(path, SNAPCHAT_ADS_API_BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const env = await getOne(accessToken, url);
    const items = Array.isArray(env[plural]) ? (env[plural] as Array<Record<string, unknown>>) : [];
    for (const item of items) {
      if (!ok(item.sub_request_status as string | undefined)) {
        if (strict) throw new ExpectedToolError("snapchat_ads_partial", "Snapchat Ads returned a failed sub-request; the list is incomplete.");
        continue;
      }
      const inner = item[singular];
      if (inner && typeof inner === "object") rows.push(inner as T);
      if (rows.length >= limit) return rows;
    }
    const next = env.paging?.next_link;
    if (!next) return rows;
    url = new URL(next);
  }
  return rows;
}
