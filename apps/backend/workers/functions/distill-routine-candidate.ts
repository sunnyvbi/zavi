
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import {
  distillRoutineCandidates,
  type DistillRoutineDeps,
  type DistillRunRow,
  type CandidateInsert,
} from "@/services/routines/distill-routine-candidate";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";

function defaultDistillRoutineDeps(
  logger?: { warn: (m: string) => void; info?: (m: string) => void },
): DistillRoutineDeps {
  const sb = serviceClient();
  return {
    readSuccessfulRuns: async (sinceIso, limit) => {
      const { data, error } = await sb
        .from("agent_runs")
        .select("id, tenant_id, agent_slug, status, grounding_flags, tool_calls")
        .eq("status", "success")
        .gte("finished_at", sinceIso)
        .order("finished_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return ((data ?? []) as DistillRunRow[]);
    },
    signatureExists: async (tenant_id, agent_slug, signature) => {
      const { data, error } = await sb
        .from("tenant_routines")
        .select("id")
        .eq("tenant_id", tenant_id)
        .eq("agent_slug", agent_slug)
        .eq("provenance->>distill_signature", signature)
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return !!data;
    },
    insertCandidate: async (row: CandidateInsert) => {
      const { error } = await sb.from("tenant_routines").insert(row);
      if (error) throw new Error(error.message);
    },
    logger,
  };
}

export const distillRoutineCandidateFn = inngest.createFunction(
  { id: "distill-routine-candidate", concurrency: 1 },
  { cron: "23 4 * * *" },
  async ({ logger }) => {
    if (isWorkerCronStopped("distill-routine-candidate")) {
      logger.info("distill-routine-candidate: skipped — not on the scheduled-work allowlist");
      return { cron_stopped: true as const };
    }
    const res = await distillRoutineCandidates(defaultDistillRoutineDeps(logger));
    logger.info(
      `distill-routine-candidate: enabled=${res.enabled} runs_scanned=${res.runs_scanned} ` +
        `groups=${res.groups_considered} staged=${res.candidates_staged} ` +
        `skipped_existing=${res.skipped_existing} insert_failures=${res.insert_failures}`,
    );
    return res;
  },
);
