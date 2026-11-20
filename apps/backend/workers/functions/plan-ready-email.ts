
import { inngest } from "../client";
import {
  PLAN_READY_EMAIL_DELAY,
  PLAN_READY_EMAIL_EVENT,
  maybeSendPlanReadyEmail,
} from "@/services/growth/plan-ready-email";
import { maybeSendPlanReadyPush } from "@/services/growth/plan-ready-push";

export const planReadyEmailWaitFn = inngest.createFunction(
  { id: "plan-ready-email-wait", concurrency: 20 },
  { event: PLAN_READY_EMAIL_EVENT },
  async ({ event, step }) => {
    const { run_id } = event.data as { run_id: string };
    await step.sleep("let-the-founder-see-it-first", PLAN_READY_EMAIL_DELAY);
    const email = await step.run("send", () => maybeSendPlanReadyEmail(run_id));
    const push = await step.run("push", () => maybeSendPlanReadyPush(run_id));
    return { email, push };
  },
);
