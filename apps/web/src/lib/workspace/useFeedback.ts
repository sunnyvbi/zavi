"use client";

import { apiFetch } from "@/lib/api";

export type FeedbackResult =
  | { ok: true; status: "active" | "suggested" | "duplicate" | "exists"; rule_id: string | null }
  | { ok: false; error: string };

export async function submitFeedback(args: { agent_slug: string; body: string }): Promise<FeedbackResult> {
  try {
    const res = await apiFetch("/api/agents/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: args.agent_slug, text: args.body }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      return { ok: false, error: j?.error?.message ?? "Could not save the rule." };
    }
    const data = (await res.json()) as { status: string; rule_id?: string };
    return {
      ok: true,
      status: data.status as "active" | "suggested" | "duplicate" | "exists",
      rule_id: data.rule_id ?? null,
    };
  } catch {
    return { ok: false, error: "Could not reach Zavi. Try again." };
  }
}

export function feedbackConfirmation(body: string, status: string): string {
  if (status === "suggested") {
    return `Suggested as a rule for this agent: "${body}". An owner or admin can turn it on in Settings → Rules.`;
  }
  if (status === "duplicate" || status === "exists") {
    return `That rule is already saved: "${body}".`;
  }
  return `Rule saved for this agent: "${body}". It applies from its next run. See or change it in Settings → Rules.`;
}
