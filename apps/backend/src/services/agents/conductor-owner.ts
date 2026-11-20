import type { SupabaseClient } from "@supabase/supabase-js";
import { workerId } from "./boot-role";
import { getBoolSetting } from "@/services/settings";
import { BUILD_CONDUCTOR_RUN_ID_KEY } from "@/services/billing/tiers";

export const CONDUCTOR_OWNER_KEY = "owner_worker";

type GraphNode = { payload?: Record<string, unknown> | null };

export function conductorOwnerOf(graph: unknown): string | null {
  if (!Array.isArray(graph)) return null;
  const owner = (graph[0] as GraphNode | undefined)?.payload?.[CONDUCTOR_OWNER_KEY];
  return typeof owner === "string" && owner.length > 0 ? owner : null;
}

export function stampConductorOwner<N extends GraphNode>(
  graph: N[],
  opts: { owner?: string; replace?: boolean } = {},
): N[] {
  if (!Array.isArray(graph) || graph.length === 0) return graph;
  if (!opts.replace && conductorOwnerOf(graph) !== null) return graph;
  const [first, ...rest] = graph;
  const stamped = {
    ...first,
    payload: { ...(first.payload ?? {}), [CONDUCTOR_OWNER_KEY]: opts.owner ?? workerId() },
  } as N;
  return [stamped, ...rest];
}

export function isOtherWorkersOwner(owner: string | null | undefined, me: string = workerId()): boolean {
  return typeof owner === "string" && owner.length > 0 && owner !== me;
}

export function ownerOnlyMayApply(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "production") return false;
  return workerId(env).startsWith("dev:");
}

export async function conductorOwnerOnlyEnabled(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!ownerOnlyMayApply(env)) return false;
  return getBoolSetting("conductor_owner_only").catch(() => true);
}

type OwnedRun = {
  worker_id?: string | null;
  conductor_run_id?: string | null;
  payload?: unknown;
};

function conductorIdOf(row: OwnedRun): string | null {
  if (typeof row.conductor_run_id === "string" && row.conductor_run_id.length > 0) return row.conductor_run_id;
  const p = row.payload;
  if (p && typeof p === "object") {
    const v = (p as Record<string, unknown>)[BUILD_CONDUCTOR_RUN_ID_KEY];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

export async function dropForeignRuns<T extends OwnedRun>(
  svc: SupabaseClient,
  rows: T[],
  opts: { requireActiveConductor?: boolean } = {},
): Promise<T[]> {
  if (rows.length === 0) return rows;
  const touched = rows.some((r) => (r.worker_id ?? null) !== null || conductorIdOf(r) !== null);
  if (!touched) return rows;
  if (!(await conductorOwnerOnlyEnabled())) return rows;
  const me = workerId();

  const ids = [...new Set(rows.map(conductorIdOf).filter((v): v is string => v !== null))];
  const conductors = new Map<string, { status: string | null; owner: string | null }>();
  let lookupFailed = false;
  if (ids.length > 0) {
    const { data, error } = await svc
      .from("conductor_runs")
      .select("id, status, goal_graph")
      .in("id", ids);
    if (error) {
      lookupFailed = true;
    } else {
      for (const c of (data ?? []) as Array<{ id: string; status: string | null; goal_graph: unknown }>) {
        conductors.set(c.id, { status: c.status, owner: conductorOwnerOf(c.goal_graph) });
      }
    }
  }

  return rows.filter((r) => {
    if (isOtherWorkersOwner(r.worker_id, me)) return false;
    const cid = conductorIdOf(r);
    if (cid === null) return true;
    if (lookupFailed) return false;
    const c = conductors.get(cid);
    if (opts.requireActiveConductor && c?.status !== "active") return false;
    if (c && isOtherWorkersOwner(c.owner, me)) return false;
    return true;
  });
}
