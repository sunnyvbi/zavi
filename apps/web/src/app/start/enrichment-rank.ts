
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  ndash: "–",
  mdash: "-",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
};

export function decodeEntities(text: string): string {
  let cur = text ?? "";
  for (let i = 0; i < 4; i++) {
    const next = cur.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (m, ent: string) => {
      if (ent[0] === "#") {
        const hex = ent[1] === "x" || ent[1] === "X";
        const code = hex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return NAMED_ENTITIES[ent.toLowerCase()] ?? m;
    });
    if (next === cur) break;
    cur = next;
  }
  return cur.replace(/[<>]/g, " ").replace(/\s+/g, " ").trim();
}

export function brandFromTitle(title: string, host: string): string {
  const segments = decodeEntities(title)
    .split(/\s*\|\s*|\s+[–—\-:·•]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const label = key(host.replace(/^www\./, "").split(".")[0] ?? "");
  const matches = segments.filter((s) => {
    const k = key(s);
    return k.length >= 3 && label.length >= 3 && (label.includes(k) || k.includes(label));
  });
  if (matches.length > 0) return matches.sort((a, b) => a.length - b.length)[0].slice(0, 120);
  if (segments.length === 1 && segments[0].split(/\s+/).length <= 5) return segments[0].slice(0, 120);
  return "";
}

export function isHomepageUrl(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") === "";
  } catch {
    return false;
  }
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
  const parts = h.split(".");
  const twoPartTld =
    parts.length >= 3 &&
    ["co", "com", "org", "gov", "ac", "net", "edu"].includes(parts[parts.length - 2]) &&
    parts[parts.length - 1].length === 2;
  return parts[parts.length - (twoPartTld ? 3 : 2)] === "amazon";
}

export function inferCompanyName(host: string): string {
  if (isPlatformHost(host)) return "";
  const base = host.split(".")[0] || host;
  return base
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

type NamePage = { url: string; title: string };
export type NameSource = {
  company_name?: string;
  domain_pages: NamePage[];
  research_pages?: NamePage[];
};

export function resolveCompanyName(enrichment: NameSource | null | undefined, host: string): string {
  return pickName(enrichment, host).slice(0, 120).trim();
}

function pickName(enrichment: NameSource | null | undefined, host: string): string {
  if (enrichment) {
    const fromBackend = enrichment.company_name ? decodeEntities(enrichment.company_name) : "";
    if (fromBackend) return fromBackend;
    const home = enrichment.domain_pages.find((p) => isHomepageUrl(p.url));
    const fromHome = home ? brandFromTitle(home.title, host) : "";
    if (fromHome) return fromHome;
    const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const label = key(host.replace(/^www\./, "").split(".")[0] ?? "");
    if (label.length >= 3) {
      for (const p of [...enrichment.domain_pages, ...(enrichment.research_pages ?? [])]) {
        const hit = decodeEntities(p.title ?? "")
          .split(/\s*\|\s*|\s+[–—\-:·•]\s+/)
          .find((s) => key(s) === label);
        if (hit) return hit.trim();
      }
    }
  }
  return inferCompanyName(host);
}

export function pageRank(url: string, title: string): number {
  const u = url.toLowerCase();
  const t = title.toLowerCase();
  let path: string | null = null;
  try {
    path = new URL(url).pathname.replace(/\/+$/, "");
  } catch {
  }
  if (path === "" || t.includes("home")) return 0;
  if (u.includes("/about") || t.includes("about")) return 1;
  if (u.includes("/why") || t.includes("why")) return 2;
  if (u.includes("/pricing") || t.includes("pricing")) return 3;
  if (u.includes("/privacy") || u.includes("/terms") || t.includes("privacy") || t.includes("terms")) {
    return 20;
  }
  return 10;
}

export function stripBrandSuffix(title: string, brand: string): string {
  const t = title.trim();
  const b = brand.trim().toLowerCase().replace(/\s+/g, "");
  if (!b) return t;
  const cleaned = t.replace(/\s*[|—–-]\s*[^|—–-]+$/, "").trim();
  if (cleaned.length < 3) return t;
  const tailCore = t.slice(cleaned.length).toLowerCase().replace(/[|—–\-\s]/g, "");
  return tailCore === b ? cleaned : t;
}

export function derivedCompanyName(
  enrichment: (Partial<NameSource> & { status?: string }) | null | undefined,
  host: string,
): string {
  return enrichment && enrichment.status === "ok"
    ? resolveCompanyName({ ...enrichment, domain_pages: enrichment.domain_pages ?? [] }, host)
    : inferCompanyName(host);
}

export function commitCompanyName(
  typed: string | null | undefined,
  enrichment: (Partial<NameSource> & { status?: string }) | null | undefined,
  host: string,
): string {
  return (typed ?? "").trim() || derivedCompanyName(enrichment, host);
}
