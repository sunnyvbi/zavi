
export interface ShardTarget {
  ref: string;
  publicUrl: string;
  baseUrl: string;
  publishableKey: string;
  anonKey: string;
  serviceKey: string;
  adminDbUrl: string;
  brokerDbUrl: string;
  hookSecret: string;
  signerJwk: Record<string, unknown>;
  kind: "pooled" | "kernel";
}

export const SHARD_REF_RE = /^[a-z0-9]{20}$/;
