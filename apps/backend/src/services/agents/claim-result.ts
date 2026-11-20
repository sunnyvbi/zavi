
export type ClaimRpcRow = {
  id: string;
  tenant_id: string;
  [k: string]: unknown;
};

export function asClaimedRow(data: unknown): ClaimRpcRow | null {
  if (data == null) return null;
  const row = Array.isArray(data) ? data[0] : data;
  if (row == null || typeof row !== "object") return null;
  const { id, tenant_id } = row as { id?: unknown; tenant_id?: unknown };
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof tenant_id !== "string" || tenant_id.length === 0) return null;
  return row as ClaimRpcRow;
}
