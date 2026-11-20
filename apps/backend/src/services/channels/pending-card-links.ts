import { adCardTitle } from "@zavi/shared";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { channelActionUrl } from "@/services/web-base";

export type PendingCard = { id: string; channel_slug: string; title: string | null; exec_class: string | null; exec_payload: unknown };

export const PENDING_LINKS_MAX = 3;

export async function loadRunPendingCards(tenant_id: string, run_id: string): Promise<PendingCard[]> {
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("channel_actions")
      .select("id, channel_slug, title, exec_class, exec_payload")
      .eq("tenant_id", tenant_id)
      .eq("run_id", run_id)
      .eq("status", "pending")
      .not("exec_class", "is", null)
      .is("exec_status", null)
      .order("proposed_at", { ascending: true })
      .limit(PENDING_LINKS_MAX + 1);
    if (error) throw new Error(error.message);
    return (data ?? []) as PendingCard[];
  } catch (e) {
    console.warn(`[pending-card-links] run ${run_id}: ${(e as Error).message}`);
    return [];
  }
}

export const LINK_TITLE_MAX = 120;
function oneLine(t: string): string {
  const flat = t.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > LINK_TITLE_MAX ? `${flat.slice(0, LINK_TITLE_MAX - 1).trimEnd()}…` : flat;
}

export function allRecipientsAreMembers(recipients: readonly string[], members: ReadonlySet<string>, disabled: ReadonlySet<string>): boolean {
  const all = recipients.map((a) => a.trim().toLowerCase()).filter(Boolean);
  return all.length > 0 && all.every((a) => members.has(a) && !disabled.has(a));
}

export function replyWithCardLinks(a: {
  body: string;
  allMembers: boolean;
  cards: readonly PendingCard[];
  tenant_id: string;
  max: number;
  scan: (text: string) => boolean;
}): { body: string; dropped: "not_all_members" | "outbound_scan" | "too_long" | null } {
  if (a.cards.length === 0) return { body: a.body, dropped: null };
  if (!a.allMembers) return { body: a.body, dropped: "not_all_members" };
  const out = withPendingCardLinks(a.body, a.cards, a.tenant_id);
  if (out.length > a.max) return { body: a.body, dropped: "too_long" };
  if (a.scan(out)) return { body: a.body, dropped: "outbound_scan" };
  return { body: out, dropped: null };
}

export function withPendingCardLinks(body: string, cards: readonly PendingCard[], tenant_id: string): string {
  if (cards.length === 0) return body;
  const shown = cards.slice(0, PENDING_LINKS_MAX);
  const lines = shown.map((c) => {
    const title = oneLine(adCardTitle({ title: c.title, exec_class: c.exec_class, exec_payload: c.exec_payload })) || "Your card";
    return `- ${title}: ${channelActionUrl(c.channel_slug, c.id, tenant_id)}`;
  });
  const more = cards.length > shown.length ? ["- More are waiting on the same channel."] : [];
  const head = shown.length === 1 ? "Approve or reject it here:" : "Approve or reject them here:";
  return `${body.trimEnd()}\n\n${head}\n${[...lines, ...more].join("\n")}`;
}
