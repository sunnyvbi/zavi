
import { createHash } from "node:crypto";
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";

import { DEFAULT_RAW_TTL_DAYS } from "@/services/agents/raw-transcript-ttl";
export { DEFAULT_RAW_TTL_DAYS };
const BATCH_LIMIT = 500;
const MAX_BATCHES = 10;
export const BATCH_PAUSE_MS = 2_000;

export async function runTranscriptRetentionPurge(
  pause: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ purged: number; skipped: boolean }> {
  if (process.env.TRANSCRIPT_RETENTION_PURGE_ENABLED === "false") {
    return { purged: 0, skipped: true };
  }
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const { data, error } = await serviceClient().rpc(
      "purge_expired_raw_transcripts",
      { p_default_ttl_days: DEFAULT_RAW_TTL_DAYS, p_batch_limit: BATCH_LIMIT },
    );
    if (error) {
      throw new Error(`transcript_retention_purge failed: ${error.message}`);
    }
    const purged = typeof data === "number" ? data : 0;
    total += purged;
    if (purged < BATCH_LIMIT) break;
    await pause(BATCH_PAUSE_MS);
  }
  return { purged: total, skipped: false };
}

export const transcriptRetentionPurgeFn = inngest.createFunction(
  { id: "transcript-retention-purge" },
  { cron: "30 9 * * *" },
  async ({ logger }) => {
    const out = await runTranscriptRetentionPurge();
    logger.info(
      `transcript_retention_purge: purged=${out.purged} skipped=${out.skipped}`,
    );
    return out;
  },
);

export const DRAIN_BUDGET_MS = 120_000;
export const DB_RETENTION_BATCH = 2000;
export const ACCESS_LOG_BATCH = 20_000;
export const DRAIN_PAUSE_MS = 250;
export const OVERDUE_ALERT_S: Record<PrivateDataPurge, number> = { raw_results: 7200, chat_answers: 86_400, access_log: 86_400 };

export type PrivateDataPurge = "raw_results" | "chat_answers" | "access_log";
const isPrivateDataPurge = (p: RetentionPurge): p is PrivateDataPurge => p === "raw_results" || p === "chat_answers" || p === "access_log";
export const CLEANUP_PURGES = [
  "stream_drafts",
  "run_events",
  "thread_event_steps",
  "memory_search_traces",
  "eval_candidates",
  "praxis_logs",
  "ship_pr_files",
  "sdk_sessions",
  "code_index_orphans",
] as const;
export type CleanupPurge = (typeof CLEANUP_PURGES)[number];
export type RetentionPurge = PrivateDataPurge | CleanupPurge;

export const CLEANUP_BATCH = 5000;
const PURGES: Record<RetentionPurge, { rpc: string; batch: number; code: string }> = {
  raw_results: { rpc: "purge_db_raw_results", batch: DB_RETENTION_BATCH, code: "db_raw_results_purge_failed" },
  chat_answers: { rpc: "purge_db_chat_answers", batch: DB_RETENTION_BATCH, code: "db_chat_answers_purge_failed" },
  access_log: { rpc: "purge_data_access_log", batch: ACCESS_LOG_BATCH, code: "data_access_log_purge_failed" },
  stream_drafts: { rpc: "purge_stream_drafts", batch: CLEANUP_BATCH, code: "stream_drafts_purge_failed" },
  run_events: { rpc: "purge_run_events", batch: CLEANUP_BATCH, code: "run_events_purge_failed" },
  thread_event_steps: { rpc: "purge_thread_event_steps", batch: CLEANUP_BATCH, code: "thread_event_steps_purge_failed" },
  memory_search_traces: { rpc: "purge_memory_search_traces", batch: CLEANUP_BATCH, code: "memory_search_traces_purge_failed" },
  eval_candidates: { rpc: "purge_eval_candidates", batch: CLEANUP_BATCH, code: "eval_candidates_purge_failed" },
  praxis_logs: { rpc: "purge_praxis_logs", batch: CLEANUP_BATCH, code: "praxis_logs_purge_failed" },
  ship_pr_files: { rpc: "purge_ship_pr_file_contents", batch: 200, code: "ship_pr_files_purge_failed" },
  sdk_sessions: { rpc: "purge_sdk_sessions", batch: 5000, code: "sdk_sessions_purge_failed" },
  code_index_orphans: { rpc: "purge_code_index_orphans", batch: 1000, code: "code_index_orphans_purge_failed" },
};

export function readBatch(data: unknown, batch: number): { n: number; more: boolean; oversized: number } {
  if (typeof data === "number") return { n: data, more: data >= batch, oversized: 0 };
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const o = data as { deleted?: unknown; more?: unknown; oversized?: unknown };
    const n = typeof o.deleted === "number" ? o.deleted : 0;
    return { n, more: o.more === true, oversized: typeof o.oversized === "number" ? o.oversized : 0 };
  }
  return { n: 0, more: false, oversized: 0 };
}

export type DrainDeps = {
  now: () => number;
  pause: (ms: number) => Promise<void>;
  continueLater: (purge: PrivateDataPurge, parentKey?: string) => Promise<void>;
};

export function continuationEventId(purge: PrivateDataPurge, parentKey: string | undefined, nowMs: number): string {
  if (!parentKey) return `db-retention-continue-${purge}-tick-${Math.floor(nowMs / 300_000)}`;
  return `db-retention-continue-${purge}-${createHash("sha256").update(parentKey).digest("hex").slice(0, 24)}`;
}
const DRAIN_DEFAULT: DrainDeps = {
  now: () => Date.now(),
  pause: (ms) => new Promise((r) => setTimeout(r, ms)),
  continueLater: async (purge, parentKey) => {
    await inngest.send({ id: continuationEventId(purge, parentKey, Date.now()), name: "db-retention.continue", data: { purge } });
  },
};

export async function drainPurge(
  purge: RetentionPurge,
  deps: Partial<DrainDeps> = {},
  opts: { parentKey?: string; maxRows?: number; budgetMs?: number; pauseMs?: number } = {},
): Promise<{ total: number; backlog: boolean; failed: boolean }> {
  const d = { ...DRAIN_DEFAULT, ...deps };
  const { rpc, batch, code } = PURGES[purge];
  const budgetMs = opts.budgetMs ?? DRAIN_BUDGET_MS;
  const start = d.now();
  let total = 0;
  for (;;) {
    const limit = opts.maxRows === undefined ? batch : Math.max(1, Math.min(batch, opts.maxRows - total));
    let n: number;
    let more: boolean;
    let oversized: number;
    try {
      const { data, error } = await serviceClient().rpc(rpc, { p_batch_limit: limit });
      if (error) throw new Error(error.message);
      ({ n, more, oversized } = readBatch(data, limit));
    } catch (err) {
      await logEvent({ level: "warn", source: "data-retention-purge", code, error: err });
      return { total, backlog: false, failed: true };
    }
    if (oversized > 0) {
      await logEvent({
        level: "warn",
        source: "data-retention-purge",
        code: `${purge}_oversized_skipped`,
        message: `${purge}: ${oversized} item(s) too big for one batch were skipped, not deleted`,
        meta: { total: oversized },
      });
    }
    total += n;
    if (!more) return { total, backlog: false, failed: false };
    if (opts.maxRows !== undefined && total >= opts.maxRows) return { total, backlog: true, failed: false };
    if (d.now() - start >= budgetMs) {
      if (isPrivateDataPurge(purge)) await d.continueLater(purge, opts.parentKey).catch(async (err) => {
        await logEvent({ level: "warn", source: "data-retention-purge", code: "db_retention_continue_failed", error: err });
      });
      return { total, backlog: true, failed: false };
    }
    await d.pause(opts.pauseMs ?? DRAIN_PAUSE_MS);
  }
}

export async function checkRetentionBacklog(): Promise<Partial<Record<PrivateDataPurge, number>>> {
  try {
    const { data, error } = await serviceClient().rpc("db_retention_backlog");
    if (error) throw new Error(error.message);
    const out = (data ?? {}) as Partial<Record<PrivateDataPurge, number>>;
    for (const purge of Object.keys(OVERDUE_ALERT_S) as PrivateDataPurge[]) {
      const s = Number(out[purge] ?? 0);
      if (s > OVERDUE_ALERT_S[purge]) {
        await logEvent({
          level: "error",
          source: "data-retention-purge",
          code: "db_retention_overdue",
          message: `${purge} retention is ${Math.round(s / 60)} minutes overdue`,
          meta: { ms: s * 1000 },
        });
      }
    }
    return out;
  } catch (err) {
    await logEvent({ level: "warn", source: "data-retention-purge", code: "db_retention_backlog_failed", error: err });
    return {};
  }
}

export const DB_CLEANUP_EVENT = "db-cleanup.run";

async function startDbCleanupDefault(nowMs: number): Promise<void> {
  await inngest.send({ id: `db-cleanup-${new Date(nowMs).toISOString().slice(0, 10)}`, name: DB_CLEANUP_EVENT, data: {} });
}

export async function runDataRetentionPurge(
  deps: Partial<DrainDeps> & { startDbCleanup?: (nowMs: number) => Promise<void> } = {},
): Promise<{
  access_log_purged: number;
  access_log_skipped: boolean;
  chat_answers_deleted: number;
  db_cleanup_started: boolean;
}> {
  const access_log_skipped = process.env.DATA_ACCESS_LOG_PURGE_ENABLED === "false";
  const access_log_purged = access_log_skipped ? 0 : (await drainPurge("access_log", deps)).total;
  const chat_answers_deleted = (await drainPurge("chat_answers", deps)).total;
  await checkRetentionBacklog();
  let db_cleanup_started = false;
  if (process.env.DB_CLEANUP_PURGE_ENABLED !== "false") {
    try {
      await (deps.startDbCleanup ?? startDbCleanupDefault)((deps.now ?? Date.now)());
      db_cleanup_started = true;
    } catch (err) {
      await logEvent({ level: "warn", source: "data-retention-purge", code: "db_cleanup_start_failed", error: err });
    }
  }
  return { access_log_purged, access_log_skipped, chat_answers_deleted, db_cleanup_started };
}

export const CLEANUP_NIGHT_ROWS = 200_000;
export const CLEANUP_NIGHT_MS = 20 * 60_000;
export const CLEANUP_MAX_PASSES = 3;
export const CLEANUP_PAUSE_MS = 1_500;

export type StepRunner = <T>(id: string, fn: () => Promise<T>) => Promise<T>;

const cleanupOff = () => process.env.DB_CLEANUP_PURGE_ENABLED === "false";

export async function runDbCleanup(
  step: StepRunner,
  deps: Partial<DrainDeps> = {},
): Promise<{ skipped: boolean; expired_code_indexes: number; deleted: Partial<Record<CleanupPurge, number>>; stopped?: "budget" | "kill_switch" }> {
  if (cleanupOff()) return { skipped: true, expired_code_indexes: 0, deleted: {} };
  const now = deps.now ?? Date.now;
  const pass: Partial<DrainDeps> = { ...deps, continueLater: async () => undefined };
  const startedAt = await step("start", async () => now());
  const expired_code_indexes = await step("expire-stale-code-indexes", async () => {
    try {
      const { data, error } = await serviceClient().rpc("expire_stale_code_indexes", { p_limit: 50 });
      if (error) throw new Error(error.message);
      return typeof data === "number" ? data : 0;
    } catch (err) {
      await logEvent({ level: "warn", source: "data-retention-purge", code: "expire_stale_code_indexes_failed", error: err });
      return 0;
    }
  });
  const deleted: Partial<Record<CleanupPurge, number>> = {};
  let used = 0;
  let stopped: "budget" | "kill_switch" | undefined;
  outer: for (let k = 0; k < CLEANUP_PURGES.length; k++) {
    const purge = CLEANUP_PURGES[k];
    const share = Math.ceil((CLEANUP_NIGHT_ROWS - used) / (CLEANUP_PURGES.length - k));
    let total = 0;
    for (let i = 0; i < CLEANUP_MAX_PASSES; i++) {
      if (cleanupOff()) {
        stopped = "kill_switch";
        break outer;
      }
      const rowsLeft = Math.min(share - total, CLEANUP_NIGHT_ROWS - used);
      const msLeft = startedAt + CLEANUP_NIGHT_MS - now();
      if (rowsLeft <= 0 || msLeft <= 0) {
        if (CLEANUP_NIGHT_ROWS - used <= 0 || msLeft <= 0) {
          stopped = "budget";
          break outer;
        }
        break;
      }
      const r = await step(`${purge}-${i}`, () =>
        drainPurge(purge, pass, { maxRows: rowsLeft, budgetMs: Math.min(DRAIN_BUDGET_MS, msLeft), pauseMs: CLEANUP_PAUSE_MS }),
      );
      total += r.total;
      used += r.total;
      deleted[purge] = total;
      if (!r.backlog) break;
    }
    deleted[purge] = total;
  }
  await logEvent({
    level: "info",
    source: "data-retention-purge",
    code: "db_cleanup_done",
    message: `expired code indexes ${expired_code_indexes}; deleted ${CLEANUP_PURGES.map((p) => `${p}=${deleted[p] ?? 0}`).join(" ")}${stopped ? `; stopped: ${stopped}` : ""}`,
    meta: { removed: used, total: expired_code_indexes },
  });
  return { skipped: false, expired_code_indexes, deleted, ...(stopped ? { stopped } : {}) };
}

export const dbCleanupPurgeFn = inngest.createFunction(
  { id: "db-cleanup-purge", concurrency: { limit: 1 }, retries: 1 },
  { event: DB_CLEANUP_EVENT },
  async ({ step, logger }) => {
    const out = await runDbCleanup((id, fn) => step.run(id, fn) as unknown as ReturnType<typeof fn>);
    logger.info(`db_cleanup_purge: ${JSON.stringify(out)}`);
    return out;
  },
);

export const COVERAGE_PAGE = 5000;
export const COVERAGE_BUDGET_MS = 60_000;

export async function runRetentionCoverage(deps: Partial<DrainDeps> = {}): Promise<{ scanned: number; enqueued: number; wrapped: boolean }> {
  const d = { ...DRAIN_DEFAULT, ...deps };
  const start = d.now();
  let scanned = 0;
  let enqueued = 0;
  for (;;) {
    try {
      const { data, error } = await serviceClient().rpc("enqueue_db_run_retention_page", { p_limit: COVERAGE_PAGE });
      if (error) throw new Error(error.message);
      const row = (Array.isArray(data) ? data[0] : data) as { scanned?: number; enqueued?: number; wrapped?: boolean } | null;
      scanned += Number(row?.scanned ?? 0);
      enqueued += Number(row?.enqueued ?? 0);
      if (row?.wrapped !== false) return { scanned, enqueued, wrapped: true };
    } catch (err) {
      await logEvent({ level: "warn", source: "data-retention-purge", code: "db_retention_coverage_failed", error: err });
      return { scanned, enqueued, wrapped: false };
    }
    if (d.now() - start >= COVERAGE_BUDGET_MS) return { scanned, enqueued, wrapped: false };
    await d.pause(DRAIN_PAUSE_MS);
  }
}

export async function runDbRawResultsSweep(deps: Partial<DrainDeps> = {}): Promise<{ scrubbed: number; enqueued: number }> {
  const coverage = await runRetentionCoverage(deps);
  const r = await drainPurge("raw_results", deps);
  return { scrubbed: r.total, enqueued: coverage.enqueued };
}

export const dbRetentionContinueFn = inngest.createFunction(
  { id: "db-retention-continue", concurrency: { limit: 1, key: "event.data.purge" } },
  { event: "db-retention.continue" },
  async ({ event, logger }) => {
    const purge = event.data.purge;
    if (purge !== "raw_results" && purge !== "chat_answers" && purge !== "access_log") return { skipped: true };
    if (purge === "access_log" && process.env.DATA_ACCESS_LOG_PURGE_ENABLED === "false") return { skipped: true };
    const out = await drainPurge(purge, {}, { parentKey: typeof event.id === "string" && event.id ? event.id : `${purge}-${Date.now()}` });
    await checkRetentionBacklog();
    logger.info(`db_retention_continue: ${purge} ${JSON.stringify(out)}`);
    return out;
  },
);
