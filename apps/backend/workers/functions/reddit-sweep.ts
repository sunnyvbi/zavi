import { inngest } from "../client";
import {
  downstreamSteps,
  failRedditSweep,
  finalizeSweep,
  listSweepableTenants,
  loadSweepJobs,
  openRedditSweep,
  REDDIT_SWEEP_EVENT,
  resolveRedditSweep,
  runDownstreamStep,
  runSweepJob,
} from "@/services/channels/reddit/sweep";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";

export const redditSweepFn = inngest.createFunction(
  {
    id: "reddit-sweep",
    concurrency: [{ limit: 2 }],
    idempotency: "event.data.sweep_id",
    retries: 2,
    onFailure: async ({ event }) => {
      const sweepId = (event.data.event.data as { sweep_id?: string }).sweep_id;
      if (!sweepId) return;
      const scope = await resolveRedditSweep(sweepId);
      if (scope) await failRedditSweep(scope.tenant_id, sweepId, "worker_failed");
    },
  },
  { event: REDDIT_SWEEP_EVENT },
  async ({ event, step }) => {
    const sweepId = event.data.sweep_id;
    if (typeof sweepId !== "string" || sweepId.length === 0) {
      return { status: "skip", reason: "no_sweep_id" };
    }

    const scope = await step.run("resolve-sweep", () => resolveRedditSweep(sweepId));
    if (!scope) return { status: "skip", reason: "sweep_not_found" };
    if (scope.status !== "running") return { status: "skip", reason: `sweep_${scope.status}` };
    const tenantId = scope.tenant_id;

    const jobs = await step.run("load-jobs", () => loadSweepJobs(tenantId, sweepId));

    let jobsDone = 0;
    let jobsFailed = 0;
    let counterFailures = 0;
    for (const job of jobs) {
      const r = await step.run(`job-${job.key}`, () => runSweepJob(tenantId, sweepId, job));
      if (r.error === "sweep_not_running") break;
      if (r.ok) jobsDone += 1;
      else jobsFailed += 1;
      if (r.counter_error) counterFailures += 1;
    }
    const ran = { jobs_done: jobsDone, jobs_failed: jobsFailed };

    let stepFailures = counterFailures;
    let spendUsd = 0;
    for (const ds of downstreamSteps()) {
      const r = await step.run(ds.id, () => runDownstreamStep(ds, tenantId, sweepId, {}, ran));
      spendUsd += r.cost_usd ?? 0;
      if (!r.ok) stepFailures += 1;
      if (r.skipped === "sweep_not_running") break;
    }

    const final = await step.run("finalize", () =>
      finalizeSweep(tenantId, sweepId, { step_failures: stepFailures, spend_usd: spendUsd, ran }),
    );
    return {
      status: final.status,
      jobs: jobs.length,
      jobs_failed: jobsFailed,
      posts: final.posts_scanned ?? null,
      step_failures: stepFailures,
    };
  },
);

export const redditSweepCronFn = inngest.createFunction(
  { id: "reddit-sweep-cron", concurrency: 1 },
  { cron: "0 13 * * *" },
  async ({ logger, step }) => {
    if (isWorkerCronStopped("reddit-sweep")) {
      logger.info("reddit-sweep-cron: skipped — not on the scheduled-work allowlist");
      return { cron_stopped: true as const };
    }
    const tenants = await step.run("list-tenants", () => listSweepableTenants());

    const outcomes: Record<string, number> = {};
    for (const tenantId of tenants) {
      const r = await step.run(`open-${tenantId}`, () => openRedditSweep(tenantId, { trigger: "cron" }));
      const key = r.ok ? "opened" : r.reason;
      outcomes[key] = (outcomes[key] ?? 0) + 1;
    }
    logger.info(`reddit-sweep-cron: tenants=${tenants.length} outcomes=${JSON.stringify(outcomes)}`);
    return { tenants: tenants.length, outcomes };
  },
);
