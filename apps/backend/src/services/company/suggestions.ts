
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { inferCompanyCountry, readCountrySignals, type CountryInference } from "@/services/company/country-inference";

const COMPANY_SLUG = "company";

export type CompanySuggestion = {
  value: string;
  from: string;
};

export type CompanySuggestions = {
  what_we_sell?: CompanySuggestion;
  company_story?: CompanySuggestion;
  country?: CompanySuggestion;
};

export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function withoutLeadingHeadings(text: string): string {
  return text.replace(/^(?:\s*#{1,6}[^\n]*(?:\n|$))+/, "");
}

export function firstSentence(text: string, max = 300): string | null {
  const clean = plainText(withoutLeadingHeadings(text));
  if (!clean) return null;
  const match = clean.match(/^.{20,}?[.!?](?=\s|$)/);
  const sentence = (match?.[0] ?? clean).trim();
  if (sentence.length < 20) return null;
  if (!/\s/.test(sentence)) return null;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

export async function readCompanyBrief(tenant_id: string): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("memory_note")
    .select("body_markdown, updated_at")
    .eq("slug", COMPANY_SLUG)
    .is("superseded_by", null)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) return null;
  const body = (data?.[0] as { body_markdown?: string } | undefined)?.body_markdown;
  return typeof body === "string" && body.trim() ? body : null;
}

export async function companySuggestions(
  tenant_id: string,
  missing: ReadonlySet<string>,
  record: { location?: string | null; markets?: string | null } = {},
): Promise<CompanySuggestions> {
  if (missing.size === 0) return {};
  const out: CompanySuggestions = {};
  if (missing.has("country")) {
    const text = { location: record.location ?? null, markets: record.markets ?? null };
    let inference: CountryInference;
    try {
      const signals = await readCountrySignals(tenant_id, {});
      inference = inferCompanyCountry({ ...signals, text });
    } catch {
      inference = inferCompanyCountry({ strong: [], timezones: [], text });
    }
    if (inference.decision === "write") out.country = { value: inference.country, from: inference.source_ref };
    else if (inference.decision === "suggest") out.country = { value: inference.country, from: inference.from };
  }
  const brief = await readCompanyBrief(tenant_id);
  if (!brief) return out;

  if (missing.has("what_we_sell")) {
    const sentence = firstSentence(brief);
    if (sentence) out.what_we_sell = { value: sentence, from: "your company brief" };
  }
  if (missing.has("company_story")) {
    const story = brief.trim().slice(0, 8000);
    out.company_story = { value: story, from: "your company brief" };
  }
  return out;
}
