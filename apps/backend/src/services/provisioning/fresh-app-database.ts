import { asTenantId, tenantClient } from "@/services/tenant-client";
import { createNeonDbProvisioner, type FreshDatabaseInput } from "./neon-db";
import { attachAppDatabase } from "./render-hosting";
import { realResolveResourcesDeps } from "./resolve-resources";
import type { ProvisionResult } from "./types";

export type FreshAppDatabaseOutcome = "fresh" | "no_app_db";

type DbRow = { mode: string; status: string; provider: string | null; external_ref: Record<string, unknown> | null };

export type FreshAppDatabaseDeps = {
  readDbRow: (tenant_id: string) => Promise<DbRow | null>;
  freshDatabase: (input: FreshDatabaseInput) => Promise<ProvisionResult>;
  record: (tenant_id: string, external_ref: Record<string, unknown>, vault_key: string | null) => Promise<void>;
  attach: (tenant_id: string) => Promise<unknown>;
};

export const realFreshAppDatabaseDeps: FreshAppDatabaseDeps = {
  async readDbRow(tenant_id) {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("tenant_resources")
      .select("mode, status, provider, external_ref")
      .eq("resource_kind", "db")
      .maybeSingle<DbRow>();
    if (error) throw new Error(`db row read failed: ${error.message}`);
    return data ?? null;
  },
  freshDatabase: (input) => createNeonDbProvisioner().freshDatabase(input),
  record: (tenant_id, external_ref, vault_key) =>
    realResolveResourcesDeps.setTenantResource(tenant_id, "db", "provisioned", "ready", "neon", external_ref, vault_key),
  attach: (tenant_id) => attachAppDatabase(tenant_id),
};

export function freshDatabaseName(conductor_run_id: string): string {
  return `app_${conductor_run_id.replace(/[^0-9a-f]/gi, "").toLowerCase().slice(0, 12)}`;
}

export async function giveNewAppFreshDatabase(
  input: { tenant_id: string; conductor_run_id: string },
  deps: FreshAppDatabaseDeps = realFreshAppDatabaseDeps,
): Promise<FreshAppDatabaseOutcome> {
  const row = await deps.readDbRow(input.tenant_id);
  if (!row || row.mode !== "provisioned" || row.status !== "ready" || row.provider !== "neon") return "no_app_db";
  const existing_ref = row.external_ref ?? {};
  if (typeof existing_ref.neon_project_id !== "string" || !existing_ref.neon_project_id) return "no_app_db";

  const result = await deps.freshDatabase({
    tenant_id: input.tenant_id,
    existing_ref,
    database_name: freshDatabaseName(input.conductor_run_id),
  });
  await deps.record(input.tenant_id, result.external_ref, result.vault_keys?.connection_uri ?? null);
  await deps.attach(input.tenant_id);
  return "fresh";
}
