
import type { TabDescriptor } from "@/lib/workspace/types";
import { deepLinkTabId } from "./deepLinkSeed";

export function reviveBlankAgentThreads(
  tabs: TabDescriptor[],
  keepBlankSlug?: string | null,
): TabDescriptor[] {
  const keepIdPrefix = keepBlankSlug ? deepLinkTabId(keepBlankSlug) : null;
  let mutated = false;
  const next = tabs.map((t) => {
    if (t.kind !== "agent") return t;
    const p = t.payload as {
      kind: "agent";
      slug: string;
      threadId?: string | null;
    };
    if (p.threadId !== null) return t;
    if (
      keepIdPrefix &&
      p.slug === keepBlankSlug &&
      (t.id === keepIdPrefix || t.id.startsWith(`${keepIdPrefix}-`))
    ) {
      return t;
    }
    const { threadId: _blank, ...rest } = p;
    mutated = true;
    return { ...t, payload: rest };
  });
  return mutated ? next : tabs;
}
