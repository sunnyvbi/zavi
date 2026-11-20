
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";

const BUCKET = "agent-run-traces";
const REMOVE_BATCH_SIZE = 100;
const MAX_ROWS_PER_RUN = 1000;

export const agentTraceGcFn = inngest.createFunction(
  { id: "agent-trace-gc" },
  { cron: "0 5 * * *" },
  async ({ logger }) => {
    if (process.env.PRAXIS_AGENT_TRACE_GC_ENABLED === "0") {
      logger.info("agent-trace-gc: disabled via env");
      return { removed_objects: 0, removed_rows: 0 };
    }

    const sb = serviceClient();
    const nowIso = new Date().toISOString();

    const { data: rows, error } = await sb
      .from("agent_run_trace")
      .select("run_id, storage_path")
      .lt("expires_at", nowIso)
      .limit(MAX_ROWS_PER_RUN);

    if (error) {
      logger.error(`agent-trace-gc: query failed: ${error.message}`);
      throw new Error(`agent-trace-gc query failed: ${error.message}`);
    }

    const expired = (rows ?? []) as { run_id: string; storage_path: string }[];
    if (expired.length === 0) {
      logger.info("agent-trace-gc: nothing expired");
      return { removed_objects: 0, removed_rows: 0 };
    }

    let removedObjects = 0;
    let removedRows = 0;
    const batchErrors: string[] = [];
    for (let i = 0; i < expired.length; i += REMOVE_BATCH_SIZE) {
      const slice = expired.slice(i, i + REMOVE_BATCH_SIZE);
      const paths = slice
        .map((r) => r.storage_path)
        .filter((p): p is string => typeof p === "string" && p.length > 0);

      const { error: rmErr } = await sb.storage.from(BUCKET).remove(paths);
      if (rmErr) {
        batchErrors.push(rmErr.message);
        logger.warn(
          `agent-trace-gc: object batch remove failed (${i}-${i + slice.length}); rows kept for retry: ${rmErr.message}`,
        );
        continue;
      }
      removedObjects += paths.length;

      const runIds = slice.map((r) => r.run_id);
      const { error: delErr } = await sb
        .from("agent_run_trace")
        .delete()
        .in("run_id", runIds);
      if (delErr) {
        batchErrors.push(delErr.message);
        logger.warn(
          `agent-trace-gc: row delete failed (${i}-${i + slice.length}): ${delErr.message}`,
        );
        continue;
      }
      removedRows += runIds.length;
    }

    logger.info(
      `agent-trace-gc: removed ${removedObjects} objects, ${removedRows} rows of ${expired.length} expired` +
        (batchErrors.length > 0 ? ` (${batchErrors.length} batch errors, retried next sweep)` : ""),
    );

    await logEvent({
      level: batchErrors.length > 0 ? "warn" : "info",
      source: "agent-trace-gc",
      code: "swept",
      meta: {
        removed_objects: removedObjects,
        removed_rows: removedRows,
        expired_seen: expired.length,
        batch_errors: batchErrors.length,
      },
    });

    return {
      removed_objects: removedObjects,
      removed_rows: removedRows,
      batch_errors: batchErrors.length,
    };
  },
);
