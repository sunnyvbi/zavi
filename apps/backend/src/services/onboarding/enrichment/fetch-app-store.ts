
import { callWebSearchTool } from "@/services/mcp/internal/web-search";
import { assertSafeUrl, SsrfBlockedError } from "./url-guard";
import type { AppListing } from "./types";
import { PER_PAGE_TIMEOUT_MS, MAX_BYTES_PER_PAGE } from "./fetch-domain";

async function streamWithCap(
  res: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let bytes = 0;
  const chunks: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value as Uint8Array;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        controller.abort();
        try {
          await reader.cancel();
        } catch {
        }
        break;
      }
      chunks.push(decoder.decode(chunk, { stream: true }));
    }
    chunks.push(decoder.decode());
  } catch {
  }
  return chunks.join("");
}

type StoreId = "ios" | "android";

async function tavilyFindListing(orgName: string, store: StoreId): Promise<string | null> {
  const siteFilter = store === "ios" ? "apps.apple.com" : "play.google.com";
  const search = await callWebSearchTool("", "search", {
    query: `${orgName} app site:${siteFilter}`,
    max_results: 3,
    include_answer: false,
  });
  if (!search.ok || search.is_error) return null;
  let payload: { results?: Array<{ url?: string }> };
  try {
    payload = JSON.parse(search.content) as { results?: Array<{ url?: string }> };
  } catch {
    return null;
  }
  for (const r of payload.results ?? []) {
    if (!r?.url) continue;
    try {
      const u = new URL(r.url);
      if (u.hostname === siteFilter || u.hostname === `www.${siteFilter}`) return u.toString();
    } catch {
    }
  }
  return null;
}

function extractJsonLd(html: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const re = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (Array.isArray(parsed)) {
        for (const p of parsed) {
          if (p && typeof p === "object") out.push(p as Record<string, unknown>);
        }
      } else if (parsed && typeof parsed === "object") {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
    }
  }
  return out;
}

function pickString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (typeof v === "string" && v.length > 0) return v.slice(0, 500);
  return null;
}

function pickNumber(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseListing(url: string, store: StoreId, html: string): AppListing {
  const blocks = extractJsonLd(html);
  let name: string | null = null;
  let version: string | null = null;
  let last_updated: string | null = null;
  let rating: number | null = null;
  let ratings_count: number | null = null;
  let support_url: string | null = null;
  for (const block of blocks) {
    const type = block["@type"];
    if (
      type === "SoftwareApplication" ||
      type === "MobileApplication" ||
      type === "WebApplication"
    ) {
      name = name ?? pickString(block, "name");
      version = version ?? pickString(block, "softwareVersion");
      last_updated = last_updated ?? pickString(block, "datePublished");
      const agg = block["aggregateRating"];
      if (agg && typeof agg === "object") {
        rating = rating ?? pickNumber(agg as Record<string, unknown>, "ratingValue");
        ratings_count =
          ratings_count ?? pickNumber(agg as Record<string, unknown>, "ratingCount");
      }
      support_url = support_url ?? pickString(block, "supportUrl");
    }
  }
  return { store, url, name, version, last_updated, rating, ratings_count, support_url };
}

export async function fetchAppListings(
  orgName: string,
  budget: { perPageTimeoutMs?: number; maxBytesPerPage?: number } = {},
): Promise<AppListing[]> {
  const timeout = budget.perPageTimeoutMs ?? PER_PAGE_TIMEOUT_MS;
  const maxBytes = budget.maxBytesPerPage ?? MAX_BYTES_PER_PAGE;
  const out: AppListing[] = [];
  for (const store of ["ios", "android"] as StoreId[]) {
    const url = await tavilyFindListing(orgName, store);
    if (!url) continue;
    try {
      await assertSafeUrl(url);
    } catch (e) {
      if (e instanceof SsrfBlockedError) continue;
      throw e;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { "user-agent": "PraxisBot/1.0 (+https://zaviagent.com)" },
      });
      if (!res.ok) continue;
      const html = await streamWithCap(res, maxBytes, controller);
      if (!html) continue;
      out.push(parseListing(url, store, html));
    } catch {
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}
