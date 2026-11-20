import type { GrowthIntakeResearchRow } from "@/routes/workspace/growth-intake-research";
import { unescapeExcerpt } from "@/services/growth/plan-dossier";

export type LearnedCard = {
  lines: string[];
  quotes: Array<{ text: string; source_url: string }>;
};

export type LearnedResponse = {
  status: "none" | "pending" | "ready" | "thin" | "failed";
  card: LearnedCard | null;
};

const QUOTE_TOPICS = new Set(["offering", "pricing", "locations", "customers", "differentiation"]);
const MAX_QUOTES = 3;
const MAX_QUOTE_CHARS = 160;
const MAX_NAME_CHARS = 60;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

function joinNames(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function oneLine(s: string): string {
  return unescapeExcerpt(s).replace(/\s+/g, " ").trim();
}

export function learnedCardOf(row: GrowthIntakeResearchRow | null): LearnedResponse {
  if (!row) return { status: "none", card: null };
  if (row.status === "pending" || row.status === "failed") return { status: row.status, card: null };
  const payload = row.payload;
  if (!payload) return { status: row.status, card: null };

  const lines: string[] = [];
  const outside = payload.research_pages ?? [];
  const hosts: string[] = [];
  for (const p of outside) {
    const h = hostOf(p.url);
    if (h && !hosts.includes(h)) hosts.push(h);
  }
  if (row.status === "ready" && hosts.length > 0) {
    lines.push(
      `Read ${outside.length} page${outside.length === 1 ? "" : "s"} about you outside your own site, on ${joinNames(hosts.slice(0, 3))}.`,
    );
  }

  const names = (payload.competitors ?? [])
    .map((c) => oneLine(c.name ?? ""))
    .filter((n) => n.length > 0 && n.length <= MAX_NAME_CHARS && !/[<>]/.test(n))
    .filter((n, i, all) => all.findIndex((m) => m.toLowerCase() === n.toLowerCase()) === i)
    .slice(0, 3);
  if (names.length >= 2) lines.push(`You come up next to ${joinNames(names)}.`);

  const pagesRead = payload.dossier?.pages_read?.length ?? 0;
  if (pagesRead > 0) lines.push(`Read ${pagesRead} page${pagesRead === 1 ? "" : "s"} of your own site.`);

  const quotes: LearnedCard["quotes"] = [];
  for (const f of payload.dossier?.facts ?? []) {
    if (quotes.length >= MAX_QUOTES) break;
    if (!f.own_site || !QUOTE_TOPICS.has(f.topic) || f.as_of) continue;
    const text = oneLine(f.quote ?? "");
    if (text.length < 12 || text.length > MAX_QUOTE_CHARS || /[<>]/.test(text)) continue;
    if (!hostOf(f.source_url)) continue;
    if (quotes.some((q) => q.text.toLowerCase() === text.toLowerCase())) continue;
    quotes.push({ text, source_url: f.source_url });
  }

  if (lines.length === 0 && quotes.length === 0) return { status: row.status, card: null };
  return { status: row.status, card: { lines, quotes } };
}
