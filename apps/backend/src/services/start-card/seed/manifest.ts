import { canonicalDomain, type ManifestItem } from "./store";

const PLATFORM_HOSTS = [
  "apple.com", "google.com", "play.google.com", "github.com", "github.io", "gitlab.com",
  "linkedin.com", "twitter.com", "x.com", "facebook.com", "instagram.com", "tiktok.com",
  "youtube.com", "medium.com", "substack.com", "notion.site", "notion.so", "vercel.app",
  "netlify.app", "herokuapp.com", "webflow.io", "framer.website", "framer.ai", "carrd.co",
  "wixsite.com", "squarespace.com", "producthunt.com", "ycombinator.com", "bit.ly",
  "linktr.ee", "chrome.google.com", "chromewebstore.google.com", "apps.apple.com",
];

export function companyDomain(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`).hostname;
  } catch {
    return null;
  }
  const d = canonicalDomain(host);
  if (!d.includes(".") || /^\d+(\.\d+){3}$/.test(d) || d.includes(":")) return null;
  if (PLATFORM_HOSTS.some((p) => d === p || d.endsWith(`.${p}`))) return null;
  return d;
}

export type YcCompany = { website?: unknown; status?: unknown; team_size?: unknown; launched_at?: unknown };

export function pickYc(rows: YcCompany[], opts: { maxTeam: number }): ManifestItem[] {
  return rows
    .filter((r) => r.status === "Active")
    .filter((r) => typeof r.team_size === "number" && r.team_size > 0 && r.team_size <= opts.maxTeam)
    .sort((a, b) => Number(b.launched_at ?? 0) - Number(a.launched_at ?? 0))
    .map((r) => companyDomain(r.website))
    .filter((d): d is string => d !== null)
    .map((domain) => ({ domain, source: "yc" as const }));
}

export function mergeManifest(lists: ManifestItem[][], limit: number, exclude: Iterable<string> = []): ManifestItem[] {
  const seen = new Set<string>([...exclude].map(canonicalDomain));
  const out: ManifestItem[] = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max && out.length < limit; i++) {
    for (const l of lists) {
      const it = l[i];
      if (!it) continue;
      const d = canonicalDomain(it.domain);
      if (seen.has(d)) continue;
      seen.add(d);
      out.push({ domain: d, source: it.source });
      if (out.length >= limit) break;
    }
  }
  return out;
}
