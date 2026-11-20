
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { reapOrphanWorktrees } from "@/services/sandbox/run-worktree";
import { resumeSandbox } from "@/services/sandbox/e2b-client";
import { SANDBOX_AGENT_SLUGS } from "./run-agent";

const RECENT_BATCH_HOURS = 24;
const MAX_SANDBOXES_PER_TICK = 10;
const SANDBOX_SCAN_TIMEOUT_MS = 60_000;

type ActiveSandbox = {
  id: string;
  tenant_id: string;
  repo_full_name: string;
  e2b_sandbox_id: string;
  status: string;
};

type LiveBatchChild = {
  id: string;
  tenant_id: string;
};

async function listCandidateSandboxes(): Promise<ActiveSandbox[]> {
  const sb = serviceClient();
  const since = new Date(
    Date.now() - RECENT_BATCH_HOURS * 60 * 60 * 1000,
  ).toISOString();

  const sandboxSlugs = Array.from(SANDBOX_AGENT_SLUGS).join(",");
  const { data: recent, error } = await sb
    .from("agent_runs")
    .select("tenant_id, payload")
    .or(`batch_id.not.is.null,agent_slug.in.(${sandboxSlugs})`)
    .gte("enqueued_at", since)
    .limit(2000);
  if (error || !recent) return [];

  const pairs = new Map<string, { tenant_id: string; repo_full_name: string }>();
  for (const r of recent) {
    const repo = (r.payload as { repo_hint?: unknown } | null)?.repo_hint;
    if (typeof repo !== "string" || repo.length === 0) continue;
    const key = `${r.tenant_id}|${repo}`;
    if (!pairs.has(key)) {
      pairs.set(key, { tenant_id: r.tenant_id as string, repo_full_name: repo });
    }
    if (pairs.size >= MAX_SANDBOXES_PER_TICK * 4) break;
  }
  if (pairs.size === 0) return [];

  const tenantIds = [...new Set([...pairs.values()].map((p) => p.tenant_id))];
  const { data: rows } = await sb
    .from("tenant_sandbox")
    .select("id, tenant_id, repo_full_name, e2b_sandbox_id, status")
    .in("tenant_id", tenantIds)
    .in("status", ["active", "paused"]);
  if (!rows) return [];

  const matched = (rows as ActiveSandbox[]).filter((r) =>
    pairs.has(`${r.tenant_id}|${r.repo_full_name}`),
  );
  matched.sort((a, b) => a.tenant_id.localeCompare(b.tenant_id));
  return matched.slice(0, MAX_SANDBOXES_PER_TICK);
}

async function listLiveBatchChildrenFor(
  tenant_id: string,
  repo_full_name: string,
): Promise<string[]> {
  const sb = serviceClient();
  const { data: liveChildren } = await sb
    .from("agent_runs")
    .select("id, payload, batch_id")
    .in("status", ["queued", "running", "blocked"])
    .eq("tenant_id", tenant_id);
  if (!liveChildren) return [];
  return (
    liveChildren as Array<LiveBatchChild & { payload: unknown; batch_id: string | null }>
  )
    .filter((r) => {
      const rh = (r.payload as { repo_hint?: unknown } | null)?.repo_hint;
      if (typeof rh !== "string" || rh.length === 0) return true;
      return rh === repo_full_name;
    })
    .map((r) => r.id);
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms),
    ),
  ]);
}

async function reapOneSandbox(sandbox: ActiveSandbox): Promise<{
  sandbox_row_id: string;
  removed: number;
  resumed: boolean;
  error: string | null;
}> {
  let resumed = false;
  try {
    if (sandbox.status === "paused") {
      await resumeSandbox(sandbox.e2b_sandbox_id);
      resumed = true;
    }
    const keep = await listLiveBatchChildrenFor(
      sandbox.tenant_id,
      sandbox.repo_full_name,
    );
    const result = await withTimeout(
      reapOrphanWorktrees({
        sandbox_id: sandbox.e2b_sandbox_id,
        keepRunIds: keep,
      }),
      SANDBOX_SCAN_TIMEOUT_MS,
    );
    return {
      sandbox_row_id: sandbox.id,
      removed: result.removed.length,
      resumed,
      error: null,
    };
  } catch (e) {
    return {
      sandbox_row_id: sandbox.id,
      removed: 0,
      resumed,
      error: (e as Error).message.slice(0, 200),
    };
  }
}

export const batchFanoutWorktreeReaperFn = inngest.createFunction(
  {
    id: "batch-fanout-worktree-reaper",
    concurrency: { limit: 1, key: '"global"' },
  },
  { cron: "35 * * * *" },
  async ({ logger }) => {
    const sandboxes = await listCandidateSandboxes();
    if (sandboxes.length === 0) {
      return {
        ok: true,
        sandboxes_swept: 0,
        worktrees_removed: 0,
        errors: 0,
      };
    }

    let totalRemoved = 0;
    let errors = 0;
    const per: Array<{ tenant: string; repo: string; removed: number; error: string | null }> = [];

    for (const sandbox of sandboxes) {
      const r = await reapOneSandbox(sandbox);
      totalRemoved += r.removed;
      if (r.error) errors += 1;
      per.push({
        tenant: sandbox.tenant_id,
        repo: sandbox.repo_full_name,
        removed: r.removed,
        error: r.error,
      });
    }

    logger.info(
      `batch-fanout-worktree-reaper: ${sandboxes.length} sandboxes swept · ${totalRemoved} worktrees removed · ${errors} errors`,
    );
    return {
      ok: true,
      sandboxes_swept: sandboxes.length,
      worktrees_removed: totalRemoved,
      errors,
      per,
    };
  },
);
