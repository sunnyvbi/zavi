
import { inngest } from "../client";
import { isFleetHalted } from "@/services/agents/fleet-halt";
import { logEvent } from "@/services/logging/logEvent";
import {
  realAutoNoDeps,
  sendAutomaticNos,
  type AutoNoDeps,
  type AutoNoResult,
} from "@/services/creators/brief-applications";
import {
  listBriefsPastAnswerBy,
  loadTenantBrief,
  resolveBriefTenant,
} from "@/services/creators/briefs-db";

const SWEEP_LIMIT = 100;

export async function armBriefAnswerBy(args: {
  brief_id: string;
  tenant_id: string;
  answer_by: string;
}): Promise<void> {
  await inngest.send({
    name: "creator/brief.answer_by.armed",
    data: {
      brief_id: args.brief_id,
      tenant_id: args.tenant_id,
      answer_by: args.answer_by,
    },
  });
}

export type AnswerByOutcome =
  | { acted: false; reason: "brief_gone" | "not_due" | "already_closed" | "no_answer_by" }
  | { acted: true; result: AutoNoResult };

export type AnswerByIo = {
  resolveTenant: typeof resolveBriefTenant;
  loadBrief: typeof loadTenantBrief;
  autoNo: typeof sendAutomaticNos;
  autoNoDeps: AutoNoDeps;
  now: () => Date;
};

export const realAnswerByIo: AnswerByIo = {
  resolveTenant: resolveBriefTenant,
  loadBrief: loadTenantBrief,
  autoNo: sendAutomaticNos,
  autoNoDeps: realAutoNoDeps,
  now: () => new Date(),
};

export async function fireBriefAnswerBy(
  brief_id: string,
  io: AnswerByIo = realAnswerByIo,
): Promise<AnswerByOutcome> {
  const ref = await io.resolveTenant(brief_id);
  if (!ref) return { acted: false, reason: "brief_gone" };

  const brief = await io.loadBrief(ref.tenant_id, brief_id);
  if (!brief) return { acted: false, reason: "brief_gone" };
  if (brief.closed_at) return { acted: false, reason: "already_closed" };
  if (!brief.answer_by) return { acted: false, reason: "no_answer_by" };
  if (new Date(brief.answer_by).getTime() > io.now().getTime()) {
    return { acted: false, reason: "not_due" };
  }

  const result = await io.autoNo(
    {
      tenant_id: ref.tenant_id,
      brief_id,
      cause: "answer_by",
      hired_application_id: null,
      now: io.now(),
    },
    io.autoNoDeps,
  );
  return { acted: true, result };
}

export type AnswerBySweepOutcome = {
  found: number;
  acted: number;
  skipped: number;
  declined: number;
};

export async function runBriefAnswerBySweep(
  logger: { info: (m: string) => void; error?: (m: string) => void },
  io: AnswerByIo = realAnswerByIo,
  list: typeof listBriefsPastAnswerBy = listBriefsPastAnswerBy,
): Promise<AnswerBySweepOutcome> {
  const out: AnswerBySweepOutcome = { found: 0, acted: 0, skipped: 0, declined: 0 };

  if (await isFleetHalted()) {
    logger.info("creator-brief-answer-by-sweep: fleet halt active, skipped");
    return out;
  }

  const due = await list(SWEEP_LIMIT, io.now());
  out.found = due.length;
  for (const row of due) {
    try {
      const res = await fireBriefAnswerBy(row.id, io);
      if (res.acted) {
        out.acted += 1;
        out.declined += res.result.declined;
      } else {
        out.skipped += 1;
      }
    } catch (e) {
      out.skipped += 1;
      logger.error?.(`creator-brief-answer-by-sweep: ${row.id} failed: ${(e as Error).message}`);
      await logEvent({
        level: "warn",
        source: "creator.briefs",
        code: "answer_by_sweep_failed",
        tenant_id: row.tenant_id,
        meta: { brief_id: row.id },
      });
    }
  }

  if (out.found > 0) {
    logger.info(
      `creator-brief-answer-by-sweep: found=${out.found} acted=${out.acted} skipped=${out.skipped} declined=${out.declined}`,
    );
  }
  return out;
}

export const creatorBriefAnswerByWaitFn = inngest.createFunction(
  { id: "creator-brief-answer-by-wait", concurrency: 20 },
  { event: "creator/brief.answer_by.armed" },
  async ({ event, step, logger }) => {
    const { brief_id, answer_by } = event.data as { brief_id: string; answer_by: string };
    await step.sleepUntil("until-answer-by", new Date(answer_by));
    return step.run("send-notes", async () => {
      if (await isFleetHalted()) {
        logger.info(`creator-brief-answer-by: fleet halt, ${brief_id} deferred to sweep`);
        return { acted: false, reason: "fleet_halt" };
      }
      const res = await fireBriefAnswerBy(brief_id);
      logger.info(
        res.acted
          ? `creator-brief-answer-by: ${brief_id} closed, ${res.result.declined} notes sent`
          : `creator-brief-answer-by: ${brief_id} no-op (${res.reason})`,
      );
      return res.acted ? { acted: true, declined: res.result.declined } : { acted: false, reason: res.reason };
    });
  },
);

export const creatorBriefAnswerBySweepFn = inngest.createFunction(
  { id: "creator-brief-answer-by-sweep", concurrency: 1 },
  { cron: "55 * * * *" },
  async ({ logger }) => runBriefAnswerBySweep(logger),
);
