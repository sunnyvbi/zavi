import { describeTenantDb, type DescribeResult } from "@/services/data-gateway";

export type DiscoverForTenantResult = DescribeResult;

export const OPERATOR_DB_DISCOVER_FOR_TENANT_C8reverified = true;

export async function discoverCatalogForTenant(
  tenantId: string,
  opts?: { capMs?: number; tableCap?: number; generation?: number | null },
): Promise<DiscoverForTenantResult> {
  return describeTenantDb({ tenant_id: tenantId, caller: { kind: "background", feature: "Schema discovery" } }, opts);
}
