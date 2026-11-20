
import { asTenantId, tenantRpc } from "@/services/tenant-client";

export type ChannelRunClaim =
  | { kind: "claimed"; claim_id: string }
  | { kind: "duplicate"; claim_id: string; run_id: string | null }
  | { kind: "cap_reached"; spent_30d: number }
  | { kind: "unavailable" };

export async function claimChannelRun(
  tenant_id: string,
  channel_slug: string,
  request_id: string,
  estimate: number,
  join_lane?: string | null,
): Promise<ChannelRunClaim> {
  let data: unknown;
  try {
    const res = await tenantRpc(asTenantId(tenant_id), "claim_channel_run", {
      p_channel_slug: channel_slug,
      p_request_id: request_id,
      p_estimate: estimate,
      ...(join_lane ? { p_join_lane: join_lane } : {}),
    });
    if (res.error) return { kind: "unavailable" };
    data = res.data;
  } catch {
    return { kind: "unavailable" };
  }

  if (!data || typeof data !== "object") return { kind: "unavailable" };
  const row = data as {
    ok?: boolean;
    duplicate?: boolean;
    claim_id?: string;
    run_id?: string | null;
    reason?: string;
    spent_30d?: number;
  };

  if (row.ok !== true) {
    if (row.reason === "cap_reached") {
      return {
        kind: "cap_reached",
        spent_30d: typeof row.spent_30d === "number" ? row.spent_30d : 0,
      };
    }
    return { kind: "unavailable" };
  }
  if (typeof row.claim_id !== "string") return { kind: "unavailable" };
  return row.duplicate === true
    ? { kind: "duplicate", claim_id: row.claim_id, run_id: row.run_id ?? null }
    : { kind: "claimed", claim_id: row.claim_id };
}

export async function settleChannelRunClaim(
  tenant_id: string,
  claim_id: string,
  run_id: string,
  visible_to_ledger: boolean,
): Promise<void> {
  try {
    await tenantRpc(asTenantId(tenant_id), "settle_channel_run_claim", {
      p_claim_id: claim_id,
      p_run_id: run_id,
      p_visible_to_ledger: visible_to_ledger,
    });
  } catch {
  }
}

export async function releaseChannelRunClaim(
  tenant_id: string,
  claim_id: string,
): Promise<void> {
  try {
    await tenantRpc(asTenantId(tenant_id), "release_channel_run_claim", {
      p_claim_id: claim_id,
    });
  } catch {
  }
}
