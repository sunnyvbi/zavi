import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { isTenantDisabled } from "@/services/tenants/disabled";
import { readOwnedPostsShared, type XOwnedPost } from "@/services/x-social/owned-posts";
import { evaluateTrial, type OrganicTrialPost } from "./x-organic-trial-evaluation";
import { xOrganicTrialCopyIssue } from "@/agents/lib/x-organic-trial-copy";
import { createBody } from "@/services/connectors/x-ads/schema";
import { listXAdAccounts, xAdsTenantToken, listXFundingInstruments, listXOwnPosts, findXCountryPlace } from "@/services/connectors/x-ads/client";
import { assertXWriteAccess } from "@/services/connectors/x-ads/resources";
import { businessCountry } from "@/services/ad-locations/country";
import { readMonthCount } from "@/services/decisions/ad-month-counter";
import { buildXExecCardBody, X_CREATE_CAMPAIGN_CLASS } from "@/services/tools/x-ads/_exec-action";
import { recordChannelExecAction } from "./exec-actions";
import { refuseIfChannelPlanLocked } from "@/services/growth/preview-plan";
import { isChannelLockedStrict } from "./lock";

export type XOrganicTrial = { action_id: string; tenant_id: string; run_id: string; created_at: string; phase: string; receipts: OrganicTrialPost[]; proposal: Record<string, unknown> | null };
export type TrialCard = { status: string; body: { step?: { deliverable?: { kind?: string; parts?: Array<{ content: string }> } } }; edited_body?: { variants?: Record<string, { text?: string }>; text?: string } | null };
const fold = (s: string) => s.replace(/\s+/g, " ").trim();
const providerText = (s: string) => s.replace(/&(amp|lt|gt);/g, (_, entity: string) => entity === "amp" ? "&" : entity === "lt" ? "<" : ">");

export function matchTrialReceipts(card: TrialCard, posts: readonly XOwnedPost[], createdAt: string): OrganicTrialPost[] {
  const parts = card.body.step?.deliverable?.parts;
  if (card.body.step?.deliverable?.kind !== "post" || parts?.length !== 3) return [];
  if (card.edited_body?.text && !card.edited_body.variants) return [];
  const texts = parts.map((p, i) => card.edited_body?.variants?.[i]?.text ?? p.content);
  if (xOrganicTrialCopyIssue({ kind: "post", content: texts.join("\n\n"), parts: texts.map(content => ({ content })) })) return [];
  const receipts: OrganicTrialPost[] = [];
  for (const text of texts) {
    const matches = posts.filter(p => !p.is_reply && !p.is_repost && Date.parse(p.created_at) >= Date.parse(createdAt) && fold(providerText(p.text)) === fold(text));
    if (matches.length !== 1) return [];
    receipts.push({ id: matches[0].id, publishedAt: matches[0].created_at });
  }
  return new Set(receipts.map(p => p.id)).size === 3 ? receipts : [];
}

export function trialBudget(monthly: number, room: number, daysLeft: number): { daily: number; total: number; days: number } | null {
  if (![monthly, room, daysLeft].every(Number.isFinite) || monthly <= 0 || room <= 0 || daysLeft < 1) return null;
  const days = Math.min(14, Math.floor(daysLeft));
  const daily = Math.floor(Math.min(monthly / 30, room / (2 * days)) * 100) / 100;
  return daily >= 1 ? { daily, total: Math.floor(daily * days * 100) / 100, days } : null;
}

async function save(trial: XOrganicTrial, phase: string, note: string, extras: { receipts?: OrganicTrialPost[]; proposal?: Record<string, unknown>; resultId?: string } = {}) {
  const { data, error } = await tenantRpc(asTenantId(trial.tenant_id), "update_x_organic_trial", {
    p_action_id: trial.action_id, p_phase: phase, p_note: note,
    p_receipts: extras.receipts ?? null, p_proposal: extras.proposal ?? null, p_result_action_id: extras.resultId ?? null,
  });
  if (error) throw new Error(`trial update failed: ${error.message}`);
  if (!data || typeof data !== "object") throw new Error("trial update returned no persisted state");
  return data as XOrganicTrial;
}

async function prepareProposal(trial: XOrganicTrial, winner: { id: string; replies: number }, observedAt: string, tiedIds: string[]): Promise<Record<string, unknown> | null> {
  const budget = await readMonthCount(trial.tenant_id);
  if (budget && "unreadable" in budget) {
    await save(trial, "waiting_metrics", "A winning post is ready, but budget data could not be read. Zavi will retry."); return null;
  }
  if (!budget) {
    await save(trial, "waiting_budget", "A winning post is ready. Set your saved ad budget to review its promotion.");
    return null;
  }
  const b = trialBudget(budget.count.monthly_usd, Math.max(0, budget.count.month_cap_usd - budget.count.projection_usd), budget.count.days_left);
  if (!b) { await save(trial, "waiting_budget", "A winning post is ready, but the saved budget has no room for a test. Review your saved ad budget."); return null; }
  const accounts = await listXAdAccounts(trial.tenant_id);
  if (accounts.length !== 1 || accounts[0].currency !== "USD") {
    await save(trial, "waiting_connection", "A winning post is ready. This automatic budget proposal needs one connected X Ads account in USD; no currency conversion or account choice was guessed."); return null;
  }
  const account = accounts[0];
  const token = await xAdsTenantToken(trial.tenant_id);
  await assertXWriteAccess(token, account.id);
  if (!(await listXOwnPosts(token, account.id, [winner.id])).has(winner.id)) {
    await save(trial, "waiting_connection", `The winning post (https://x.com/i/web/status/${winner.id}) was not returned by the connected X Ads account. Check the connected X Ads account and that it can promote posts from the X profile that published it. Zavi will check again; no ad has been proposed.`);
    return null;
  }
  const funding = (await listXFundingInstruments(token, account.id)).filter(f => f.able_to_fund && f.currency === "USD");
  const country = await businessCountry(trial.tenant_id);
  const place = country ? await findXCountryPlace(token, country) : null;
  if (funding.length !== 1 || !place) { await save(trial, "waiting_connection", "A winning post is ready. Confirm the X funding account and the business location before reviewing the ad."); return null; }
  const rationale = `After all three posts were live for 72 hours, this post had ${winner.replies} replies (read ${observedAt}).${tiedIds.length ? " Reply counts tied; the lowest post ID breaks the tie." : ""} Suggested budget comes from your saved monthly budget and available room. Stop at USD ${b.total.toFixed(2)} total or after ${b.days} days. This is a spend cap, not an estimate of customer value. Approval creates a paused campaign. Review it before enabling spend.`;
  const rows = [
    { item: "Post", before: "Organic", after: `https://x.com/i/web/status/${winner.id}` },
    { item: "Replies", before: "Observation", after: String(winner.replies) },
    { item: "Daily budget", before: "No ad", after: `USD ${b.daily.toFixed(2)}` },
    { item: "Stop rule", before: "No ad", after: `USD ${b.total.toFixed(2)} total / ${b.days} days` },
    { item: "Location", before: "No ad", after: place.name },
  ];
  return { ...createBody.parse({
    account_id: account.id, funding_instrument_id: funding[0].id, name: `Organic test ${trial.action_id.slice(0, 8)}`,
    objective: "ENGAGEMENTS", daily_budget: b.daily, total_budget: b.total, tweet_ids: [winner.id],
    locations: [{ id: place.id, name: place.name }], start_time: new Date().toISOString(), end_time: null,
    duration_days: b.days, launch: "PAUSED", currency: "USD", rationale, summary: "Promote the organic post with the most replies", exact_change: { rows },
  }), origin: "x_organic_trial", organic_trial_id: trial.action_id };
}

async function filedTrialAction(trial: XOrganicTrial): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(trial.tenant_id)).from("channel_actions")
    .select("id").eq("run_id", trial.run_id).eq("channel_slug", "x_ads").eq("exec_class", X_CREATE_CAMPAIGN_CLASS)
    .eq("exec_payload->>origin", "x_organic_trial").eq("exec_payload->>organic_trial_id", trial.action_id).maybeSingle<{ id: string }>();
  if (error) throw new Error("Could not recover existing trial proposal");
  return data?.id ?? null;
}

async function fileProposal(trial: XOrganicTrial, proposal: Record<string, unknown>) {
  let id = await filedTrialAction(trial);
  if (!id) {
    const { title, card: body } = buildXExecCardBody(X_CREATE_CAMPAIGN_CLASS, proposal);
    try {
      id = (await recordChannelExecAction({ tenantId: trial.tenant_id, runId: trial.run_id, channelSlug: "x_ads", execClass: X_CREATE_CAMPAIGN_CLASS, execPayload: proposal, actionType: "create_ad", title, body })).id;
    } catch (error) {
      id = await filedTrialAction(trial);
      if (!id) throw error;
    }
  }
  await save(trial, "proposed", "The winning post has a promotion card. Check its current review status; this test will not create another one.", { resultId: id });
}

export async function deferXOrganicTrial(trial: XOrganicTrial) {
  await save(trial, "waiting_metrics", "This test could not be advanced. Zavi will retry; no new ad has been launched.");
}

export async function processXOrganicTrial(trial: XOrganicTrial, clock?: number): Promise<void> {
  if (["cancelled", "expired", "proposed", "no_replies"].includes(trial.phase)) return;
  if (await isTenantDisabled(trial.tenant_id)) { await save(trial, "cancelled", "Workspace disabled."); return; }
  if (await isChannelLockedStrict("x_ads") || await refuseIfChannelPlanLocked(trial.tenant_id, "x_ads")) {
    await save(trial, "waiting_connection", "X Ads is not available on this workspace. No promotion was proposed."); return;
  }
  const db = tenantClient(asTenantId(trial.tenant_id));
  const { data, error } = await db.from("channel_actions").select("status,body,edited_body").eq("id", trial.action_id).eq("run_id", trial.run_id).eq("channel_slug", "x_ads").maybeSingle();
  if (error) throw new Error(`trial card read failed: ${error.message}`);
  const card = data as TrialCard | null;
  if (!card || !["pending", "acted", "snoozed"].includes(card.status)) { await save(trial, "cancelled", "The organic test was closed."); return; }
  if (trial.proposal) {
    const existing = await filedTrialAction(trial);
    if (existing) {
      await save(trial, "proposed", "Recovered the existing promotion card; its review status is unchanged.", { resultId: existing }); return;
    }
  }
  if ((clock ?? Date.now()) - Date.parse(trial.created_at) > 30 * 86400000) {
    await save(trial, "expired", "This test could not be completed within the 30-day post history window. Start a new organic test."); return;
  }
  if (trial.proposal) { await fileProposal(trial, trial.proposal); return; }
  const read = await readOwnedPostsShared(trial.tenant_id, { max_results: 20, include_replies: false });
  if (read.partial_errors.length) { await save(trial, "waiting_metrics", "Some X post results are unavailable. Zavi will retry; no ad has been proposed."); return; }
  const receipts = matchTrialReceipts(card, read.items, trial.created_at);
  const outcome = evaluateTrial({ posts: receipts, metrics: read.items.map(p => ({ id: p.id, replies: p.public_metrics?.reply_count ?? null })), fetchedAt: read.fetched_at, now: clock ?? Date.now() });
  if (outcome.kind === "waiting_publication") { await save(trial, "awaiting_posts", "Waiting to confirm all three posts on your connected X account. No ad inputs are needed."); return; }
  if (outcome.kind === "waiting_window") { await save(trial, "observing", `All three posts are live. Replies will be compared after ${outcome.dueAt}.`, { receipts }); return; }
  if (outcome.kind === "waiting_metrics") { await save(trial, "waiting_metrics", "Waiting for complete X reply counts from after the observation window.", { receipts }); return; }
  if (outcome.kind === "no_replies") { await save(trial, "no_replies", "All three posts received zero replies. Do not promote them. Try three new organic posts with a different question or angle.", { receipts }); return; }
  const proposal = await prepareProposal(trial, outcome.winner, outcome.observedAt, outcome.tiedIds);
  if (!proposal) return;
  const persisted = await save(trial, "observing", "A winner is ready for a promotion proposal.", { receipts, proposal });
  if (["cancelled", "expired", "proposed", "no_replies"].includes(persisted.phase)) return;
  if (!persisted.proposal) throw new Error("trial proposal was not persisted");
  await fileProposal(persisted, persisted.proposal);
}
