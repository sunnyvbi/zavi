
import { inngest } from "../client";
import { stampOutcomes } from "@/services/memory/stamp-outcome";
import { distillEpisodes } from "@/services/memory/distill-episode";

export const memoryOutcomeStampFn = inngest.createFunction(
  { id: "memory-outcome-stamp", concurrency: 1 },
  { cron: "23 * * * *" },
  async ({ logger }) => {
    const res = await stampOutcomes();
    logger.info(`memory-outcome-stamp: runs=${res.runs} notes=${res.notes}`);
    let episodes = { scanned: 0, written: 0 };
    try {
      episodes = await distillEpisodes();
      logger.info(`distill-episode: scanned=${episodes.scanned} written=${episodes.written}`);
    } catch (e) {
      logger.warn(`distill-episode failed (non-fatal): ${(e as Error).message}`);
    }
    return { ...res, episodes };
  },
);
