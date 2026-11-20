
import { emailToolConnected } from "@/services/email-learnings/seed";
import type { ChannelActionView } from "./channel-actions";

export type ContactListDoorDeps = {
  countLists: (tenantId: string) => Promise<number>;
  toolConnected: (tenantId: string) => Promise<boolean>;
};

const DEFAULT_DEPS: ContactListDoorDeps = {
  countLists: async (tenantId) => {
    const { asTenantId, tenantClient } = await import("@/services/tenant-client");
    const { count, error } = await tenantClient(asTenantId(tenantId))
      .from("email_lists")
      .select("id", { count: "exact", head: true })
      .is("archived_at", null);
    if (error) throw new Error(`contact-list-door: list count failed: ${error.message}`);
    return count ?? 0;
  },
  toolConnected: emailToolConnected,
};

export function asksForAList(a: ChannelActionView): boolean {
  if (a.executable || a.status !== "pending") return false;
  const kind = (a.body as { step?: { deliverable?: { kind?: unknown } } } | null)?.step?.deliverable?.kind;
  return a.action_type === "send_message" || kind === "email";
}

export async function withContactListDoor(tenantId: string, actions: ChannelActionView[], deps: Partial<ContactListDoorDeps> = {}): Promise<ChannelActionView[]> {
  if (!actions.some(asksForAList)) return actions;
  const d = { ...DEFAULT_DEPS, ...deps };
  try {
    const [lists, tool] = await Promise.all([d.countLists(tenantId), d.toolConnected(tenantId)]);
    if (lists > 0 || tool) return actions;
  } catch (e) {
    console.warn(`[contact-list-door] skipped: ${(e as Error).message}`);
    return actions;
  }
  return actions.map((a) => (asksForAList(a) ? { ...a, needs_contact_list: true } : a));
}
