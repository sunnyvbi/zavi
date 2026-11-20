import { apiFetch } from "@/lib/api";
import type { RedditPostSuggestion } from "@/components/agents/RedditPostCard";
import type { RedditReplyOpportunity } from "@/components/agents/RedditReplyCard";
import type { RedditInsights } from "./types";

export type Verdict = "allowed" | "unclear" | "banned";

export type Keyword = {
  id: string;
  term: string;
  type: string;
  origin: "suggested" | "custom";
  status: "suggested" | "tracking" | "paused" | "dismissed";
  why?: string | null;
};
export type Competitor = {
  id: string;
  name: string;
  domain: string | null;
  origin?: "suggested" | "custom";
  status: "suggested" | "tracking" | "paused" | "dismissed";
  why?: string | null;
};
export type Community = {
  id: string;
  name: string;
  selected: boolean;
  rules_verdict: Verdict | null;
  rules_verdict_at: string | null;
};

export type SupportingStep = {
  id: string;
  title: string;
  body: string | null;
  blocking: boolean;
  effort: string | null;
  evidence: string[];
  deliverable?: { kind: string; label: string | null; content: string };
};

export type RedditPayload = {
  generic?: boolean;
  connected: boolean;
  workspace_v2?: boolean;
  account?: { connected: boolean; handle: string | null };
  manual_publish: boolean;
  research_summary: string | null;
  suggestions: Array<RedditPostSuggestion | RedditReplyOpportunity>;
  supporting_steps?: SupportingStep[];
  last_run?: { id: string; status: string | null; enqueued_at: string | null } | null;
  workspace?: { keywords: Keyword[]; competitors: Competitor[]; communities: Community[] };
  insights?: RedditInsights | null;
  insights_error?: string | null;
  workspace_error?: string | null;
  overview?: {
    kpis: {
      reply_opportunities: number;
      post_opportunities: number;
      communities: number;
      tracked_keywords: number;
      tracked_competitors: number;
    };
    top_communities: Array<{
      name: string;
      reply_opportunities: number;
      post_opportunities: number;
      saved: boolean;
      selected: boolean;
      rules_verdict: Verdict | null;
    }>;
    unavailable: ReadonlyArray<{ metric: string; reason: string }>;
  };
};

export const UNAVAILABLE_LABEL: Record<string, string> = {
  mentions: "Mentions",
  share_of_voice: "Share of voice",
  google_rank: "Google ranking",
  impressions: "Impressions",
};

export const VERDICT_COPY: Record<Verdict, { label: string; tone: "good" | "warn" | "bad" }> = {
  allowed: { label: "You: founders may answer", tone: "good" },
  unclear: { label: "You: rules unclear", tone: "warn" },
  banned: { label: "You: self-promo banned", tone: "bad" },
};

export const OWNER_ONLY = "Only an owner or an admin can change this.";

async function serverMessage(res: Response): Promise<string | null> {
  const body = (await res.clone().json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
  if (typeof body?.message === "string" && body.message.trim()) return body.message;
  const nested = body?.error && typeof body.error === "object" ? (body.error as { message?: unknown }).message : null;
  return typeof nested === "string" && nested.trim() ? nested : null;
}

export async function draftErrorMessage(res: Response): Promise<string> {
  if (res.status === 429) return "You've drafted a lot this hour. Try again later.";
  if (res.status === 404) return "This thread is no longer available.";
  if (res.status === 409) return (await serverMessage(res)) ?? "You already replied on this thread, so Zavi kept that reply.";
  if (res.status === 403) return (await serverMessage(res)) ?? OWNER_ONLY;
  return "Couldn't draft a reply. Try again in a moment.";
}

export async function requestReplyDraft(threadId: string): Promise<string | null> {
  try {
    const res = await apiFetch(`/api/reddit/threads/${encodeURIComponent(threadId)}/draft`, { method: "POST" });
    return res.ok ? null : await draftErrorMessage(res);
  } catch {
    return "Couldn't reach Zavi. Check your connection.";
  }
}

export async function send(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<string | null> {
  try {
    const res = await apiFetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return null;
    if (res.status === 409) {
      const err = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
      const refusal = err && err.error !== "already_exists" && typeof err.message === "string" ? err.message : null;
      return refusal ?? "Already saved.";
    }
    if (res.status === 403) return (await serverMessage(res)) ?? OWNER_ONLY;
    if (res.status === 400) return "That doesn't look right. Check the value and try again.";
    return "Couldn't save that. Try again in a moment.";
  } catch {
    return "Couldn't reach Zavi. Check your connection.";
  }
}
