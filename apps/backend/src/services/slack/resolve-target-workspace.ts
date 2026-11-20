
import { serviceClient } from "@/services/supabase";

export type ResolveTargetSlackWorkspaceResult = {
  team_id: string;
  label: string;
  reason: "source" | "agent_default" | "primary" | "oldest";
} | null;

export async function resolveTargetSlackWorkspace(
  tenant_id: string,
  agent_slug: string | undefined,
  source_team_id?: string,
): Promise<ResolveTargetSlackWorkspaceResult> {
  const sb = serviceClient();

  if (source_team_id) {
    const { data } = await sb
      .from("slack_workspaces")
      .select("team_id, label")
      .eq("tenant_id", tenant_id)
      .eq("team_id", source_team_id)
      .maybeSingle<{ team_id: string; label: string | null }>();
    if (data?.team_id) {
      return { team_id: data.team_id, label: data.label ?? "", reason: "source" };
    }
    return null;
  }

  if (agent_slug) {
    const { data } = await sb
      .from("slack_workspaces")
      .select("team_id, label")
      .eq("tenant_id", tenant_id)
      .eq("default_agent_slug", agent_slug)
      .order("is_primary", { ascending: false })
      .order("connected_at", { ascending: true })
      .limit(1)
      .maybeSingle<{ team_id: string; label: string | null }>();
    if (data?.team_id) {
      return { team_id: data.team_id, label: data.label ?? "", reason: "agent_default" };
    }
  }

  const { data: fallback } = await sb
    .from("slack_workspaces")
    .select("team_id, label, is_primary")
    .eq("tenant_id", tenant_id)
    .order("is_primary", { ascending: false })
    .order("connected_at", { ascending: true })
    .limit(1)
    .maybeSingle<{ team_id: string; label: string | null; is_primary: boolean | null }>();
  if (fallback?.team_id) {
    return {
      team_id: fallback.team_id,
      label: fallback.label ?? "",
      reason: fallback.is_primary ? "primary" : "oldest",
    };
  }

  return null;
}
