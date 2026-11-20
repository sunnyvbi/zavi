
import { inngest } from "../client";
import { selfAccountClient } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { alert } from "@/services/logging/alert";
import {
  StoragePendingError,
  finishPurgedStorage,
  listDeletionMismatches,
  listDueAccountDeletions,
  listStuckPendingDeletions,
  listStoragePendingDeletions,
  purgeAccountDeletion,
  recordPurgeFailure,
  type PurgeMode,
  type PurgeResult,
} from "@/services/account/purge-account";

const SOURCE = "account-deletion-purge";
export const MAX_PER_RUN = 25;

export function purgeModeFromEnv(raw: string | undefined): PurgeMode | "off" {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "execute") return "execute";
  if (v === "dry_run" || v === "dry-run") return "dry_run";
  return "off";
}

export type PurgeRunDeps = {
  now?: () => Date;
  client?: () => ReturnType<typeof selfAccountClient>;
  purge?: typeof purgeAccountDeletion;
  listDue?: typeof listDueAccountDeletions;
  listStoragePending?: typeof listStoragePendingDeletions;
  finishStorage?: typeof finishPurgedStorage;
  listStuckPending?: typeof listStuckPendingDeletions;
  listMismatches?: typeof listDeletionMismatches;
  recordFailure?: typeof recordPurgeFailure;
  page?: typeof alert;
  log?: typeof logEvent;
};

export type PurgeRunResult = {
  mode: PurgeMode | "off";
  due: number;
  purged: number;
  dry_run: number;
  failed: string[];
  files_finished: number;
};

export function failedById(failed: string[]): string {
  const kinds: Array<[string, string[]]> = [
    ["Killed after failing", failed.filter((f) => f.startsWith("killed:"))],
    ["Stuck pending", failed.filter((f) => f.startsWith("pending:"))],
    ["Deletion ids", failed.filter((f) => !f.startsWith("killed:") && !f.startsWith("pending:"))],
  ];
  return kinds
    .filter(([, ids]) => ids.length > 0)
    .map(([label, ids]) => `${label} (${ids.length}): ${ids.slice(0, 10).join(", ")}${ids.length > 10 ? ", ..." : ""}`)
    .join(". ");
}

const totalRows = (counts: Record<string, number> | undefined): number =>
  Object.values(counts ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);

export async function runAccountDeletionPurge(deps: PurgeRunDeps = {}): Promise<PurgeRunResult> {
  const raw = process.env.ACCOUNT_PURGE_MODE;
  const mode = purgeModeFromEnv(raw);
  const log = deps.log ?? logEvent;
  const now = deps.now ?? (() => new Date());
  const purge = deps.purge ?? purgeAccountDeletion;
  const listDue = deps.listDue ?? listDueAccountDeletions;
  const listStoragePending = deps.listStoragePending ?? listStoragePendingDeletions;
  const finishStorage = deps.finishStorage ?? finishPurgedStorage;
  const listStuckPending = deps.listStuckPending ?? listStuckPendingDeletions;
  const listMismatches = deps.listMismatches ?? listDeletionMismatches;
  const recordFailure = deps.recordFailure ?? recordPurgeFailure;
  const page = deps.page ?? alert;

  const out: PurgeRunResult = { mode, due: 0, purged: 0, dry_run: 0, failed: [], files_finished: 0 };
  const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
  try {
    const rawSet = (raw ?? "").trim();
    await log({
      level: mode === "off" && rawSet !== "" && rawSet.toLowerCase() !== "off" ? "warn" : "info",
      source: SOURCE,
      code: "account_purge_mode",
      message: `ACCOUNT_PURGE_MODE raw=${raw === undefined ? "(unset)" : JSON.stringify(raw.slice(0, 40))} -> ${mode}`,
    });

    const sb = (deps.client ??
      (() =>
        selfAccountClient(
          "account deletion purge: each request's scope is its own account_deletions row (the user and the workspaces deleted with them)",
        )))();

    try {
      for (const id of await listStuckPending(sb, now(), MAX_PER_RUN)) out.failed.push(`pending:${id}`);
    } catch (err) {
      out.failed.push("(stuck-pending list)");
      await log({ level: "error", source: SOURCE, code: "account_purge_list_failed", message: `stuck-pending list: ${errText(err)}` });
    }
    try {
      out.failed.push(...(await listMismatches(sb, MAX_PER_RUN)));
    } catch (err) {
      out.failed.push("(mismatch list)");
      await log({ level: "error", source: SOURCE, code: "account_purge_list_failed", message: `mismatch list: ${errText(err)}` });
    }
    if (mode === "off") return out;

    const record = async (id: string, message: string, opts: { purged?: boolean }) => {
      if (await recordFailure(sb, id, message, now(), opts)) return;
      await log({ level: "error", source: SOURCE, code: "account_purge_record_failed", message: `deletion ${id}: could not record the failure on its row` });
    };

    if (mode === "execute") {
      let pending: string[] = [];
      try {
        pending = await listStoragePending(sb, MAX_PER_RUN);
      } catch (err) {
        out.failed.push("(storage-pending list)");
        await log({ level: "error", source: SOURCE, code: "account_purge_list_failed", message: `storage-pending list: ${errText(err)}` });
      }
      for (const id of pending) {
        try {
          const files = await finishStorage(sb, id);
          if (files.done) out.files_finished++;
          await log({
            level: "info",
            source: SOURCE,
            code: files.done ? "account_purge_files_done" : "account_purge_files_swept",
            message: `deletion ${id}: ${files.removed} files removed after the purge${files.done ? "; done" : "; swept again tomorrow"}`,
          });
        } catch (err) {
          const message = errText(err);
          out.failed.push(id);
          await record(id, `files: ${message}`, { purged: true });
          await log({ level: "error", source: SOURCE, code: "account_purge_files_failed", message: `deletion ${id}: ${message}` });
        }
      }
    }

    let due: string[] = [];
    try {
      due = await listDue(sb, now(), MAX_PER_RUN);
    } catch (err) {
      out.failed.push("(due list)");
      await log({ level: "error", source: SOURCE, code: "account_purge_list_failed", message: `due list: ${errText(err)}` });
    }
    out.due = due.length;

    for (const id of due) {
      let result: PurgeResult;
      try {
        result = await purge(sb, id, mode);
      } catch (err) {
        const message = errText(err);
        out.failed.push(id);
        const purged = err instanceof StoragePendingError;
        if (mode === "execute") await record(id, message, { purged });
        await log({ level: "error", source: SOURCE, code: "account_purge_failed", message: `deletion ${id}: ${message}` });
        continue;
      }
      if (result.status === "purged") out.purged++;
      if (result.status === "dry_run") out.dry_run++;
      await log({
        level: "info",
        source: SOURCE,
        code: result.status === "dry_run" ? "account_purge_dry_run" : "account_purge_done",
        message:
          `deletion ${id}: ${result.status}; rows deleted ${totalRows(result.planned_delete ?? result.delete)} ` +
          `(${result.batched_agent_runs ?? 0} runs in batches), ` +
          `cleared ${totalRows(result.clear)}, kept ${totalRows(result.keep)}; ` +
          `files ${result.storage_removed || result.storage_objects}; workspaces ${result.workspaces}`,
      });
    }

  } catch (err) {
    out.failed.push("(run crashed)");
    console.error(`[${SOURCE}] run crashed: ${errText(err)}`);
  } finally {
    if (out.failed.length > 0) {
      await page({
        source: SOURCE,
        code: "account_purge_failed",
        msg:
          `${out.failed.length} account deletion(s) could not be purged, finished or confirmed (${mode}; ${out.due} due). ` +
          `The privacy page promises removal within 30 days. ${failedById(out.failed)}. ` +
          `Reason per id: account_deletions.purge_last_error or praxis_logs source ${SOURCE}. ` +
          `"pending:<id>" = a deletion stopped before confirming the login was deleted: once it is an hour old run ` +
          `select account_deletion_abort('<id>') (soft_deleted = login gone, finish the teardown by hand; failed = login ` +
          `live). "killed:<id>" = a request settled as failed whose login was deleted after all: set it soft_deleted and ` +
          `finish the teardown by hand.`,
        email: { dedupeKey: `account-purge:${now().toISOString().slice(0, 10)}` },
      }).catch((e: unknown) => console.error(`[${SOURCE}] page failed: ${errText(e)}`));
    }
  }
  return out;
}

export const accountDeletionPurgeFn = inngest.createFunction(
  { id: "account-deletion-purge", concurrency: { limit: 1 }, retries: 0 },
  { cron: "40 10 * * *" },
  async ({ logger }) => {
    const out = await runAccountDeletionPurge();
    logger.info(`account_deletion_purge: ${JSON.stringify(out)}`);
    return out;
  },
);
