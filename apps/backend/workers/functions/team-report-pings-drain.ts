import { inngest } from "../client";
import { isCanonicalContainer } from "@/services/agents/boot-role";
import { TEAM_REPORT_PING_DUE_EVENT, drainTeamReportPings, pingDueAt } from "@/services/team-notes/report-pings";

export const MAX_ROUNDS = 8;

export const teamReportPingsDrainFn = inngest.createFunction(
  {
    id: "team-report-pings-drain",
    retries: 1,
    idempotency: "event.data.ping_id",
    concurrency: { limit: 1, key: '"team-report-pings"' },
  },
  { event: TEAM_REPORT_PING_DUE_EVENT },
  async ({ event, step, logger }) => {
    if (!isCanonicalContainer()) {
      logger.info("team-report-pings-drain: skipped (not the prod container)");
      return { skipped: "not_canonical" as const };
    }
    const pingId = Number((event.data as { ping_id?: unknown } | undefined)?.ping_id);
    if (!Number.isSafeInteger(pingId) || pingId <= 0) return { skipped: "bad_event" as const };

    let dueAt = await step.run("due-at", () => pingDueAt(pingId));
    let rounds = 0;
    let sent = 0;
    while (dueAt && rounds < MAX_ROUNDS) {
      await step.sleepUntil(`wait-${rounds}`, dueAt);
      const res = await step.run(`drain-${rounds}`, () => drainTeamReportPings());
      sent += res.sent;
      if (res.retried > 0 || res.fenced > 0 || res.gave_up > 0) logger.warn(`team-report-pings-drain: ${JSON.stringify(res)}`);
      rounds += 1;
      dueAt = await step.run(`due-at-${rounds}`, () => pingDueAt(pingId));
    }
    return { ping_id: pingId, rounds, sent, settled: dueAt === null };
  },
);
