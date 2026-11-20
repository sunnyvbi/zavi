import { competitorsCitedBySources, researchIdea } from "@/services/onboarding/brainstorm-research";
import { MAX_CUSTOM_BRANDS, validateCustomBrands } from "@/services/competitor-intel/brands";
import { getCompanyFacts, joinCompetitors, projectCompanyFactValue, type CompanyFacts } from "./facts";
import { withVendorContext } from "@/services/vendors/usage";

const SEED_MAX_CHARS = 1500;
const RETRY_MS = 10 * 60_000;

const SITE_PLATFORMS = new Set([
  "squarespace", "wix", "shopify", "shopifyplus", "wordpress", "webflow", "weebly", "godaddy",
  "carrd", "jimdo", "strikingly", "framer", "googlesites", "squareonline", "bigcommerce",
  "hostinger", "duda", "ionos", "site123", "zyro", "lovable", "hostgator", "bluehost",
]);
const SITE_PLATFORM_BUSINESS_RE =
  /\b(?:website|web ?site|site|store|page|landing[- ]page|app)[- ]builders?\b|\bno[- ]code\b|\bweb ?hosting\b|\be-?commerce platforms?\b|\bcms\b|\bweb (?:design|development|agency|studio)\b|\bwebsite (?:design|development)\b|\b(?:build|design) (?:custom )?websites\b/i;

function isSitePlatform(name: string): boolean {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/(?:com|org|net)$/, "");
  return SITE_PLATFORMS.has(key);
}

function dropSitePlatforms(names: string[], seed: string): string[] {
  if (SITE_PLATFORM_BUSINESS_RE.test(seed)) return names;
  return names.filter((n) => !isSitePlatform(n));
}

const inFlight = new Map<string, Promise<string[]>>();
const searchedAt = new Map<string, number>();

export function seedFromFacts(record: CompanyFacts): string {
  const f = record.facts;
  const lines = [
    record.name && !record.nameIsWorkspaceLabel ? `Company: ${record.name}` : "",
    f.what_we_sell?.value ? `What it does: ${f.what_we_sell.value}` : "",
    f.who_we_serve?.value ? `Who it serves: ${f.who_we_serve.value}` : "",
    f.markets?.value ? `Markets: ${f.markets.value}` : "",
    record.website ? `Website: ${record.website}` : "",
    f.company_story?.value ? `In their words: ${f.company_story.value}` : "",
  ].filter(Boolean);
  return lines.join("\n").slice(0, SEED_MAX_CHARS).trim();
}

async function research(tenant_id: string, seedText: string | undefined): Promise<string[]> {
  const record = await getCompanyFacts(tenant_id);
  if (record.competitors.length > 0) return record.competitors;
  const seed = (seedText ?? "").trim().slice(0, SEED_MAX_CHARS) || seedFromFacts(record);
  if (!seed) return [];
  if (Date.now() - (searchedAt.get(tenant_id) ?? 0) < RETRY_MS) return [];
  searchedAt.set(tenant_id, Date.now());

  const landscape = await withVendorContext({ tenant_id, source: "company_research" }, () => researchIdea(seed));
  const cited = landscape.grounded
    ? dropSitePlatforms(
        competitorsCitedBySources(landscape.competitors.map((c) => c.name), landscape.evidence_sources),
        seed,
      )
    : [];
  const valid = cited.length ? validateCustomBrands(cited.slice(0, MAX_CUSTOM_BRANDS)) : null;
  const names = valid?.ok ? valid.brands : [];
  if (names.length === 0) return [];

  const { written, error } = await projectCompanyFactValue(
    tenant_id,
    "competitors",
    joinCompetitors(names),
    "ai_estimated",
    "idea web research",
  );
  if (error) throw new Error(error);
  if (written) return names;
  return (await getCompanyFacts(tenant_id)).competitors;
}

export function competitorsFromIdea(tenant_id: string, seedText?: string): Promise<string[]> {
  const running = inFlight.get(tenant_id);
  if (running) return running;
  const job = research(tenant_id, seedText).finally(() => inFlight.delete(tenant_id));
  inFlight.set(tenant_id, job);
  return job;
}

export function __resetIdeaCompetitorsForTest(): void {
  inFlight.clear();
  searchedAt.clear();
}
