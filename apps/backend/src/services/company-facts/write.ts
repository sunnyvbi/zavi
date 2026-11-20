
import { z } from "zod";
import { normalizeCompetitors, type TenantFactKey } from "@/services/agents/company-fact-sheet";
import { normalizeCountryCode } from "@/services/ad-locations/country";

export const FACT_KEYS = [
  "domain",
  "what_we_sell",
  "who_we_serve",
  "competitors",
  "company_name",
  "markets",
  "country",
] as const satisfies readonly TenantFactKey[];

export const RETIRED_FACT_KEYS = ["company_goals"] as const satisfies readonly TenantFactKey[];
const RETIRED: ReadonlySet<string> = new Set(RETIRED_FACT_KEYS);

const MAX_VALUE_CHARS: Partial<Record<(typeof FACT_KEYS)[number], number>> = {
  competitors: 1300,
};
const DEFAULT_MAX_VALUE_CHARS = 500;

export const CompanyFactsBody = z.object({
  facts: z
    .array(
      z
        .object({
          key: z.enum([...FACT_KEYS, ...RETIRED_FACT_KEYS]),
          value: z.string().max(1300),
        })
        .superRefine((f, ctx) => {
          const max =
            MAX_VALUE_CHARS[f.key as (typeof FACT_KEYS)[number]] ?? DEFAULT_MAX_VALUE_CHARS;
          if (f.key === "country" && f.value.trim() !== "" && normalizeCountryCode(f.value) === null) {
            ctx.addIssue({ code: "custom", path: ["value"], message: "country must be a two-letter ISO country code, e.g. US." });
          }
          if (f.value.length > max) {
            ctx.addIssue({
              code: "custom",
              path: ["value"],
              message: `${f.key} is limited to ${max} characters.`,
            });
          }
        }),
    )
    .min(1)
    .max(FACT_KEYS.length + RETIRED_FACT_KEYS.length)
    .transform((facts) =>
      facts.filter(
        (f): f is { key: (typeof FACT_KEYS)[number]; value: string } => !RETIRED.has(f.key),
      ),
    ),
});

export function normalizeForKey(
  key: TenantFactKey,
  raw: string,
): { value: string; rejected: string[] } {
  if (key === "competitors") return normalizeCompetitors(raw);
  if (key === "country") return { value: normalizeCountryCode(raw) ?? raw.trim(), rejected: [] };
  return { value: normalizeIfUrl(key, raw), rejected: [] };
}

export function normalizeIfUrl(key: TenantFactKey, raw: string): string {
  const s = raw.trim();
  if (!s) return s;
  if (key !== "domain" && key !== "signup_url" && key !== "pricing_page") return s;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return s;
    if (!u.hostname.includes(".")) return s;
    if (key === "domain") return `https://${u.hostname}`;
    return `https://${u.hostname}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return s;
  }
}

export async function mergeProductUrlKey(
  sb: { from: Function; rpc: Function },
  tenant_id: string,
  key: "marketing" | "api",
  value: string | null,
): Promise<{ error: { message: string } | null }> {
  const { data, error: readErr } = await sb
    .from("tenants")
    .select("product_url")
    .eq("id", tenant_id)
    .maybeSingle();
  if (readErr) return { error: { message: `product_url read failed: ${readErr.message}` } };

  const raw = (data?.product_url ?? {}) as Record<string, unknown>;
  const next: Record<string, string> = {};
  for (const k of ["marketing", "api"] as const) {
    if (typeof raw[k] === "string" && raw[k]) next[k] = raw[k] as string;
  }
  if (value) next[key] = value;
  else delete next[key];

  return await sb.rpc("set_tenant_product_url_system", {
    p_tenant_id: tenant_id,
    p_product_url: next,
  });
}

export type ProjectableFactKey = Extract<
  TenantFactKey,
  | "what_we_sell"
  | "who_we_serve"
  | "competitors"
  | "markets"
  | "company_name"
  | "industry"
  | "location"
  | "founded"
  | "linkedin_url"
  | "instagram_url"
  | "facebook_url"
  | "x_url"
  | "company_story"
>;

export async function projectCompanyFact(
  sb: { rpc: Function },
  tenant_id: string,
  key: ProjectableFactKey,
  raw: string,
  source: "staff_reviewed" | "ai_estimated",
  source_ref: string,
  opts?: { deferRender?: boolean },
): Promise<{ written: boolean; error: string | null }> {
  if ((key as string) === "domain") {
    throw new Error("projectCompanyFact: domain must go through set_tenant_company_domain_system");
  }

  const value = normalizeForKey(key, raw).value.trim();
  if (!value) return { written: false, error: null };

  const { data, error } = await sb.rpc("project_tenant_fact", {
    p_tenant_id: tenant_id,
    p_key: key,
    p_value_text: value,
    p_source: source,
    p_source_ref: source_ref,
  });
  if (error) return { written: false, error: (error as { message: string }).message };

  if (data === true && !opts?.deferRender) {
    try {
      const { regenerateCompanyBrief } = await import("@/services/company/brief");
      await regenerateCompanyBrief(tenant_id);
    } catch (e) {
      console.warn(
        `[company-facts/write] brief not re-rendered for ${tenant_id}: ${(e as Error).message}`,
      );
    }
  }
  return { written: data === true, error: null };
}
