
export type SiteRunRow = {
  id: string;
  kind?: string | null;
  status: string;
  objective?: string | null;
  goal_graph: unknown;
  created_at: string;
  updated_at?: string | null;
};

export type UnpublishedChange = { id: string; kind: "edit" | "undo"; at: string };

function firstPayload(graph: unknown): Record<string, unknown> | null {
  if (!Array.isArray(graph) || graph.length === 0) return null;
  const node = graph[0] as { payload?: unknown } | null;
  return node && node.payload && typeof node.payload === "object" ? (node.payload as Record<string, unknown>) : null;
}

export function isSitePublishRun(row: SiteRunRow): boolean {
  if (row.status !== "done") return false;
  const p = firstPayload(row.goal_graph);
  return p?.republish === true && p?.stage === "deploy";
}

function previewChangeKind(row: SiteRunRow): UnpublishedChange["kind"] | null {
  if (row.status !== "done") return null;
  const p = firstPayload(row.goal_graph);
  if (!p) return null;
  if (row.kind === "undo" || p.undo_claim === true) return p.preview_only === true ? "undo" : null;
  if (p.no_change === true) return null;
  return p.refine_mode === true && p.stop_at_preview === true && p.republish !== true ? "edit" : null;
}

export function unpublishedSiteChanges(rows: readonly SiteRunRow[]): UnpublishedChange[] {
  const asc = [...rows].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  let pending: UnpublishedChange[] = [];
  for (const row of asc) {
    if (isSitePublishRun(row)) {
      pending = [];
      continue;
    }
    const kind = previewChangeKind(row);
    if (kind) pending.push({ id: row.id, kind, at: row.updated_at ?? row.created_at });
  }
  return pending;
}

export const SITE_PENDING_SCAN_LIMIT = 500;

const PENDING_SELECT =
  "id, kind, status, objective, created_at, updated_at, " +
  "p_stage:goal_graph->0->payload->>stage, p_republish:goal_graph->0->payload->>republish, " +
  "p_refine:goal_graph->0->payload->>refine_mode, p_stop:goal_graph->0->payload->>stop_at_preview, " +
  "p_undo:goal_graph->0->payload->>undo_claim, p_preview_only:goal_graph->0->payload->>preview_only, " +
  "p_request:goal_graph->0->payload->>user_request, p_no_change:goal_graph->0->payload->>no_change, " +
  "p_parent:goal_graph->0->payload->>parent_conductor_run_id";

type PendingSelectRow = {
  id: string;
  kind: string | null;
  status: string;
  objective: string | null;
  created_at: string;
  updated_at: string | null;
  p_stage: string | null;
  p_republish: string | null;
  p_refine: string | null;
  p_stop: string | null;
  p_undo: string | null;
  p_preview_only: string | null;
  p_request: string | null;
  p_no_change?: string | null;
  p_parent?: string | null;
};

const asBool = (v: string | null) => v === "true";

export type UnpublishedChangeView = UnpublishedChange & { message: string | null };

function changeMessage(row: PendingSelectRow | undefined): string | null {
  const raw = (row?.p_request ?? row?.objective ?? "").replace(/^\[(?:refine|undo)\]\s*/i, "").trim();
  if (!raw) return null;
  return raw.length > 140 ? `${raw.slice(0, 139)}…` : raw;
}

function undoMessage(row: PendingSelectRow | undefined, byId: Map<string, PendingSelectRow>): string | null {
  const parent = row?.p_parent ? byId.get(row.p_parent) : undefined;
  const reverted = parent && parent.p_undo !== "true" ? changeMessage(parent) : null;
  return reverted ? `Undo: ${reverted}` : null;
}

export type UnpublishedChanges = {
  changes: UnpublishedChangeView[];
  capped: boolean;
};

function viewRow(r: PendingSelectRow): SiteRunRow {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
    goal_graph: [
      {
        payload: {
          stage: r.p_stage,
          republish: asBool(r.p_republish),
          refine_mode: asBool(r.p_refine),
          stop_at_preview: asBool(r.p_stop),
          undo_claim: asBool(r.p_undo),
          preview_only: asBool(r.p_preview_only),
          no_change: asBool(r.p_no_change ?? null),
        },
      },
    ],
  };
}

export async function loadUnpublishedSiteChanges(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: { from: (table: string) => any },
  tenant_id: string,
  site_id: string,
): Promise<UnpublishedChanges> {
  const { data: last, error: lastErr } = await db
    .from("conductor_runs")
    .select("id, created_at")
    .eq("tenant_id", tenant_id)
    .eq("kind", "build_app")
    .eq("status", "done")
    .eq("goal_graph->0->payload->>site_id", site_id)
    .eq("goal_graph->0->payload->>republish", "true")
    .eq("goal_graph->0->payload->>stage", "deploy")
    .order("created_at", { ascending: false })
    .limit(1);
  if (lastErr) throw new Error(`last publish read failed: ${lastErr.message ?? "unknown error"}`);
  const boundary = ((last ?? []) as Array<{ created_at?: unknown }>)[0]?.created_at;

  let q = db
    .from("conductor_runs")
    .select(PENDING_SELECT)
    .eq("tenant_id", tenant_id)
    .eq("goal_graph->0->payload->>site_id", site_id)
    .in("kind", ["build_app", "undo"])
    .eq("status", "done");
  if (typeof boundary === "string" && boundary) q = q.gt("created_at", boundary);
  const { data, error } = await q.order("created_at", { ascending: true }).limit(SITE_PENDING_SCAN_LIMIT);
  if (error) throw new Error(`unpublished changes read failed: ${error.message ?? "unknown error"}`);
  const rows = (data ?? []) as PendingSelectRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const changes = unpublishedSiteChanges(rows.map(viewRow));
  return {
    changes: changes.map((c) => ({ ...c, message: c.kind === "undo" ? undoMessage(byId.get(c.id), byId) : changeMessage(byId.get(c.id)) })),
    capped: rows.length >= SITE_PENDING_SCAN_LIMIT,
  };
}
