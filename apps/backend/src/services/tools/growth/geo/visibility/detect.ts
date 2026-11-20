
import type { RawCitation } from "./dataforseo";

export const MIN_NAME_CHARS = 3;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const URL_RE = /\]\((?:https?:\/\/)[^)\s]*\)|https?:\/\/[^\s)\]>"']+/gi;

export function stripUrls(text: string): string {
  return text.replace(URL_RE, (m) => (m.startsWith("](") ? "]" + " ".repeat(m.length - 1) : " ".repeat(m.length)));
}

export type Span = { start: number; end: number };

export function findName(text: string, name: string): Span[] {
  const n = name.trim();
  if (n.length < MIN_NAME_CHARS) return [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, "giu");
  const prose = stripUrls(text);
  const spans: Span[] = [];
  for (const m of prose.matchAll(re)) {
    if (m.index !== undefined) spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

export function brandAliasesOf(brand: string, ownedDomains: readonly string[]): string[] {
  const out = new Map<string, string>();
  for (const a of [brand, ...ownedDomains]) {
    const t = a.trim();
    if (t.length >= MIN_NAME_CHARS) out.set(t.toLowerCase(), t);
  }
  return [...out.values()];
}

export function mentionSpans(text: string, aliases: readonly string[]): Span[] {
  const spans = aliases.flatMap((a) => findName(text, a));
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) continue;
    merged.push(s);
  }
  return merged;
}

export function rivalsMentioned(text: string, rivals: readonly string[], brand: string): string[] {
  const b = brand.trim().toLowerCase();
  return rivals.filter((r) => r.trim().toLowerCase() !== b && findName(text, r).length > 0);
}

export type ResolvedCitation = {
  url: string;
  domain: string | null;
  title: string | null;
  infra: boolean;
};

export const INFRA_HOSTS: readonly string[] = ["vertexaisearch.cloud.google.com"];

function infraPath(host: string, path: string): boolean {
  return (host === "google.com" && path.startsWith("/url")) || (host === "bing.com" && path.startsWith("/ck/"));
}

export function hostOf(url: string): string | null {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return h.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

const DOMAIN_LIKE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;

export function resolveCitation(c: RawCitation): ResolvedCitation {
  const host = hostOf(c.url);
  let path = "/";
  try {
    path = new URL(c.url).pathname;
  } catch {
  }
  const isInfra = host !== null && (INFRA_HOSTS.includes(host) || infraPath(host, path));
  if (!isInfra) {
    return { url: c.url, domain: host, title: c.title, infra: false };
  }
  const named = (c.domain ?? c.title ?? "").trim().toLowerCase().replace(/^www\./, "");
  if (named && DOMAIN_LIKE.test(named) && !INFRA_HOSTS.includes(named)) {
    return { url: c.url, domain: named, title: c.title, infra: false };
  }
  return { url: c.url, domain: host, title: c.title, infra: true };
}

export function isOwned(domain: string | null, ownedDomains: readonly string[]): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase();
  return ownedDomains.some((o) => {
    const owned = o.toLowerCase().replace(/^www\./, "");
    return d === owned || d.endsWith(`.${owned}`);
  });
}

const TRACKING_PARAM = /^(utm_[a-z]+|gclid|fbclid|msclkid|ref|ref_src|srsltid)$/i;

export function canonicalPageUrl(url: string): string | null {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return null;
  }
}

export type AnswerPosition = "primary" | "list_item" | "in_body" | "sources_only" | "absent";

const HEADING_LINE = /^\s*#{1,6}\s/;
const LIST_LINE = /^\s*(?:[-*+•]|\d+[.)])\s+/;
const TABLE_LINE = /^\s*\|/;

export function answerPosition(text: string, spans: readonly Span[], ownedCited: boolean): AnswerPosition {
  if (spans.length === 0) return ownedCited ? "sources_only" : "absent";

  type Line = { start: number; end: number; kind: "heading" | "list" | "table" | "prose" | "blank" };
  const lines: Line[] = [];
  let offset = 0;
  for (const raw of text.split("\n")) {
    const kind: Line["kind"] =
      raw.trim() === ""
        ? "blank"
        : HEADING_LINE.test(raw)
          ? "heading"
          : LIST_LINE.test(raw)
            ? "list"
            : TABLE_LINE.test(raw)
              ? "table"
              : "prose";
    lines.push({ start: offset, end: offset + raw.length, kind });
    offset += raw.length + 1;
  }

  let leadStart = -1;
  let leadEnd = -1;
  for (const l of lines) {
    if (leadStart === -1) {
      if (l.kind === "prose") {
        leadStart = l.start;
        leadEnd = l.end;
      } else if (l.kind === "list" || l.kind === "table") {
        break;
      }
      continue;
    }
    if (l.kind === "prose") leadEnd = l.end;
    else break;
  }

  const lineOf = (pos: number): Line | undefined => lines.find((l) => pos >= l.start && pos <= l.end);
  if (leadStart !== -1 && spans.some((s) => s.start >= leadStart && s.end <= leadEnd)) return "primary";
  if (spans.some((s) => {
    const k = lineOf(s.start)?.kind;
    return k === "list" || k === "table";
  })) {
    return "list_item";
  }
  return "in_body";
}
