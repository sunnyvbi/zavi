
import { serviceClient } from "@/services/supabase";
import { PRIVATE_NOTE_TYPES_PGREST_IN } from "@/services/memory";

export type AgentLearning = {
  title: string;
  body_markdown: string;
};

export async function loadAgentLearnings(
  tenant_id: string,
  agent_slug: string,
  days: number,
): Promise<AgentLearning[]> {
  try {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await serviceClient()
      .from("memory_note")
      .select("title,body_markdown")
      .eq("tenant_id", tenant_id)
      .contains("tags", [`agent:${agent_slug}`, "type:learning"])
      .not("note_type", "in", PRIVATE_NOTE_TYPES_PGREST_IN)
      .gt("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) {
      console.warn(
        `[learnings] loadAgentLearnings failed for ${agent_slug}: ${error.message}`,
      );
      return [];
    }
    return (data ?? []).map((r) => ({
      title: String(r.title ?? ""),
      body_markdown: String(r.body_markdown ?? ""),
    }));
  } catch (e) {
    console.warn(
      `[learnings] loadAgentLearnings threw for ${agent_slug}: ${(e as Error).message}`,
    );
    return [];
  }
}
