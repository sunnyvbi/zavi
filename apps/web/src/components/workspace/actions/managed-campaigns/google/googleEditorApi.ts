
import { campaignFetch } from "../api";

export type GoogleEditorChannel = "google_ads" | "youtube_ads";
export const editorApi = (channel: GoogleEditorChannel) => `/api/channels/${channel}`;
export const GOOGLE_API = editorApi("google_ads");

export const GOOGLE_GOALS = [
  { value: "clicks", label: "Clicks", hint: "Google gets as many clicks as it can for the budget (Maximize clicks)." },
  { value: "conversions", label: "Conversions", hint: "Google bids for people likely to buy or sign up, counted by your Google Ads conversions (Maximize conversions)." },
] as const;
export type GoogleGoal = (typeof GOOGLE_GOALS)[number]["value"];

export const MATCH_TYPES = [
  { value: "PHRASE", label: "Phrase" },
  { value: "EXACT", label: "Exact" },
  { value: "BROAD", label: "Broad" },
] as const;
export type MatchType = (typeof MATCH_TYPES)[number]["value"];

export type GoogleKeyword = { criterion_id: string; text: string; match_type: string; status: string | null };

export type GoogleEditorView = {
  campaign: {
    id: string;
    name: string;
    status: string | null;
    channel_type: string;
    bidding_strategy_type: string;
    daily_budget: number | null;
    budget_shared: boolean;
    target_cpa: number | null;
    target_roas: number | null;
    network: { search_network: boolean; content_network: boolean } | null;
    end_date: string | null;
  };
  places: Array<{ id: string; name: string }>;
  places_editable: boolean;
  places_fingerprint: string | null;
  ad_groups: Array<{ id: string; name: string; status: string | null; type: string; cpc_bid: number | null; keywords: GoogleKeyword[] }>;
  negative_keywords: GoogleKeyword[];
  ads: Array<{ id: string; ad_group_id: string; status: string | null; type: string; headlines: string[]; descriptions: string[]; final_url: string | null }>;
  keywords_editable: boolean;
  read_only?: "video" | null;
  currency: string;
  writes_enabled: boolean;
};

export type GoogleChange = { label: string; decision_id: string; approved: boolean; code: string | null };

export type GoogleChangeOutcome =
  | { state: "done" }
  | { state: "refused"; message: string }
  | { state: "waiting"; message: string }
  | { state: "running" };

export function readGoogleCampaign(campaignId: string, channel: GoogleEditorChannel = "google_ads"): Promise<GoogleEditorView> {
  return campaignFetch<GoogleEditorView>(`${editorApi(channel)}/campaigns/${encodeURIComponent(campaignId)}`);
}

export async function saveGoogleEdits(campaignId: string, body: Record<string, unknown>, channel: GoogleEditorChannel = "google_ads"): Promise<GoogleChange[]> {
  const r = await campaignFetch<{ changes: GoogleChange[] }>(`${editorApi(channel)}/campaigns/${encodeURIComponent(campaignId)}`, { method: "POST", body: JSON.stringify(body) });
  return r.changes ?? [];
}

export async function createGoogleCampaign(body: Record<string, unknown>, channel: GoogleEditorChannel = "google_ads"): Promise<GoogleChange[]> {
  const r = await campaignFetch<{ changes: GoogleChange[] }>(`${editorApi(channel)}/campaigns`, { method: "POST", body: JSON.stringify(body) });
  return r.changes ?? [];
}

export const googleChildPath = (campaignId: string, kind: "ad-groups" | "ads") => `${GOOGLE_API}/campaigns/${encodeURIComponent(campaignId)}/${kind}`;

export async function createGoogleChild(path: string, body: Record<string, unknown>, key: string): Promise<GoogleChange[]> {
  const r = await campaignFetch<{ changes: GoogleChange[] }>(path, { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": key } });
  return r.changes ?? [];
}

async function stageThenApprove(path: string, body: Record<string, unknown>, label: string): Promise<GoogleChange> {
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

export function setGoogleDailyBudget(campaignId: string, name: string, budget: number): Promise<GoogleChange> {
  return stageThenApprove(
    "/api/agents/performance-marketer/budget-edit",
    { channel: "google", campaign_id: campaignId, campaign_name: name, proposed_daily_budget_usd: budget },
    `${name}: daily budget`,
  );
}

export function setGoogleCampaignOn(campaignId: string, name: string, on: boolean): Promise<GoogleChange> {
  return stageThenApprove(
    "/api/agents/performance-marketer/campaign-status",
    { channel: "google", campaign_id: campaignId, campaign_name: name, enabled: on },
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

export function googleRefusalText(reason: string | null | undefined): string {
  const r = (reason ?? "").toLowerCase();
  if (!r) return "Google Ads did not take this change.";
  if (r.includes("drift") || r.includes("changed since")) return "This changed in Google Ads since you opened it. Reopen the campaign and try again.";
  if (r.includes("ad_budget_over_")) return "Budget limit reached. Nothing was sent to Google. Raise your ad budget, or save a smaller change.";
  if (r.includes("cap_refuse")) return "This is over the Google daily limit set in Zavi.";
  if (r.includes("write_disabled")) return "Zavi can't change Google Ads campaigns right now. Nothing was sent.";
  if (r.includes("non_usd")) return "Zavi changes Google Ads campaigns in USD accounts only.";
  if (r.includes("video_mutate_unsupported")) return "Google's Ads API can't change Video campaigns. Change it in Google Ads.";
  return `Google Ads did not take this change: ${reason}`;
}

export async function waitForGoogleChange(change: GoogleChange, ms = 25_000, sleep = (n: number) => new Promise((r) => setTimeout(r, n))): Promise<GoogleChangeOutcome> {
  if (!change.approved) return { state: "waiting", message: WAITING[change.code ?? ""] ?? "It is waiting in Approvals." };
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await sleep(1500);
    try {
      const j = await campaignFetch<{ status?: string; dispatch_error?: string | null }>(
        `/api/agents/performance-marketer/budget-edit/status/${encodeURIComponent(change.decision_id)}`,
      );
      if (j.status === "acted") return { state: "done" };
      if (j.status === "rejected" || j.status === "dispatch_failed") return { state: "refused", message: googleRefusalText(j.dispatch_error) };
    } catch {
    }
  }
  return { state: "running" };
}

export const GOOGLE_EDITOR_EVENT = "zavi:google-campaign-editor";
export const YOUTUBE_EDITOR_EVENT = "zavi:youtube-campaign-editor";
export const editorEvent = (channel: GoogleEditorChannel) => (channel === "youtube_ads" ? YOUTUBE_EDITOR_EVENT : GOOGLE_EDITOR_EVENT);
export type GoogleEditorTarget = { campaign_id: string; create?: "group" | "ad" } | "new";

export function openGoogleCampaignEditor(target: GoogleEditorTarget, channel: GoogleEditorChannel = "google_ads"): void {
  window.dispatchEvent(new CustomEvent<GoogleEditorTarget>(editorEvent(channel), { detail: target }));
}
