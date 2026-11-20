import { asTenantId, tenantClient } from "@/services/tenant-client";
import { actionExecReceipt } from "@/services/channels/exec-receipt";
import { chatgptAdsGet } from "./http";
import { ownsCampaignName } from "./tenant-scope";
import type { ChatgptAdsCampaign } from "./client";

const CREATE = "chatgpt_ads.create_and_launch";
const MAX_RECEIPTS = 20;
const MAX_LOOKUPS = 5;
const providerId = /^cmpn_[a-zA-Z0-9]{1,80}$/;
const bindingId = /^[a-f0-9-]{36}$/;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const status = (value: unknown): string | null => typeof value === "string" && ["active", "paused", "archived"].includes(value.toLowerCase()) ? value.toLowerCase() : null;
const seconds = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;

type Creation = {
  action_id: string;
  title: string | null;
  recorded_creation: true;
  campaign_reference: string | null;
  current_state: "verified" | "unverified";
  current_status: string | null;
  campaign_name?: string;
  last_updated_at?: number | null;
  start_time?: number | null;
  end_time?: number | null;
  reason?: "receipt_without_reference" | "account_binding_required" | "lookup_limit" | "lookup_unavailable";
};

export async function readRecentChatgptCreations(tenantId: string, key: string, prefix: string, inventory: ChatgptAdsCampaign[]) {
  const base = {
    source: "recorded_actions_and_provider_readback",
    note: "An applied creation records what happened then, not current delivery. Archived campaigns may be absent from the campaign list. Last updated is not an archive timestamp. History is bounded; it is not a complete account audit. Do not treat a missing or unreadable campaign as never created or recreate it automatically.",
  };
  try {
    const { data, error } = await tenantClient(asTenantId(tenantId)).from("channel_actions")
      .select("id,title,exec_class,exec_result")
      .eq("channel_slug", "chatgpt_ads").eq("exec_class", CREATE).eq("exec_status", "executed")
      .order("proposed_at", { ascending: false }).limit(MAX_RECEIPTS + 1);
    if (error || !Array.isArray(data)) throw new Error("Creation history unavailable");
    let complete = data.length <= MAX_RECEIPTS;
    let lookups = 0;
    const current = new Map(inventory.map(c => [c.id, c]));
    const checked = new Map<string, Record<string, unknown> | null>();
    const campaigns: Creation[] = [];
    for (const raw of data.slice(0, MAX_RECEIPTS)) {
      const row = object(raw);
      if (!row || typeof row.id !== "string" || row.exec_class !== CREATE) { complete = false; continue; }
      const result = object(row.exec_result);
      const created = object(result?.created);
      const reference = actionExecReceipt(CREATE, result) && created?.platform === "chatgpt" && created.object_type === "campaign" && typeof created.id === "string" && (providerId.test(created.id) || bindingId.test(created.id)) ? created.id : null;
      const item: Creation = { action_id: row.id, title: typeof row.title === "string" ? row.title : null, recorded_creation: true, campaign_reference: reference, current_state: "unverified", current_status: null };
      campaigns.push(item);
      if (!reference) { item.reason = "receipt_without_reference"; continue; }
      if (!providerId.test(reference)) { item.reason = "account_binding_required"; continue; }
      let campaign: Record<string, unknown> | null = object(current.get(reference)) ?? checked.get(reference) ?? null;
      if (!campaign && !checked.has(reference)) {
        if (lookups >= MAX_LOOKUPS) { item.reason = "lookup_limit"; complete = false; continue; }
        lookups++;
        try { campaign = object(await chatgptAdsGet<unknown>(key, `/campaigns/${encodeURIComponent(reference)}`)); } catch { campaign = null; }
        checked.set(reference, campaign);
      }
      if (!campaign || campaign.id !== reference || typeof campaign.name !== "string" || !ownsCampaignName(campaign.name, prefix) || !status(campaign.status)) {
        item.reason = "lookup_unavailable";
        continue;
      }
      item.current_state = "verified";
      item.current_status = status(campaign.status);
      item.campaign_name = campaign.name.trim().slice(prefix.length);
      item.last_updated_at = seconds(campaign.updated_at);
      item.start_time = seconds(campaign.start_time);
      item.end_time = seconds(campaign.end_time);
    }
    return { ...base, status: "read" as const, complete, campaigns };
  } catch {
    return { ...base, status: "unavailable" as const, complete: false, campaigns: [] as Creation[] };
  }
}
