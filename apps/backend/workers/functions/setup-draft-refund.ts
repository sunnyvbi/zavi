
import { inngest } from "../client";
import { refundSetupDraftRun } from "@/services/growth/setup-draft-refund";

export const setupDraftRefundOnCompleteFn = inngest.createFunction(
  { id: "setup-draft-refund-on-complete", retries: 3 },
  { event: "agent.run.completed" },
  async ({ event, step }) => {
    if (event.data.agent_slug !== "cgo") return { skipped: "not_cgo" };
    const run_id = event.data.run_id;
    return step.run("refund", () => refundSetupDraftRun(run_id));
  },
);

export const setupDraftRefundOnFailFn = inngest.createFunction(
  { id: "setup-draft-refund-on-fail", retries: 3 },
  { event: "agent.run.failed" },
  async ({ event, step }) => {
    if (event.data.agent_slug !== "cgo") return { skipped: "not_cgo" };
    const run_id = event.data.run_id;
    return step.run("refund", () => refundSetupDraftRun(run_id));
  },
);
