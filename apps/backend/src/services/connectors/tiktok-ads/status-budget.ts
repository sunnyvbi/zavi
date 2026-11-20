import { createHash } from "node:crypto";
import type { OwnedComposioAccount } from "@/services/connectors/composio/api";
import { ExpectedToolError } from "@/services/tools/types";
import { isDailyMode, listTiktokAdGroups, readTiktokObject, type TiktokObject } from "./objects";
import { tiktokStatusBody, type TiktokStatusBody } from "./held-schema";
import { tiktokAdsAccount } from "./composio-read";
import { ensureAdAccounts } from "./ad-accounts";

type ResumePlan = NonNullable<TiktokStatusBody["resume_plan"]>;
const unknown = (): never => { throw new ExpectedToolError("tiktok_ads_budget_unknown", "TikTok did not provide a complete daily budget and campaign lineage for this resume. Nothing changed."); };

export async function readTiktokResumePlan(account: OwnedComposioAccount, advertiserId: string, target: TiktokObject): Promise<ResumePlan> {
  const objects = new Map<string, TiktokObject>([[`${target.level}:${target.id}`, target]]);
  const get = async (level: "campaign" | "ad_group", id: string) => {
    const value = objects.get(`${level}:${id}`) ?? await readTiktokObject(account, advertiserId, level, id);
    if (!value || value.level !== level || value.id !== id || value.campaign_id !== target.campaign_id || !["ACTIVE", "PAUSED"].includes(value.status)) return unknown();
    objects.set(`${level}:${id}`, value);
    return value;
  };
  const campaign = await get("campaign", target.campaign_id);
  let group: TiktokObject | undefined;
  if (target.level === "ad") {
    if (!target.ad_group_id) return unknown();
    group = await get("ad_group", target.ad_group_id);
  } else if (target.level === "ad_group") group = target;
  let owners: TiktokObject[];
  if (isDailyMode(campaign.budget_mode)) owners = [campaign];
  else if (campaign.budget_mode === "BUDGET_MODE_INFINITE") {
    if (group) owners = [group];
    else {
      const children = await listTiktokAdGroups(account, advertiserId, [campaign.id]);
      if (new Set(children.map(g => g.id)).size !== children.length) return unknown();
      for (const child of children) {
        if (child.level !== "ad_group" || child.campaign_id !== campaign.id || !["ACTIVE", "PAUSED", "DELETED"].includes(child.status)) return unknown();
        objects.set(`ad_group:${child.id}`, child);
      }
      owners = children.filter(g => g.status === "ACTIVE");
    }
  } else return unknown();
  const sources = owners.map(o => {
    if (!isDailyMode(o.budget_mode) || o.budget === null || !(o.budget > 0) || !Number.isFinite(o.budget)) return unknown();
    return { object_id: o.id, level: o.level as "campaign" | "ad_group", daily_budget_usd: o.budget, budget_mode: o.budget_mode! };
  }).sort((a, b) => a.object_id.localeCompare(b.object_id));
  const snapshot = [...objects.values()].map(o => ({ level: o.level, id: o.id, campaign_id: o.campaign_id, ad_group_id: o.ad_group_id ?? null, status: o.status, budget: o.budget, budget_mode: o.budget_mode })).sort((a, b) => `${a.level}:${a.id}`.localeCompare(`${b.level}:${b.id}`));
  return { revision: createHash("sha256").update(JSON.stringify({ advertiserId, snapshot })).digest("hex"), sources };
}

export const resumeDailyBudget = (plan: ResumePlan): number => Math.ceil(plan.sources.reduce((sum, o) => sum + o.daily_budget_usd, 0) * 100) / 100;

export async function resolveTiktokStatusHold(tenantId: string, heldObjectId: string, body: unknown): Promise<"landed" | "not_landed" | null> {
  const parsed = tiktokStatusBody.safeParse(body);
  if (!parsed.success || parsed.data.status !== "ACTIVE" || !parsed.data.resume_plan?.sources.some(s => s.object_id === heldObjectId)) return null;
  const b = parsed.data;
  const state = await ensureAdAccounts(tenantId);
  if (!state.connected || !state.accounts.some(a => a.advertiser_id === b.advertiser_id)) return null;
  const account = await tiktokAdsAccount(tenantId);
  const live = await readTiktokObject(account, b.advertiser_id, b.level, b.object_id);
  if (!live || live.campaign_id !== b.campaign_id || (b.level === "ad" && live.ad_group_id !== b.ad_group_id)) return null;
  return live.status === "ACTIVE" ? "landed" : live.status === "PAUSED" ? "not_landed" : null;
}
