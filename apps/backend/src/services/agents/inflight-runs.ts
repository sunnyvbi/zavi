
import { serviceClient } from "@/services/supabase";
import { MONEY_PATH_SLUGS } from "@/services/agents/infra-retry";
import { workerId } from "@/services/agents/boot-role";

export interface DeployBlockingRuns {
  count: number;
  slugs: string[];
  safe_to_swap: boolean;
  stale_ignored: number;
}

export const DEFAULT_DEPLOY_GUARD_STALE_MS = 20 * 60 * 1000;

export function deployGuardStaleMs(): number {
  const raw = Number(process.env.PRAXIS_DEPLOY_GUARD_STALE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DEPLOY_GUARD_STALE_MS;
}

type Svc = ReturnType<typeof serviceClient>;

export async function getDeployBlockingRuns(
  svc: Svc = serviceClient(),
  now: number = Date.now(),
): Promise<DeployBlockingRuns> {
  const moneySlugs = [...MONEY_PATH_SLUGS];
  const me = workerId();
  const { data, error } = await svc
    .from("agent_runs")
    .select("agent_slug,last_progress_at")
    .eq("status", "running")
    .not("last_progress_at", "is", null)
    .not("agent_slug", "in", `(${moneySlugs.join(",")})`)
    .or(`worker_id.is.null,worker_id.eq.${me}`);

  if (error) {
    return { count: 0, slugs: [], safe_to_swap: false, stale_ignored: 0 };
  }

  const all = (data ?? []) as Array<{ agent_slug: string; last_progress_at: string | null }>;
  const cutoff = now - deployGuardStaleMs();
  const isStale = (r: { last_progress_at: string | null }) =>
    Date.parse(r.last_progress_at ?? "") < cutoff;
  const rows = all.filter((r) => !isStale(r));
  const slugs = [...new Set(rows.map((r) => r.agent_slug))].sort();
  return {
    count: rows.length,
    slugs,
    safe_to_swap: rows.length === 0,
    stale_ignored: all.length - rows.length,
  };
}
