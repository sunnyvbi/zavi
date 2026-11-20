
import type { SupabaseClient } from "@supabase/supabase-js";
import { isChannelOnlyAgent } from "@/services/agents/registry";

export type ReviserResolution =
  | { ok: true; slug: string }
  | { ok: false; status: number; code: string; message: string };

export async function resolveDecisionReviser(
  client: SupabaseClient,
  decision: { id: string; tenant_id: string; agent_run_id: string | null },
): Promise<ReviserResolution> {
  if (!decision.agent_run_id) {
    return {
      ok: false,
      status: 409,
      code: "reviser_unknown",
      message: "this proposal has no recorded agent run, so there is no agent to ask",
    };
  }

  const { data, error } = await client
    .from("agent_runs")
    .select("agent_slug")
    .eq("id", decision.agent_run_id)
    .eq("tenant_id", decision.tenant_id)
    .maybeSingle<{ agent_slug: string | null }>();

  if (error) {
    return {
      ok: false,
      status: 500,
      code: "reviser_lookup_failed",
      message: error.message,
    };
  }
  const slug = data?.agent_slug;
  if (!slug) {
    return {
      ok: false,
      status: 409,
      code: "reviser_unknown",
      message: "this proposal has no recorded agent run, so there is no agent to ask",
    };
  }

  if (isChannelOnlyAgent(slug)) {
    return {
      ok: false,
      status: 409,
      code: "reviser_channel_only",
      message: `${slug} runs only as a channel and cannot take a revision request directly`,
    };
  }

  return { ok: true, slug };
}
