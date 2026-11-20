import { callWebSearchTool } from "@/services/mcp/internal/web-search";
import { companyWebsiteHost } from "./domain-host";
import { hasAnthropicAuth } from "@/services/anthropic";
import { apiComplete, type EnrichmentComplete } from "./text-model";
import { logEvent } from "@/services/logging/logEvent";
import { z } from "zod";

type CompetitorGap = "web_search_no_results" | "no_competitors_extracted" | "extraction_failed";
function logCompetitorGap(code: CompetitorGap, domain: string, detail: string): void {
  void logEvent({
    level: "warn",
    source: "onboarding.competitors",
    code,
    message: `onboarding.competitors.${code} domain=${domain} ${detail}`,
    meta: {},
  });
}

function searchReason(search: Awaited<ReturnType<typeof callWebSearchTool>> | null): string {
  if (!search) return "null";
  if (search.ok === true && !search.is_error) return "ok";
  try {
    return (JSON.parse(search.content) as { error?: string }).error ?? "error";
  } catch {
    return "error";
  }
}

export type CompetitorCandidate = {
  name: string;
  url: string;
  source_title: string;
  source_url: string;
  snippet: string;
};

type SearchResult = { title?: string; url?: string; content?: string; snippet?: string };

function hostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function ownDomainResultFor(
  name: string,
  results: SearchResult[],
): { url: string; host: string } | null {
  if (compactName(name).length < 3) return null;
  for (const r of results) {
    const url = (r.url ?? "").trim();
    const host = url ? hostname(url) : null;
    if (!host) continue;
    if (brandLabelMatches(companyWebsiteHost(host), name)) {
      return { url, host };
    }
  }
  return null;
}

export async function findCompetitors(
  orgName: string,
  domain: string,
  contextText = "",
  complete?: EnrichmentComplete,
): Promise<CompetitorCandidate[]> {
  const own = companyWebsiteHost(domain).toLowerCase();
  if (!orgName.trim() || !own) return [];

  const queries = await competitorQueries(orgName, domain, contextText, complete);
  const searches = await Promise.all(
    queries.map((query) =>
      callWebSearchTool("", "search", {
        query,
        max_results: 10,
        search_depth: "basic",
        include_answer: true,
      }).catch(() => null),
    ),
  );
  const payloads = searches
    .filter((search): search is Awaited<ReturnType<typeof callWebSearchTool>> =>
      Boolean(search && search.ok === true && !search.is_error),
    )
    .flatMap((search) => {
      try {
        return [
          JSON.parse(search.content) as {
            answer?: string;
            results?: SearchResult[];
          },
        ];
      } catch {
        return [];
      }
    });

  if (payloads.length === 0) {
    logCompetitorGap(
      "web_search_no_results",
      domain,
      `queries=${queries.length} reasons=${searches.map(searchReason).join(",")}`,
    );
    return [];
  }

  const results = payloads.flatMap((payload) => payload.results ?? []);
  const uniqueResults: SearchResult[] = [];
  const seenUrls = new Set<string>();
  for (const r of results) {
    const url = (r.url ?? "").trim();
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    uniqueResults.push(r);
  }

  const answers = Array.from(
    new Set(payloads.map((p) => (p.answer ?? "").replace(/\s+/g, " ").trim()).filter(Boolean)),
  );

  const llmCandidates = await extractCompetitorsWithLlm(orgName, domain, contextText, uniqueResults, answers, complete);
  if (llmCandidates.length === 0) {
    logCompetitorGap(
      "no_competitors_extracted",
      domain,
      `results=${uniqueResults.length} answers=${answers.length}`,
    );
  }
  return llmCandidates;
}

type Evidence =
  | { kind: "result"; result: SearchResult }
  | { kind: "summary"; text: string };

const CompetitorPickSchema = z.object({
  name: z.string().min(2).max(60),
  evidence_index: z.number().int().min(1),
  domain: z.preprocess(
    (v) => (typeof v === "string" ? v.slice(0, 253) : undefined),
    z.string().optional(),
  ),
  why: z
    .string()
    .transform((value) => value.slice(0, 200))
    .optional(),
});
type CompetitorPick = z.infer<typeof CompetitorPickSchema>;

const CompetitorLlmSchema = z.object({
  competitors: z.array(z.unknown()),
});

export function parseCompetitorPicks(raw: unknown[]): CompetitorPick[] {
  const picks: CompetitorPick[] = [];
  for (const entry of raw) {
    const parsed = CompetitorPickSchema.safeParse(entry);
    if (parsed.success) picks.push(parsed.data);
    if (picks.length >= 8) break;
  }
  return picks;
}

const CompetitorQuerySchema = z.object({
  category: z.string(),
  queries: z.array(z.string().min(8).max(180)).min(2).max(4),
});

async function competitorQueries(
  orgName: string,
  domain: string,
  contextText: string,
  complete?: EnrichmentComplete,
): Promise<string[]> {
  const fallback = fallbackCompetitorQueries(orgName, domain, contextText);
  if (!complete && !hasAnthropicAuth()) return fallback;

  const system = `You generate web-search queries to find competitors for a company.
Return only JSON inside <queries_json> tags.
1. Infer the clearest product/service category, buyer/user, geography (if the company is location-bound), and core job-to-be-done from the context. If ambiguous, use broader category terms; do NOT force a SaaS/platform framing (support local services, agencies, e-commerce, marketplaces, hardware).
2. Generate 3-4 diverse queries for BUYER ALTERNATIVES: mostly direct competitors, at most one close-adjacent category. Use local/regional terms when the company appears location-bound.
3. CRITICAL: Focus on the CATEGORY and VALUE PROP. Do NOT include the company name, domain, product names, or branded feature names (e.g. if the company mentions "Fleet", do NOT use "Fleet") — this avoids self-biased results.
4. Use phrases like "competitors", "alternatives", "similar platforms", or "companies like".`;

  const user = `Company: ${orgName} (${domain})
Context: ${contextText.slice(0, 1500)}

Return: <queries_json>{"category":"...","queries":["..."]}</queries_json>`;

  try {
    const raw = await (complete ?? apiComplete)({ system, user, maxTokens: 500, timeoutMs: 20_000 });
    const match = raw.match(/<queries_json>([\s\S]*?)<\/queries_json>/);
    if (!match) return fallback;
    const parsed = CompetitorQuerySchema.parse(JSON.parse(match[1]));
    return Array.from(new Set([...fallback.slice(0, 1), ...parsed.queries])).slice(0, 4);
  } catch {
    return fallback;
  }
}

async function extractCompetitorsWithLlm(
  orgName: string,
  domain: string,
  contextText: string,
  results: SearchResult[],
  answers: string[] = [],
  complete?: EnrichmentComplete,
): Promise<CompetitorCandidate[]> {
  if ((!complete && !hasAnthropicAuth()) || (results.length === 0 && answers.length === 0)) return [];
  const evidence: Evidence[] = [
    ...results.slice(0, 20).map((result) => ({ kind: "result" as const, result })),
    ...answers.slice(0, 4).map((text) => ({ kind: "summary" as const, text })),
  ];
  const evidenceText = evidence
    .map((item, index) => {
      if (item.kind === "summary") {
        return `${index + 1}. [SUMMARY] ${item.text.slice(0, 700)}`;
      }
      const title = (item.result.title ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
      const url = (item.result.url ?? "").trim();
      const snippet = (item.result.content ?? item.result.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
      return `${index + 1}. [RESULT] TITLE: ${title}\nURL: ${url}\nSNIPPET: ${snippet}`;
    })
    .join("\n\n");

  const system = `You identify competitors from web-search evidence.
Return only a JSON object inside <competitors_json> tags.
1. Use the provided context to understand what the company does.
2. Review the search evidence and pick 3-8 high-quality competitors.
3. Every competitor MUST be EXPLICITLY NAMED in the numbered evidence item it cites via "evidence_index" — do not use prior knowledge or a name not present in that item. A [SUMMARY] is valid only if it explicitly names the entity as a competitor, alternative, or similar provider.
4. Use the competitor's own brand name (e.g. "Acme"), never a blog/article title or a listicle publisher.
5. Prefer direct competitors (similar product + same ICP, and same geography when the company is location-bound) or close adjacents.
6. Reject: the company itself; generic blogs/directories/listicles; unrelated tools; app-development / white-label / clone-script vendors (they sell software to BUILD a company like this — they are NOT competitors); and companies serving a different country/market when the company is location-bound.
7. For each, provide a brief "why" explaining the overlap.
8. For each, also return "domain": that competitor's OWN primary website's registrable domain, from your own knowledge (e.g. "acme.com" — no scheme, no path, no "www."). Use "" when you are not sure. NEVER return the domain of an article, blog, directory, listicle or news site that merely mentions the competitor — not even by copying a URL out of the evidence above. Rule 3 still binds the NAME to the evidence; only "domain" may come from your own knowledge.`;

  const user = `Company: ${orgName} (${domain})
Context: ${contextText.slice(0, 1500)}

Search Evidence:
${evidenceText}

Return: <competitors_json>{"competitors":[{"name":"Name","evidence_index":1,"domain":"name.com","why":"..."}]}</competitors_json>`;

  try {
    const raw = await (complete ?? apiComplete)({ system, user, maxTokens: 1000, timeoutMs: 30_000 });
    const match = raw.match(/<competitors_json>([\s\S]*?)<\/competitors_json>/);
    if (!match) return [];
    const parsed = CompetitorLlmSchema.parse(JSON.parse(match[1]));
    const picks = parseCompetitorPicks(parsed.competitors);
    return materializeLlmCompetitors(picks, orgName, domain, evidence, results);
  } catch (err) {
    logCompetitorGap(
      "extraction_failed",
      domain,
      `err=${(err as { name?: string })?.name ?? "Error"} status=${(err as { status?: number })?.status ?? "none"}`,
    );
    return [];
  }
}

function materializeLlmCompetitors(
  picks: CompetitorPick[],
  orgName: string,
  domain: string,
  evidence: Evidence[],
  results: SearchResult[],
): CompetitorCandidate[] {
  const own = companyWebsiteHost(domain).toLowerCase();
  const ownName = compactName(orgName);
  const byKey = new Map<string, number>();
  const evidenceEtlds = new Set(
    results
      .map((r) => {
        const raw = (r.url ?? "").trim();
        const host = raw ? hostname(raw) : null;
        return host ? companyWebsiteHost(host) : null;
      })
      .filter((v): v is string => Boolean(v)),
  );
  const out: CompetitorCandidate[] = [];
  for (const pick of picks) {
    const item = evidence[pick.evidence_index - 1];
    if (!item) continue;
    const name = cleanCandidateName(pick.name);
    if (!name) continue;
    const compact = compactName(name);
    if (!compact || compact === ownName) continue;

    const citedUrl = item.kind === "result" ? (item.result.url ?? "").trim() : "";

    const offered = normalizeCompetitorDomain(pick.domain);
    const modelDomain =
      offered && evidenceEtlds.has(offered) && !brandLabelMatches(offered, name) ? null : offered;

    const brand = ownDomainResultFor(name, results);
    const etld = brand ? companyWebsiteHost(brand.host) : modelDomain;
    if (etld === own) continue;

    const nameKey = `name:${compact}`;
    const keys = etld ? [etld, nameKey] : [nameKey];
    const hit = keys.find((k) => byKey.has(k));
    if (hit !== undefined) {
      const idx = byKey.get(hit)!;
      const storedEtld = out[idx].url.replace(/^https:\/\//, "");
      const better =
        etld &&
        (!out[idx].url ||
          (brandLabelMatches(etld, out[idx].name) && !brandLabelMatches(storedEtld, out[idx].name)));
      if (better) {
        out[idx] = { ...out[idx], url: `https://${etld}` };
        byKey.set(etld as string, idx);
      }
      continue;
    }

    const snippet = (item.kind === "summary" ? item.text : resultText(item.result))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 280);
    const sourceTitle =
      item.kind === "result" ? (item.result.title ?? name).slice(0, 160) : name.slice(0, 160);

    for (const k of keys) byKey.set(k, out.length);
    out.push({
      name,
      url: etld ? `https://${etld}` : "",
      source_title: sourceTitle,
      source_url: citedUrl,
      snippet,
    });
    if (out.length >= 6) break;
  }
  return out;
}

function cleanCandidateName(name: string): string | null {
  const cleaned = name
    .replace(/^(introducing|meet|inside|understanding|how|top|best)\s+/i, "")
    .replace(/\s+(competitors?|alternatives?|review|reviews|guide)$/i, "")
    .replace(/[:|].*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const lower = cleaned.toLowerCase();
  const generic = new Set([
    "ai",
    "api",
    "b2b",
    "saas",
    "the",
    "inside",
    "understanding",
    "how ai",
    "ai agents",
    "ai agent",
    "ai assistant",
    "autonomous agents",
    "business operations",
  ]);
  if (
    cleaned.length < 3 ||
    cleaned.length > 50 ||
    generic.has(lower) ||
    /^[0-9]+/.test(cleaned) ||
    cleaned.split(/\s+/).length > 4
  ) {
    return null;
  }
  return cleaned;
}

export function normalizeCompetitorDomain(raw: string | undefined): string | null {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  let host: string;
  try {
    host = new URL(withScheme).hostname;
  } catch {
    return null;
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host)) return null;
  if (/^[0-9.]+$/.test(host)) return null;
  return companyWebsiteHost(host) || null;
}

function compactName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function brandLabelMatches(etld: string, name: string): boolean {
  const label = etld.split(".")[0].replace(/[^a-z0-9]/g, "");
  if (!label) return false;
  return brandNameForms(name).includes(label);
}

function brandNameForms(name: string): string[] {
  const raw = name.trim().toLowerCase();
  const forms = new Set<string>();
  const add = (value: string) => {
    const compact = compactName(value);
    if (compact) forms.add(compact);
  };
  add(raw);
  const withoutLegal = raw.replace(/,?\s+(?:inc|llc|l\.l\.c|ltd|limited|corp|corporation|co|plc|gmbh|sa|bv|ab)\.?$/, "");
  add(withoutLegal);
  add(withoutLegal.replace(/^the\s+/, ""));
  const dotted = raw.match(/^(.+)\.(?:com|co|io|ai|net|org)$/);
  if (dotted) add(dotted[1]);
  return Array.from(forms);
}

function fallbackCompetitorQueries(orgName: string, domain: string, contextText: string): string[] {
  const category = searchCategoryPhrase(contextText);
  const distinctive = distinctiveOfferingPhrase(orgName, contextText);
  if (distinctive) {
    return [
      `"${distinctive}" competitors alternatives`,
      `"${distinctive}" similar companies`,
      `${distinctive} software platform competitors alternatives`,
      `${orgName} ${domain} ${distinctive} competitors alternatives`,
    ];
  }
  return [
    `${orgName} ${domain} competitors alternatives similar companies`,
    `${category} competitors alternatives similar products`,
    `${category} software companies for same customers`,
  ];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function searchCategoryPhrase(contextText: string): string {
  const cleaned = contextText
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-zA-Z0-9 .,&/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = cleaned.split(/(?<=[.!?])\s+/).filter(Boolean);
  const useful =
    sentences.find((sentence) =>
      /\b(provides?|helps?|platform|software|marketplace|service|product|customers?|companies?|teams?)\b/i.test(
        sentence,
      ),
    ) ??
    sentences[0] ??
    cleaned;
  return useful.split(/\s+/).slice(0, 18).join(" ") || "business";
}

function distinctiveOfferingPhrase(orgName: string, contextText: string): string | null {
  const cleaned = contextText
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const escapedOrg = escapeRegExp(orgName.trim());
  const patterns = [
    new RegExp(`\\b${escapedOrg}\\b\\s+(?:provides?|offers?|builds?|sells?)\\s+(?:an?\\s+|the\\s+)?([^.!?\\n]{8,120})`, "i"),
    /\b(?:we|our company|the company)\s+(?:provides?|offers?|builds?|sells?)\s+(?:an?\s+|the\s+)?([^.!?\n]{8,120})/i,
    /\b(?:is|are)\s+(?:an?\s+|the\s+)?([^.!?\n]{8,120})/i,
    /\bhelps?\s+([^.!?\n]{8,120})/i,
  ];
  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    const phrase = match?.[1]
      ?.replace(/\b(like|such as)\b.*$/i, "")
      .replace(/[,;:].*$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (phrase && phrase.split(/\s+/).length >= 3) {
      return phrase.split(/\s+/).slice(0, 10).join(" ");
    }
  }
  return null;
}

function resultText(result: SearchResult): string {
  return result.content ?? result.snippet ?? "";
}

