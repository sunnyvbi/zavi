
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { getNumberSetting } from "@/services/settings";
import { logEvent } from "@/services/logging/logEvent";
import { isCanonicalContainer } from "@/services/agents/boot-role";
import { drainTeamReportPings, type PingResult } from "@/services/team-notes/report-pings";

export const PING_SWEEP_BATCH = 10;
export const PING_SWEEP_DEADLINE_MS = 5_000;

async function sweepOverduePings(warn: (m: string) => void): Promise<PingResult | { error: "claim_failed" } | null> {
  if (!isCanonicalContainer()) return null;
  try {
    return await drainTeamReportPings({}, { batchSize: PING_SWEEP_BATCH, maxBatches: 1, deadlineMs: PING_SWEEP_DEADLINE_MS });
  } catch (e) {
    warn(`team-reports-gc: ping sweep failed: ${(e as Error).message}`);
    return { error: "claim_failed" };
  }
}

export const GC_BATCH = 2000;
export const GC_MAX_BATCHES = 50;
const GC_BUDGET_MS = 50_000;

type BatchResult = { deleted: number; backlog: number; oldest_expired_seconds: number };

export const teamReportsGcFn = inngest.createFunction(
  { id: "team-reports-gc", concurrency: { limit: 1 } },
  { cron: "15 * * * *" },
  async ({ logger }) => {
    if (process.env.PRAXIS_TEAM_REPORTS_GC_ENABLED === "0") return { removed: 0, batches: 0 };
    const offerDays = await getNumberSetting("team_note_offer_retention_days");
    const started = Date.now();
    let removed = 0;
    let batches = 0;
    let last: BatchResult = { deleted: 0, backlog: 0, oldest_expired_seconds: 0 };
    while (batches < GC_MAX_BATCHES && Date.now() - started < GC_BUDGET_MS) {
      const { data, error } = await serviceClient().rpc("purge_expired_team_notes_v2", {
        p_limit: GC_BATCH, p_offer_days: offerDays,
      });
      if (error) throw new Error(error.message);
      last = data as BatchResult;
      batches += 1;
      removed += last.deleted;
      if (last.deleted === 0) break;
    }
    void logEvent({
      level: last.backlog > 0 ? "warn" : "info",
      source: "team-reports-gc",
      code: "team_notes.gc",
      meta: { purge_backlog: last.backlog, purge_oldest_age_s: Math.round(last.oldest_expired_seconds) },
    });
    logger.info(`[team-reports-gc] removed ${removed} in ${batches} batch(es), backlog ${last.backlog}`);
    const pings = await sweepOverduePings((m) => logger.warn(m));
    return { removed, batches, pings };
  },
);
