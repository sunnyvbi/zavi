
import { serviceClient } from "@/services/supabase";
import { getSecret } from "@/services/secrets/vault";
import { getConnectorToken } from "@/services/connectors/core/token";
import type { ResourceKind, ResourceMode, ResourceStatus, TenantResourceRow } from "./types";

export type ResolvedCreds = {
  mode: ResourceMode;
  secret: string | null;
  external_ref: Record<string, unknown>;
  provider: string | null;
  status: ResourceStatus;
};

export type ResolveCredsDeps = {
  loadRow: (tenant_id: string, kind: ResourceKind) => Promise<TenantResourceRow | null>;
  getSecret: (tenant_id: string, key: string) => Promise<string | null>;
  getConnectorToken: (tenant_id: string, slug: string, key: string) => Promise<string | null>;
};

export const realResolveCredsDeps: ResolveCredsDeps = {
  async loadRow(tenant_id, kind) {
    const { data, error } = await serviceClient()
      .from("tenant_resources")
      .select("tenant_id, resource_kind, mode, status, provider, external_ref, vault_key, last_error")
      .eq("tenant_id", tenant_id)
      .eq("resource_kind", kind)
      .maybeSingle();
    if (error) throw new Error(`tenant_resources load failed: ${error.message}`);
    return (data as TenantResourceRow | null) ?? null;
  },
  getSecret,
  getConnectorToken,
};

export async function resolveResourceCreds(
  tenant_id: string,
  kind: ResourceKind,
  deps: ResolveCredsDeps = realResolveCredsDeps,
): Promise<ResolvedCreds | null> {
  const row = await deps.loadRow(tenant_id, kind);
  if (!row) return null;

  if (row.mode === "connected") {
    const slug = String(row.external_ref?.connector_slug ?? "");
    const tokenKey = String(row.external_ref?.token_key ?? "");
    const secret =
      slug && tokenKey ? await deps.getConnectorToken(tenant_id, slug, tokenKey) : null;
    return {
      mode: "connected",
      secret,
      external_ref: row.external_ref ?? {},
      provider: row.provider ?? null,
      status: row.status,
    };
  }

  const secret = row.vault_key ? await deps.getSecret(tenant_id, row.vault_key) : null;
  return {
    mode: "provisioned",
    secret,
    external_ref: row.external_ref ?? {},
    provider: row.provider ?? null,
    status: row.status,
  };
}
