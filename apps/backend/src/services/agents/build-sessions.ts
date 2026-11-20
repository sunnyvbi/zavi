
import { decodeXmlEntities } from "@/services/onboarding/enrichment/sanitize";
import { deriveAppReady, type AppReadyNode, type PublishStatus } from "@/services/build/app-ready";
import { SITE_MARKER_SELECT, siteIdFromMarkerRow } from "@/services/sites/site-run";
import { explicitName } from "@/services/sites/label";

export type SessionRunRow = {
  id: string;
  objective: string | null;
  status: string;
  created_at: string;
  updated_at: string | null;
  refine_mode?: unknown;
  parent_id?: unknown;
  republish?: unknown;
  failure_class?: unknown;
  s0?: unknown;
  s1?: unknown;
  s2?: unknown;
  g3_stage?: unknown;
  g3_status?: unknown;
  g4_stage?: unknown;
  g4_status?: unknown;
  g5_stage?: unknown;
  g5_status?: unknown;
  g6_stage?: unknown;
  g6_status?: unknown;
  p0_stage?: unknown;
  p0_status?: unknown;
  p1_stage?: unknown;
  p1_status?: unknown;
};

export const PROVISION_MARKER_SELECT =
  "p0_stage:goal_graph->0->payload->>stage, p0_status:goal_graph->0->>status, p1_stage:goal_graph->1->payload->>stage, p1_status:goal_graph->1->>status";

export const SESSION_RUN_SELECT =
  `id, objective, status, created_at, updated_at, failure_class, refine_mode:goal_graph->0->payload->>refine_mode, parent_id:goal_graph->0->payload->>parent_conductor_run_id, republish:goal_graph->0->payload->>republish, g3_stage:goal_graph->3->payload->>stage, g3_status:goal_graph->3->>status, g4_stage:goal_graph->4->payload->>stage, g4_status:goal_graph->4->>status, g5_stage:goal_graph->5->payload->>stage, g5_status:goal_graph->5->>status, g6_stage:goal_graph->6->payload->>stage, g6_status:goal_graph->6->>status, ${PROVISION_MARKER_SELECT}, ${SITE_MARKER_SELECT}`;

export type BuildSessionState = "building" | "ready" | "failed" | "publishing" | "publish_failed" | "replaced";

export type BuildSessionSummary = {
  id: string;
  title: string;
  request: string;
  state: BuildSessionState;
  run_status: string;
  created_at: string;
  last_activity_at: string;
  last_request_at: string;
  refine_count: number;
  is_current: boolean;
};

const TERMINAL_RUN = new Set(["done", "failed", "halted", "paused", "cancelled", "canceled"]);
const FAILED_RUN = new Set(["failed", "halted", "paused", "cancelled", "canceled"]);

export function isRefineRow(row: Pick<SessionRunRow, "refine_mode">): boolean {
  return row.refine_mode === true || row.refine_mode === "true";
}

function slotGraph(row: SessionRunRow): AppReadyNode[] {
  const siteId = siteIdFromMarkerRow(row);
  const slots: Array<[unknown, unknown]> = [
    [row.g3_stage, row.g3_status],
    [row.g4_stage, row.g4_status],
    [row.g5_stage, row.g5_status],
    [row.g6_stage, row.g6_status],
  ];
  return [
    { status: "done", payload: { stage: "", refine_mode: isRefineRow(row) } },
    ...slots
      .filter(([stage]) => typeof stage === "string" && stage.length > 0)
      .map(([stage, status]) => ({
        status: typeof status === "string" ? status : null,
        payload: siteId ? { stage: stage as string, site_id: siteId } : { stage: stage as string },
      })),
  ];
}

export function sessionPublishStatusOf(row: SessionRunRow): PublishStatus {
  return deriveAppReady(
    {
      status: row.status,
      failure_class: typeof row.failure_class === "string" ? row.failure_class : null,
    },
    slotGraph(row),
  ).publish.status;
}

export function sessionStateOf(row: SessionRunRow): BuildSessionState {
  const publish = sessionPublishStatusOf(row);
  if (publish === "failed") return "publish_failed";
  if (FAILED_RUN.has(row.status)) return "failed";
  if (row.status === "done") return "ready";
  if (publish === "publishing") return "publishing";
  return "building";
}

function parentOf(row: Pick<SessionRunRow, "parent_id">): string | null {
  return typeof row.parent_id === "string" && row.parent_id.length > 0
    ? row.parent_id
    : null;
}

function laterOf(a: string, b: string | null | undefined): string {
  if (!b) return a;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(tb)) return a;
  if (!Number.isFinite(ta)) return b;
  return tb > ta ? b : a;
}

export function buildRequestFromObjective(objective: string | null): string {
  if (!objective) return "";
  let s = decodeXmlEntities(objective).trim();
  if (/^build product:/i.test(s)) {
    s = s.replace(/^build product:\s*/i, "").replace(/^[^—]{1,120}?\s*—\s*/, "");
  }
  return s.replace(/^\[refine\]\s*/i, "").trim();
}

const LEAD_IN =
  /^(?:please\s+)?(?:can you\s+|could you\s+|i(?:'d| would) like(?: you)? to\s+|i want(?: you)? to\s+|i need\s+|let'?s\s+)?(?:build|create|make|design|develop|generate|ship|code|write)\s+(?:me\s+)?(?:(?:an|a|the|my|our)\s+)?/i;

export function buildSessionTitle(objective: string | null): string {
  const request = buildRequestFromObjective(objective);
  const named = explicitName(request.split(/[.!?\n]/)[0] ?? "");
  if (named && /^[A-Z0-9]/.test(named)) return named;
  let s = request.split(/[.!?:;\n]/)[0] ?? "";
  s = s.split(/,\s/)[0] ?? s;
  s = s
    .replace(LEAD_IN, "")
    .replace(/^(?:an|a|the)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) s = request.replace(/\s+/g, " ").trim();
  if (!s) return "Untitled build";
  return s[0].toUpperCase() + s.slice(1);
}

export type ReplaceEvidenceRow = {
  status: string;
  failure_class?: unknown;
  goal_graph?: unknown;
  p0_stage?: unknown;
  p0_status?: unknown;
  p1_stage?: unknown;
  p1_status?: unknown;
};

function provisionNodeDone(row: ReplaceEvidenceRow): boolean {
  if (Array.isArray(row.goal_graph)) {
    return (row.goal_graph as Array<{ status?: unknown; payload?: { stage?: unknown } | null } | null>).some(
      (node) => node?.payload?.stage === "provision" && node.status === "done",
    );
  }
  return (
    [
      [row.p0_stage, row.p0_status],
      [row.p1_stage, row.p1_status],
    ] as const
  ).some(([stage, status]) => stage === "provision" && status === "done");
}

export function replacesOldApp(row: ReplaceEvidenceRow): boolean {
  if (row.status === "provisioning" || row.failure_class === "provision_failed") return false;
  return row.status === "done" || provisionNodeDone(row);
}

export function groupBuildSessions(rowsAsc: SessionRunRow[], opts: { markReplaced?: boolean } = {}): {
  sessions: BuildSessionSummary[];
  refineSession: Map<string, string>;
  current_session_id: string | null;
} {
  const byId = new Map<string, BuildSessionSummary>();
  const pendingRefine = new Map<string, boolean>();
  const refineSession = new Map<string, string>();
  let currentRoot: string | null = null;
  let currentOldRoot: string | null = null;
  const siteRoots = new Map<string, string>();
  const oldRoots: string[] = [];
  const replacedOld = new Set<string>();
  let newestOldRoot: SessionRunRow | null = null;

  for (const row of rowsAsc) {
    const siteId = siteIdFromMarkerRow(row);
    if (!isRefineRow(row)) {
      currentRoot = row.id;
      if (!siteId) {
        if (replacesOldApp(row) || currentOldRoot === null) currentOldRoot = row.id;
        newestOldRoot = row;
        if (replacesOldApp(row)) for (const earlier of oldRoots) replacedOld.add(earlier);
        oldRoots.push(row.id);
      } else if (!siteRoots.has(siteId)) siteRoots.set(siteId, row.id);
      byId.set(row.id, {
        id: row.id,
        title: buildSessionTitle(row.objective),
        request: buildRequestFromObjective(row.objective),
        state: sessionStateOf(row),
        run_status: row.status,
        created_at: row.created_at,
        last_activity_at: laterOf(row.created_at, row.updated_at),
        last_request_at: row.created_at,
        refine_count: 0,
        is_current: false,
      });
      pendingRefine.set(row.id, false);
      continue;
    }
    const owner = parentOf(row) ?? (siteId ? (siteRoots.get(siteId) ?? null) : currentOldRoot);
    if (!owner) continue;
    const session = byId.get(owner);
    if (!session) continue;
    refineSession.set(row.id, owner);
    if (row.republish !== true && row.republish !== "true") session.refine_count += 1;
    session.last_activity_at = laterOf(
      session.last_activity_at,
      laterOf(row.created_at, row.updated_at),
    );
    const guessed = !parentOf(row) && !siteId && siteRoots.size > 0;
    if (!guessed) session.last_request_at = laterOf(session.last_request_at, row.created_at);
    if (!TERMINAL_RUN.has(row.status)) pendingRefine.set(owner, true);
  }

  for (const [id, busy] of pendingRefine) {
    const session = byId.get(id);
    if (session && busy && (session.state === "ready" || session.state === "building")) session.state = "building";
  }
  const newestOldUnplaced = newestOldRoot && !replacesOldApp(newestOldRoot) ? newestOldRoot.id : null;
  for (const id of [currentOldRoot, newestOldUnplaced, ...siteRoots.values()]) {
    const current = id ? byId.get(id) : undefined;
    if (current) current.is_current = true;
  }
  for (const session of byId.values()) {
    if (session.is_current) continue;
    if (session.state === "publishing") session.state = "building";
    else if (session.state === "publish_failed") session.state = "failed";
  }
  if (opts.markReplaced) {
    for (const id of replacedOld) {
      const session = byId.get(id);
      if (session && session.state === "ready") session.state = "replaced";
    }
  }

  const sessions = Array.from(byId.values()).sort((a, b) => {
    const ta = Date.parse(a.last_activity_at);
    const tb = Date.parse(b.last_activity_at);
    if (ta !== tb) return tb - ta;
    return a.id < b.id ? 1 : -1;
  });
  return { sessions, refineSession, current_session_id: currentRoot };
}

export function refineIdsForSession(
  rowsAsc: SessionRunRow[],
  sessionId: string,
): string[] {
  const { refineSession } = groupBuildSessions(rowsAsc);
  return rowsAsc
    .filter((row) => refineSession.get(row.id) === sessionId)
    .map((row) => row.id);
}
