
import { inngest } from "../client";
import { reconcilePendingOutcomes } from "@/services/growth/action-outcomes";

export const reconcileActionOutcomesFn = inngest.createFunction(
  { id: "reconcile-action-outcomes", concurrency: 1 },
  { cron: "37 * * * *" },
  async ({ logger }) => {
    const res = await reconcilePendingOutcomes();
    logger.info(
      `reconcile-action-outcomes: scanned ${res.scanned}, measured ${res.measured}, ` +
        `no_data ${res.no_data}, errors ${res.errors}, noop ${res.noop}`,
    );
    return res;
  },
);
