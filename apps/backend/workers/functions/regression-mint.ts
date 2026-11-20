
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { alert } from "@/services/logging/alert";
import {
  computeRegressionSignature,
  type RawStep,
  type SignatureInput,
} from "@/services/agents/regression-signature";
import {
  decideMintable,
  type MintCandidateRow,
} from "@/services/agents/regression-mint-predicate";

type EventRow = { stage: string; meta: Record<string, unknown> | null };

export function deriveStepsAndFailingTool(events: EventRow[]): {
  steps: RawStep[];
  failing_tool_name: string | null;
} {
  const steps: RawStep[] = [];
  let failing_tool_name: string | null = null;
  for (const e of events) {
    const m = e.meta ?? {};
    const tool_name = typeof m.tool_name === "string" ? m.tool_name : null;
    const code = typeof m.code === "string" ? m.code : null;
    if (tool_name || code) steps.push({ tool_name, code });
    if (code && tool_name) failing_tool_name = tool_name;
  }
  if (!failing_tool_name) {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].tool_name) {
        failing_tool_name = steps[i].tool_name ?? null;
        break;
      }
    }
  }
  return { steps, failing_tool_name };
}

type MintResult =
  | { skip: string; run_id: string }
  | {
      minted: true;
      run_id: string;
      sig8: string;
      recurrence: boolean;
      code_class: string;
    };

export async function mintRegressionFromRun(run_id: string): Promise<MintResult> {
  if (typeof run_id !== "string" || run_id.length === 0) {
    return { skip: "bad_run_id", run_id: String(run_id) };
  }
  const sb = serviceClient();

  const { data: run, error: runErr } = await sb
    .from("agent_runs")
    .select("id, tenant_id, agent_slug, status, error, last_progress_at, model_used")
    .eq("id", run_id)
    .maybeSingle();
  if (runErr) return { skip: `run_read_failed`, run_id };
  if (!run) return { skip: "run_not_found", run_id };

  const candidate: MintCandidateRow = {
    agent_slug: run.agent_slug,
    status: run.status,
    error: run.error,
    last_progress_at: run.last_progress_at,
  };
  const decision = decideMintable(candidate);
  if (!decision.mintable) return { skip: decision.reason, run_id };

  const { data: events, error: eventsErr } = await sb
    .from("agent_run_events")
    .select("stage, meta")
    .eq("agent_run_id", run_id)
    .order("id", { ascending: true })
    .limit(200);
  if (eventsErr) return { skip: "events_read_failed", run_id };

  const { steps, failing_tool_name } = deriveStepsAndFailingTool(
    (events ?? []) as EventRow[],
  );

  const sigInput: SignatureInput = {
    agent_slug: run.agent_slug,
    engine: run.model_used ?? null,
    failing_tool_name,
    status: run.status,
    raw_code: run.error,
    steps,
  };
  const sig = computeRegressionSignature(sigInput);

  const { data: rpc, error: rpcErr } = await sb.rpc(
    "register_regression_signature",
    {
      p_run_id: run_id,
      p_signature: sig.signature,
      p_sig_version: sig.sig_version,
      p_code_class: sig.code_class,
      p_agent_slug: run.agent_slug,
      p_engine: run.model_used ?? null,
    },
  );
  if (rpcErr) return { skip: `rpc_failed`, run_id };

  const row = Array.isArray(rpc) ? rpc[0] : rpc;
  const was_recurrence = !!row?.was_recurrence;
  const sig8 = sig.signature.slice(0, 8);

  if (was_recurrence) {
    try {
      await alert({
        source: "regression-mint",
        code: "armed_signature_recurred",
        msg: `armed regression signature recurred: sig=${sig8} agent=${run.agent_slug} tenant=${run.tenant_id} class=${sig.code_class}`,
      });
    } catch {
    }
  }

  return {
    minted: true,
    run_id,
    sig8,
    recurrence: was_recurrence,
    code_class: sig.code_class,
  };
}

export const regressionMintFn = inngest.createFunction(
  { id: "regression-mint", retries: 1, concurrency: 4 },
  { event: "agent.run.terminal" },
  async ({ event, step, logger }) => {
    const run_id = event.data.run_id as string;
    const res = await step.run("mint", () => mintRegressionFromRun(run_id));
    logger.info(`regression-mint ${run_id}: ${JSON.stringify(res)}`);
    return res;
  },
);
