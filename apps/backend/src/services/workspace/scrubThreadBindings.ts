
import { serviceClient } from "@/services/supabase";

type AgentTab = {
  id?: string;
  payload?: {
    kind?: string;
    slug?: string;
    threadId?: string | null;
  } | null;
};

const DISPUTE_DETAIL_SLUG = "dispute-response";

const HOME_CHAT_SLUG = "operator";

const GROWTH_CHAT_SLUG = "cgo";

function bindingSlug(p: NonNullable<AgentTab["payload"]>): string | null {
  if (p.kind === "agent") return p.slug && p.slug.length > 0 ? p.slug : null;
  if (p.kind === "dispute-detail") return DISPUTE_DETAIL_SLUG;
  if (p.kind === "home" || p.kind === "build") return HOME_CHAT_SLUG;
  if (p.kind === "autopilot") return GROWTH_CHAT_SLUG;
  return null;
}

function bindingKey(threadId: string, slug: string): string {
  return `${threadId}|${slug}`;
}

export function scrubThreadBindingsPure<T extends AgentTab>(
  tabs: T[],
  validKeys: ReadonlySet<string>,
): T[] {
  return tabs.map((tab) => {
    const p = tab.payload;
    if (!p) return tab;
    const slug = bindingSlug(p);
    if (!slug) return tab;
    const threadId = p.threadId;
    if (typeof threadId !== "string" || threadId.length === 0) return tab;
    if (validKeys.has(bindingKey(threadId, slug))) return tab;
    return { ...tab, payload: { ...p, threadId: null } };
  });
}

export async function scrubForeignThreadBindings<T extends AgentTab>(
  tabs: T[],
  tenantId: string,
  userId: string,
): Promise<T[]> {
  if (!tenantId || !userId) return tabs;
  const threadIds = Array.from(
    new Set(
      tabs
        .filter((t) => t.payload != null && bindingSlug(t.payload) !== null)
        .map((t) => t.payload?.threadId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  if (threadIds.length === 0) return tabs;

  const { data, error } = await serviceClient()
    .from("agent_threads")
    .select("id, agent_slug")
    .in("id", threadIds)
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .is("deleted_at", null);

  if (error) {
    return tabs;
  }

  const validKeys = new Set(
    ((data ?? []) as Array<{ id: string; agent_slug: string }>).map((r) =>
      bindingKey(r.id, r.agent_slug),
    ),
  );
  return scrubThreadBindingsPure(tabs, validKeys);
}
