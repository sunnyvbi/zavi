
import { inngest } from "../client";
import {
  failSweep,
  finalizeSweep,
  loadSweep,
  resolveSweep,
  runSweepSlots,
  slotGroupsOf,
  SWEEP_EVENT,
  SWEEP_GROUP_PARALLELISM as GROUP_PARALLELISM,
} from "@/services/tools/growth/geo/visibility/sweep";

export const geoPromptSweepFn = inngest.createFunction(
  {
    id: "geo-prompt-sweep",
    concurrency: [{ limit: 2 }],
    idempotency: "event.data.sweep_id",
    retries: 3,
    onFailure: async ({ event }) => {
      const sweepId = (event.data.event.data as { sweep_id?: string }).sweep_id;
      if (!sweepId) return;
      const scope = await resolveSweep(sweepId);
      if (scope) await failSweep(scope.tenant_id, sweepId, "worker_failed");
    },
  },
  { event: SWEEP_EVENT },
  async ({ event, step }) => {
    const sweepId = event.data.sweep_id;
    if (typeof sweepId !== "string" || sweepId.length === 0) {
      return { status: "skip", reason: "no_sweep_id" };
    }

    const scope = await step.run("resolve-sweep", () => resolveSweep(sweepId));
    if (!scope) return { status: "skip", reason: "sweep_not_found" };
    if (scope.status !== "running") return { status: "skip", reason: `sweep_${scope.status}` };

    const groups = await step.run("plan-slots", async () => {
      const sweep = await loadSweep(scope.tenant_id, sweepId);
      return sweep ? slotGroupsOf(sweep) : [];
    });

    let asked = 0;
    for (let i = 0; i < groups.length; i += GROUP_PARALLELISM) {
      const batch = groups.slice(i, i + GROUP_PARALLELISM);
      const results = await Promise.all(
        batch.map((g) =>
          step.run(`ask-${g.prompt_id}-${g.engine}`, () => runSweepSlots(scope.tenant_id, sweepId, g)),
        ),
      );
      asked += results.reduce((n, r) => n + r.asked, 0);
    }

    const final = await step.run("finalize", () => finalizeSweep(scope.tenant_id, sweepId));
    return { status: final.status, asked, collected: final.collected, failed: final.failed };
  },
);
