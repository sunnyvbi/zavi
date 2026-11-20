
import { baseSlug, tenantSuffix } from "@/services/provisioning/tenant-slug";
import { builtinBaseDomain } from "@/services/provisioning/builtin-url";
import { decodeXmlEntities } from "@/services/onboarding/enrichment/sanitize";

export const SITE_LABEL_COMPANY_MAX = 24;

export const SITE_HOSTNAME_SUFFIX_RE = /^(-[a-z0-9]{1,10})?$/;
export const SITE_BASE_DOMAIN_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export type SiteHostnameConfig = { suffix: string; base_domain: string };

export function siteHostnameConfig(env: Record<string, string | undefined> = process.env): SiteHostnameConfig {
  const suffix = (env.SITE_HOSTNAME_SUFFIX ?? "").trim();
  if (!SITE_HOSTNAME_SUFFIX_RE.test(suffix)) throw new Error("SITE_HOSTNAME_SUFFIX is invalid (expected '' or e.g. '-dev')");
  const base_domain = (env.PRAXIS_PRODUCT_DOMAIN ?? builtinBaseDomain()).trim();
  if (base_domain.length > 200 || !SITE_BASE_DOMAIN_RE.test(base_domain)) throw new Error("site base domain is invalid");
  return { suffix, base_domain };
}

export function siteIdSuffix(siteId: string): string {
  return String(siteId ?? "").replace(/-/g, "").toLowerCase().slice(0, 6);
}

export const SITE_NAME_MAX = 60;

export function cleanSiteName(raw: string | null | undefined): string | null {
  const s = decodeXmlEntities(String(raw ?? ""))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cut = Array.from(s).slice(0, SITE_NAME_MAX).join("").trim();
  return cut || null;
}

function nameSlug(name: string | null | undefined, maxLen: number): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
}

export function siteLabel(companyName: string, tenantId: string, siteId: string, siteName?: string | null): string {
  const slug = nameSlug(cleanSiteName(siteName), SITE_LABEL_COMPANY_MAX) || baseSlug(companyName, SITE_LABEL_COMPANY_MAX);
  return `${slug}-${tenantSuffix(tenantId)}-${siteIdSuffix(siteId)}`;
}

export const SITE_LABEL_NAME_MAX = 40;

export function cleanSiteLabel(companyName: string, siteId: string, siteName?: string | null, firstTry = true): string {
  const slug = nameSlug(cleanSiteName(siteName), SITE_LABEL_NAME_MAX) || nameSlug(companyName, SITE_LABEL_NAME_MAX);
  if (firstTry && slug.length >= 3) return slug;
  return `${slug || "site"}-${siteIdSuffix(siteId)}`;
}

export function siteHostname(label: string, cfg: SiteHostnameConfig = siteHostnameConfig()): string {
  return `${label}${cfg.suffix}.${cfg.base_domain}`;
}

const LABEL_NAME_RE = /^(.+?)-[0-9a-f]{8}-[0-9a-f]{6}$/;
const CLEAN_LABEL_NAME_RE = /^(.+?)-(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{6}$/;

export function siteDisplayName(label: string | null | undefined): string {
  const raw = String(label ?? "").trim().toLowerCase();
  const name = LABEL_NAME_RE.exec(raw)?.[1] ?? CLEAN_LABEL_NAME_RE.exec(raw)?.[1] ?? raw;
  const shown = name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return shown || "Untitled site";
}

export function siteShownName(site: { label?: string | null; name?: string | null }): string {
  return cleanSiteName(site.name) ?? siteDisplayName(site.label);
}

const NAME_MAX_WORDS = 3;
const FILLER = new Set(
  (
    "a an the my our your his her their its me us i we you it this that these those some any " +
    "want wants wanted need needs like would should could can will please just really very also " +
    "to ot make build create design develop launch set up get help let lets show " +
    "simple basic modern responsive clean nice beautiful professional new small single one mobile " +
    "website site web webpage page landing homepage app application platform portal tool online " +
    "booking bookings"
  ).split(" "),
);
const PHRASE_END = new Set(
  "in at on near with without that which where who whose to and or but so from by using there here when while because if than as via".split(" "),
);

function words(text: string): string[] {
  return (
    decodeXmlEntities(text)
      .toLowerCase()
      .replace(/&[a-z#0-9]+;/g, " ")
      .match(/[a-z0-9]+|&/g) ?? []
  );
}

function joinAmp(w: string[]): string[] {
  const out: string[] = [];
  for (const word of w) {
    if (word === "&" && (out.length === 0 || out[out.length - 1] === "&")) continue;
    out.push(word);
  }
  while (out[out.length - 1] === "&") out.pop();
  return out;
}

const wordCount = (w: string[]) => w.filter((x) => x !== "&").length;

const CLARIFIED_NAME_RE = /(?:^|\s)- Name: The business is called "([^"\n]{1,60})"\.?(?=\s|$)/g;

export function withoutClarifiedName(rawIdea: string): string {
  return decodeXmlEntities(String(rawIdea ?? "")).replace(CLARIFIED_NAME_RE, " ");
}

export function clarifiedName(rawIdea: string): string | null {
  const idea = decodeXmlEntities(String(rawIdea ?? ""));
  let found: string | null = null;
  for (const m of idea.matchAll(CLARIFIED_NAME_RE)) found = m[1].trim() || found;
  return found;
}

const LOGO_ANSWER_RE = /(?:^|\n)- Logo: [^\n]*/g;

export function explicitName(rawIdea: string): string | null {
  const idea = decodeXmlEntities(rawIdea).replace(LOGO_ANSWER_RE, "\n");
  const clarified = clarifiedName(idea);
  if (clarified) return clarified;
  const own = ownIdea(idea);
  for (const quoted of own.matchAll(new RegExp(`(?:${NAME_LEAD})\\s+["\u201c']([^"\u201d'\\n]{2,40})["\u201d']`, "gi"))) {
    if (!isPersonalNameLead(own, quoted)) return quoted[1].trim();
  }
  for (const lead of own.matchAll(new RegExp(`(?:${NAME_LEAD})\\s+`, "gi"))) {
    if (isPersonalNameLead(own, lead)) continue;
    const bare = /^[A-Za-z0-9][A-Za-z0-9&'-]*(?:\s+(?:&\s+)?[A-Z0-9][A-Za-z0-9&'-]*){0,3}/.exec(own.slice(lead.index! + lead[0].length));
    if (!bare) continue;
    const name = bare[0].trim();
    const first = name.split(/\s+/)[0]!.toLowerCase();
    if (/^(?:after|for)\b/.test(name)) continue;
    if (!FILLER.has(first) && !PHRASE_END.has(first) && !NOT_A_NAME.has(first)) return name;
  }
  return ownedName(own);
}

export const OWNED_NAME_RE =
  /\b(?:I|we|We)\s+(?:run|own|operate|started|founded|opened|manage)\s+([A-Z0-9][A-Za-z0-9&'\u2019-]*(?:\s+(?:&\s+)?[A-Z0-9][A-Za-z0-9&'\u2019-]*){0,3})(?=\s*(?:[,.;:!?(\u2014\u2013]|\s-\s|$)|\s+(?:in|on|at|from|which|that|where|with|since|here)\b)/;

export const OWNED_NOT_A_BUSINESS = new Set(
  "shopify airbnb google facebook meta instagram uber amazon etsy ebay youtube tiktok linkedin whatsapp twitter pinterest zomato swiggy doordash grubhub wix wordpress squarespace webflow substack patreon fiverr upwork".split(" "),
);

export function ownedName(idea: string): string | null {
  const m = OWNED_NAME_RE.exec(idea);
  if (!m) return null;
  const name = m[1]!.trim();
  const parts = name.split(/\s+/);
  if (/^\d/.test(name)) return null;
  if (OWNED_NOT_A_BUSINESS.has(parts[0]!.toLowerCase())) return null;
  if (parts.length === 1 && (NOT_A_NAME.has(name.toLowerCase()) || FILLER.has(name.toLowerCase()))) return null;
  return name;
}

const NAME_LEAD =
  "\\b(?:called|named|name it|call it|brand(?:ed)? as|(?:(?:website|site|business|shop|store|brand|app|company|bakery|restaurant|cafe)(?:'s)?\\s+)?name\\s+(?:of\\s+(?:the|my|our)\\s+\\w+\\s+)?(?:is|will be|should be|would be|shall be))";

const PERSONAL_NAME_RE = /\b(?:my|his|her|their)(?:\s+(?:first|full|last|real|given))?\s*$/i;
function isPersonalNameLead(idea: string, lead: RegExpMatchArray): boolean {
  const before = idea.slice(0, lead.index);
  return (PERSONAL_NAME_RE.test(before) && /^name\s+(?:is|will be|should be|would be|shall be)\b/i.test(lead[0])) || /\b(?:i\s+am|i'm)\s*$/i.test(before);
}
const NOT_A_NAME = new Set("something anything one best good great nice short catchy memorable unique cool fun later tbd".split(" "));

const CONTEXT_HEADING_RE = /\s*\bAdditional context:/i;

export function ownIdea(rawIdea: string): string {
  const idea = String(rawIdea ?? "");
  const at = idea.search(CONTEXT_HEADING_RE);
  return at < 0 ? idea : idea.slice(0, at);
}

function forPhrase(segment: string): string[] {
  const w = words(segment);
  const at = w.indexOf("for");
  if (at < 0) return [];
  const out: string[] = [];
  for (const word of w.slice(at + 1)) {
    if (word === "&") {
      if (out.length > 0) out.push(word);
      continue;
    }
    if (PHRASE_END.has(word)) {
      if (out.length > 0) break;
      continue;
    }
    if (FILLER.has(word)) {
      if (out.length > 0) break;
      continue;
    }
    out.push(word);
    if (wordCount(out) >= NAME_MAX_WORDS) break;
  }
  return joinAmp(out);
}

const norm = (v: string | null | undefined) => joinAmp(words(String(v ?? ""))).join(" ");

export function siteLabelName(input: { idea: string; company_name: string; workspace_name?: string | null }): string {
  const idea = decodeXmlEntities(String(input.idea ?? "")).slice(0, 2000);
  const company = decodeXmlEntities(String(input.company_name ?? "")).trim();
  const explicit = explicitName(idea);
  if (explicit && norm(explicit)) return norm(explicit);
  const companyNorm = norm(company);
  const workspaceNorm = norm(input.workspace_name);
  const typed = companyNorm && workspaceNorm && companyNorm !== workspaceNorm && companyNorm !== "my company";
  if (typed) return company;
  const segment = ownIdea(idea).split(/[.:;!?\n]/).find((part) => part.trim() && (!/\b(?:my|his|her|their)\s+(?:(?:first|full|last|real|given)\s+)?name\s+is\b|\b(?:i\s+am|i'm)\s+called\b/i.test(part) || forPhrase(part).length > 0)) ?? "";
  const phrase = forPhrase(segment);
  if (phrase.length > 0) return phrase.join(" ");
  const named = describedName(segment);
  if (named.length > 0) return named.join(" ");
  return company;
}

const DOING = new Set(
  "run runs running own owns owned have has operate operates operating manage manages managing start starts starting started open opens opening opened founded launched m ve re ll".split(" "),
);
const GENERIC = new Set("service services business company".split(" "));
const PLACE_LEAD = new Set(["in", "near"]);
const PLACE_MAX_WORDS = 2;

function describedName(segment: string): string[] {
  const w = words(segment).filter((x) => !DOING.has(x));
  const what: string[] = [];
  let at = 0;
  for (; at < w.length; at++) {
    const word = w[at]!;
    if (FILLER.has(word) || word === "for" || GENERIC.has(word)) {
      if (wordCount(what) > 0 && !GENERIC.has(word)) break;
      continue;
    }
    if (PHRASE_END.has(word)) {
      if (wordCount(what) > 0) break;
      continue;
    }
    if (word !== "&" && wordCount(what) >= NAME_MAX_WORDS) break;
    what.push(word);
  }
  const desc = joinAmp(what);
  if (desc.length === 0 || !PLACE_LEAD.has(w[at] ?? "")) return desc;
  const place: string[] = [];
  for (const word of w.slice(at + 1)) {
    if (word === "&" || FILLER.has(word) || PHRASE_END.has(word) || GENERIC.has(word) || place.length >= PLACE_MAX_WORDS) break;
    place.push(word);
  }
  return [...desc, ...place];
}
