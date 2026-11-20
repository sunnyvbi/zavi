
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";

const CHUNK_SIZE = 5000;
const CHUNK_GAP_MS = 250;
const TTL_DAYS = 90;

export const slackMessageIndexPruneFn = inngest.createFunction(
  { id: "slack-message-index-prune", concurrency: 1, retries: 1 },
  { cron: "0 3 * * *" },
  async ({ step, logger }) => {
    const cutoff = new Date(Date.now() - TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

    let totalDeleted = 0;
    let chunkIdx = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const chunk = await step.run(`prune-chunk-${chunkIdx}`, async () => {
        const sb = serviceClient();

        const { data: rows, error: selErr } = await sb
          .from("slack_message_index")
          .select("tenant_id, channel_id, ts")
          .lt("created_at", cutoff)
          .limit(CHUNK_SIZE);
        if (selErr) {
          throw new Error(`slack_message_index select failed: ${selErr.message}`);
        }
        const pks = (rows as Array<{ tenant_id: string; channel_id: string; ts: string }> | null) ?? [];
        if (pks.length === 0) return { deleted: 0, done: true };

        let chunkDeleted = 0;
        for (const r of pks) {
          const { error: delErr } = await sb
            .from("slack_message_index")
            .delete()
            .eq("tenant_id", r.tenant_id)
            .eq("channel_id", r.channel_id)
            .eq("ts", r.ts);
          if (delErr) {
            logger.warn(
              `slack-message-index-prune: per-row delete failed (${r.tenant_id}/${r.channel_id}/${r.ts}): ${delErr.message}`,
            );
            continue;
          }
          chunkDeleted += 1;
        }
        return { deleted: chunkDeleted, done: pks.length < CHUNK_SIZE };
      });

      totalDeleted += chunk.deleted;
      chunkIdx += 1;

      if (chunk.done) break;

      await step.sleep(`gap-${chunkIdx}`, `${CHUNK_GAP_MS}ms`);
    }

    logger.info(
      `slack-message-index-prune: cutoff=${cutoff} chunks=${chunkIdx} deleted=${totalDeleted}`,
    );
    return { cutoff, chunks: chunkIdx, deleted: totalDeleted };
  },
);
