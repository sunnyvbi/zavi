
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import {
  memorySignalRetentionDays,
  retentionCutoffIso,
} from "./cleanup-gc-boundaries";

async function gc(): Promise<{ deleted: number }> {
  const sb = serviceClient();
  const cutoff = retentionCutoffIso(
    memorySignalRetentionDays(process.env.PRAXIS_MEMORY_SIGNAL_RETENTION_DAYS),
  );
  const { data, error } = await sb
    .from("memory_signal")
    .delete()
    .lt("created_at", cutoff)
    .not("distilled_at", "is", null)
    .select("id");
  if (error) {
    console.warn(`[memory-signal-gc] delete failed: ${error.message}`);
    return { deleted: 0 };
  }
  return { deleted: (data ?? []).length };
}

export const memorySignalGcFn = inngest.createFunction(
  { id: "memory-signal-gc", concurrency: 1 },
  { cron: "30 4 * * *" },
  async ({ logger }) => {
    const res = await gc();
    logger.info(`memory-signal-gc: deleted=${res.deleted}`);
    return res;
  },
);
