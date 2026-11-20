import { recordZaviAdChange } from "@/services/decisions/ad-changes";
import { assertSpendWritesOn } from "@/services/channels/lock";
import { inngest } from "../../../../workers/client";
import { ExpectedToolError } from "@/services/tools/types";
import { commitAdSpend, dropAdSpendHold, rebaseAdSpendForObject, reserveAdSpend, type AdSpendHold } from "@/services/decisions/ad-budget";
import { cgoAdBudget } from "@/services/growth/cgo-ads";
import { authorizeUnattended } from "@/services/growth/unattended-policy";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { loadTenantRoleFor } from "@/services/auth/tenant-role";
import { authoritySchema, redditActionNeedsAdmin, redditActionRaisesSpend, REDDIT_ACTION_SCHEMAS, adUpdateSchema, budgetSchema, launchSchema, prepareSchema, removeSchema, samePage, renameSchema, replacementSchema, statusSchema, targetUpdateSchema, targetingSchema, type RedditActionClass } from "./schema";
import { getObject, getPost, ownedAccount, listObjects, record, type RedditObject } from "./adapter";
import { createObject, patchObject } from "./writes";
import { createCreative, launchCampaign, postMatchesCreative, prepareCampaign, preparedCampaign, targetingMatches } from "./lifecycle";
import { CORRECTABLE_CODES, CORRECT_PLAN_STEP, durableStep, operationStore, requestHash } from "./operations";
import { assertReady } from "./readiness-gates";
import { HOLD_KEPT_NOTE, releaseRedditHolds } from "./hold-release";
import { permanentReadRefusal } from "./read-refusal";
import { adoptPreparedEdit, checkPreparedEdit, preparedEditFor, type PreparedEdit } from "./prepared-edits";

export type RedditExecRow = { id: string; tenant_id: string; body: unknown; decision_class: string; approved_by?: string | null; approved_by_source?: string | null; exec_source?: string; agent_run_id?: string | null };
export type RedditExecutionDetails = { action_id: string; execution_state: string; delivery_state: string; approval_required: boolean; external_ids?: Record<string, unknown>; failed_step?: string | null; failure_reason: string | null; next_recovery_step: string | null };
export type RedditExecResult = { ok: boolean; code?: string; error?: string; notice?: string; outcome_unknown?: boolean; held_for_founder?: boolean; agent_outcome?: string; execution_details: RedditExecutionDetails; created?: { platform: "reddit"; object_type: "campaign" | "ad"; id: string; status: "PAUSED" | "ACTIVE" } };
function details(d: RedditExecRow, state: string, ids?: Record<string, unknown>): RedditExecutionDetails {
  return { action_id: d.id, execution_state: state, delivery_state: "unconfirmed", approval_required: false, external_ids: ids, failure_reason: null, next_recovery_step: "Read current delivery status and fresh performance; enabled ads can still be under review." };
}
async function lockCheck(d: RedditExecRow): Promise<void> {
  if (d.decision_class === "reddit_ads.prepare_campaign" || redditActionRaisesSpend(d.decision_class, d.body)) await assertSpendWritesOn("reddit_ads", "Reddit Ads", "reddit_ads");
}
async function guard(d: RedditExecRow): Promise<void> {
  await lockCheck(d);
  if (d.approved_by_source === "staff" || !d.approved_by) throw new ExpectedToolError("reddit_ads_approval_required", "This Reddit action requires founder approval or permitted CGO approval.");
  if (d.approved_by_source !== "cgo") {
    if (!redditActionNeedsAdmin(d.decision_class, d.body)) return;
    let role: string | null;
    try { role = await loadTenantRoleFor(d.approved_by, d.tenant_id); } catch { throw new ExpectedToolError("reddit_ads_role_unavailable", "The approver's workspace role could not be checked. Nothing was changed; try again."); }
    if (role !== "owner" && role !== "admin") throw new ExpectedToolError("reddit_ads_admin_required", "Only a workspace owner or admin can approve a Reddit launch, budget increase, targeting change or operating limits.");
    return;
  }
  if (!(await cgoAdBudget(d.tenant_id))) throw new ExpectedToolError("reddit_ads_autopilot_off", "Autopilot or its approved ad budget is no longer active. This action is waiting for the founder.");
  const verdict = await authorizeUnattended(d.tenant_id, { kind: "ad", exec_class: d.decision_class, payload: d.body, source: { table: "channel_actions", id: d.id, run_id: d.agent_run_id ?? null } }, { where: "reddit_write" });
  if (verdict.verdict !== "allow") throw new ExpectedToolError("reddit_ads_policy_held", `Founder review required: ${verdict.reasons.join(", ")}`);
}
function success(d: RedditExecRow, state: string, notice: string, ids: Record<string, unknown>): RedditExecResult {
  const execution_details = details(d, state, ids);
  return { ok: true, notice, execution_details, agent_outcome: JSON.stringify(execution_details) };
}
function stepLabel(step: string): string {
  if (step === "group") return "ad group";
  if (step === "replacement_ad") return "replacement ad";
  const index = /^(post|ad)_(\d+)$/.exec(step);
  return index ? `${index[1] === "post" ? "image post" : "ad"} ${Number(index[2]) + 1}` : step;
}
async function progress(d: RedditExecRow): Promise<{ ids: Record<string, string>; failed: string | null }> {
  const body = record(d.body) ? d.body : {};
  const key = typeof body.operation_key === "string" ? body.operation_key : `action_${d.id}`;
  const rows = await operationStore(d.tenant_id, key, d.id).list();
  const ids: Record<string, string> = {};
  for (const row of rows) if (row.state === "complete" && record(row.result) && typeof row.result.id === "string") ids[row.step] = row.result.id;
  return { ids, failed: rows.find((row) => row.state !== "complete" && row.step !== "plan" && row.step !== "manifest")?.step ?? null };
}
function partialNote(ids: Record<string, string>, failed: string | null, unknown: boolean): string {
  const created = Object.entries(ids).filter(([step]) => step === "campaign" || step === "group" || step === "replacement_ad" || /^(post|ad)_\d+$/.test(step));
  const stopped = failed ? ` ${unknown ? "Unconfirmed" : "Failed"} step: ${stepLabel(failed)}.` : "";
  if (!created.length) return unknown ? stopped : ` Nothing was created in Reddit.${stopped}`;
  return ` Created before it stopped: ${created.map(([step, id]) => `${stepLabel(step)} ${id}`).join(", ")}.${stopped}`;
}
const LIVE_STATUSES = new Set(["ACTIVE", "PAUSED"]);
async function assertSamePageAsPost(account: RedditAccount, ad: RedditObject, url: string): Promise<void> {
  let postUrl: unknown;
  let refusal: string | null = null;
  try {
    const post: Record<string, unknown> | null = typeof ad.post_id === "string" ? await getPost(account, ad.post_id) : null;
    const content = post ? post.content : null;
    postUrl = Array.isArray(content) && content.length === 1 ? (content[0] as Record<string, unknown>).destination_url : null;
  } catch (e) {
    postUrl = null;
    refusal = permanentReadRefusal(e);
  }
  if (typeof postUrl !== "string") throw new ExpectedToolError("reddit_ads_post_unreadable", refusal
    ? `Zavi could not read this ad's image post, so it cannot check the new link lands on the same page: ${refusal.replace("this object", "this ad's image post")} Nothing was changed; trying again will not help until that changes.`
    : "Zavi could not read this ad's image post, so it cannot check the new link lands on the same page. Nothing was changed; try again in a minute.");
  if (!samePage(url, postUrl)) throw new ExpectedToolError("reddit_ads_invalid_request", `This ad's image post sends people to ${postUrl}. Its click link may differ from that only in tracking parameters, so Zavi did not change it. To send people to a different page, propose a replacement ad (propose_replace_creative) with the new destination. Nothing was changed.`);
}
function pausedForPlan(obj: RedditObject): boolean {
  if (obj.configured_status === "PAUSED") return true;
  if (obj.configured_status === "ACTIVE") return false;
  throw new ExpectedToolError("reddit_ads_invalid_request", `This object is ${String(obj.configured_status ?? "unreadable").toLowerCase()} in Reddit, so Zavi did not change it. Nothing was changed.`);
}
export function keepZaviTag(newName: string, current: string | null | undefined): string {
  const tag = /\s*(\[prax:[^\]]*\])\s*$/.exec(current ?? "")?.[1];
  const clean = newName.replace(/\s*\[prax:[^\]]*\]\s*$/, "").trim();
  return tag ? `${clean} ${tag}` : clean;
}
const PLAN_NOT_UPDATED_NOTE = " The change is live in Reddit, but Zavi could not update its prepared plan; read check_readiness before launching.";
async function keepPreparedPlan(tenantId: string, account: RedditAccount, edit: PreparedEdit): Promise<string> {
  try {
    const key = await adoptPreparedEdit(tenantId, account, edit);
    return key ? ` The prepared campaign ${key} now carries this change, so it can still be launched.` : "";
  } catch (e) {
    console.warn(`[reddit-ads] prepared plan not updated after an approved edit: ${(e as Error).message}`);
    return PLAN_NOT_UPDATED_NOTE;
  }
}
type RedditAccount = Awaited<ReturnType<typeof ownedAccount>>["account"];
async function onParent(account: RedditAccount, accountId: string, level: "campaign" | "ad_group", id: unknown, child: string): Promise<RedditObject> {
  const label = level === "ad_group" ? "ad group" : "campaign";
  if (typeof id !== "string" || !id) throw new ExpectedToolError("reddit_ads_budget_unreadable", `The ${child}'s ${label} could not be read, so Zavi cannot hold its budget. Nothing was changed.`);
  const parent = await getObject(account, accountId, level, id);
  if (parent.configured_status !== "ACTIVE") throw new ExpectedToolError("reddit_ads_invalid_request", `The ${child}'s ${label} is ${String(parent.configured_status ?? "unreadable").toLowerCase()} in Reddit, so turning on the ${child} would deliver nothing. Turn on the ${label} first. Nothing was changed.`);
  return parent;
}
async function campaignGroup(account: RedditAccount, accountId: string, campaign: RedditObject): Promise<RedditObject> {
  const groups = (await listObjects(account, accountId, "ad_group")).filter((g) => g.campaign_id === campaign.id && g.configured_status === "ACTIVE");
  if (groups.length !== 1) throw new ExpectedToolError("reddit_ads_invalid_request", groups.length ? "This campaign has several ad groups turned on, so turning it on would start more than one budget at once. Turn on one ad group at a time instead." : "This campaign has no ad group turned on, so turning it on would deliver nothing. Turn on an ad group instead.");
  return groups[0];
}
async function resumedGroup(account: RedditAccount, accountId: string, level: "campaign" | "ad_group" | "ad", obj: RedditObject): Promise<RedditObject> {
  const group = level === "campaign" ? await campaignGroup(account, accountId, obj) : level === "ad" ? await onParent(account, accountId, "ad_group", obj.ad_group_id, "ad") : obj;
  if (level !== "campaign") await onParent(account, accountId, "campaign", group.campaign_id, level === "ad" ? "ad" : "ad group");
  if (level === "ad") return group;
  const ads = (await listObjects(account, accountId, "ad")).filter((a) => a.ad_group_id === group.id && a.configured_status === "ACTIVE");
  if (!ads.length) throw new ExpectedToolError("reddit_ads_invalid_request", `Ad group ${group.id} has no ad turned on, so turning on the ${level === "campaign" ? "campaign" : "ad group"} would deliver nothing. Turn on an ad first. Nothing was changed.`);
  return group;
}
function verifyCurrency(currency: unknown): void {
  if (currency !== "USD") throw new ExpectedToolError("reddit_ads_currency_unsupported", `Reddit Ads execution supports USD accounts; this account uses ${String(currency)}.`);
}
async function confirmedPatch(d: RedditExecRow, account: Awaited<ReturnType<typeof ownedAccount>>["account"], accountId: string, level: "campaign" | "ad_group" | "ad", obj: RedditObject, change: Record<string, unknown>, beforePatch: () => void): Promise<RedditObject> {
  const store = operationStore(d.tenant_id, `action_${d.id}`, d.id);
  const read = () => getObject(account, accountId, level, obj.id);
  const matches = (live: RedditObject) => Object.entries(change).every(([k, v]) => k === "targeting" ? targetingMatches(live[k], targetingSchema.parse(v)) : JSON.stringify(live[k]) === JSON.stringify(v));
  return durableStep(store, "patch", { id: obj.id, ...change }, async () => {
    await guard(d);
    const live = await read();
    if (live.modified_at !== obj.modified_at) throw new ExpectedToolError("reddit_ads_object_drifted", "The Reddit object changed immediately before execution. Review and propose again.");
    await inngest.send({ id: `reddit-exec-reconcile:${d.id}`, name: "channel-action.exec-reconcile", data: { action_id: d.id } });
    await lockCheck(d);
    beforePatch();
    await patchObject(account, level, obj.id, change);
    try { const updated = await read(); if (matches(updated)) return updated; } catch { }
    throw new ExpectedToolError("reddit_ads_outcome_unknown", "Reddit accepted the update but read-back did not confirm its settings. Reconcile before retrying.");
  }, async () => { const live = await read(); return matches(live) ? live : null; });
}
async function execute(d: RedditExecRow): Promise<RedditExecResult> {
  let hold: AdSpendHold = { status: "no_budget" };
  let writeStarted = false;
  const reserve = async (objectId: string, delta: number) => {
    hold = await reserveAdSpend(d, { platform: "reddit", op: d.decision_class === "reddit_ads.update_budget" ? "raise" : "resume", object_id: objectId, daily_delta_usd: delta, currency: "USD" });
    if (hold.status === "refused") throw new ExpectedToolError("reddit_ads_budget_refused", hold.error);
    if (d.approved_by_source === "cgo" && hold.status !== "held") throw new ExpectedToolError("reddit_ads_budget_required", "CGO execution requires an active budget reservation.");
  };
  try {
    const schema = REDDIT_ACTION_SCHEMAS[d.decision_class as RedditActionClass];
    if (!schema) throw new ExpectedToolError("reddit_ads_action_unknown", "Unsupported Reddit action class.");
    const parsed = schema.safeParse(d.body);
    if (!parsed.success) throw new ExpectedToolError("reddit_ads_invalid_request", `This approved Reddit action no longer matches what Zavi requires (${parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}). Nothing was sent to Reddit.`);
    const b = parsed.data;
    await guard(d);
    const { account, details: accountDetails } = await ownedAccount(d.tenant_id, b.ad_account_id);
    verifyCurrency(accountDetails.currency);
    const beforeWrite = async () => { await guard(d); await ownedAccount(d.tenant_id, b.ad_account_id); await inngest.send({ id: `reddit-exec-reconcile:${d.id}`, name: "channel-action.exec-reconcile", data: { action_id: d.id } }); await lockCheck(d); writeStarted = true; };
    if (d.decision_class === "reddit_ads.authorize_account") {
      if (d.approved_by_source === "cgo") throw new ExpectedToolError("reddit_ads_founder_required", "Only the founder can approve Reddit operating limits.");
      const limits = authoritySchema.parse(b);
      if (Date.parse(limits.expires_at) <= Date.now()) throw new ExpectedToolError("reddit_ads_authority_expired", "Operating limits must expire in the future.");
      const db = tenantClient(asTenantId(d.tenant_id));
      const { data: goal, error: goalError } = await db.from("autopilot_goals").select("id,status").eq("id", limits.goal_id).maybeSingle<{ id: string; status: string }>();
      if (goalError || goal?.status !== "active") throw new ExpectedToolError("reddit_ads_goal_invalid", "Select an active goal owned by this workspace.");
      await guard(d);
      const saved = await tenantRpc(asTenantId(d.tenant_id), "save_reddit_ad_authority", { p_ad_account_id: b.ad_account_id, p_limits: limits, p_action_id: d.id });
      if (saved.error) throw new ExpectedToolError("reddit_ads_authority_unreadable", "The Reddit operating limits could not be saved. Nothing was changed; approve again in a minute.");
      const out = (saved.data ?? {}) as { ok?: boolean; code?: string };
      if (out.code === "superseded") throw new ExpectedToolError("reddit_ads_authority_superseded", "A newer Reddit operating grant for this account was already approved, so this older card was not applied. Nothing was changed; propose new limits if these are still wanted.");
      if (out.ok !== true) throw new ExpectedToolError("reddit_ads_authority_unreadable", "This grant card could not be matched to its Reddit ad account. Nothing was changed.");
      return success(d, "authorized", "Saved founder-approved Reddit account, goal and operating limits. Autopilot still requires an active shared ad budget and channel autorun.", { ad_account_id: b.ad_account_id });
    }
    if (d.decision_class === "reddit_ads.prepare_campaign") {
      const plan = prepareSchema.parse(b);
      const m = await prepareCampaign(d.tenant_id, d.id, plan, beforeWrite);
      return { ...success(d, "created_paused", "Created and verified the campaign, ad group and image ads, all paused. Launch needs a separate approved action.", { campaign_id: m.id, ad_group_id: m.group.id, ad_ids: m.ads.map((a) => a.id), operation_key: plan.operation_key }), created: { platform: "reddit", object_type: "campaign", id: m.id, status: "PAUSED" } };
    }
    if (d.decision_class === "reddit_ads.launch_campaign") {
      const input = launchSchema.parse(b);
      const { plan, manifest, store } = await preparedCampaign(d.tenant_id, input.operation_key, d.id);
      if (plan.ad_account_id !== b.ad_account_id) throw new ExpectedToolError("reddit_ads_account_not_owned", "Prepared campaign belongs to a different account.");
      await assertReady(d.tenant_id, b.ad_account_id, plan.pixel_id);
      const liveGroup = await getObject(account, b.ad_account_id, "ad_group", manifest.group.id);
      if (liveGroup.goal_value !== Math.round(plan.daily_budget_usd * 1000000)) throw new ExpectedToolError("reddit_ads_object_drifted", "The ad group's daily budget in Reddit is not the one this launch would reserve. Nothing was turned on; read check_readiness and propose the launch again.");
      await reserve(manifest.group.id, plan.daily_budget_usd);
      const live = await launchCampaign(account, plan, manifest, store, beforeWrite);
      await commitAdSpend(hold, manifest.group.id);
      return success(d, "enabled", `Enabled the prepared campaign. Reddit reports ${live.ads.map((a) => a.effective_status ?? "UNKNOWN").join(", ")}; delivery is not yet confirmed.`, { campaign_id: manifest.id, ad_group_id: manifest.group.id, ad_ids: manifest.ads.map((a) => a.id) });
    }
    if (d.decision_class === "reddit_ads.replace_creative") {
      const input = replacementSchema.parse(b);
      const group = await getObject(account, b.ad_account_id, "ad_group", input.ad_group_id);
      if (!LIVE_STATUSES.has(group.configured_status ?? "")) throw new ExpectedToolError("reddit_ads_invalid_request", `Ad group ${group.id} is ${String(group.configured_status ?? "unreadable").toLowerCase()} in Reddit, so no replacement ad was created. Pick a live ad group.`);
      if (group.conversion_pixel_id) await assertReady(d.tenant_id, b.ad_account_id, group.conversion_pixel_id);
      const store = operationStore(d.tenant_id, input.operation_key, d.id);
      if (await store.claim("plan", input)) await store.save("plan", "complete", input);
      else if ((await store.read("plan"))?.request_hash !== requestHash(input)) throw new ExpectedToolError("reddit_ads_operation_conflict", "This operation key belongs to a different replacement.");
      const post = await createCreative(account, b.ad_account_id, input.profile_id, input.operation_key, 0, input.creative, store, beforeWrite);
      const data = { ad_group_id: group.id, name: `${input.creative.name} [prax:${input.operation_key}:replacement]`, post_id: post.id, click_url: input.creative.click_url ?? input.creative.destination_url, configured_status: "PAUSED" };
      const ad = await durableStep(store, "replacement_ad", data, async () => { await beforeWrite(); return createObject(account, b.ad_account_id, "ad", data); }, async () => {
        const matches = (await listObjects(account, b.ad_account_id, "ad")).filter((a) => a.ad_group_id === group.id && a.post_id === post.id && a.name === data.name);
        if (matches.length > 1) throw new ExpectedToolError("reddit_ads_duplicate_match", "Multiple replacement ads match this operation. Review them before continuing.");
        return matches[0] ?? null;
      });
      let verified: RedditObject;
      try { verified = await getObject(account, b.ad_account_id, "ad", ad.id); } catch { throw new ExpectedToolError("reddit_ads_outcome_unknown", "The replacement ad was created but its read-back failed. Reconcile before retrying."); }
      if (verified.configured_status !== "PAUSED" || verified.post_id !== post.id || verified.ad_group_id !== group.id || verified.click_url !== (input.creative.click_url ?? input.creative.destination_url)) throw new ExpectedToolError("reddit_ads_verification_failed", "Reddit saved the replacement ad with settings that differ from the approved ones. Review it in Reddit Ads Manager before turning anything on.");
      let livePost: Record<string, unknown>;
      try { livePost = await getPost(account, post.id); } catch { throw new ExpectedToolError("reddit_ads_outcome_unknown", "The replacement ad was created but its post could not be read back. Reconcile before retrying."); }
      if (!postMatchesCreative(livePost, input.profile_id, input.creative)) throw new ExpectedToolError("reddit_ads_verification_failed", "Reddit saved the replacement post with ownership, copy or a destination that differ from the approved creative. Review it in Reddit Ads Manager before turning anything on.");
      return { ...success(d, "created_paused", "Created a paused replacement image ad in the ad group. The existing ad is unchanged; turning the new ad on is a separate approved action.", { ad_id: ad.id, post_id: post.id, ad_group_id: group.id, operation_key: input.operation_key }), created: { platform: "reddit", object_type: "ad", id: ad.id, status: "PAUSED" } };
    }
    if (d.decision_class === "reddit_ads.update_budget") {
      const input = budgetSchema.parse(b);
      const obj = await getObject(account, b.ad_account_id, "ad_group", input.ad_group_id);
      if (obj.goal_type !== "DAILY_SPEND" || obj.is_campaign_budget_optimization !== false || obj.goal_value !== Math.round(input.expected_current_daily_budget_usd * 1000000)) throw new ExpectedToolError("reddit_ads_budget_drifted", "Current daily budget or budget mode differs from the approved action.");
      const preparedEdit: PreparedEdit | null = pausedForPlan(obj) ? { kind: "budget", ad_group_id: obj.id, daily_budget_usd: input.daily_budget_usd } : null;
      if (preparedEdit) await checkPreparedEdit(d.tenant_id, preparedEdit);
      const delta = input.daily_budget_usd - input.expected_current_daily_budget_usd;
      if (delta > 0) await reserve(obj.id, delta);
      await confirmedPatch(d, account, b.ad_account_id, "ad_group", obj, { goal_value: Math.round(input.daily_budget_usd * 1000000) }, () => { writeStarted = true; });
      await recordZaviAdChange(d.tenant_id, { table: "channel_actions", id: d.id }, { platform: "reddit", object_id: obj.id, level: "ad_group", campaign_id: obj.campaign_id ?? null, object_name: obj.name ?? null, change_kind: "budget", before_status: obj.configured_status ?? null, after_status: obj.configured_status ?? null, before_daily_usd: input.expected_current_daily_budget_usd, after_daily_usd: input.daily_budget_usd });
      if (delta > 0) await commitAdSpend(hold, obj.id);
      if (delta < 0) await rebaseAdSpendForObject(d.tenant_id, "reddit", obj.id, input.daily_budget_usd, `${d.id}:rebase`, -delta);
      const kept = preparedEdit ? await keepPreparedPlan(d.tenant_id, account, preparedEdit) : "";
      return success(d, "updated", `Verified the Reddit ad group daily budget.${kept}`, { ad_group_id: obj.id });
    }
    if (d.decision_class === "reddit_ads.rename_object" || d.decision_class === "reddit_ads.remove_object") {
      if (d.approved_by_source === "cgo") throw new ExpectedToolError("reddit_ads_founder_required", "Only a person can approve renaming, archiving or deleting a Reddit object.");
      const rename = d.decision_class === "reddit_ads.rename_object";
      const input = rename ? renameSchema.parse(b) : removeSchema.parse(b);
      const obj = await getObject(account, b.ad_account_id, input.level, input.object_id);
      if (!obj.modified_at || obj.modified_at !== input.expected_modified_at) throw new ExpectedToolError("reddit_ads_object_drifted", "The object changed after this action was proposed. Review and propose again.");
      const label = input.level === "ad_group" ? "ad group" : input.level;
      let change: Record<string, unknown>;
      if ("new_name" in input) change = { name: keepZaviTag(input.new_name, obj.name) };
      else if (input.mode === "archive") {
        if (obj.configured_status === "ACTIVE") throw new ExpectedToolError("reddit_ads_invalid_request", `This ${label} is on in Reddit. Pause it first, then archive it. Nothing was changed.`);
        if (obj.configured_status !== "PAUSED") throw new ExpectedToolError("reddit_ads_invalid_request", `This ${label} is ${String(obj.configured_status ?? "unreadable").toLowerCase()} in Reddit, so it cannot be archived. Nothing was changed.`);
        change = { configured_status: "ARCHIVED" };
      } else {
        if (obj.configured_status !== "ARCHIVED") throw new ExpectedToolError("reddit_ads_invalid_request", `Reddit deletes only an archived ${label}. Archive it first; Reddit allows the delete some hours later. Nothing was changed.`);
        change = { configured_status: "DELETED" };
      }
      await confirmedPatch(d, account, b.ad_account_id, input.level, obj, change, () => { writeStarted = true; });
      if ("new_name" in input) {
        const kept = await keepPreparedPlan(d.tenant_id, account, { kind: "refresh", level: input.level, object_id: obj.id });
        return success(d, "updated", `Reddit confirmed the new name of the ${label}.${kept}`, { [`${input.level}_id`]: obj.id });
      }
      const released = await releaseRedditHolds(d.tenant_id, account, b.ad_account_id, input.level, obj.id);
      return success(d, input.mode === "archive" ? "archived" : "deleted", `Reddit confirmed the ${label} is ${input.mode === "archive" ? "archived" : "deleted"}.${released ? "" : HOLD_KEPT_NOTE}`, { [`${input.level}_id`]: obj.id, ...(released ? {} : { budget_hold: "release_unconfirmed" }) });
    }
    const input = d.decision_class === "reddit_ads.update_targeting" ? targetUpdateSchema.parse(b) : d.decision_class === "reddit_ads.update_ad" ? adUpdateSchema.parse(b) : statusSchema.parse(b);
    const level = "ad_group_id" in input ? "ad_group" : "ad_id" in input ? "ad" : input.level;
    const id = "ad_group_id" in input ? input.ad_group_id : "ad_id" in input ? input.ad_id : input.object_id;
    const obj = await getObject(account, b.ad_account_id, level, id);
    if (!obj.modified_at || obj.modified_at !== input.expected_modified_at) throw new ExpectedToolError("reddit_ads_object_drifted", "The object changed after this action was proposed. Review and propose again.");
    if ("destination_url" in input) await assertSamePageAsPost(account, obj, input.destination_url);
    const change = "targeting" in input ? { targeting: input.targeting } : "destination_url" in input ? { click_url: input.destination_url } : { configured_status: input.status };
    const edit = "status" in input ? null : pausedForPlan(obj) ? preparedEditFor(d.decision_class, input as Record<string, unknown>) : null;
    if (edit) await checkPreparedEdit(d.tenant_id, edit);
    const resume = "status" in input && input.status === "ACTIVE";
    let heldGroup: string | null = null;
    if (resume) {
      if (obj.configured_status === "ACTIVE") throw new ExpectedToolError("reddit_ads_invalid_request", "This object is already on in Reddit. Nothing was changed.");
      if (!LIVE_STATUSES.has(obj.configured_status ?? "")) throw new ExpectedToolError("reddit_ads_invalid_request", `This object is ${String(obj.configured_status ?? "unreadable").toLowerCase()} in Reddit and cannot be turned on. Nothing was changed.`);
      const group = await resumedGroup(account, b.ad_account_id, level, obj);
      if (group.goal_type !== "DAILY_SPEND" || typeof group.goal_value !== "number" || group.goal_value <= 0 || group.is_campaign_budget_optimization !== false) throw new ExpectedToolError("reddit_ads_budget_unreadable", "Turning this on needs a readable daily ad group budget without campaign budget optimization. Nothing was changed.");
      if (!group.conversion_pixel_id) throw new ExpectedToolError("reddit_ads_tracking_unverified", "Turning this on needs an ad group with a pixel, so results can be read. Nothing was changed.");
      await assertReady(d.tenant_id, b.ad_account_id, group.conversion_pixel_id);
      await reserve(group.id, group.goal_value / 1000000);
      heldGroup = group.id;
    }
    const updated = await confirmedPatch(d, account, b.ad_account_id, level, obj, change, () => { writeStarted = true; });
    if ("status" in input) await recordZaviAdChange(d.tenant_id, { table: "channel_actions", id: d.id }, { platform: "reddit", object_id: obj.id, level, campaign_id: obj.campaign_id ?? null, object_name: obj.name ?? null, change_kind: "status", before_status: obj.configured_status ?? null, after_status: updated.configured_status ?? null, before_daily_usd: null, after_daily_usd: null });
    if (heldGroup) {
      await commitAdSpend(hold, heldGroup);
      return success(d, "enabled", `Reddit confirmed the ${level === "ad_group" ? "ad group" : level} is on. Reddit reports ${updated.effective_status ?? "UNKNOWN"}; delivery is not yet confirmed.`, { [`${level}_id`]: obj.id, ad_group_id: heldGroup });
    }
    if ("status" in input) {
      const released = await releaseRedditHolds(d.tenant_id, account, b.ad_account_id, level, obj.id);
      return success(d, "paused", `Reddit confirmed the pause. Read delivery status separately.${released ? "" : HOLD_KEPT_NOTE}`, { [`${level}_id`]: obj.id, ...(released ? {} : { budget_hold: "release_unconfirmed" }) });
    }
    const kept = edit ? await keepPreparedPlan(d.tenant_id, account, edit) : "";
    return success(d, "updated", `${"targeting" in input ? "Reddit confirmed the ad group's new targeting." : "Reddit confirmed the ad's new destination."} Read delivery status separately.${kept}`, { [`${level}_id`]: obj.id });
  } catch (e) {
    const code = e instanceof ExpectedToolError ? e.code : "reddit_ads_execution_failed";
    const unknown = code === "reddit_ads_outcome_unknown" || (writeStarted && !(e instanceof ExpectedToolError));
    if (!unknown && (!writeStarted || ["reddit_ads_permission_denied", "reddit_ads_token_revoked", "reddit_ads_rate_limited", "reddit_ads_request_failed", "reddit_ads_invalid_request"].includes(code))) await dropAdSpendHold(hold);
    let error = e instanceof Error ? e.message : "Reddit execution failed";
    let state: Awaited<ReturnType<typeof progress>> | null = null;
    try { state = await progress(d); } catch { }
    if (state && (d.decision_class === "reddit_ads.prepare_campaign" || d.decision_class === "reddit_ads.replace_creative")) error += partialNote(state.ids, state.failed, unknown);
    const correctable = CORRECTABLE_CODES.includes(code);
    const held = ["reddit_ads_autopilot_off", "reddit_ads_policy_held", "reddit_ads_approval_required", "reddit_ads_founder_required", "reddit_ads_admin_required"].includes(code);
    return { ok: false, code: unknown ? "exec_outcome_unknown" : code, error, outcome_unknown: unknown, held_for_founder: held,
      execution_details: { ...details(d, unknown ? "outcome_unknown" : held ? "awaiting_founder" : "failed", state?.ids ?? {}), failed_step: state?.failed ?? null, approval_required: held, failure_reason: error,
        next_recovery_step: unknown ? "Reconcile the original operation key. Do not recreate it until the external outcome is established."
          : correctable ? (d.decision_class === "reddit_ads.prepare_campaign" || d.decision_class === "reddit_ads.launch_campaign" || d.decision_class === "reddit_ads.replace_creative" ? CORRECT_PLAN_STEP : "Do not retry this unchanged. Read the current Reddit object, correct the request and propose it again.")
          : "Resolve this failure and retry using the original operation key; completed steps are retained." } };
  }
}

export async function executeRedditAction(d: RedditExecRow): Promise<RedditExecResult> {
  const result = await execute(d);
  if (result.ok || result.outcome_unknown || result.code === "reddit_ads_budget_refused") {
    const quiet_ok = result.ok && !result.outcome_unknown && !result.error
      && (result.execution_details.external_ids as Record<string, unknown> | undefined)?.budget_hold !== "release_unconfirmed"
      && !(result.notice ?? "").includes(PLAN_NOT_UPDATED_NOTE.trim());
    try { await (await import("./monitor")).wakeRedditChange(d.tenant_id, `${d.id}:${result.execution_details.execution_state}`, [`Reddit action ${d.id}: ${result.execution_details.execution_state}. ${result.error ?? result.notice ?? "Read its ledger result."}`], { quiet_ok }); } catch { }
  }
  return result;
}
