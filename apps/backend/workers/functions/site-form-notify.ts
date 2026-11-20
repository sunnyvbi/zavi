
import { inngest } from "../client";
import { runFormNotifyDrain } from "@/services/site-auth/form-notify-run";

export const siteFormNotifyFn = inngest.createFunction(
  { id: "site-form-notify", concurrency: { limit: 1, key: '"global"' } },
  { cron: "*/5 * * * *" },
  async ({ logger }) => {
    const r = await runFormNotifyDrain();
    if ("skipped" in r) return r;
    logger.info(`site-form-notify: ${JSON.stringify(r)}`);
    return r;
  },
);
