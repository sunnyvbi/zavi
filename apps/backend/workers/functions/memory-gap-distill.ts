
import { inngest } from "../client";
import { distillGaps } from "@/services/memory/distill-gap";

export const memoryGapDistillFn = inngest.createFunction(
  { id: "memory-gap-distill", concurrency: 1 },
  { cron: "40 5 * * *" },
  async ({ logger }) => {
    const res = await distillGaps();
    logger.info(`memory-gap-distill: groups=${res.groups} upserted=${res.upserted}`);
    return res;
  },
);
