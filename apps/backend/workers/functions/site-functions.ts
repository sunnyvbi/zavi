
import { inngest } from "../client";
import { siteFunctionsConfig } from "@/services/site-functions/config";
import { createSiteFunctionsStore, type ClaimedRun } from "@/services/site-functions/store";
import { invokeRuns, schedulerTick, type RunRef } from "@/services/site-functions/scheduler";
import { runSweep } from "@/services/site-functions/sweeper";
import { defaultDeployDeps, reconcileDirtySites, reconcileSiteFunctions } from "@/services/site-functions/deploy";

export const SITE_FUNCTION_RUNS_EVENT = "site-functions/runs.invoke" as const;
const CHUNK = 10;

export const siteFunctionsSchedulerFn = inngest.createFunction(
  { id: "site-functions-scheduler", concurrency: { limit: 1, key: '"global"' }, retries: 1 },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    if (!siteFunctionsConfig().ok) return { skipped: "not_configured" };
    await step.run("reconcile-kv", () => reconcileDirtySites(defaultDeployDeps(), 50));
    const r = await step.run("tick", () => schedulerTick({ store: createSiteFunctionsStore() }));
    const runs = r.claimed as unknown as ClaimedRun[];
    if (runs.length) {
      const events: Array<{ name: typeof SITE_FUNCTION_RUNS_EVENT; data: { runs: RunRef[] } }> = [];
      for (let i = 0; i < runs.length; i += CHUNK) {
        events.push({ name: SITE_FUNCTION_RUNS_EVENT, data: { runs: runs.slice(i, i + CHUNK).map((x) => ({ id: x.id, attempt: x.attempt })) } });
      }
      await step.sendEvent("fan-out", events);
    }
    return { fired: r.fired, stale: r.stale, invalid: r.invalid, claimed: runs.length };
  },
);

export const siteFunctionsRunBatchFn = inngest.createFunction(
  { id: "site-functions-run-batch", concurrency: { limit: 20 }, retries: 0 },
  { event: SITE_FUNCTION_RUNS_EVENT },
  async ({ event }) => {
    const c = siteFunctionsConfig();
    if (!c.ok) return { skipped: "not_configured" };
    const runs: RunRef[] = Array.isArray(event.data?.runs) ? event.data.runs : [];
    return invokeRuns({ store: createSiteFunctionsStore(), dispatchUrl: c.config.dispatchUrl, dispatchSecret: c.config.dispatchSecret }, runs.slice(0, CHUNK));
  },
);

export const siteFunctionsSweeperFn = inngest.createFunction(
  { id: "site-functions-sweeper", concurrency: { limit: 1, key: '"global"' } },
  { cron: "23 * * * *" },
  async () => {
    if (!siteFunctionsConfig().ok) return { skipped: "not_configured" };
    const d = defaultDeployDeps();
    return runSweep({ store: d.store, wfp: d.wfp, kv: d.kv, reconcile: (site_id) => reconcileSiteFunctions(d, site_id) });
  },
);
