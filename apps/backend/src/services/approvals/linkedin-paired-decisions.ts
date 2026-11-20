import { OPEN_CHANNEL_ACTIONS_VIEW } from "@/services/channels/open-actions-count";

export type LinkedInPending = { id: string; decision_class: string; social_channel: string | null; social_text?: unknown; social_original_text?: unknown };
const key = (text: unknown) => typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";

export function pairedLinkedInDecisionIds(decisions: readonly LinkedInPending[], actions: readonly { content?: unknown; action_type?: unknown }[]): Set<string> {
  const available = new Map<string, number>();
  for (const a of actions) {
    const text = key(a.content);
    if (a.action_type === "text_post" && text) available.set(text, (available.get(text) ?? 0) + 1);
  }
  const paired = new Set<string>();
  for (const d of decisions) {
    if (d.decision_class !== "social.publish.v2" || d.social_channel !== "linkedin") continue;
    const text = key(d.social_original_text ?? d.social_text); const left = available.get(text) ?? 0;
    if (left > 0) { paired.add(d.id); available.set(text, left - 1); }
  }
  return paired;
}

export async function readPairedLinkedInDecisions(sb: { from: (table: string) => any }, tenantId: string, decisions: readonly LinkedInPending[]): Promise<Set<string>> {
  if (!decisions.some(d => d.social_channel === "linkedin" && d.decision_class === "social.publish.v2")) return new Set();
  try {
    const [cards, pending] = await Promise.all([
      sb.from(OPEN_CHANNEL_ACTIONS_VIEW)
        .select("action_type,content:body->step->deliverable->>content")
        .eq("tenant_id", tenantId).eq("channel_slug", "linkedin_organic").eq("action_type", "text_post").limit(500),
      sb.from("customer_visible_pending_decisions")
        .select("id,decision_class,social_channel:body->>channel,social_text:body->payload->>text,social_original_text:body->post_draft_original->payload->>text")
        .eq("tenant_id", tenantId).eq("decision_class", "social.publish.v2").eq("body->>channel", "linkedin").limit(500),
    ]);
    if (cards.error || pending.error || !Array.isArray(cards.data) || !Array.isArray(pending.data)) return new Set();
    const counted = new Set(decisions.map(d => d.id));
    return pairedLinkedInDecisionIds(pending.data.filter((d: LinkedInPending) => counted.has(d.id)), cards.data);
  } catch { return new Set(); }
}
