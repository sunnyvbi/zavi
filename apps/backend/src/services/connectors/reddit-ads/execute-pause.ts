
import { z } from "zod";
import { composioExecuteTool } from "@/services/connectors/composio/api";
import { notePlatformWrite } from "@/services/channels/write-fence";
import { resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import { getCampaign } from "./composio-read";
import { ExpectedToolError } from "@/services/tools/types";

const bodySchema = z.object({
  campaign_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  ad_account_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  status: z.literal("PAUSED"),
  name: z.string().min(1).max(300),
});

export type PauseResult = { ok: boolean; error?: string; code?: string; notice?: string; outcome_unknown?: boolean };

export async function executeRedditPause(d: { tenant_id: string; body: unknown }): Promise<PauseResult> {
  const p = bodySchema.safeParse(d.body);
  if (!p.success) return { ok: false, code: "reddit_ads_body_invalid", error: "reddit_ads.set_status body invalid" };
  const b = p.data;

  let account: Awaited<ReturnType<typeof resolveOwnedComposioAccount>>;
  try {
    account = await resolveOwnedComposioAccount(d.tenant_id, "reddit_ads");
  } catch {
    return { ok: false, code: "reddit_ads_account_check_failed", error: "Could not check the Reddit Ads connection. Approve again in a minute." };
  }
  if (!account) return { ok: false, code: "reddit_ads_not_connected", error: "Reconnect Reddit Ads, then approve again." };

  let current: Awaited<ReturnType<typeof getCampaign>>;
  try {
    current = await getCampaign(account, b.campaign_id);
  } catch (e) {
    const msg = e instanceof ExpectedToolError ? e.message : "Reddit Ads could not be read.";
    return { ok: false, code: e instanceof ExpectedToolError ? e.code : "reddit_ads_read_failed", error: msg };
  }
  if (!current || current.ad_account_id !== b.ad_account_id) {
    return { ok: false, code: "reddit_ads_campaign_not_found", error: `Campaign "${b.name}" is no longer in the linked Reddit Ads account.` };
  }
  if (current.status === "PAUSED") {
    return { ok: true, notice: `"${b.name}" was already paused in Reddit Ads.` };
  }
  if (current.status !== "ACTIVE") {
    return { ok: false, code: "reddit_ads_campaign_not_active", error: `Campaign "${b.name}" is ${current.status}, so Zavi did not change it.` };
  }

  notePlatformWrite();
  const r = await composioExecuteTool({
    tool_slug: "REDDIT_ADS_UPDATE_CAMPAIGN",
    user_id: account.tenant_id,
    connected_account_id: account.connected_account_id,
    arguments: { campaign_id: b.campaign_id, data: { configured_status: "PAUSED" } },
  });
  if (!r.ok && r.outcome_unknown) {
    return {
      ok: false,
      outcome_unknown: true,
      code: "reddit_ads_outcome_unknown",
      error: `Reddit Ads did not confirm the pause of "${b.name}". Check it in Reddit Ads; approving again re-reads it first.`,
    };
  }
  if (!r.ok) {
    const msg = typeof r.error === "string" ? r.error : JSON.stringify(r.error ?? `HTTP ${r.status}`);
    return { ok: false, code: "reddit_ads_refused", error: `Reddit Ads refused: ${msg.slice(0, 300)}` };
  }
  return { ok: true, notice: `Paused "${b.name}" in Reddit Ads.` };
}
