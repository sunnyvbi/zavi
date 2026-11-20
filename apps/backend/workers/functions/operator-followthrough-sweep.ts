
import { inngest } from "../client";
import { sweepOperatorFollowthrough } from "@/services/agents/operator-followthrough-sweep";
import { isCanonicalContainer } from "@/services/agents/boot-role";

export const operatorFollowthroughSweepFn = inngest.createFunction(
  { id: "operator-followthrough-sweep", concurrency: 1 },
  { cron: "*/5 * * * *" },
  async ({ logger }) => {
    if (!isCanonicalContainer()) {
      logger.info("operator-followthrough-sweep: skipped (not the prod container)");
      return { skipped: "not_canonical" as const };
    }
    const res = await sweepOperatorFollowthrough();
    logger.info(
      `operator-followthrough-sweep: scanned=${res.scanned} interim=${res.interim_posted} ` +
        `failed=${res.failed_posted} skipped_dedupe=${res.skipped_dedupe} ` +
        `skipped_infra_retry=${res.skipped_infra_retry} errors=${res.errors} halted=${res.halted}`,
    );
    return res;
  },
);
