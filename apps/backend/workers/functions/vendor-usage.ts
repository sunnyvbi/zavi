
import { inngest } from "../client";
import { checkApifyUsage, previousUtcDay, reconcileApifyDay } from "@/services/vendors/reconcile";

export const vendorUsageReconcileFn = inngest.createFunction(
  { id: "vendor-usage-reconcile", concurrency: 1 },
  { cron: "30 3 * * *" },
  async ({ step, logger }) => {
    const paged = await step.run("check-apify-usage", async () => {
      try {
        return { paged: await checkApifyUsage() };
      } catch (e) {
        return { paged: [] as number[], error: (e as Error).message.slice(0, 200) };
      }
    });
    const now = new Date();
    const days = [previousUtcDay(new Date(now.getTime() - 86_400_000)), previousUtcDay(now)];
    const results = [];
    for (const day of days) {
      results.push(await step.run(`reconcile-apify-${day}`, () => reconcileApifyDay(day)));
    }
    logger.info(
      `vendor-usage-reconcile: ${results.map((r) => `${r.day} actors=${r.actors} real_usd=${r.real_usd}`).join("; ")} paged=${paged.paged.join(",")}${"error" in paged ? ` alert_error=${paged.error}` : ""}`,
    );
    return { paged, results };
  },
);
