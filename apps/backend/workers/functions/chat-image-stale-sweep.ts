
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import {
  CHAT_IMAGE_RETENTION_DAYS as RETENTION_DAYS,
  CHAT_IMAGE_BATCH_SIZE as BATCH_SIZE,
  retentionCutoffIso,
} from "./cleanup-gc-boundaries";

const BUCKET = "agent-chat-images";

export const chatImageStaleSweepFn = inngest.createFunction(
  { id: "chat-image-stale-sweep" },
  { cron: "0 4 * * *" },
  async ({ logger }) => {
    const sb = serviceClient();
    const cutoff = retentionCutoffIso(RETENTION_DAYS);

    const { data: rows, error } = await sb
      .schema("storage")
      .from("objects")
      .select("name")
      .eq("bucket_id", BUCKET)
      .lt("created_at", cutoff);

    if (error) {
      logger.error(
        `chat-image-stale-sweep: storage.objects query failed: ${error.message}`,
      );
      throw new Error(`stale-sweep query failed: ${error.message}`);
    }

    const names = (rows ?? [])
      .map((r: { name: string | null }) => r.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);

    if (names.length === 0) {
      logger.info("chat-image-stale-sweep: no stale objects");
      return { removed: 0 };
    }

    let removed = 0;
    const errors: string[] = [];
    for (let i = 0; i < names.length; i += BATCH_SIZE) {
      const batch = names.slice(i, i + BATCH_SIZE);
      const { error: rmErr } = await sb.storage.from(BUCKET).remove(batch);
      if (rmErr) {
        errors.push(rmErr.message);
        logger.warn(
          `chat-image-stale-sweep: batch remove failed (batch ${i}-${i + batch.length}): ${rmErr.message}`,
        );
        continue;
      }
      removed += batch.length;
    }

    logger.info(
      `chat-image-stale-sweep: removed ${removed}/${names.length} stale objects` +
        (errors.length > 0 ? ` (${errors.length} batch errors)` : ""),
    );

    await logEvent({
      level: errors.length > 0 ? "warn" : "info",
      source: "chat-image-stale-sweep",
      code: "deleted",
      meta: {
        removed,
        total: names.length,
        batch_errors: errors.length,
      },
    });

    return { removed, total: names.length, batch_errors: errors.length };
  },
);
