
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import type { TenantFactKey } from "@/services/agents/company-fact-sheet";

export type FactSource =
  | "human_confirmed"
  | "typed_column"
  | "connector"
  | "onboarding_enrichment"
  | "staff_reviewed"
  | "ai_estimated";

export type CompanyFact = {
  value: string;
  source: FactSource;
  verified_at: string | null;
  source_ref?: string | null;
};

export type CompanyFacts = {
  name: string | null;
  nameIsWorkspaceLabel: boolean;
  website: string | null;
  competitors: string[];
  facts: Partial<Record<TenantFactKey, CompanyFact>>;
};

export const COMPANY_STORY_MAX = 8000;

export const MAX_COMPETITORS = 20;
export const MAX_COMPETITOR_NAME_CHARS = 60;

export function splitCompetitors(value: string | undefined | null): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(",")) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.slice(0, MAX_COMPETITORS);
}

export function joinCompetitors(names: readonly string[]): string {
  return Array.from(
    new Map(names.map((n) => [n.trim().toLowerCase(), n.trim()])).values(),
  )
    .filter(Boolean)
    .slice(0, MAX_COMPETITORS)
    .join(", ");
}

const competitorKey = (name: string): string => name.trim().toLowerCase();

export async function addCompetitorToRecord(
  tenant_id: string,
  name: string,
  source_ref: string,
): Promise<{ ok: boolean; error: string | null; full: boolean }> {
  const wanted = name.trim();
  if (!wanted) return { ok: true, error: null, full: false };

  const current = (await getCompanyFacts(tenant_id)).competitors;
  if (current.some((n) => competitorKey(n) === competitorKey(wanted))) {
    return { ok: true, error: null, full: false };
  }
  if (current.length >= MAX_COMPETITORS) {
    return {
      ok: false,
      error: `the competitor list is full (${MAX_COMPETITORS} names). Remove one before adding "${wanted}".`,
      full: true,
    };
  }
  const { ok, error } = await setCompanyFact(
    tenant_id,
    "competitors",
    joinCompetitors([...current, wanted]),
    source_ref,
  );
  return { ok, error, full: false };
}

export async function removeCompetitorFromRecord(
  tenant_id: string,
  name: string,
  source_ref: string,
): Promise<{ ok: boolean; error: string | null }> {
  const key = competitorKey(name);
  if (!key) return { ok: true, error: null };

  const current = (await getCompanyFacts(tenant_id)).competitors;
  const next = current.filter((n) => competitorKey(n) !== key);
  if (next.length === current.length) return { ok: true, error: null };

  return setCompanyFact(tenant_id, "competitors", joinCompetitors(next), source_ref);
}

export async function getCompanyFacts(tenant_id: string): Promise<CompanyFacts> {
  const tid = asTenantId(tenant_id);
  const client = tenantClient(tid);

  const [factRes, tenantRes] = await Promise.all([
    client.from("tenant_fact").select("key, value_text, source, verified_at, source_ref"),
    client.from("tenants").select("display_name, product_url").limit(1),
  ]);

  if (factRes.error) throw new Error(`company facts read failed: ${factRes.error.message}`);
  if (tenantRes.error) {
    throw new Error(`company tenant read failed: ${tenantRes.error.message}`);
  }

  const facts: Partial<Record<TenantFactKey, CompanyFact>> = {};
  for (const row of (factRes.data ?? []) as Array<{
    key: TenantFactKey;
    value_text: string | null;
    source: FactSource;
    verified_at: string | null;
    source_ref?: string | null;
  }>) {
    const value = (row.value_text ?? "").trim();
    if (!value) continue;
    facts[row.key] = { value, source: row.source, verified_at: row.verified_at, source_ref: row.source_ref ?? null };
  }

  const tenantRow = (tenantRes.data?.[0] ?? null) as {
    display_name?: string | null;
    product_url?: Record<string, unknown> | null;
  } | null;

  const label = (tenantRow?.display_name ?? "").trim() || null;
  const nameFact = facts.company_name?.value ?? null;
  const legacySite =
    typeof tenantRow?.product_url?.marketing === "string"
      ? (tenantRow.product_url.marketing as string)
      : null;

  return {
    name: nameFact ?? label,
    nameIsWorkspaceLabel: nameFact === null && label !== null,
    website: facts.domain?.value ?? legacySite,
    competitors: splitCompetitors(facts.competitors?.value),
    facts,
  };
}

export async function getCompanyName(tenant_id: string): Promise<string | null> {
  return (await getCompanyFacts(tenant_id)).name;
}

export async function setCompanyFact(
  tenant_id: string,
  key: Exclude<TenantFactKey, "domain">,
  value: string,
  source_ref: string,
): Promise<{ ok: boolean; error: string | null }> {
  const { error } = await tenantRpc(asTenantId(tenant_id), "set_tenant_fact", {
    p_key: key,
    p_value_text: value,
    p_source: "human_confirmed",
    p_source_ref: source_ref,
  });
  if (!error) await regenerateBrief(tenant_id);
  return { ok: !error, error: error?.message ?? null };
}

export async function projectCompanyFactValue(
  tenant_id: string,
  key: Exclude<TenantFactKey, "domain">,
  value: string,
  source: Extract<FactSource, "onboarding_enrichment" | "staff_reviewed" | "ai_estimated" | "connector">,
  source_ref: string,
): Promise<{ written: boolean; error: string | null }> {
  const trimmed = value.trim();
  if (!trimmed) return { written: false, error: null };
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "project_tenant_fact", {
    p_key: key,
    p_value_text: trimmed,
    p_source: source,
    p_source_ref: source_ref,
  });
  if (error) return { written: false, error: error.message };
  if (data === true) await regenerateBrief(tenant_id);
  return { written: data === true, error: null };
}

export async function removeMachineFactsFromSource(
  tenant_id: string,
  match: { prefix: string; suffix?: string } | { exact: string; key: string },
): Promise<number> {
  const base = tenantClient(asTenantId(tenant_id))
    .from("tenant_fact")
    .delete()
    .in("source", ["onboarding_enrichment", "ai_estimated"]);
  const q =
    "exact" in match
      ? base.eq("source_ref", match.exact).eq("key", match.key)
      : base.like("source_ref", `${match.prefix}%${match.suffix ?? ""}`);
  const { data, error } = await q.select("key");
  if (error) throw new Error(`company fact removal failed: ${error.message}`);
  const n = (data ?? []).length;
  if (n > 0) await regenerateBrief(tenant_id);
  return n;
}

async function regenerateBrief(tenant_id: string): Promise<void> {
  try {
    const { regenerateCompanyBrief } = await import("./brief");
    await regenerateCompanyBrief(tenant_id);
  } catch (e) {
    console.warn(
      `[company/facts] brief not re-rendered for ${tenant_id}: ${(e as Error).message}`,
    );
  }
}

export async function setCompanyDomain(
  tenant_id: string,
  url: string | null,
  source: FactSource,
  source_ref: string,
): Promise<{ ok: boolean; error: string | null }> {
  const { error } = await tenantRpc(
    asTenantId(tenant_id),
    "set_tenant_company_domain_system",
    { p_url: url, p_source: source, p_source_ref: source_ref },
  );
  if (!error) await regenerateBrief(tenant_id);
  return { ok: !error, error: error?.message ?? null };
}
