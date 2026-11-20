
import { globalClient } from "@/services/tenant-client";

export const STALE_AFTER_MS = 5 * 60 * 1000;

export type ScriptRun = {
  id: string;
  script_key: string;
  args: Record<string, unknown>;
  lock_key: string;
  mode: "dry_run" | "apply";
  status: "running" | "done" | "failed";
  run_by: string;
  run_by_email: string;
  started_at: string;
  finished_at: string | null;
  last_heartbeat_at: string;
  progress: Record<string, unknown>;
  summary: Record<string, unknown> | null;
  error: string | null;
};

const COLUMNS =
  "id, script_key, args, lock_key, mode, status, run_by, run_by_email, started_at, finished_at, last_heartbeat_at, progress, summary, error";

export class AlreadyRunningError extends Error {
  constructor(readonly runId: string | null) {
    super("This script is already running.");
  }
}

const table = () => globalClient().from("admin_script_runs");

function fail(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`admin_script_runs: ${what} failed: ${error.message}`);
}

export async function reapStale(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS).toISOString();
  const { data, error } = await table()
    .update({
      status: "failed",
      finished_at: now.toISOString(),
      error: "stopped: no heartbeat for 5 minutes (the backend restarted?). Progress so far is kept; re-running is safe.",
    })
    .eq("status", "running")
    .lt("last_heartbeat_at", cutoff)
    .select("id");
  fail(error, "reap stale runs");
  return (data ?? []).length;
}

export async function startRun(input: {
  scriptKey: string;
  args: Record<string, unknown>;
  lockKey: string;
  runBy: string;
  runByEmail: string;
}): Promise<ScriptRun> {
  await reapStale();
  const { data, error } = await table()
    .insert({
      script_key: input.scriptKey,
      args: input.args,
      lock_key: input.lockKey,
      mode: "apply",
      run_by: input.runBy,
      run_by_email: input.runByEmail,
    })
    .select(COLUMNS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      const { data: existing } = await table()
        .select("id")
        .eq("script_key", input.scriptKey)
        .eq("lock_key", input.lockKey)
        .eq("status", "running")
        .maybeSingle();
      throw new AlreadyRunningError((existing as { id?: string } | null)?.id ?? null);
    }
    fail(error, "start run");
  }
  return data as ScriptRun;
}

export async function heartbeat(id: string, progress: Record<string, unknown>): Promise<void> {
  const { error } = await table()
    .update({ progress, last_heartbeat_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "running");
  fail(error, "heartbeat");
}

export async function finishRun(
  id: string,
  outcome: { status: "done" | "failed"; summary?: Record<string, unknown> | null; progress?: Record<string, unknown>; error?: string | null },
): Promise<void> {
  const patch: Record<string, unknown> = {
    status: outcome.status,
    finished_at: new Date().toISOString(),
    summary: outcome.summary ?? null,
    error: outcome.error ? outcome.error.slice(0, 1000) : null,
  };
  if (outcome.progress) patch.progress = outcome.progress;
  const { error } = await table().update(patch).eq("id", id).eq("status", "running");
  fail(error, "finish run");
}

export async function getRun(id: string): Promise<ScriptRun | null> {
  const { data, error } = await table().select(COLUMNS).eq("id", id).maybeSingle();
  fail(error, "read run");
  return (data as ScriptRun | null) ?? null;
}

export async function listRecent(scriptKey: string, limit = 10): Promise<ScriptRun[]> {
  const { data, error } = await table()
    .select(COLUMNS)
    .eq("script_key", scriptKey)
    .order("started_at", { ascending: false })
    .limit(limit);
  fail(error, "list runs");
  return (data ?? []) as ScriptRun[];
}
