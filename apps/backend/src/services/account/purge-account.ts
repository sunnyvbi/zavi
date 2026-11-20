
import type { SupabaseClient } from "@supabase/supabase-js";

export type PurgeMode = "dry_run" | "execute";

export type PurgeSummary = {
  status: "dry_run" | "purged" | "already_purged";
  deletion_id: string;
  workspaces: number;
  delete: Record<string, number>;
  clear: Record<string, number>;
  keep: Record<string, number>;
  other_links?: Record<string, number>;
  unclassified_links?: Record<string, number>;
  cross_tenant_links?: Record<string, number>;
  storage_objects: number;
  storage_pending?: boolean;
  batched_agent_runs: number;
  planned_delete?: Record<string, number> | null;
  auth_user: {
    present: boolean;
    cascade: Record<string, number>;
    clear: Record<string, number>;
    blockers: Record<string, number>;
  };
  purged_at?: string;
};

export type PurgeResult = PurgeSummary & { storage_removed: number; runs_deleted: number };

export const STORAGE_REMOVE_CHUNK = 100;
export const STORAGE_LIST_PAGE = 1000;
export const STORAGE_MAX_PAGES = 50;
export const RUN_BATCH = 25;
export const RUN_MAX_BATCHES = 400;

export class AccountPurgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountPurgeError";
  }
}

export async function removeDeletedWorkspaceStorage(
  sb: SupabaseClient,
  deletionId: string,
): Promise<{ removed: number; done: boolean }> {
  let removed = 0;
  for (let page = 0; page < STORAGE_MAX_PAGES; page++) {
    const { data, error } = await sb.rpc("account_purge_storage_objects", {
      p_deletion_id: deletionId,
      p_limit: STORAGE_LIST_PAGE,
    });
    if (error) throw new AccountPurgeError(`storage list failed: ${error.message}`);
    if (!Array.isArray(data)) throw new AccountPurgeError("storage list returned no list");
    const rows = data as Array<{ bucket_id: string; name: string }>;
    if (rows.length === 0) {
      const { data: doneAt, error: doneErr } = await sb.rpc("account_purge_storage_done", { p_deletion_id: deletionId });
      if (doneErr) throw new AccountPurgeError(`storage done failed: ${doneErr.message}`);
      return { removed, done: typeof doneAt === "string" && doneAt.length > 0 };
    }

    const byBucket = new Map<string, string[]>();
    for (const row of rows) {
      const list = byBucket.get(row.bucket_id);
      if (list) list.push(row.name);
      else byBucket.set(row.bucket_id, [row.name]);
    }
    for (const [bucket, names] of byBucket) {
      for (let i = 0; i < names.length; i += STORAGE_REMOVE_CHUNK) {
        const chunk = names.slice(i, i + STORAGE_REMOVE_CHUNK);
        const { error: rmErr } = await sb.storage.from(bucket).remove(chunk);
        if (rmErr) throw new AccountPurgeError(`storage remove failed in bucket ${bucket}: ${rmErr.message}`);
        removed += chunk.length;
      }
    }
  }
  throw new AccountPurgeError(`storage still not empty after ${STORAGE_MAX_PAGES} pages`);
}

export async function deleteDeletedWorkspaceRuns(sb: SupabaseClient, deletionId: string): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < RUN_MAX_BATCHES; i++) {
    const { data, error } = await sb.rpc("account_purge_delete_runs", { p_deletion_id: deletionId, p_limit: RUN_BATCH });
    if (error) throw new AccountPurgeError(`run batch failed: ${error.message}`);
    const n =
      typeof data === "number" ? data : typeof data === "string" && /^\d+$/.test(data) ? Number(data) : Number.NaN;
    if (!Number.isSafeInteger(n) || n < 0) throw new AccountPurgeError("run batch returned no count");
    if (n === 0) return deleted;
    deleted += n;
  }
  throw new AccountPurgeError(`runs still left after ${RUN_MAX_BATCHES} batches`);
}

export async function purgeAccountDeletion(
  sb: SupabaseClient,
  deletionId: string,
  mode: PurgeMode,
): Promise<PurgeResult> {
  const execute = mode === "execute";
  if (execute) {
    const { data: plan, error: planErr } = await sb.rpc("purge_account_deletion", {
      p_deletion_id: deletionId,
      p_execute: false,
    });
    if (planErr) throw new AccountPurgeError(planErr.message);
    const summary = plan as PurgeSummary | null;
    const blockers = summary?.auth_user?.blockers;
    const cross = summary?.cross_tenant_links;
    if (
      !blockers || typeof blockers !== "object" || Array.isArray(blockers) ||
      (summary?.status !== "already_purged" && (!cross || typeof cross !== "object" || Array.isArray(cross)))
    ) {
      throw new AccountPurgeError("purge plan unreadable; nothing was touched");
    }
    if (Object.keys(blockers).length > 0) {
      throw new AccountPurgeError(
        `account_purge: user_rows_outside (rows outside the deleted workspaces still point at the person: ${JSON.stringify(blockers)})`,
      );
    }
    if (cross && Object.keys(cross).length > 0) {
      throw new AccountPurgeError(
        `account_purge: cross_tenant_rows (a delete would reach rows of other workspaces: ${JSON.stringify(cross)})`,
      );
    }
  }
  const runs_deleted = execute ? await deleteDeletedWorkspaceRuns(sb, deletionId) : 0;

  const { data, error } = await sb.rpc("purge_account_deletion", {
    p_deletion_id: deletionId,
    p_execute: execute,
  });
  let summary: PurgeSummary;
  if (error || !data || typeof data !== "object") {
    const committed = execute ? await readCommittedPurge(sb, deletionId) : null;
    if (!committed) throw new AccountPurgeError(error?.message ?? "purge returned no summary");
    summary = committed;
  } else {
    summary = data as PurgeSummary;
  }
  if (!execute) return { ...summary, storage_removed: 0, runs_deleted };

  let files: { removed: number; done: boolean };
  try {
    files = await removeDeletedWorkspaceStorage(sb, deletionId);
  } catch (e) {
    throw new StoragePendingError(e instanceof Error ? e.message : String(e), { ...summary, storage_removed: 0, runs_deleted });
  }
  return { ...summary, storage_pending: !files.done, storage_removed: files.removed, runs_deleted };
}

export class StoragePendingError extends AccountPurgeError {
  readonly result: PurgeResult;
  constructor(message: string, result: PurgeResult) {
    super(`purged, files pending: ${message}`);
    this.name = "StoragePendingError";
    this.result = result;
  }
}

export async function finishPurgedStorage(
  sb: SupabaseClient,
  deletionId: string,
): Promise<{ removed: number; done: boolean }> {
  return removeDeletedWorkspaceStorage(sb, deletionId);
}

export async function listDeletionMismatches(sb: SupabaseClient, limit = 25): Promise<string[]> {
  const { data, error } = await sb.rpc("account_deletion_mismatches", { p_limit: limit });
  if (error) throw new AccountPurgeError(`mismatch list failed: ${error.message}`);
  if (!Array.isArray(data)) throw new AccountPurgeError("mismatch list returned no list");
  return (data as Array<{ id: string }>).map((r) => `killed:${r.id}`);
}

export const STUCK_PENDING_MS = 60 * 60_000;

export async function listStuckPendingDeletions(sb: SupabaseClient, now: Date, limit = 25): Promise<string[]> {
  const { data, error } = await sb
    .from("account_deletions")
    .select("id")
    .eq("status", "pending")
    .lte("requested_at", new Date(now.getTime() - STUCK_PENDING_MS).toISOString())
    .order("requested_at", { ascending: true })
    .limit(limit);
  if (error) throw new AccountPurgeError(`stuck-pending list failed: ${error.message}`);
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

async function readCommittedPurge(sb: SupabaseClient, deletionId: string): Promise<PurgeSummary | null> {
  let res: { data: { purged_at: string | null; purge_summary: PurgeSummary | null } | null; error: { message: string } | null };
  try {
    res = await sb
      .from("account_deletions")
      .select("purged_at, purge_summary")
      .eq("id", deletionId)
      .maybeSingle<{ purged_at: string | null; purge_summary: PurgeSummary | null }>();
  } catch (e) {
    res = { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
  }
  if (res.error) {
    throw new AccountPurgeError(
      `outcome unknown: the purge call failed and the request could not be read back (${res.error.message}); check account_deletions.purged_at`,
    );
  }
  if (!res.data?.purged_at || !res.data.purge_summary) return null;
  return { ...res.data.purge_summary, status: "purged", purged_at: res.data.purged_at };
}

export async function listStoragePendingDeletions(sb: SupabaseClient, limit = 25): Promise<string[]> {
  const { data, error } = await sb
    .from("account_deletions")
    .select("id")
    .eq("status", "purged")
    .not("purged_at", "is", null)
    .is("storage_purged_at", null)
    .order("purged_at", { ascending: true })
    .limit(limit);
  if (error) throw new AccountPurgeError(`storage-pending list failed: ${error.message}`);
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

export async function listDueAccountDeletions(sb: SupabaseClient, now: Date, limit = 25): Promise<string[]> {
  const { data, error } = await sb
    .from("account_deletions")
    .select("id")
    .is("purged_at", null)
    .eq("status", "soft_deleted")
    .lte("purge_after", now.toISOString())
    .order("purge_after", { ascending: true })
    .limit(limit);
  if (error) throw new AccountPurgeError(`due list failed: ${error.message}`);
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

export async function recordPurgeFailure(
  sb: SupabaseClient,
  deletionId: string,
  message: string,
  now: Date,
  opts: { purged?: boolean } = {},
): Promise<boolean> {
  try {
    const { data, error: readErr } = await sb
      .from("account_deletions")
      .select("purge_attempts")
      .eq("id", deletionId)
      .maybeSingle<{ purge_attempts: number | null }>();
    if (readErr) return false;
    const update = sb
      .from("account_deletions")
      .update({
        purge_last_error: message.slice(0, 500),
        purge_attempts: (data?.purge_attempts ?? 0) + 1,
        purge_last_attempt_at: now.toISOString(),
      })
      .eq("id", deletionId);
    const { error } = await (opts.purged ? update.is("storage_purged_at", null) : update.is("purged_at", null));
    return !error;
  } catch {
    return false;
  }
}
