import { authoritySchema, REDDIT_ACTION_SCHEMAS, budgetSchema, prepareSchema, launchSchema, replacementSchema, type RedditActionClass } from "@/services/connectors/reddit-ads/schema";
import { assertReady } from "@/services/connectors/reddit-ads/readiness-gates";
import { getObject, ownedAccount, record } from "@/services/connectors/reddit-ads/adapter";
import { preparedCampaign } from "@/services/connectors/reddit-ads/lifecycle";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { UnattendedAction, UnattendedFacts, UnattendedVerdict } from "./unattended-policy";

export type RedditPolicyFacts = { ready: boolean; managed: boolean; unchanged: boolean };
const CGO_CLASSES: ReadonlySet<string> = new Set(["reddit_ads.prepare_campaign", "reddit_ads.launch_campaign", "reddit_ads.replace_creative"]);
export function redditDirection(cls: string, body: unknown): "up" | "down" | "create" | "other" {
  if (cls === "reddit_ads.prepare_campaign" || cls === "reddit_ads.replace_creative") return "create";
  if (cls === "reddit_ads.launch_campaign") return "up";
  if (cls === "reddit_ads.update_budget") {
    const p = budgetSchema.safeParse(body);
    if (p.success) return p.data.daily_budget_usd > p.data.expected_current_daily_budget_usd ? "up" : p.data.daily_budget_usd < p.data.expected_current_daily_budget_usd ? "down" : "other";
  }
  if (body && typeof body === "object" && "status" in body) return body.status === "ACTIVE" ? "up" : "down";
  return "other";
}
export function evaluateRedditAd(action: Extract<UnattendedAction, { kind: "ad" }>, facts: UnattendedFacts): UnattendedVerdict {
  const cls = action.exec_class as RedditActionClass;
  const schema = REDDIT_ACTION_SCHEMAS[cls];
  if (!schema) return { verdict: "ask_founder", reasons: ["pause_needs_founder"] };
  const parsed = schema.safeParse(action.payload);
  if (!parsed.success) return { verdict: "deny", reasons: ["body_unreadable"] };
  if (parsed.data.origin !== "specialist") return { verdict: "ask_founder", reasons: ["founder_staged_change"] };
  if (cls === "reddit_ads.update_budget") return { verdict: "ask_founder", reasons: ["reddit_budget_change_needs_founder"] };
  if (cls === "reddit_ads.set_object_status") return { verdict: "ask_founder", reasons: ["status" in parsed.data && parsed.data.status === "ACTIVE" ? "reddit_resume_needs_founder" : "pause_needs_founder"] };
  if (cls === "reddit_ads.update_targeting" || cls === "reddit_ads.update_ad") return { verdict: "ask_founder", reasons: ["reddit_edit_needs_founder"] };
  if (!CGO_CLASSES.has(cls)) return { verdict: "ask_founder", reasons: ["class_not_on_unattended_list"] };
  const reasons: string[] = [];
  if (facts.channelAutorun !== true) reasons.push("channel_asks_first");
  if (facts.spendUpUnderBudget !== true) reasons.push("no_ad_budget");
  if (facts.openAdvice !== "clear") reasons.push(facts.openAdvice === "conflict" ? "open_advice_conflict" : "open_advice_unreadable");
  if (facts.refsResolved !== true) reasons.push("object_unresolved");
  if (!facts.goal?.present || facts.goal.numberTrusted !== true) reasons.push("goal_number_untrusted");
  if (facts.reddit?.ready !== true) reasons.push("reddit_readiness_unverified");
  if (cls !== "reddit_ads.prepare_campaign" && facts.reddit?.managed !== true) reasons.push("pause_owner_unknown");
  if (facts.reddit?.unchanged !== true) reasons.push("founder_paused_it");
  return { verdict: reasons.length ? "ask_founder" : "allow", reasons };
}
const notReady: RedditPolicyFacts = { ready: false, managed: false, unchanged: false };
export async function loadRedditAdFacts(tenantId: string, action: Extract<UnattendedAction, { kind: "ad" }>): Promise<RedditPolicyFacts> {
  const b = REDDIT_ACTION_SCHEMAS[action.exec_class as RedditActionClass]?.parse(action.payload);
  if (!b || !CGO_CLASSES.has(action.exec_class)) return notReady;
  const authority = await assertRedditAuthority(tenantId, b.ad_account_id, b);
  const goalDb = tenantClient(asTenantId(tenantId));
  if (!action.source.run_id) throw new Error("CGO Reddit work requires a run bound to the approved business goal.");
  const goalRun = await goalDb.from("agent_runs").select("payload").eq("id", action.source.run_id).maybeSingle<{ payload: { goal_id?: string } | null }>();
  if (goalRun.error || goalRun.data?.payload?.goal_id !== authority.goal_id) throw new Error("This run is outside the founder-approved Reddit goal.");
  if (action.exec_class === "reddit_ads.prepare_campaign") {
    const p = prepareSchema.parse(b);
    await assertReady(tenantId, p.ad_account_id, p.pixel_id);
    return { ready: true, managed: true, unchanged: true };
  }
  if (action.exec_class === "reddit_ads.replace_creative") {
    const p = replacementSchema.parse(b);
    const { account } = await ownedAccount(tenantId, p.ad_account_id);
    const group = await getObject(account, p.ad_account_id, "ad_group", p.ad_group_id);
    if (!group.campaign_id) throw new Error("The ad group's campaign could not be read.");
    const campaign = await getObject(account, p.ad_account_id, "campaign", group.campaign_id);
    if (typeof campaign.objective !== "string" || !campaign.objective) throw new Error("The campaign objective could not be read.");
    if (!record(group.targeting) || !Array.isArray(group.targeting.geolocations) || !group.targeting.geolocations.length) throw new Error("The ad group's geographic targeting could not be read.");
    if (group.goal_type !== "DAILY_SPEND" || typeof group.goal_value !== "number" || group.goal_value <= 0) throw new Error("The ad group's daily budget could not be read.");
    if (typeof campaign.spend_cap !== "number" || campaign.spend_cap <= 0) throw new Error("The campaign's lifetime cap could not be read.");
    await assertRedditAuthority(tenantId, p.ad_account_id, { objective: campaign.objective, targeting: group.targeting, daily_budget_usd: group.goal_value / 1000000, lifetime_cap_usd: campaign.spend_cap / 1000000 });
    if (!group.conversion_pixel_id) throw new Error("The ad group has no pixel.");
    await assertReady(tenantId, p.ad_account_id, group.conversion_pixel_id);
    const db = tenantClient(asTenantId(tenantId));
    const { data, error } = await db.from("reddit_ad_operations").select("step").eq("state", "complete").eq("step", "group").eq("result->>id", group.id).limit(1);
    if (error) throw error;
    return { ready: true, managed: (data ?? []).length > 0, unchanged: true };
  }
  const p = launchSchema.parse(b);
  const { plan, manifest, store } = await preparedCampaign(tenantId, p.operation_key, action.source.id);
  await assertRedditAuthority(tenantId, p.ad_account_id, plan);
  if (plan.ad_account_id !== p.ad_account_id) throw new Error("Prepared account mismatch");
  const { account } = await assertReady(tenantId, plan.ad_account_id, plan.pixel_id);
  let unchanged = true;
  for (const { level, obj } of [{ level: "campaign" as const, obj: manifest.campaign }, { level: "ad_group" as const, obj: manifest.group }, ...manifest.ads.map((obj) => ({ level: "ad" as const, obj }))]) {
    const live = await getObject(account, p.ad_account_id, level, obj.id);
    const enabled = await store.read(`enable_${obj.id}`);
    const snapshot = enabled?.state === "complete" ? enabled.result : obj;
    const modified = snapshot && typeof snapshot === "object" && "modified_at" in snapshot ? snapshot.modified_at : null;
    if (!modified || live.modified_at !== modified) unchanged = false;
  }
  return { ready: true, managed: true, unchanged };
}

export async function assertRedditAuthority(tenantId: string, accountId: string, body: Record<string, unknown>) {
  const db = tenantClient(asTenantId(tenantId));
  const { data, error } = await db.from("reddit_ad_authority").select("limits").eq("ad_account_id", accountId).maybeSingle<{ limits: unknown }>();
  if (error || !data) throw new Error("Founder-approved Reddit account and operating limits are required.");
  const limits = authoritySchema.parse(data.limits);
  if (Date.parse(limits.expires_at) <= Date.now()) throw new Error("Reddit operating authority expired.");
  const { data: goal, error: goalError } = await db.from("autopilot_goals").select("id,status").eq("id", limits.goal_id).maybeSingle<{ id: string; status: string }>();
  if (goalError || goal?.status !== "active") throw new Error("The founder-approved Reddit goal is no longer active.");
  if (body.targeting && typeof body.targeting === "object" && "geolocations" in body.targeting) {
    const geos = body.targeting.geolocations;
    if (!Array.isArray(geos) || !geos.length || geos.some((geo) => !limits.geolocations.includes(String(geo)))) throw new Error("Geographic targeting is outside the approved Reddit limits.");
  }
  if (typeof body.daily_budget_usd === "number" && body.daily_budget_usd > limits.daily_limit_usd) throw new Error("Daily budget exceeds the founder-approved Reddit limit.");
  if (typeof body.lifetime_cap_usd === "number" && body.lifetime_cap_usd > limits.campaign_lifetime_limit_usd) throw new Error("Campaign cap exceeds the founder-approved Reddit limit.");
  if (typeof body.objective === "string" && !limits.objectives.includes(body.objective as "CLICKS")) throw new Error("Campaign objective is outside the approved Reddit limits.");
  return limits;
}
