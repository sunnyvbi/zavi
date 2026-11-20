
import { campaignFetch } from "../api";

export const META_API = "/api/channels/meta_ads";

export type MetaPlacement = "facebook" | "instagram" | "messenger" | "audience_network" | "threads";
export const META_PLACEMENTS: ReadonlyArray<{ value: MetaPlacement; label: string }> = [
  { value: "facebook", label: "Facebook" },
  { value: "instagram", label: "Instagram" },
  { value: "messenger", label: "Messenger" },
  { value: "audience_network", label: "Audience Network" },
  { value: "threads", label: "Threads" },
];

export const META_GOALS = [
  { value: "traffic", label: "Website visits", hint: "Meta finds people likely to click through to your link." },
  { value: "conversions", label: "Conversions", hint: "Meta finds people likely to buy or sign up, counted by your Meta pixel." },
  { value: "awareness", label: "Reach", hint: "Meta shows your ad to as many people as it can for the budget." },
] as const;
export type MetaGoal = (typeof META_GOALS)[number]["value"];

export const META_CONVERSION_EVENTS = [
  { value: "PURCHASE", label: "Purchase" },
  { value: "LEAD", label: "Lead" },
  { value: "COMPLETE_REGISTRATION", label: "Sign-up" },
  { value: "INITIATED_CHECKOUT", label: "Started checkout" },
  { value: "ADD_TO_CART", label: "Add to cart" },
] as const;

export const META_CTAS = [
  ["LEARN_MORE", "Learn more"],
  ["SHOP_NOW", "Shop now"],
  ["SIGN_UP", "Sign up"],
  ["BOOK_TRAVEL", "Book now"],
  ["GET_OFFER", "Get offer"],
  ["CONTACT_US", "Contact us"],
  ["SUBSCRIBE", "Subscribe"],
  ["APPLY_NOW", "Apply now"],
  ["DOWNLOAD", "Download"],
  ["ORDER_NOW", "Order now"],
  ["GET_QUOTE", "Get quote"],
] as const;

export type MetaEditorView = {
  campaign: {
    id: string;
    name: string;
    status: string | null;
    objective: string | null;
    budget_level: "campaign" | "ad_set" | "lifetime" | "mixed" | "none";
    daily_budget: number | null;
    spend_cap: number | null;
  };
  ad_sets: Array<{
    id: string;
    name: string;
    status: string | null;
    daily_budget: number | null;
    end_time: string | null;
    places: Array<{ id: string; name: string }>;
    places_editable: boolean;
    placements: MetaPlacement[] | null;
  }>;
  ads: Array<{ id: string; name: string; status: string | null; ad_set_id: string | null; headline: string | null; primary_text: string | null; link_url: string | null; image_url: string | null }>;
  currency: string;
  writes_enabled: boolean;
};

export type MetaChange = { label: string; decision_id: string; approved: boolean; code: string | null };

export type MetaChangeOutcome =
  | { state: "done" }
  | { state: "refused"; message: string }
  | { state: "waiting"; message: string }
  | { state: "running" };

export function readMetaCampaign(campaignId: string): Promise<MetaEditorView> {
  return campaignFetch<MetaEditorView>(`${META_API}/campaigns/${encodeURIComponent(campaignId)}`);
}

export async function saveMetaEdits(campaignId: string, body: Record<string, unknown>): Promise<MetaChange[]> {
  const r = await campaignFetch<{ changes: MetaChange[] }>(`${META_API}/campaigns/${encodeURIComponent(campaignId)}`, { method: "POST", body: JSON.stringify(body) });
  return r.changes ?? [];
}

export async function createMetaCampaign(body: Record<string, unknown>): Promise<MetaChange[]> {
  const r = await campaignFetch<{ changes: MetaChange[] }>(`${META_API}/campaigns`, { method: "POST", body: JSON.stringify(body) });
  return r.changes ?? [];
}

export const metaChildPath = (campaignId: string, kind: "ad-sets" | "ads") => `${META_API}/campaigns/${encodeURIComponent(campaignId)}/${kind}`;

export async function createMetaChild(path: string, body: Record<string, unknown>, key: string): Promise<MetaChange[]> {
  const r = await campaignFetch<{ changes: MetaChange[] }>(path, { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": key } });
  return r.changes ?? [];
}

async function stageThenApprove(path: string, body: Record<string, unknown>, label: string): Promise<MetaChange> {
  const staged = await campaignFetch<{ decision_id: string }>(path, { method: "POST", body: JSON.stringify(body) });
  try {
    await campaignFetch(`/api/approvals/${encodeURIComponent(staged.decision_id)}/approve`, { method: "POST", body: "{}" });
    return { label, decision_id: staged.decision_id, approved: true, code: null };
  } catch (e) {
    const code = (e as { code?: string }).code ?? "approve_failed";
    try {
      const j = await campaignFetch<{ status?: string }>(`/api/agents/performance-marketer/budget-edit/status/${encodeURIComponent(staged.decision_id)}`);
      if (j.status === "approved") {
        try {
          await campaignFetch(`/api/approvals/${encodeURIComponent(staged.decision_id)}/approve`, { method: "POST", body: "{}" });
        } catch {
          return { label, decision_id: staged.decision_id, approved: false, code: "dispatch_unsent" };
        }
      }
      if (j.status === "approved" || j.status === "dispatching" || j.status === "acted") return { label, decision_id: staged.decision_id, approved: true, code: null };
    } catch {
    }
    return { label, decision_id: staged.decision_id, approved: false, code };
  }
}

export function setMetaDailyBudget(campaignId: string, name: string, budget: number): Promise<MetaChange> {
  return stageThenApprove(
    "/api/agents/performance-marketer/budget-edit",
    { channel: "meta", campaign_id: campaignId, campaign_name: name, proposed_daily_budget_usd: budget },
    `${name}: daily budget`,
  );
}

export function setMetaCampaignOn(campaignId: string, name: string, on: boolean): Promise<MetaChange> {
  return stageThenApprove(
    "/api/agents/performance-marketer/campaign-status",
    { channel: "meta", campaign_id: campaignId, campaign_name: name, enabled: on },
    on ? `${name}: switch on` : `${name}: pause`,
  );
}

const WAITING: Record<string, string> = {
  budget_choice_required: "This goes over your Zavi ad budget. Open it in Approvals to choose a new limit.",
  budget_choice_in_zavi: "This goes over your Zavi ad budget. Open it in Approvals to choose a new limit.",
  not_authorized: "Only a workspace owner or admin can approve this. It is waiting in Approvals.",
  paired_move_waits: "It waits for a matching budget cut. Open it in Approvals.",
  stage_unknown: "Zavi could not confirm this change. Check Approvals before saving it again.",
  dispatch_unsent: "Approved, but Zavi could not start it yet. Reopen the campaign in a minute to see whether it went through.",
};

export function metaRefusalText(reason: string | null | undefined): string {
  const r = (reason ?? "").toLowerCase();
  if (!r) return "Meta did not take this change.";
  if (r.includes("drift")) return "This changed in Meta since you opened it. Reopen the campaign and try again.";
  if (r.includes("ad_budget_over_")) return "Budget limit reached. Nothing was sent to Meta. Raise your ad budget, or save a smaller change.";
  if (r.includes("cap_refuse")) return "This is over the Meta daily limit set in Zavi.";
  if (r.includes("write_disabled")) return "Zavi can't change Meta campaigns right now. Nothing was sent.";
  return `Meta did not take this change: ${reason}`;
}

export async function waitForMetaChange(change: MetaChange, ms = 25_000, sleep = (n: number) => new Promise((r) => setTimeout(r, n))): Promise<MetaChangeOutcome> {
  if (!change.approved) return { state: "waiting", message: WAITING[change.code ?? ""] ?? "It is waiting in Approvals." };
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await sleep(1500);
    try {
      const j = await campaignFetch<{ status?: string; dispatch_error?: string | null }>(
        `/api/agents/performance-marketer/budget-edit/status/${encodeURIComponent(change.decision_id)}`,
      );
      if (j.status === "acted") return { state: "done" };
      if (j.status === "rejected" || j.status === "dispatch_failed") return { state: "refused", message: metaRefusalText(j.dispatch_error) };
    } catch {
    }
  }
  return { state: "running" };
}

export const META_EDITOR_EVENT = "zavi:meta-campaign-editor";
export type MetaEditorTarget = { campaign_id: string; create?: "group" | "ad" } | "new";

export function openMetaCampaignEditor(target: MetaEditorTarget): void {
  window.dispatchEvent(new CustomEvent<MetaEditorTarget>(META_EDITOR_EVENT, { detail: target }));
}
