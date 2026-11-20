
import type { SupabaseClient } from "@supabase/supabase-js";

export type RunLane = "interactive" | "background";

export const INTERACTIVE_TRIGGERS: readonly string[] = ["chat", "slack", "mcp"];

export function computeRunLane(
  trigger: string | null | undefined,
  batch_id: string | null | undefined,
): RunLane {
  const humanWaiting =
    typeof trigger === "string" && INTERACTIVE_TRIGGERS.includes(trigger) && batch_id == null;
  return humanWaiting ? "interactive" : "background";
}

type RunRequestedEvent = {
  id: string;
  name: "agent.run.requested";
  data: {
    run_id: string;
    tenant_id?: string;
    agent_slug?: string;
    lane: RunLane;
  };
};

export type RunRequestedEventInput = {
  run_id: string;
  tenant_id?: string;
  agent_slug?: string;
  trigger: string | null | undefined;
  batch_id: string | null | undefined;
};

export function buildRunRequestedEvent(
  input: RunRequestedEventInput,
): RunRequestedEvent {
  return {
    id: input.run_id,
    name: "agent.run.requested",
    data: {
      run_id: input.run_id,
      ...(input.tenant_id ? { tenant_id: input.tenant_id } : {}),
      ...(input.agent_slug ? { agent_slug: input.agent_slug } : {}),
      lane: computeRunLane(input.trigger, input.batch_id),
    },
  };
}

export async function buildRunRequestedEventForRunId(
  sb: SupabaseClient,
  run_id: string,
  extra?: { tenant_id?: string; agent_slug?: string },
): Promise<RunRequestedEvent> {
  const { data: row } = await sb
    .from("agent_runs")
    .select("trigger, batch_id, tenant_id, agent_slug")
    .eq("id", run_id)
    .maybeSingle();
  return buildRunRequestedEvent({
    run_id,
    tenant_id: extra?.tenant_id ?? (row?.tenant_id as string | undefined),
    agent_slug: extra?.agent_slug ?? (row?.agent_slug as string | undefined),
    trigger: (row?.trigger as string | null | undefined) ?? null,
    batch_id: (row?.batch_id as string | null | undefined) ?? null,
  });
}
