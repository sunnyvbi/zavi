
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type NodeLike = { payload?: { site_id?: unknown } | null } | null | undefined;

export function siteIdFromGraph(goalGraph: unknown): string | null {
  if (!Array.isArray(goalGraph)) return null;
  for (const n of goalGraph as NodeLike[]) {
    const id = n?.payload?.site_id;
    if (typeof id === "string" && UUID_RE.test(id)) return id.toLowerCase();
  }
  return null;
}

export function isSiteGraph(goalGraph: unknown): boolean {
  return siteIdFromGraph(goalGraph) !== null;
}

export const SITE_MARKER_SELECT =
  "s0:goal_graph->0->payload->>site_id, s1:goal_graph->1->payload->>site_id, s2:goal_graph->2->payload->>site_id";

export function siteMarkersOf(goalGraph: unknown): { s0: unknown; s1: unknown; s2: unknown } {
  const g = Array.isArray(goalGraph) ? (goalGraph as NodeLike[]) : [];
  const at = (i: number) => g[i]?.payload?.site_id ?? null;
  return { s0: at(0), s1: at(1), s2: at(2) };
}

export function rowHasSiteMarker(row: { s0?: unknown; s1?: unknown; s2?: unknown } | null | undefined): boolean {
  return [row?.s0, row?.s1, row?.s2].some((v) => typeof v === "string" && UUID_RE.test(v));
}

export function siteIdFromMarkerRow(row: { s0?: unknown; s1?: unknown; s2?: unknown } | null | undefined): string | null {
  for (const v of [row?.s0, row?.s1, row?.s2]) {
    if (typeof v === "string" && UUID_RE.test(v)) return v.toLowerCase();
  }
  return null;
}
