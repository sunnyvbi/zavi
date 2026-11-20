
export type ResourceKind =
  | "repo"
  | "hosting"
  | "db"
  | "stripe"
  | "email"
  | "ads"
  | "domain";

export const RESOURCE_KINDS: readonly ResourceKind[] = [
  "repo",
  "hosting",
  "db",
  "stripe",
  "email",
  "ads",
  "domain",
] as const;

export type ResourceMode = "provisioned" | "connected";

export type ResourceStatus =
  | "pending"
  | "provisioning"
  | "ready"
  | "failed"
  | "teardown"
  | "torn_down";

export type TenantResourceRow = {
  tenant_id: string;
  resource_kind: ResourceKind;
  mode: ResourceMode;
  status: ResourceStatus;
  provider: string | null;
  external_ref: Record<string, unknown>;
  vault_key: string | null;
  last_error?: string | null;
};

export type ProvisionResult = {
  external_ref: Record<string, unknown>;
  vault_keys: Record<string, string>;
};

export type EnsureInput = {
  tenant_id: string;
  company_name: string;
  context?: Record<string, unknown>;
  existing_ref?: Record<string, unknown> | null;
};

export interface Provisioner {
  kind: ResourceKind;
  provider: string;
  ensure(input: EnsureInput): Promise<ProvisionResult>;
  teardown(external_ref: Record<string, unknown>): Promise<void>;
  initialStatus?(result: ProvisionResult): ResourceStatus;
}
