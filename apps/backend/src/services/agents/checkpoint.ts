
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";

export type CheckpointInput = {
  run_id: string;
  tenant_id: string;
  iter: number;
  messages: MessageParam[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  last_stop_reason?: string | null;
  summary?: string | null;
};

export type CheckpointDeps = {
  upsertLatest: (input: CheckpointInput) => Promise<void>;
  pruneOlder: (run_id: string, keepIter: number) => Promise<void>;
};

const SUMMARY_MAX = 500;
const OBJECTIVE_MAX = 300;

export function buildCheckpointSummary(
  objective: string,
  iter: number,
  nextToolNames: readonly string[],
): string {
  const obj = objective.trim().replace(/\s+/g, " ").slice(0, OBJECTIVE_MAX);
  const tools =
    nextToolNames.length > 0 ? ` | next: ${[...nextToolNames].join(", ")}` : "";
  return `iter ${iter} | ${obj}${tools}`.slice(0, SUMMARY_MAX);
}

export const realCheckpointDeps: CheckpointDeps = {
  async upsertLatest(input) {
    const { error } = await serviceClient()
      .from("agent_run_checkpoints")
      .upsert(
        {
          run_id: input.run_id,
          tenant_id: input.tenant_id,
          iter: input.iter,
          messages_jsonb: input.messages as unknown as Record<string, unknown>[],
          usage: (input.usage ?? null) as unknown as Record<string, unknown> | null,
          last_stop_reason: input.last_stop_reason ?? null,
          summary: input.summary ?? null,
        },
        { onConflict: "run_id,iter" },
      );
    if (error) throw new Error(error.message);
  },
  async pruneOlder(run_id, keepIter) {
    const { error } = await serviceClient()
      .from("agent_run_checkpoints")
      .delete()
      .eq("run_id", run_id)
      .lt("iter", keepIter);
    if (error) throw new Error(error.message);
  },
};

export async function recordCheckpoint(
  input: CheckpointInput,
  deps: CheckpointDeps = realCheckpointDeps,
): Promise<void> {
  try {
    await deps.upsertLatest(input);
  } catch (e) {
    await failOpen("upsert", input.run_id, e);
    return;
  }
  try {
    await deps.pruneOlder(input.run_id, input.iter);
  } catch (e) {
    await failOpen("prune", input.run_id, e);
  }
}

async function failOpen(stage: string, run_id: string, e: unknown): Promise<void> {
  await logEvent({
    level: "warn",
    source: "agents.checkpoint",
    code: `checkpoint_${stage}_failopen`,
    run_id,
    error: e instanceof Error ? e : new Error(String(e)),
  }).catch(() => {});
}

export type ResumeState = {
  messages: MessageParam[];
  startIter: number;
  replayContent: MessageParam["content"];
  replayStopReason: string | null;
};

export type LoadResumeDeps = {
  fetchLatest: (run_id: string) => Promise<{
    iter: number;
    messages_jsonb: unknown;
    last_stop_reason: string | null;
  } | null>;
};

export const realLoadResumeDeps: LoadResumeDeps = {
  async fetchLatest(run_id) {
    const { data, error } = await serviceClient()
      .from("agent_run_checkpoints")
      .select("iter, messages_jsonb, last_stop_reason")
      .eq("run_id", run_id)
      .order("iter", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (
      (data as { iter: number; messages_jsonb: unknown; last_stop_reason: string | null } | null) ?? null
    );
  },
};

export async function loadResumeState(
  run_id: string,
  deps: LoadResumeDeps = realLoadResumeDeps,
): Promise<ResumeState | null> {
  let row: Awaited<ReturnType<LoadResumeDeps["fetchLatest"]>>;
  try {
    row = await deps.fetchLatest(run_id);
  } catch (e) {
    await failOpen("resume_load", run_id, e);
    return null;
  }
  if (!row || !Array.isArray(row.messages_jsonb) || row.messages_jsonb.length === 0) {
    return null;
  }
  const messages = row.messages_jsonb as MessageParam[];
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return null;
  return {
    messages,
    startIter: row.iter,
    replayContent: last.content,
    replayStopReason: row.last_stop_reason ?? null,
  };
}
