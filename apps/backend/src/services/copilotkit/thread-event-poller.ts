
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { RUNNING_HARD_CAP_HOURS } from "@/services/agents/run-hard-cap";
import type { ThreadEventRow } from "./ag-ui-translate";

export const POLL_INTERVAL_MS = 500;
const HARD_CAP_MS = RUNNING_HARD_CAP_HOURS * 60 * 60 * 1000;
const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "blocked"]);

export type PollDeps = {
  fetchEvents: (afterId: number) => Promise<ThreadEventRow[]>;
  fetchRunStatus: () => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export function defaultPollDeps(tenantId: string, runId: string): PollDeps {
  const tid = asTenantId(tenantId);
  return {
    async fetchEvents(afterId) {
      const { data, error } = await tenantClient(tid)
        .from("thread_event")
        .select("id, kind, body, created_at")
        .eq("agent_run_id", runId)
        .gt("id", afterId)
        .order("id", { ascending: true })
        .limit(200);
      if (error) throw new Error(`thread_event read failed: ${error.message}`);
      return (data ?? []) as ThreadEventRow[];
    },
    async fetchRunStatus() {
      const { data } = await tenantClient(tid).from("agent_runs").select("status").eq("id", runId).maybeSingle();
      return (data as { status?: string } | null)?.status ?? null;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

export async function* pollThreadEvents(
  deps: PollDeps,
  isDone: () => boolean,
  signal?: AbortSignal,
): AsyncGenerator<ThreadEventRow, "finished" | "run_gone" | "timeout" | "aborted", void> {
  const t0 = deps.now();
  let afterId = 0;
  let idleTicks = 0;
  for (;;) {
    if (signal?.aborted) return "aborted";
    const rows = await deps.fetchEvents(afterId);
    for (const r of rows) {
      afterId = Math.max(afterId, Number(r.id));
      yield r;
      if (isDone()) return "finished";
    }
    if (rows.length === 0) {
      idleTicks += 1;
      if (idleTicks % 10 === 0) {
        const status = await deps.fetchRunStatus();
        if (status && !ACTIVE_RUN_STATUSES.has(status)) return "run_gone";
      }
    } else {
      idleTicks = 0;
    }
    if (deps.now() - t0 > HARD_CAP_MS) return "timeout";
    await deps.sleep(POLL_INTERVAL_MS);
  }
}
