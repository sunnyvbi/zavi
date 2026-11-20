
import { inngest } from "../client";
import { sweepStrategistReviews } from "@/services/meta-ads/strategist-gate/sweep";

export const strategistReviewSweepFn = inngest.createFunction(
  { id: "strategist-review-sweep", concurrency: 1 },
  { cron: "*/5 * * * *" },
  async ({ logger }) => {
    const res = await sweepStrategistReviews();
    logger.info(
      `strategist-review-sweep: scanned=${res.scanned} retried=${res.retried} ` +
        `recovered=${res.recovered} failed=${res.failed} waited=${res.waited} errors=${res.errors}`,
    );
    return res;
  },
);
