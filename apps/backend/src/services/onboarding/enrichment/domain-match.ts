
import { companyWebsiteHost, eTldPlusOne } from "./domain-host";
export { eTldPlusOne } from "./domain-host";

import { callWebSearchTool } from "@/services/mcp/internal/web-search";

export type DomainResolveResult =
  | { domain: string; confidence: number; via: "override" | "tavily" }
  | null;

const MARKETPLACE_SUFFIXES = new Set([
  "rentals",
  "rental",
  "marketplace",
  "market",
  "shop",
  "store",
  "tutor",
  "tutors",
  "tutoring",
  "labs",
  "lab",
  "inc",
  "llc",
  "ltd",
  "co",
  "corp",
  "company",
  "io",
  "app",
  "ai",
]);

export function normalizeOrgName(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(normalized: string): string[] {
  return normalized
    .split(/[\s_-]+/)
    .filter((t) => t.length > 0 && !MARKETPLACE_SUFFIXES.has(t));
}

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const matchDistance = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches = new Array<boolean>(a.length).fill(false);
  const bMatches = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatches[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

const PLATFORM_HOSTS = [
  "facebook.com",
  "fb.com",
  "instagram.com",
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  "linkedin.com",
  "x.com",
  "twitter.com",
  "linktr.ee",
  "etsy.com",
  "apps.apple.com",
  "play.google.com",
];

export function isPlatformHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  if (PLATFORM_HOSTS.some((p) => h === p || h.endsWith(`.${p}`))) return true;
  return eTldPlusOne(h).split(".")[0] === "amazon";
}

const MIN_CONFIDENCE = 0.85;

export type ResolveOpts = { override?: string };

export async function resolveDomain(
  orgName: string,
  opts: ResolveOpts = {},
): Promise<DomainResolveResult> {
  if (opts.override && opts.override.trim().length > 0) {
    let host = opts.override.trim();
    try {
      const withScheme = host.includes("://") ? host : `https://${host}`;
      host = new URL(withScheme).hostname.replace(/\.$/, "");
    } catch {
      return null;
    }
    if (
      /^(\d{1,3}\.){3}\d{1,3}$/.test(host) ||
      host.includes(":")  ||
      !host.includes(".")
    ) {
      return null;
    }
    if (isPlatformHost(host)) return null;
    return { domain: companyWebsiteHost(host), confidence: 1, via: "override" };
  }

  if (!orgName || orgName.trim().length === 0) return null;
  const normalized = normalizeOrgName(orgName);
  const rawTokens = normalized.split(/[\s_-]+/).filter((t) => t.length > 0);
  const meaningfulTokens = tokenize(normalized);
  if (rawTokens.length === 0) return null;

  const compactRaw = rawTokens.join("");
  const compactMeaningful = meaningfulTokens.length > 0 ? meaningfulTokens.join("") : compactRaw;

  const search = await callWebSearchTool("", "search", {
    query: `${orgName} official site`,
    max_results: 5,
    include_answer: false,
  });
  if (search.ok !== true || search.is_error) return null;
  let payload: { results?: Array<{ url?: string }> };
  try {
    payload = JSON.parse(search.content) as { results?: Array<{ url?: string }> };
  } catch {
    return null;
  }
  const results = payload?.results ?? [];
  for (const r of results) {
    if (!r?.url) continue;
    let host: string;
    try {
      host = new URL(r.url).hostname;
    } catch {
      continue;
    }
    const etld = companyWebsiteHost(host);
    const etldRoot = etld.split(".")[0];
    if (!etldRoot) continue;
    const jw = Math.max(
      jaroWinkler(compactRaw, etldRoot),
      jaroWinkler(compactMeaningful, etldRoot),
    );
    const concatRaw = etldRoot === compactRaw;
    const concatMeaningful = etldRoot === compactMeaningful;
    const tokenPresent = rawTokens.includes(etldRoot);
    if (jw >= MIN_CONFIDENCE && (concatRaw || concatMeaningful || tokenPresent)) {
      return { domain: etld, confidence: jw, via: "tavily" };
    }
  }
  return null;
}

