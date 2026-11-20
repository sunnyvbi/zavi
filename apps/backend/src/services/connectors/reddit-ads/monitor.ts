import { createHash } from "node:crypto";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { readChannelAutorun } from "@/services/growth/unattended-policy";
import { enqueueGoalOwnerRun } from "@/services/growth/goal-owner";
import { cgoAdBudget } from "@/services/growth/cgo-ads";
import { redditAdsAccount, listAdAccounts } from "./composio-read";
import { listObjects, ownedAccount } from "./adapter";
import { tracking } from "./readiness";

export async function wakeRedditChange(tenantId: string, incident: string, issues: string[], opts: { quiet_ok?: boolean } = {}) {
  if (!(await readChannelAutorun(tenantId, "reddit_ads"))) return;
  return enqueueGoalOwnerRun({ tenant_id: tenantId, reason: "reddit_ads_change", reddit: { incident_id: incident, issues, ...(opts.quiet_ok ? { quiet_ok: true } : {}) } });
}
export async function monitorRedditAds(tenantId: string, now = new Date()): Promise<{ issues: string[]; changed: boolean }> {
  if (!(await readChannelAutorun(tenantId, "reddit_ads"))) return { issues: [], changed: false };
  const db = tenantClient(asTenantId(tenantId));
  const { data: linked, error: linkError } = await db.from("connector_metadata").select("slug").eq("slug", "composio.reddit_ads").maybeSingle();
  if (linkError) throw linkError;
  if (!linked) return { issues: [], changed: false };
  const issues: string[] = [];
  try {
    const connection = await redditAdsAccount(tenantId);
    for (const selected of await listAdAccounts(connection)) {
      const { account, details } = await ownedAccount(tenantId, selected.id);
      if (details.currency !== "USD") issues.push(`Account ${selected.id}: unsupported currency ${String(details.currency)}.`);
      if (details.admin_approval !== "VALID" || details.suspension_reason) issues.push(`Account ${selected.id}: resolve approval or suspension in Ads Manager.`);
      const campaigns = await listObjects(account, selected.id, "campaign");
      const stopped = new Set(campaigns.filter((c) => c.configured_status !== "ACTIVE").map((c) => c.id));
      const groups = (await listObjects(account, selected.id, "ad_group")).filter((g) => !(typeof g.campaign_id === "string" && stopped.has(g.campaign_id)));
      const liveGroups = new Set(groups.filter((g) => g.configured_status === "ACTIVE").map((g) => g.id));
      const ads = (await listObjects(account, selected.id, "ad")).filter((a) => typeof a.ad_group_id !== "string" || liveGroups.has(a.ad_group_id));
      for (const ad of ads) if (ad.configured_status === "ACTIVE" && /REJECT|DISAPPROV|ERROR|NOT_DELIVER/i.test(String(ad.effective_status))) issues.push(`Ad ${ad.id}: delivery status ${String(ad.effective_status)}. Read the rejection reason before changing it.`);
      for (const group of groups) if (group.configured_status === "ACTIVE") {
        if (["SIGN_UP", "LEAD", "PURCHASE"].includes(group.optimization_goal ?? "")) {
          if (!group.conversion_pixel_id || !(await tracking(account, selected.id, group.conversion_pixel_id, group.optimization_goal ?? undefined, now)).event_fresh) issues.push(`Ad group ${group.id}: goal tracking missing or stale; conversion optimization is blocked.`);
        }
      }
      if (groups.some((g) => g.configured_status === "ACTIVE") && !(await cgoAdBudget(tenantId))) issues.push(`Account ${selected.id}: active ads lack an active Autopilot budget. Founder review is required.`);
    }
  } catch (e) { issues.push(`Reddit access or monitoring failed: ${e instanceof Error ? e.message : "unknown read failure"}`); }
  issues.sort();
  const fingerprint = createHash("sha256").update(JSON.stringify(issues)).digest("hex");
  const { data, error } = await db.from("reddit_ad_monitor_state").select("fingerprint").maybeSingle<{ fingerprint: string }>();
  if (error) throw error;
  if (data?.fingerprint === fingerprint) return { issues, changed: false };
  if (issues.length) {
    const wake = await wakeRedditChange(tenantId, fingerprint, issues);
    if (wake && !wake.enqueued && wake.skipped !== "duplicate" && wake.skipped !== "no_active_goals") return { issues, changed: true };
  }
  const saved = await db.from("reddit_ad_monitor_state").upsert({ fingerprint, issues, checked_at: now.toISOString() }, { onConflict: "tenant_id" });
  if (saved.error) throw saved.error;
  return { issues, changed: true };
}
