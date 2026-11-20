
import { serviceClient } from "@/services/supabase";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ArtifactRunBinding = {
  agent_slug: string | null;
  thread_id: string | null;
};

export async function artifactRunBinding(
  run_id: string,
): Promise<ArtifactRunBinding> {
  try {
    const { data, error } = await serviceClient()
      .from("agent_runs")
      .select("agent_slug, payload")
      .eq("id", run_id)
      .single();
    if (error || !data) return { agent_slug: null, thread_id: null };
    const row = data as { agent_slug?: unknown; payload?: unknown };
    const agent_slug =
      typeof row.agent_slug === "string" && row.agent_slug ? row.agent_slug : null;
    const rawThread =
      row.payload && typeof row.payload === "object"
        ? (row.payload as { thread_id?: unknown }).thread_id
        : undefined;
    const thread_id =
      typeof rawThread === "string" && UUID_RE.test(rawThread) ? rawThread : null;
    return { agent_slug, thread_id };
  } catch {
    return { agent_slug: null, thread_id: null };
  }
}
