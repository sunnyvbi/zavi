import { asTenantId, tenantClient } from "@/services/tenant-client";
import { reconcileChannelActionExec } from "@/services/channels/exec-actions";
import { commitAdSpend, rebaseAdSpendForObject } from "@/services/decisions/ad-budget";
import { HOLD_KEPT_NOTE, releaseRedditHolds } from "./hold-release";
import type { ReconcileTarget } from "@/services/connectors/email-campaign/reconcile";
import { endpoint, getObject, getPost, listObjects, objectSchema, ownedAccount, pages, record, type RedditObject } from "./adapter";
import { operationStore, type Operation } from "./operations";
import { adoptPreparedEdit, preparedEditFor } from "./prepared-edits";
import { REDDIT_ACTION_SCHEMAS, budgetSchema, prepareSchema, removeSchema, replacementSchema, statusSchema, targetingSchema, type RedditActionClass, type RedditLevel } from "./schema";
import { findStepPost, postMatchesCreative, targetingMatches, verifyManifest } from "./lifecycle";

async function settleRecoveredSpend(actionId: string, target: ReconcileTarget, account: Awaited<ReturnType<typeof ownedAccount>>["account"]): Promise<boolean> {
  const commit = () => commitAdSpend({ status: "held", tenant_id: target.tenant_id, idem_key: `${actionId}:${target.exec_class === "reddit_ads.update_budget" ? "raise" : "resume"}`, fresh: false });
  if (target.exec_class === "reddit_ads.launch_campaign") { await commit(); return true; }
  if (target.exec_class === "reddit_ads.update_budget") {
    const b = budgetSchema.parse(target.exec_payload);
    const delta = b.daily_budget_usd - b.expected_current_daily_budget_usd;
    if (delta > 0) await commit();
    if (delta < 0) await rebaseAdSpendForObject(target.tenant_id, "reddit", b.ad_group_id, b.daily_budget_usd, `${actionId}:rebase`, -delta);
  }
  if (target.exec_class === "reddit_ads.remove_object") {
    const b = removeSchema.parse(target.exec_payload);
    return releaseRedditHolds(target.tenant_id, account, b.ad_account_id, b.level, b.object_id);
  }
  if (target.exec_class === "reddit_ads.set_object_status") {
    const b = statusSchema.parse(target.exec_payload);
    if (b.status === "ACTIVE") { await commit(); return true; }
    return releaseRedditHolds(target.tenant_id, account, b.ad_account_id, b.level, b.object_id);
  }
  return true;
}

export function matchesRequest(live: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(live) && live.length === expected.length && expected.every((v, i) => matchesRequest(live[i], v));
  if (record(expected)) return record(live) && Object.entries(expected).every(([key, value]) => {
    const current = live[key];
    if (key === "start_time" && typeof value === "string") return typeof current === "string" && Date.parse(current) === Date.parse(value);
    if (key !== "targeting") return matchesRequest(current, value);
    const targeting = targetingSchema.safeParse(value);
    return targeting.success && targetingMatches(current, targeting.data);
  });
  return live === expected;
}
export async function reconcileRedditOperation(tenantId: string, key: string, actionId: string, accountId: string, patchLevel?: RedditLevel) {
  const { account } = await ownedAccount(tenantId, accountId);
  const db = tenantClient(asTenantId(tenantId));
  const { data, error } = await db.from("reddit_ad_operations").select("step,state,result,request_hash,request,created_at").eq("operation_key", key).order("created_at");
  if (error) throw error;
  const plan = (data as Operation[] | null)?.find((r) => r.step === "plan");
  if (plan && plan.request.ad_account_id !== accountId) throw new Error("This operation belongs to a different Reddit ad account.");
  const store = operationStore(tenantId, key, actionId);
  const rows = (data ?? []) as Operation[];
  const ids: Record<string, string> = {};
  let unresolved = false;
  for (const row of rows) {
    if (row.state === "complete") {
      if (record(row.result) && typeof row.result.id === "string") ids[row.step] = row.result.id;
      continue;
    }
    if (row.state === "failed") continue;
    if (row.step === "plan") { await store.save("plan", "complete", row.request); continue; }
    if (row.step === "manifest") continue;
    let found: RedditObject | null = null;
    if (row.step.startsWith("post_")) {
      const plan = await store.read("plan");
      const profile = record(plan?.result) ? plan.result.profile_id : row.request.profile_id;
      if (typeof profile !== "string") { unresolved = true; continue; }
      const posts = await pages(account, "LIST_POSTS", { profile_id: profile, page_size: 100 }, endpoint("profiles", profile, "/posts"));
      try {
        const post = await findStepPost(tenantId, posts, { ...row.request, profile_id: profile }, row.created_at);
        if (post) found = objectSchema.parse(post);
      } catch {  }
    } else {
      const level = row.step === "campaign" ? "campaign" : row.step === "group" ? "ad_group" : row.step.startsWith("ad_") || row.step === "replacement_ad" ? "ad" : row.step === "patch" ? patchLevel : undefined;
      if (level) {
        if (typeof row.request.id === "string") found = await getObject(account, accountId, level, row.request.id);
        else {
          const matches = (await listObjects(account, accountId, level)).filter((o) => o.name === row.request.name);
          if (matches.length === 1) found = await getObject(account, accountId, level, matches[0].id);
        }
      } else if (row.step.startsWith("enable_") && typeof row.request.id === "string") {
        const id = row.request.id;
        const level = ids.campaign === id ? "campaign" : ids.group === id ? "ad_group" : "ad";
        found = await getObject(account, accountId, level, id);
      }
    }
    if (found && (row.step.startsWith("post_") || matchesRequest(found, row.request))) {
      await store.save(row.step, "complete", found);
      ids[row.step] = found.id;
    } else unresolved = true;
  }
  return { store, ids, unresolved, account };
}
export async function reconcileRedditAction(actionId: string, target: ReconcileTarget): Promise<{ done: boolean; outcome: string }> {
  const cls = target.exec_class as RedditActionClass;
  const schema = REDDIT_ACTION_SCHEMAS[cls];
  if (!schema || target.exec_status === "executed") return { done: true, outcome: "nothing_to_do" };
  if (target.exec_status === "dispatching" && !target.lease_expired) return { done: false, outcome: "in_flight" };
  if (target.exec_status !== "dispatching" && !(target.exec_status === "failed" && ["exec_outcome_unknown", "exec_partial"].includes(String(target.exec_result?.code)))) return { done: true, outcome: "nothing_to_do" };
  const body = schema.parse(target.exec_payload);
  const key = "operation_key" in body ? body.operation_key : `action_${actionId}`;
  const level = "ad_group_id" in body ? "ad_group" : "ad_id" in body ? "ad" : "level" in body ? body.level : undefined;
  try {
    const r = await reconcileRedditOperation(target.tenant_id, key, actionId, body.ad_account_id, level);
    if (r.unresolved) return { done: false, outcome: "could_not_read" };
    let complete = false;
    if (cls === "reddit_ads.prepare_campaign") {
      const plan = prepareSchema.parse(body);
      const campaign = await r.store.read("campaign");
      const group = await r.store.read("group");
      const ads = await Promise.all(plan.creatives.map((_, i) => r.store.read(`ad_${i}`)));
      if (campaign?.state === "complete" && group?.state === "complete" && ads.every((a) => a?.state === "complete")) {
        const manifest = await verifyManifest(r.account, plan, { id: r.ids.campaign, campaign: objectSchema.parse(campaign.result), group: objectSchema.parse(group.result), ads: ads.map((a) => objectSchema.parse(a?.result)) }, "PAUSED");
        await r.store.claim("manifest", { campaign_id: manifest.id });
        await r.store.save("manifest", "complete", manifest);
        complete = true;
      }
    } else if (cls === "reddit_ads.launch_campaign") {
      const { preparedCampaign } = await import("./lifecycle");
      const p = await preparedCampaign(target.tenant_id, key, actionId);
      const enabled = await Promise.all([p.manifest.campaign, p.manifest.group, ...p.manifest.ads].map((o) => r.store.read(`enable_${o.id}`)));
      if (enabled.every((s) => s?.state === "complete")) { await verifyManifest(r.account, p.plan, p.manifest, "ACTIVE"); complete = true; }
    } else {
      const replacement = cls === "reddit_ads.replace_creative";
      const step = await r.store.read(replacement ? "replacement_ad" : "patch");
      if (step?.state === "complete") {
        const saved = objectSchema.parse(step.result);
        const objectLevel = replacement ? "ad" : level;
        if (!objectLevel) throw new Error("The recovered object level is missing.");
        const live = await getObject(r.account, body.ad_account_id, objectLevel, saved.id);
        if (!matchesRequest(live, step.request)) throw new Error("The recovered object changed; review its current settings before settlement.");
        if (replacement) {
          const input = replacementSchema.parse(body);
          if (typeof live.post_id !== "string" || !postMatchesCreative(await getPost(r.account, live.post_id), input.profile_id, input.creative)) throw new Error("The replacement post could not be confirmed; review it before settlement.");
        }
        complete = true;
      }
    }
    const released = complete ? await settleRecoveredSpend(actionId, target, r.account) : true;
    const holdNote = released ? "" : HOLD_KEPT_NOTE;
    let planWarning: string | null = null;
    if (complete) {
      const edit = preparedEditFor(cls, body as Record<string, unknown>);
      if (edit) {
        try { await adoptPreparedEdit(target.tenant_id, r.account, edit); } catch (e) {
          console.warn(`[reddit-ads] prepared plan not updated after a reconciled edit: ${(e as Error).message}`);
          planWarning = "The change is live in Reddit, but Zavi could not update the prepared campaign's plan, so it may not launch as it is. Read check_readiness before launching; if it shows the campaign as drifted, prepare it again.";
        }
      }
    }
    const error = complete ? null : "Interrupted safely. Completed object IDs are retained. Approve the original action again to finish its remaining steps.";
    const settled = await reconcileChannelActionExec(target.tenant_id, { actionId, execClass: cls, ok: complete, error, result: { reconciled: true, ...(error ? { error, code: "reddit_ads_interrupted" } : { notice: `Reddit settings confirmed by read-only reconciliation; delivery remains unconfirmed.${holdNote}${planWarning ? ` ${planWarning}` : ""}`, ...(planWarning ? { plan_warning: planWarning } : {}) }), execution_details: { action_id: actionId, external_ids: released ? r.ids : { ...r.ids, budget_hold: "release_unconfirmed" }, execution_state: complete ? "confirmed" : "interrupted", delivery_state: "unconfirmed", approval_required: !complete, failure_reason: error, next_recovery_step: error ?? planWarning ?? "Read fresh delivery and performance." } } });
    if (!settled.ok) return { done: false, outcome: "could_not_read" };
    const quiet_ok = complete && released && !planWarning;
    try { await (await import("./monitor")).wakeRedditChange(target.tenant_id, `${actionId}:reconciled:${complete ? "confirmed" : "interrupted"}`, [`Reddit action ${actionId}: ${complete ? `confirmed by platform reads; delivery remains unconfirmed${released ? "" : "; its budget hold could not be confirmed released"}${planWarning ? `. ${planWarning}` : ""}` : error}.`], { quiet_ok }); } catch { }
    return { done: true, outcome: complete ? "confirmed" : "interrupted" };
  } catch { return { done: false, outcome: "could_not_read" }; }
}
