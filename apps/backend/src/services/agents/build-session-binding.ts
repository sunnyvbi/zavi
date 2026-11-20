
import { buildEstimateText, currentBuildStage, stageExpectedMs } from "@zavi/shared";
import { getBoolSetting } from "@/services/settings";
import { siteIdFromGraph } from "@/services/sites/site-run";
import { siteGraphStages } from "@/services/sites/site-build-status";
import { lookAwaitingSiteId } from "@/services/sites/look-wait";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const BUILD_SESSION_PAYLOAD_KEY = "build_session_id";

type QueryResult<T> = PromiseLike<{ data: T | null; error: { message: string } | null }>;

export type BindingDb = {
  from: (table: string) => {
    select: (cols: string) => BindingQuery;
  };
};
type BindingQuery = {
  eq: (col: string, value: unknown) => BindingQuery;
  not: (col: string, op: string, value: unknown) => BindingQuery;
  in: (col: string, values: unknown[]) => PromiseLike<{ data: Array<Record<string, unknown>> | null; error: { message: string } | null }>;
  order: (col: string, opts: { ascending: boolean }) => BindingQuery;
  limit: (n: number) => BindingQuery;
  maybeSingle: () => QueryResult<Record<string, unknown>>;
};

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v.trim());
}

export function buildSessionOfPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>)[BUILD_SESSION_PAYLOAD_KEY];
  return isUuid(v) ? v.trim().toLowerCase() : null;
}

export async function isOwnedBuildSession(db: BindingDb, tenant_id: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const { data, error } = await db
    .from("conductor_runs")
    .select("id")
    .eq("id", id.trim())
    .eq("tenant_id", tenant_id)
    .eq("kind", "build_app")
    .maybeSingle();
  if (error) throw new Error(`build session read failed: ${error.message}`);
  return !!data;
}

export async function buildSessionOfRun(db: BindingDb, tenant_id: string, run_id: string): Promise<string | null> {
  const { data, error } = await db
    .from("agent_runs")
    .select("payload")
    .eq("id", run_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (error) throw new Error(`run payload read failed: ${error.message}`);
  return buildSessionOfPayload(data?.payload);
}

export async function buildSessionOfThread(db: BindingDb, tenant_id: string, thread_id: string): Promise<string | null> {
  const { data, error } = await db
    .from("agent_runs")
    .select("payload")
    .eq("tenant_id", tenant_id)
    .eq("payload->>thread_id", thread_id)
    .not(`payload->>${BUILD_SESSION_PAYLOAD_KEY}`, "is", null)
    .order("enqueued_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`thread binding read failed: ${error.message}`);
  return buildSessionOfPayload(data?.payload);
}

export function mustForkThread(session: string | null, boundTo: string | null): boolean {
  return !!session && !!boundTo && session.toLowerCase() !== boundTo.toLowerCase();
}

export const BUILD_PROGRESS_PAYLOAD_KEY = "build_progress";

export type BuildProgress = { current_stage: string | null; estimate: string | null };

const OLD_FLOW_STAGES = ["provision", "spec", "scaffold", "build"] as const;
const BUILD_OVER = new Set(["done", "failed", "halted", "paused", "cancelled", "canceled"]);

type ProgressNode = {
  status?: string | null;
  started_at?: string | null;
  child_run_id?: string | null;
  payload?: { stage?: unknown } | null;
};

export type BuildProgressDeps = {
  movesInStage?: (tenant_id: string) => Promise<boolean>;
  now?: () => number;
  awaitsLook?: (tenant_id: string, site_id: string) => Promise<boolean>;
};

async function awaitsLookRow(tenant_id: string, site_id: string): Promise<boolean> {
  const [{ siteAwaitsLook }, { siteDesignStore }] = await Promise.all([
    import("@/services/sites/look-wait"),
    import("@/services/sites/site-design-store"),
  ]);
  return siteAwaitsLook(siteDesignStore(), { tenant_id, site_id });
}

async function parkedOnLook(deps: BuildProgressDeps, tenant_id: string, graph: unknown): Promise<boolean> {
  const site_id = lookAwaitingSiteId(graph);
  if (!site_id) return false;
  try {
    return (await (deps.awaitsLook ?? awaitsLookRow)(tenant_id, site_id)) === true;
  } catch {
    return false;
  }
}

async function movesInStageSetting(tenant_id: string): Promise<boolean> {
  try {
    return await getBoolSetting("build_progress_moves_in_stage", tenant_id);
  } catch {
    return false;
  }
}

export async function buildProgressOfSession(
  db: BindingDb,
  tenant_id: string,
  session_id: string,
  deps: BuildProgressDeps = {},
): Promise<BuildProgress | null> {
  if (!isUuid(session_id)) return null;
  const { data: run, error } = await db
    .from("conductor_runs")
    .select("id, status, goal_graph")
    .eq("id", session_id.trim())
    .eq("tenant_id", tenant_id)
    .eq("kind", "build_app")
    .maybeSingle();
  if (error) throw new Error(`build progress read failed: ${error.message}`);
  if (!run || BUILD_OVER.has(String(run.status ?? ""))) return null;
  const graph = (Array.isArray(run.goal_graph) ? run.goal_graph : []) as ProgressNode[];
  const site = siteIdFromGraph(graph) !== null;
  const childIds = graph
    .map((n) => n.child_run_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const childStart = new Map<string, string | null>();
  if (childIds.length > 0) {
    const { data: children, error: childErr } = await db
      .from("agent_runs")
      .select("id, started_at")
      .eq("tenant_id", tenant_id)
      .in("id", childIds);
    if (!childErr) {
      for (const c of children ?? []) childStart.set(String(c.id), (c.started_at as string | null | undefined) ?? null);
    }
  }
  const moves = await (deps.movesInStage ?? movesInStageSetting)(tenant_id);
  const byStage = new Map<string, ProgressNode>();
  for (const n of graph) {
    const st = n.payload?.stage;
    if (typeof st === "string" && !byStage.has(st)) byStage.set(st, n);
  }
  const names = site ? siteGraphStages(graph) : [...OLD_FLOW_STAGES];
  const stages = names.map((stage) => {
    const n = byStage.get(stage);
    const status = n?.status === "dispatched" ? "running" : (n?.status ?? "pending");
    const started_at = n?.started_at ?? (n?.child_run_id ? childStart.get(n.child_run_id) : null) ?? null;
    return { stage, status, started_at, expected_ms: moves ? stageExpectedMs(stage, site) : null };
  });
  const now = (deps.now ?? Date.now)();
  const awaitingPick = await parkedOnLook(deps, tenant_id, graph);
  return { current_stage: currentBuildStage(stages), estimate: buildEstimateText(stages, now, { awaitingPick }) };
}
