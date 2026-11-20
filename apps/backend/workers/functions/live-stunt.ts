import { inngest } from "../client";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";
import { realDraftJobDeps, realSnapshotJobDeps, reviewLink, runDraftJob, runSnapshotJob } from "@/services/live-stunt/jobs";
import { emailReviewLink, slackReviewLink } from "@/services/live-stunt/notify";
import { hashToken } from "@/services/live-stunt/token";

export const liveStuntSnapshotFn = inngest.createFunction(
  { id: "live-stunt-snapshot", retries: 1, concurrency: { limit: 1 } },
  { cron: "23 * * * *" },
  async ({ step }) =>
    step.run("snapshot", () => {
      if (isWorkerCronStopped("live-stunt-snapshot")) return { cron_stopped: true as const };
      return runSnapshotJob(realSnapshotJobDeps);
    }),
);

export const liveStuntDraftFn = inngest.createFunction(
  { id: "live-stunt-draft", retries: 2, concurrency: { limit: 1 } },
  { cron: "TZ=America/New_York 30 23 * * *" },
  async ({ step }) => {
    if (isWorkerCronStopped("live-stunt-draft")) return { cron_stopped: true as const };
    const drafts = await step.run("draft", () => runDraftJob(realDraftJobDeps));
    const sent: string[] = [];
    for (const r of drafts) {
      if (r.result === "kept_published") continue;
      const link = reviewLink(r.slug, r.day, r.token);
      await step.run(`email-${r.slug}`, () =>
        emailReviewLink(r.tenant_id, { day: r.day, dayNumber: r.dayNumber, headline: r.headline, link, ttlHours: r.ttlHours }),
      );
      await step.run(`slack-${r.slug}`, () =>
        slackReviewLink(
          r.tenant_id,
          `*Mission log (${r.slug}), day ${r.dayNumber}* is ready: ${r.headline}\n<${link}|Review and publish>. Nothing is public until you press Publish.`,
          `live_stunt_review:${r.tenant_id}:${r.slug}:${r.day}:${hashToken(r.token)}`,
        ),
      );
      sent.push(r.slug);
    }
    return { drafts: drafts.length, sent };
  },
);
