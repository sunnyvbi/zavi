
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { upsertAnchorGuarded } from "@/services/memory/upsert-anchor";
import { projectCompanyFactValue } from "@/services/company/facts";
import { COMPANY_SHAPES } from "@/services/onboarding/enrichment/classify-shape-stage";
import { logEvent } from "@/services/logging/logEvent";
import { withVendorContext } from "@/services/vendors/usage";
import { seedCompetitorBrandsFromEnrichment } from "@/routes/onboarding/activate";
import { runWebsiteScan, scanSpendAllowed, type EnrichmentResult } from "./scan";
import { readClaimedScan, saveInlineScan } from "./scan-store";
import { generateWebsiteMemory, type WebsiteMemory } from "./website-memory";
import {
  ONBOARDING_SEED,
  isTenantMember,
  markMemoryFailed,
  markMemoryReady,
  readMemoryRow,
  setMemoryScan,
  type MemoryJobRow,
} from "./background-memory";

const SCANNED_SHAPES = new Set(["marketplace", "saas", "ecommerce", "services", "fintech", "other"]);
const NAME_MAX = 120;

export function scannedShapeAndStage(enrichment: EnrichmentResult | null): { marketplaceShape: string; stage: number } {
  const unknown = { marketplaceShape: "other", stage: 0 };
  if (!enrichment || enrichment.status !== "ok") return unknown;
  const shape = enrichment.inferredShape ?? "";
  if (!SCANNED_SHAPES.has(shape) || shape === "marketplace" || (shape === "other" && enrichment.shapeConfidence !== "high")) return unknown;
  const stage = enrichment.inferredStage;
  return { marketplaceShape: shape, stage: Number.isInteger(stage) && stage! >= 0 && stage! <= 6 ? stage! : 0 };
}

export function storableScannedShape(enrichment: EnrichmentResult | null): string | null {
  if (!enrichment || enrichment.status !== "ok" || enrichment.shapeConfidence !== "high") return null;
  const { marketplaceShape } = scannedShapeAndStage(enrichment);
  if (marketplaceShape === "other") return null;
  return (COMPANY_SHAPES as readonly string[]).includes(marketplaceShape) ? marketplaceShape : null;
}

function scanName(enrichment: EnrichmentResult | null): string | null {
  if (!enrichment || enrichment.status !== "ok") return null;
  const name = (enrichment.company_name ?? "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX).trim();
  return name || null;
}

export type LoadResult = { ok: true; row: MemoryJobRow } | { ok: false; reason: "not_found" | "not_pending" | "not_member" };

export async function loadJob(tenantId: string): Promise<LoadResult> {
  const row = await readMemoryRow(tenantId);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status !== "pending") return { ok: false, reason: "not_pending" };
  if (!(await isTenantMember(tenantId, row.user_id))) return { ok: false, reason: "not_member" };
  return { ok: true, row };
}

export async function scanStatus(scanPublicId: string, userId: string): Promise<string> {
  const scan = await readClaimedScan(scanPublicId, userId);
  return scan?.status ?? "missing";
}

export async function inlineScan(row: MemoryJobRow): Promise<string | null> {
  if (!row.host) return null;
  const host = row.host;
  const enrichment = await withVendorContext({ tenant_id: row.tenant_id, source: "onboarding" }, () =>
    runWebsiteScan(host, row.user_id),
  );
  const id = await saveInlineScan(host, row.user_id, enrichment);
  await setMemoryScan(row.tenant_id, id);
  return id;
}

export { scanSpendAllowed };

async function loadEnrichment(row: MemoryJobRow, scanPublicId: string | null): Promise<EnrichmentResult | null> {
  if (!scanPublicId) return null;
  const scan = await readClaimedScan(scanPublicId, row.user_id);
  if (!scan || scan.status !== "done") return null;
  return scan.enrichment;
}

export type ApplyResult = { name_updated: boolean; shape: string | null };

export async function applyScan(row: MemoryJobRow, scanPublicId: string | null): Promise<ApplyResult> {
  const enrichment = await loadEnrichment(row, scanPublicId);
  const tid = asTenantId(row.tenant_id);
  const result: ApplyResult = { name_updated: false, shape: null };

  const name = scanName(enrichment);
  if (name && row.initial_name && name !== row.initial_name) {
    const { data, error } = await tenantClient(tid)
      .from("tenants")
      .update({ display_name: name })
      .eq("display_name", row.initial_name)
      .select("id");
    if (error) throw new Error(`tenant rename failed: ${error.message}`);
    result.name_updated = ((data ?? []) as unknown[]).length > 0;
  }
  const factName = name ?? row.initial_name ?? "";
  if (factName) {
    const fact = await projectCompanyFactValue(
      row.tenant_id,
      "company_name",
      factName,
      "onboarding_enrichment",
      name ? "read from the customer's website at onboarding" : "guessed from the website address at onboarding",
    );
    if (fact.error) console.warn(`[onboarding/website-memory] company_name fact failed for ${row.tenant_id}: ${fact.error}`);
  }

  const shape = storableScannedShape(enrichment);
  if (shape) {
    const { data, error } = await tenantClient(tid)
      .from("tenants")
      .update({ company_shape: shape, company_shape_source: "inferred" })
      .or("company_shape.is.null,company_shape_source.is.null,company_shape_source.neq.founder")
      .select("id");
    if (error) throw new Error(`tenant shape update failed: ${error.message}`);
    if (((data ?? []) as unknown[]).length > 0) result.shape = shape;
  }

  if (enrichment?.status === "ok" && enrichment.competitors?.length) {
    const names = enrichment.competitors.map((c) => c.name.trim()).filter(Boolean);
    await seedCompetitorBrandsFromEnrichment(row.tenant_id, row.user_id, names);
  }
  return result;
}

export async function generateForJob(row: MemoryJobRow, scanPublicId: string | null): Promise<WebsiteMemory> {
  const enrichment = await loadEnrichment(row, scanPublicId);
  const { data } = await tenantClient(asTenantId(row.tenant_id)).from("tenants").select("display_name").maybeSingle();
  const current = ((data as { display_name?: string | null } | null)?.display_name ?? "").trim();
  const orgName = current || scanName(enrichment) || row.initial_name || row.host || "our company";
  const shape = scannedShapeAndStage(enrichment).marketplaceShape;
  return generateWebsiteMemory({
    orgName,
    host: row.host,
    enrichment,
    shape: shape === "other" ? "company" : shape,
  });
}

export async function writeMemory(tenantId: string, memory: WebsiteMemory): Promise<{ company_stored: boolean; ops_written: boolean }> {
  const { writeCompanyProse } = await import("@/services/company/brief");
  const stored = await writeCompanyProse(tenantId, memory.company, "provisioning", "website onboarding — generated summary");
  const ops = await upsertAnchorGuarded(
    {
      tenant_id: tenantId,
      slug: "ops",
      body_markdown: memory.ops,
      source: ONBOARDING_SEED,
      metadata: { seed: memory.fallback ? "placeholder" : "ai" },
    },
    [ONBOARDING_SEED],
    memory.fallback ? { skipEmbedding: true } : undefined,
  );
  return { company_stored: stored.stored, ops_written: ops !== null };
}

export async function finishJob(
  tenantId: string,
  info: { fallback: boolean; scan_status: string; ms: number },
): Promise<void> {
  await markMemoryReady(tenantId, info.fallback);
  void logEvent({
    level: "info",
    source: "onboarding.website_memory",
    code: "onboarding.website_memory.ready",
    message: `onboarding.website_memory.ready fallback=${info.fallback} scan_status=${info.scan_status} ms=${info.ms}`,
    tenant_id: tenantId,
    meta: { ms: info.ms },
  });
}

export async function failJob(tenantId: string, error: string): Promise<{ marked: boolean }> {
  const row = await readMemoryRow(tenantId);
  if (!row || row.status !== "pending") return { marked: false };
  if (!(await isTenantMember(tenantId, row.user_id))) return { marked: false };
  await markMemoryFailed(tenantId, error || "memory job failed");
  void logEvent({
    level: "warn",
    source: "onboarding.website_memory",
    code: "onboarding.website_memory.failed",
    message: `onboarding.website_memory.failed attempt=${row.attempt} error=${(error || "unknown").slice(0, 300)}`,
    tenant_id: tenantId,
  });
  return { marked: true };
}
