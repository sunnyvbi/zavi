
import { createHash } from "node:crypto";
import {
  fetchWithGuards,
  MAX_BODY_BYTES,
  WALLCLOCK_MS,
} from "@/services/mcp/internal/web_fetch_core";

export function normalizeForDiff(s: string): string {
  return s
    .replace(/<\/?untrusted_web_content>/gi, "")
    .replace(/…\[truncated\]\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripFetchNotes(s: string): string {
  return s
    .replace(/…\[truncated\]/gu, "")
    .replace(/\[(?:excerpt|body)_truncated:[^\]]*\]/g, "");
}

export function watchContentHash(content: string): string {
  return createHash("sha256").update(normalizeForDiff(stripFetchNotes(content)), "utf8").digest("hex");
}

export function conditionIsPageOnly(condition: string): boolean {
  const urlCount = (condition.match(/\bhttps?:\/\/[^\s<>"'`]+/gi) ?? []).length;
  if (urlCount > WATCH_MAX_URLS) return false;
  const rest = condition
    .replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, (u) => ` PAGE${u.match(/[.,;!?]+$/u)?.[0] ?? ""}`)
    .trim();
  if (/\b(or|and|but|unless|also|otherwise|plus|either|as well|if|then|while)\b/i.test(rest)) return false;
  const clauses = rest
    .replace(/(\d)[.,](?=\d)/g, "$1")
    .split(/[.,;!?\n]+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  return clauses.length <= 1;
}

export type Refetch = (url: string) => Promise<{ content: string; ok: boolean }>;

export async function guardedRefetch(
  url: string,
  fetchImpl: typeof fetchWithGuards = fetchWithGuards,
): Promise<{ content: string; ok: boolean }> {
  try {
    const r = await fetchImpl(url, {
      max_bytes: MAX_BODY_BYTES,
      timeout_ms: WALLCLOCK_MS,
    });
    const ok = r.capture === "dom_text" || r.capture === "social_card";
    return { content: r.body_text, ok };
  } catch {
    return { content: "", ok: false };
  }
}

export const WATCH_MAX_URLS = 5;

export function extractWatchUrls(condition: string): string[] {
  const out: string[] = [];
  const re = /\bhttps?:\/\/[^\s<>"'`]+/gi;
  for (const m of condition.matchAll(re)) {
    let raw = m[0].replace(/[.,;:!?)\]}]+$/u, "");
    if (/^http:\/\//i.test(raw)) raw = `https://${raw.slice("http://".length)}`;
    let url: string;
    try {
      url = new URL(raw).toString();
    } catch {
      continue;
    }
    if (!out.includes(url)) out.push(url);
    if (out.length >= WATCH_MAX_URLS) break;
  }
  return out;
}

export type UrlBaseline = Record<string, string>;

export type UrlWatchCheck =
  | { kind: "no_delta" }
  | { kind: "first"; baseline: UrlBaseline }
  | { kind: "delta"; baseline: UrlBaseline; changed: string[]; uncertain: boolean };

export async function checkUrlWatch(
  urls: readonly string[],
  stored: UrlBaseline | null | undefined,
  refetch: Refetch,
): Promise<UrlWatchCheck> {
  const prev: UrlBaseline = stored && typeof stored === "object" ? stored : {};
  const reads = await Promise.all(urls.map(async (u) => ({ url: u, ...(await refetch(u)) })));
  const next: UrlBaseline = {};
  const changed: string[] = [];
  let uncertain = false;
  const firstCheck = urls.every((u) => typeof prev[u] !== "string");
  for (const r of reads) {
    if (!r.ok) {
      uncertain = true;
      if (typeof prev[r.url] === "string") next[r.url] = prev[r.url];
      continue;
    }
    const h = watchContentHash(r.content);
    next[r.url] = h;
    if (prev[r.url] !== h) changed.push(r.url);
  }
  if (firstCheck) return { kind: "first", baseline: next };
  if (!uncertain && changed.length === 0) return { kind: "no_delta" };
  return { kind: "delta", baseline: next, changed, uncertain };
}
