
import { inngest } from "../client";
import { defaultIdleDeps, sweepIdleSites } from "@/services/sites/idle";
import { supabaseMgmtConfig } from "@/services/sites/supabase-mgmt";
import { staticHostingConfig } from "@/services/hosting/static-publish";

export const siteIdleSweepFn = inngest.createFunction(
  { id: "site-idle-sweep", concurrency: { limit: 1 } },
  { cron: "15 6 * * *" },
  async ({ logger }) => {
    try {
      supabaseMgmtConfig();
    } catch {
      logger.warn("site-idle-sweep: Supabase management credentials not configured — skipping");
      return { skipped: "no_supabase_mgmt" };
    }
    if (!staticHostingConfig().ok) {
      logger.warn("site-idle-sweep: static hosting (KV) not configured — skipping");
      return { skipped: "no_static_hosting" };
    }
    const result = await sweepIdleSites({ ...defaultIdleDeps(), log: (m) => logger.warn(m) });
    logger.info(`site-idle-sweep: ${JSON.stringify(result)}`);
    return result;
  },
);
