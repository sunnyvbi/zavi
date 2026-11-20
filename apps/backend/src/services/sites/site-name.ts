import { validateCompanyName } from "@/services/provisioning/tenant-slug";
import { decodeXmlEntities } from "@/services/onboarding/enrichment/sanitize";
import { cleanProductName } from "@/services/agents/founder-product-name";
import { clarifiedName, cleanSiteName, siteLabelName, withoutClarifiedName } from "./label";

function usable(raw: string | null | undefined): string | null {
  const name = cleanSiteName(raw);
  if (!name) return null;
  return validateCompanyName(name) ? null : name;
}

export function pickedSiteName(idea: string | null | undefined): string | null {
  const name = usable(clarifiedName(String(idea ?? "")));
  return name ? name.replace(/[*`]/g, "").trim() || null : null;
}

const plain = (v: string | null | undefined) =>
  String(v ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join(" ");

function titled(name: string): string {
  return name.replace(/(^|\s)([a-z])/g, (_m, sp: string, c: string) => `${sp}${c.toUpperCase()}`);
}

export type SiteNameInput = {
  idea: string;
  company_name: string;
  workspace_name?: string | null;
  site_name?: string | null;
};
export type SiteNameDeps = { extract?: (idea: string) => Promise<string | null> };

export async function resolveSiteName(raw: SiteNameInput, deps: SiteNameDeps = {}): Promise<string | null> {
  const input: SiteNameInput = {
    ...raw,
    idea: decodeXmlEntities(String(raw.idea ?? "")),
    company_name: decodeXmlEntities(String(raw.company_name ?? "")),
    workspace_name: raw.workspace_name == null ? raw.workspace_name : decodeXmlEntities(raw.workspace_name),
  };
  const given = usable(input.site_name);
  if (given) return given;
  const picked = pickedSiteName(input.idea);
  if (picked) return picked;
  input.idea = withoutClarifiedName(input.idea);
  const named = ideaGivenName(input.idea);
  const sure = named && (named.quoted || /^[\p{Lu}\p{N}]/u.test(named.name)) ? usable(named.name) : null;
  if (sure) return sure;
  const company = plain(input.company_name);
  const workspace = plain(input.workspace_name);
  if (company && workspace && company !== workspace && company !== "my company") {
    const typed = usable(input.company_name);
    if (typed) return typed;
  }
  if (deps.extract) {
    const extracted = usable(await deps.extract(input.idea).catch(() => null));
    if (extracted) return extracted;
  }
  const fromIdea = siteLabelName({ idea: input.idea, company_name: input.company_name, workspace_name: input.workspace_name ?? null });
  return usable(fromIdea === input.company_name ? fromIdea : titled(fromIdea));
}

const NOT_A_NAME = new Set(
  (
    "after by for from the a an to it its this that these those something whatever as in on at of with and or " +
    "me my our your his her their out up so because what which who when where like"
  ).split(" "),
);
const WORD = "[\\p{L}\\p{N}][\\p{L}\\p{N}\\p{M}&'\u2019-]*";
const CAP_WORD = "[\\p{Lu}\\p{N}][\\p{L}\\p{N}\\p{M}&'\u2019-]*";
const QUOTED = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:called|named|name it|brand(?:ed)? as)\\s+(?:"([^"\\n]{2,40})"|\u201c([^\u201d\\n]{2,40})\u201d|'((?:[^'\\n]|'(?=\\p{L}))+?)'(?!\\p{L})|\u2018((?:[^\u2019\\n]|\u2019(?=\\p{L}))+?)\u2019(?!\\p{L}))`,
  "giu",
);
const BARE = new RegExp(`(?<![\\p{L}\\p{N}])(?:[Cc]alled|[Nn]amed|CALLED|NAMED)\\s+(${WORD}(?:\\s+(?:&\\s+)?${CAP_WORD}){0,3})`, "gu");

export function ideaGivenName(rawIdea: string): { name: string; quoted: boolean } | null {
  const idea = decodeXmlEntities(String(rawIdea ?? ""));
  for (const m of idea.matchAll(QUOTED)) {
    const name = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (name.length >= 2 && name.length <= 40) return { name, quoted: true };
  }
  for (const m of idea.matchAll(BARE)) {
    const name = m[1].replace(/[&'\u2019-]+$/u, "").trim();
    const first = name.split(/\s+/)[0] ?? "";
    if (!name || (first === first.toLowerCase() && NOT_A_NAME.has(first))) continue;
    return { name, quoted: false };
  }
  return null;
}

function ideaCallsIt(idea: string, name: string): boolean {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:called|named)\\s+["\u201c'\u2018]?${parts.map(escapeRegExp).join("\\s+")}(?![\\p{L}\\p{N}])`, "iu").test(idea);
}

export type SiteBrand = { name: string; from: "idea" | "founder" | "site" | "none" };

function escapeRegExp(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function ideaNamesIt(rawIdea: string, rawName: string): boolean {
  const idea = decodeXmlEntities(String(rawIdea ?? ""));
  const parts = String(rawName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${parts.map(escapeRegExp).join("\\s+")}(?![\\p{L}\\p{N}])`, "giu");
  for (const m of idea.matchAll(re)) {
    const start = m.index ?? 0;
    const sentenceStart = /(^|[.!?:\n]\s*)$/.test(idea.slice(0, start));
    for (const w of m[0].matchAll(/[\p{L}\p{N}][^\s]*/gu)) {
      const at = start + (w.index ?? 0);
      if (at === start && sentenceStart) continue;
      if (/\p{Lu}/u.test(w[0])) return true;
    }
  }
  return false;
}

export function siteBrandName(input: { idea: string; siteName?: string | null; founderName?: string | null }): SiteBrand {
  const idea = decodeXmlEntities(String(input.idea ?? ""));
  const clean = (v: string | null | undefined) => cleanProductName(cleanSiteName(v));
  const picked = clean(pickedSiteName(idea));
  if (picked) return { name: picked, from: "idea" };
  return siteBrandFromIdea(withoutClarifiedName(idea), input);
}

function siteBrandFromIdea(idea: string, input: { siteName?: string | null; founderName?: string | null }): SiteBrand {
  const clean = (v: string | null | undefined) => cleanProductName(cleanSiteName(v));
  const site = clean(input.siteName);
  if (site && ideaCallsIt(idea, site)) return { name: site, from: "idea" };
  const explicit = clean(ideaGivenName(idea)?.name);
  if (explicit) return { name: explicit, from: "idea" };
  if (site && ideaNamesIt(idea, site)) return { name: site, from: "idea" };
  const founder = clean(input.founderName);
  if (founder) return { name: founder, from: "founder" };
  if (site) return { name: site, from: "site" };
  return { name: "the company", from: "none" };
}
