
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";

export const voiceCallbackEventsCleanupFn = inngest.createFunction(
  { id: "voice-callback-events-cleanup" },
  { cron: "50 4 * * *" },
  async ({ logger }) => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { error, count } = await serviceClient()
      .from("voice_callback_events_seen")
      .delete({ count: "exact" })
      .lt("seen_at", twoHoursAgo);
    if (error) {
      throw new Error(`voice_callback_events_cleanup failed: ${error.message}`);
    }
    logger.info(
      `voice_callback_events_cleanup: removed ${count ?? 0} expired nonces`,
    );
    return { removed: count ?? 0 };
  },
);
