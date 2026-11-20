import { asTenantId, tenantClient } from "@/services/tenant-client";
import { NON_REFINE_BUILD_FILTER } from "@/services/autopilot/build-liveness";

type BuildTab = {
  id?: string;
  payload?: {
    kind?: string;
    sessionId?: string | null;
  } | null;
};

const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function boundSessionId(p: NonNullable<BuildTab["payload"]>): string | null {
  if (p.kind !== "build") return null;
  const id = p.sessionId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function queryableSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

export function scrubBuildSessionBindingsPure<T extends BuildTab>(
  tabs: T[],
  validIds: ReadonlySet<string>,
): T[] {
  return tabs.map((tab) => {
    const p = tab.payload;
    if (!p) return tab;
    const sessionId = boundSessionId(p);
    if (!sessionId) return tab;
    if (validIds.has(sessionId)) return tab;
    return { ...tab, payload: { ...p, sessionId: null } } as T;
  });
}

export async function scrubForeignBuildSessions<T extends BuildTab>(
  tabs: T[],
  tenantId: string,
): Promise<T[]> {
  if (!tenantId) return tabs;
  const boundIds = Array.from(
    new Set(
      tabs
        .map((t) => (t.payload ? boundSessionId(t.payload) : null))
        .filter((id): id is string => typeof id === "string"),
    ),
  );
  if (boundIds.length === 0) return tabs;
  const sessionIds = boundIds.filter(queryableSessionId);
  if (sessionIds.length === 0) return scrubBuildSessionBindingsPure(tabs, new Set());

  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("conductor_runs")
    .select("id")
    .in("id", sessionIds)
    .eq("kind", "build_app")
    .or(NON_REFINE_BUILD_FILTER);

  if (error) return tabs;

  const validIds = new Set(
    ((data ?? []) as Array<{ id: string }>).map((r) => r.id),
  );
  return scrubBuildSessionBindingsPure(tabs, validIds);
}
