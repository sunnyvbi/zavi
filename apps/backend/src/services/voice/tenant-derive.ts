
import type { SupabaseClient } from "@supabase/supabase-js";

export interface VoiceSessionAuthoritative {
  sessionId: string;
  tenantId: string;
  userId: string;
  agentSlug: string;
  threadId: string;
  status: "active" | "ended" | "reaped";
}

export async function deriveVoiceSessionAuthoritative(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<VoiceSessionAuthoritative | null> {
  const { data, error } = await supabase
    .from("voice_sessions")
    .select("id, tenant_id, user_id, agent_slug, thread_id, status")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    sessionId: data.id as string,
    tenantId: data.tenant_id as string,
    userId: data.user_id as string,
    agentSlug: data.agent_slug as string,
    threadId: data.thread_id as string,
    status: data.status as VoiceSessionAuthoritative["status"],
  };
}
