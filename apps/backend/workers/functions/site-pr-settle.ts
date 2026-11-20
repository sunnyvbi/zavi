
import { inngest } from "../client";
import { SITE_PR_STARTED_EVENT, settleSitePullRequest } from "@/services/channels/site-pr";

export const SITE_PR_SETTLE_TENANT_C8reverified = true;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const LOOK_GAPS: readonly string[] = ["1m", "5m", "15m", "1h", ...Array.from({ length: 64 }, () => "3h")];

export const sitePrSettleFn = inngest.createFunction(
  { id: "site-pr-settle", retries: 3 },
  { event: SITE_PR_STARTED_EVENT },
  async ({ event, step }) => {
    const run_key = String(event.data.run_key ?? "");
    const tenant_id = String(event.data.tenant_id ?? "");
    let r = await step.run("look-0", () => settleSitePullRequest(tenant_id, run_key, { final: false }));
    if (r.state !== "pending") return r;
    let runDeadlinePassed = false;
    if (r.waiting_on === "run") {
      const ended = UUID.test(r.run_id)
        ? await step.waitForEvent("wait-run-end", {
            event: "agent.run.terminal",
            timeout: "6h",
            if: `async.data.run_id == "${r.run_id}"`,
          })
        : null;
      runDeadlinePassed = ended == null;
    }
    for (let i = 0; i < LOOK_GAPS.length; i++) {
      r = await step.run(`look-${i + 1}`, () => settleSitePullRequest(tenant_id, run_key, { final: false, runDeadlinePassed }));
      if (r.state !== "pending") return r;
      await step.sleep(`gap-${i + 1}`, LOOK_GAPS[i]);
    }
    return step.run("look-final", () => settleSitePullRequest(tenant_id, run_key, { final: true, runDeadlinePassed: true }));
  },
);
