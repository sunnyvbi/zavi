
import { createHash, randomBytes } from "node:crypto";
import { asTenantId, preTenantRpc, tenantClient, tenantRpc } from "@/services/tenant-client";
import { aggregateHits, parseLogBody, type HitRow } from "./parse";

export const INGEST_TOKEN_PREFIX = "zgeo_";
const RAW_TOKEN = /^zgeo_[0-9a-f]{64}$/;
const WRITE_CHUNK = 2_000;

export function generateIngestToken(): string {
  return INGEST_TOKEN_PREFIX + randomBytes(32).toString("hex");
}

export function hashIngestToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function displayPrefix(raw: string): string {
  return raw.slice(0, INGEST_TOKEN_PREFIX.length + 6);
}

export async function rotateIngestToken(
  tenantId: string,
  userId: string,
): Promise<{ token: string; token_id: string; token_prefix: string }> {
  const token = generateIngestToken();
  const token_prefix = displayPrefix(token);
  const { data, error } = await tenantRpc(asTenantId(tenantId), "geo_rotate_crawler_ingest_token", {
    p_token_hash: hashIngestToken(token),
    p_token_prefix: token_prefix,
    p_created_by: userId,
  });
  if (error || typeof data !== "string") {
    throw new Error(`geo ingest token rotate failed: ${error?.message ?? "no id"}`);
  }
  return { token, token_id: data, token_prefix };
}

export async function revokeIngestToken(tenantId: string): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("geo_crawler_ingest_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .is("revoked_at", null)
    .select("id");
  if (error) throw new Error(`geo ingest token revoke failed: ${error.message}`);
  return ((data ?? []) as unknown[]).length > 0;
}

export type IngestTokenStatus = {
  connected: boolean;
  token_prefix: string | null;
  created_at: string | null;
  last_received_at: string | null;
};

export async function ingestTokenStatus(tenantId: string): Promise<IngestTokenStatus> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("geo_crawler_ingest_tokens")
    .select("token_prefix, created_at, last_received_at")
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw new Error(`geo ingest token read failed: ${error.message}`);
  const row = data as { token_prefix: string; created_at: string; last_received_at: string | null } | null;
  return {
    connected: row !== null,
    token_prefix: row?.token_prefix ?? null,
    created_at: row?.created_at ?? null,
    last_received_at: row?.last_received_at ?? null,
  };
}

export async function resolveIngestToken(raw: string): Promise<{ tenant_id: string; token_id: string } | null> {
  if (!RAW_TOKEN.test(raw)) return null;
  const { data, error } = await preTenantRpc("geo_resolve_crawler_ingest_token", {
    p_token_hash: hashIngestToken(raw),
  });
  const row = Array.isArray(data) ? (data[0] as { tenant_id?: string; token_id?: string } | undefined) : undefined;
  if (error || !row?.tenant_id || !row.token_id) return null;
  return { tenant_id: row.tenant_id, token_id: row.token_id };
}

export type IngestResult = {
  records: number;
  matched: number;
  ignored: number;
  unparsed: number;
  undated: number;
  rows_written: number;
  truncated: boolean;
};

export async function ingestLogBatch(
  scope: { tenant_id: string; token_id: string },
  body: Buffer,
  now: number = Date.now(),
): Promise<IngestResult> {
  const parsed = parseLogBody(body);
  const agg = aggregateHits(parsed.records, now);
  let rows_written = 0;
  for (let i = 0; i < agg.rows.length; i += WRITE_CHUNK) {
    const chunk: HitRow[] = agg.rows.slice(i, i + WRITE_CHUNK);
    const { data, error } = await tenantRpc(asTenantId(scope.tenant_id), "geo_record_crawler_hits", {
      p_token_id: scope.token_id,
      p_rows: chunk,
    });
    if (error) throw new Error(`geo crawler hits write failed: ${error.message}`);
    rows_written += typeof data === "number" ? data : 0;
  }
  return {
    records: parsed.records.length,
    matched: agg.matched,
    ignored: agg.ignored,
    unparsed: parsed.unparsed,
    undated: agg.undated,
    rows_written,
    truncated: parsed.truncated,
  };
}
