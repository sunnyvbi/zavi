
import { randomUUID } from "node:crypto";
import { ExpectedToolError } from "@/services/tools/types";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { TIKTOK_CREATE_LAUNCH_CLASS } from "./held-schema";

export const EXEC_LEASE_MS = 10 * 60_000;
const SKEW_MS = 5_000;

export type LaunchClaim = { token: string; verify: () => Promise<void>; release: () => Promise<void> };

const unreadable = () =>
  new ExpectedToolError("tiktok_ads_launch_state_unreadable", "Zavi could not check whether another TikTok launch is being carried out, so nothing was created. Approve again in a minute.");
const busy = (other: string) =>
  new ExpectedToolError("tiktok_ads_launch_in_flight", `Another TikTok launch (card ${other}) is being carried out on this ad account right now, so nothing was created. Zavi runs one TikTok test at a time; approve this card again once that one has finished, or reject it.`);

type ClaimRow = { action_id: string; token: string; claimed_at: string };

async function holderRunning(tenantId: string, row: ClaimRow, now: Date): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("channel_actions")
    .select("exec_status,exec_claimed_at")
    .eq("id", row.action_id)
    .maybeSingle<{ exec_status: string | null; exec_claimed_at: string | null }>();
  if (error) throw unreadable();
  if (!data || data.exec_status !== "dispatching" || !data.exec_claimed_at) return false;
  const leaseStart = Date.parse(data.exec_claimed_at);
  if (!Number.isFinite(leaseStart) || now.getTime() - leaseStart > EXEC_LEASE_MS) return false;
  return Date.parse(row.claimed_at) >= leaseStart - SKEW_MS;
}

export async function claimLaunch(tenantId: string, advertiserId: string, actionId: string, now: Date = new Date()): Promise<LaunchClaim> {
  const db = tenantClient(asTenantId(tenantId));
  const token = randomUUID();
  const held: LaunchClaim = {
    token,
    verify: async () => {
      const { data, error } = await db.from("tiktok_launch_claims").select("action_id,token").eq("advertiser_id", advertiserId).maybeSingle<{ action_id: string; token: string }>();
      if (error) throw new ExpectedToolError("tiktok_ads_launch_claim_lost", "Zavi could not confirm it still holds this TikTok launch, so it stopped before switching anything on.");
      if (!data || data.token !== token || data.action_id !== actionId) {
        throw new ExpectedToolError("tiktok_ads_launch_claim_lost", "Another run took over this TikTok launch, so this one stopped before switching anything on.");
      }
    },
    release: async () => {
      const { error } = await db.from("tiktok_launch_claims").delete().eq("advertiser_id", advertiserId).eq("token", token);
      if (error) console.warn(`[tiktok-launch] claim for card ${actionId} not released (${error.message}); it is taken over once the card's exec lease ends`);
    },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const ins = await db.from("tiktok_launch_claims").insert({ advertiser_id: advertiserId, action_id: actionId, token, claimed_at: now.toISOString() });
    if (!ins.error) return held;
    if (ins.error.code !== "23505") throw unreadable();
    const { data: cur, error } = await db.from("tiktok_launch_claims").select("action_id,token,claimed_at").eq("advertiser_id", advertiserId).maybeSingle<ClaimRow>();
    if (error) throw unreadable();
    if (!cur) continue;
    if (await holderRunning(tenantId, cur, now)) throw busy(cur.action_id);
    const upd = await db
      .from("tiktok_launch_claims")
      .update({ action_id: actionId, token, claimed_at: now.toISOString() })
      .eq("advertiser_id", advertiserId)
      .eq("token", cur.token)
      .select("action_id");
    if (upd.error) throw unreadable();
    if ((upd.data ?? []).length === 1) return held;
    throw busy(cur.action_id);
  }
  throw unreadable();
}

export async function otherLaunchesExecuting(tenantId: string, actionId: string): Promise<string[]> {
  const { openChannelCards } = await import("@/services/growth/pending-test-claim");
  return (await openChannelCards(tenantId, "tiktok_ads", TIKTOK_CREATE_LAUNCH_CLASS))
    .filter((c) => c.action_id !== actionId && (c.exec_status !== null || c.status === "acted"))
    .map((c) => c.action_id);
}
