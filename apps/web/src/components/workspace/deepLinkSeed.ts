import type { TabDescriptor } from "@/lib/workspace/types";

export const WORKSPACE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const WORKSPACE_AGENT_SLUG_RE = /^[a-z][a-z0-9-]{0,63}$/;

export function resolveWorkspaceAgentSlug(
  raw: unknown,
  availableSlugs: Iterable<string>,
  opts?: { allowSyntaxFallback?: boolean },
): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;

  let sawAvailableSlug = false;
  for (const slug of availableSlugs) {
    sawAvailableSlug = true;
    if (slug === raw) return slug;
  }

  if (sawAvailableSlug) return undefined;
  if (!opts?.allowSyntaxFallback) return undefined;
  return WORKSPACE_AGENT_SLUG_RE.test(raw) ? raw : undefined;
}

export function deepLinkTabId(slug: string): string {
  return `agent-deeplink-${slug}`;
}

export function buildDeepLinkSeed(
  base: TabDescriptor[],
  slug: string | undefined,
  threadId: string | "new" | null,
): TabDescriptor[] {
  if (!slug) return base;

  const existing = base.find((t) => {
    if (t.kind !== "agent") return false;
    const p = t.payload as { slug: string; threadId?: string | null };
    if (p.slug !== slug) return false;
    if (threadId === "new") return p.threadId === null;
    if (threadId) return p.threadId === threadId;
    return true;
  });
  if (existing) return base;

  const payload =
    threadId === null
      ? { kind: "agent" as const, slug }
      : {
          kind: "agent" as const,
          slug,
          threadId: threadId === "new" ? null : threadId,
        };

  const stable = deepLinkTabId(slug);
  const taken = base.filter(
    (t) => t.id === stable || t.id.startsWith(`${stable}-`),
  ).length;
  const id = taken === 0 ? stable : `${stable}-${taken}`;

  return [
    ...base,
    {
      id,
      kind: "agent" as const,
      title: slug,
      payload,
      dirty: false,
      pinned: false,
    },
  ];
}
