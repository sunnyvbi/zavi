import { inngest } from "../client";
import { isCanonicalContainer } from "@/services/agents/boot-role";
import { OPS_ALERT_ENQUEUED_EVENT, drainOpsAlerts } from "@/services/logging/ops-alert-outbox";
import { runPrivateDataHousekeeping } from "./private-data-housekeeping";
import { runVideoChargeSettleSlot } from "./video-charge-settle";

export const opsAlertOutboxDrainFn = inngest.createFunction(
  { id: "ops-alert-outbox-drain", concurrency: 1, retries: 2 },
  [{ event: OPS_ALERT_ENQUEUED_EVENT }, { cron: "*/10 * * * *" }],
  async ({ event, step, logger }) => {
    if (!isCanonicalContainer()) {
      logger.info("ops-alert-outbox-drain: skipped (not the prod container)");
      return { skipped: "not_canonical" as const };
    }
    const res = await step.run("drain", () => drainOpsAlerts());
    if (res.failed > 0 || res.fenced > 0) logger.warn(`ops-alert-outbox-drain: ${JSON.stringify(res)}`);
    if (event?.name === "inngest/scheduled.timer") {
      const hk = await step.run("private-data-housekeeping", () => runPrivateDataHousekeeping(new Date()));
      logger.info(`private-data-housekeeping: ${JSON.stringify(hk)}`);
      const charges = await step.run("settle-video-charges", () => runVideoChargeSettleSlot(new Date()));
      if (charges !== "skipped") logger.info(`settle-video-charges: ${JSON.stringify(charges)}`);
      return { ...res, housekeeping: hk, video_charges: charges };
    }
    return res;
  },
);
