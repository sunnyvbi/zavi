
import type { CompanyShape } from "@/services/onboarding/enrichment/classify-shape-stage";

export type ShapeSource = "founder" | "mapping" | "inferred" | null;

export type ShapeReads = {
  companyShape: (tenant_id: string) => Promise<{ shape: unknown; source: ShapeSource }>;
  marketplaceConfirmed: (tenant_id: string) => Promise<boolean>;
  fill?: (tenant_id: string, confirmedMarketplace: boolean) => Promise<void>;
};

export type ShapeFillDeps = {
  claimClassify: (tenant_id: string) => Promise<boolean>;
  siteText: (tenant_id: string) => Promise<string | null>;
  classify: (text: string) => Promise<{ shape: CompanyShape; confidence: "high" | "low" }>;
  save: (tenant_id: string, shape: CompanyShape, source: "mapping" | "inferred") => Promise<void>;
};

export function marketingUrl(raw: unknown): string | null {
  const v = raw && typeof raw === "object" ? (raw as { marketing?: unknown }).marketing : raw;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

const CLASSIFY_BUCKET = "company-shape-classify";
const CLASSIFY_WINDOW_S = 10 * 365 * 24 * 3600;

const defaultFillDeps: ShapeFillDeps = {
  claimClassify: async (tenant_id) => {
    const { asTenantId, consumeTenantRateLimit } = await import("@/services/tenant-client");
    return consumeTenantRateLimit(asTenantId(tenant_id), CLASSIFY_BUCKET, 1, CLASSIFY_WINDOW_S);
  },
  siteText: async (tenant_id) => {
    const { asTenantId, tenantClient } = await import("@/services/tenant-client");
    const { data, error } = await tenantClient(asTenantId(tenant_id)).from("tenants").select("product_url").maybeSingle();
    if (error) throw new Error(error.message);
    const url = marketingUrl((data as { product_url?: unknown } | null)?.product_url);
    if (!url) return null;
    let host: string;
    try {
      host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname;
    } catch {
      return null;
    }
    const { eTldPlusOne } = await import("@/services/onboarding/enrichment/domain-match");
    if (eTldPlusOne(host) !== host.replace(/^www\./i, "")) return null;
    const { fetchDomain } = await import("@/services/onboarding/enrichment/fetch-domain");
    const { buildEnrichmentContext } = await import("@/services/onboarding/enrichment/context");
    const crawl = await fetchDomain(host);
    const text = buildEnrichmentContext(crawl.pages, []);
    return text.trim() ? text : null;
  },
  classify: async (text) => (await import("@/services/onboarding/enrichment/classify-shape-stage")).classifyShapeStage(text),
  save: async (tenant_id, shape, source) => {
    const { asTenantId, tenantClient } = await import("@/services/tenant-client");
    const q = tenantClient(asTenantId(tenant_id)).from("tenants").update({ company_shape: shape, company_shape_source: source });
    const { error } = await (source === "mapping" ? q.or("company_shape.is.null,company_shape_source.eq.inferred") : q.is("company_shape", null));
    if (error) throw new Error(error.message);
  },
};

export async function fillBusinessShape(
  tenant_id: string,
  confirmedMarketplace: boolean,
  deps: ShapeFillDeps = defaultFillDeps,
): Promise<void> {
  try {
    if (confirmedMarketplace) {
      await deps.save(tenant_id, "marketplace", "mapping");
      return;
    }
    if (!(await deps.claimClassify(tenant_id))) return;
    const text = await deps.siteText(tenant_id);
    if (!text) return;
    const r = await deps.classify(text);
    if (r.confidence !== "high" || r.shape === "other") return;
    await deps.save(tenant_id, r.shape, "inferred");
  } catch (e) {
    console.warn(`[business-shape] fill failed: ${(e as Error).message}`);
  }
}

const defaultReads: ShapeReads = {
  companyShape: async (tenant_id) => {
    const { asTenantId, tenantClient } = await import("@/services/tenant-client");
    const { data, error } = await tenantClient(asTenantId(tenant_id)).from("tenants").select("company_shape, company_shape_source").maybeSingle();
    if (error) throw new Error(error.message);
    const row = data as { company_shape?: unknown; company_shape_source?: unknown } | null;
    const source = row?.company_shape_source;
    return { shape: row?.company_shape ?? null, source: source === "founder" || source === "mapping" || source === "inferred" ? source : null };
  },
  marketplaceConfirmed: async (tenant_id) => {
    const { resolveMarketplaceConfig } = await import("@/services/marketplace-intel/self-serve");
    return (await resolveMarketplaceConfig(tenant_id)) !== null;
  },
  fill: (tenant_id, confirmedMarketplace) => fillBusinessShape(tenant_id, confirmedMarketplace),
};

export async function resolveBusinessShape(tenant_id: string, reads: ShapeReads = defaultReads): Promise<CompanyShape | null> {
  try {
    const { coerceCompanyShape } = await import("@/services/agents/shape-visibility");
    const { shape: raw, source } = await reads.companyShape(tenant_id);
    const declared = coerceCompanyShape(raw);
    if (declared && source !== "inferred") return declared;
    const confirmed = await reads.marketplaceConfirmed(tenant_id);
    if (declared) {
      if (confirmed && reads.fill) void reads.fill(tenant_id, true).catch(() => undefined);
      return confirmed ? "marketplace" : declared === "marketplace" ? null : declared;
    }
    if (raw == null && reads.fill) void reads.fill(tenant_id, confirmed).catch(() => undefined);
    return confirmed ? "marketplace" : null;
  } catch {
    return null;
  }
}
