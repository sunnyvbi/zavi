
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";

export const cleanupOauthStatesFn = inngest.createFunction(
  { id: "cleanup-oauth-states" },
  { cron: "0 * * * *" },
  async ({ logger }) => {
    const { error, count } = await serviceClient()
      .from("oauth_states")
      .delete({ count: "exact" })
      .lt("expires_at", new Date().toISOString());
    if (error) {
      throw new Error(`cleanup_oauth_states failed: ${error.message}`);
    }
    logger.info(`cleanup_oauth_states: removed ${count ?? 0} expired rows`);
    return { removed: count ?? 0 };
  },
);
