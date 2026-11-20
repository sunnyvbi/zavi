
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import {
  SYNTHETIC_THREADS_BATCH_SIZE as BATCH_SIZE,
  SYNTHETIC_THREADS_MAX_BATCHES_PER_RUN as MAX_BATCHES_PER_RUN,
  SYNTHETIC_THREADS_RETENTION_DAYS,
  retentionCutoffIso,
} from "./cleanup-gc-boundaries";

export const cleanupSyntheticThreadsFn = inngest.createFunction(
  { id: "cleanup-synthetic-threads", concurrency: 1 },
  { cron: "0 3 * * *" },
  async ({ logger }) => {
    const cutoff = retentionCutoffIso(SYNTHETIC_THREADS_RETENTION_DAYS);
    let totalRemoved = 0;
    let batches = 0;

    while (batches < MAX_BATCHES_PER_RUN) {
      const sb = serviceClient();
      const { data: ids, error: selErr } = await sb
        .from("agent_threads")
        .select("id")
        .eq("synthetic", true)
        .lt("last_message_at", cutoff)
        .limit(BATCH_SIZE);
      if (selErr) {
        throw new Error(`select batch failed: ${selErr.message}`);
      }
      const idList = ((ids ?? []) as { id: string }[]).map((r) => r.id);
      if (idList.length === 0) break;

      const { error: delErr, count } = await sb
        .from("agent_threads")
        .delete({ count: "exact" })
        .in("id", idList);
      if (delErr) {
        throw new Error(`delete batch failed: ${delErr.message}`);
      }
      totalRemoved += count ?? 0;
      batches += 1;

      if (idList.length < BATCH_SIZE) break;
    }

    logger.info(
      `cleanup-synthetic-threads: removed ${totalRemoved} rows across ${batches} batches (cutoff=${cutoff})`,
    );
    return { removed: totalRemoved, batches };
  },
);
