import { staffCrossTenantClient } from "@/services/tenant-client";

export type SuggestionChatRole = "staff" | "zavi";

export type SuggestionChatMessage = {
  id: string;
  session_id: string;
  role: SuggestionChatRole;
  body: string;
  meta: Record<string, unknown>;
  created_at: string;
};

export type SuggestionChatSession = {
  id: string;
  tenant_id: string;
  title: string;
  created_at: string;
  last_message_at: string;
};

const SESSION_COLUMNS = "id, tenant_id, title, created_at, last_message_at";
const MESSAGE_COLUMNS = "id, session_id, role, body, meta, created_at";
const STAFF_REASON = "admin growth-suggestions: staff curation chat for one tenant";

export function sessionTitle(firstStaffMessage: string): string {
  const clean = firstStaffMessage.replace(/\s+/g, " ").trim();
  if (!clean) return "Suggestion session";
  return clean.length > 240 ? `${clean.slice(0, 239)}…` : clean;
}

export async function listSuggestionSessions(tenantId: string): Promise<SuggestionChatSession[]> {
  const { data, error } = await staffCrossTenantClient(STAFF_REASON)
    .from("growth_suggestion_sessions")
    .select(SESSION_COLUMNS)
    .eq("tenant_id", tenantId)
    .order("last_message_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as SuggestionChatSession[];
}

export async function getSuggestionSession(
  sessionId: string,
  tenantId: string,
): Promise<{ session: SuggestionChatSession; messages: SuggestionChatMessage[] } | null> {
  const sb = staffCrossTenantClient(STAFF_REASON);
  const { data: session, error } = await sb
    .from("growth_suggestion_sessions")
    .select(SESSION_COLUMNS)
    .eq("id", sessionId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!session) return null;

  const { data: messages, error: messagesError } = await sb
    .from("growth_suggestion_messages")
    .select(MESSAGE_COLUMNS)
    .eq("session_id", sessionId)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true })
    .limit(500);
  if (messagesError) throw new Error(messagesError.message);

  return {
    session: session as unknown as SuggestionChatSession,
    messages: (messages ?? []) as unknown as SuggestionChatMessage[],
  };
}

export async function recordSuggestionTurn(input: {
  tenant_id: string;
  session_id?: string | null;
  staff: { user_id: string; email: string };
  staff_body: string;
  zavi_body: string;
  meta?: Record<string, unknown>;
}): Promise<{ session_id: string; messages: SuggestionChatMessage[] }> {
  const sb = staffCrossTenantClient(STAFF_REASON);
  let sessionId = input.session_id ?? null;

  if (sessionId) {
    const { data, error } = await sb
      .from("growth_suggestion_sessions")
      .select("id")
      .eq("id", sessionId)
      .eq("tenant_id", input.tenant_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) sessionId = null;
  }

  if (!sessionId) {
    const { data, error } = await sb
      .from("growth_suggestion_sessions")
      .insert({
        tenant_id: input.tenant_id,
        title: sessionTitle(input.staff_body),
        created_by_staff_id: input.staff.user_id,
        created_by_staff_email: input.staff.email,
      })
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    sessionId = (data as unknown as { id: string } | null)?.id ?? null;
    if (!sessionId) throw new Error("could not open a suggestion session");
  }

  const { data: messages, error: insertError } = await sb
    .from("growth_suggestion_messages")
    .insert([
      { session_id: sessionId, tenant_id: input.tenant_id, role: "staff", body: input.staff_body, meta: {} },
      { session_id: sessionId, tenant_id: input.tenant_id, role: "zavi", body: input.zavi_body, meta: input.meta ?? {} },
    ])
    .select(MESSAGE_COLUMNS);
  if (insertError) throw new Error(insertError.message);

  return { session_id: sessionId, messages: (messages ?? []) as unknown as SuggestionChatMessage[] };
}
