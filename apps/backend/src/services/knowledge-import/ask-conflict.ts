
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { PRIVATE_NOTE_TYPES_PGREST_IN } from "@/services/memory";
import { CGO, CONFLICT_KEEP, CONFLICT_USE_FILE, latestCgoThread } from "@/services/setup/chat-fastpaths";

type ConflictMeta = {
  key: string;
  file_value: string;
  existing_value: string;
  existing_source: string;
  status: "open" | "file" | "kept";
  asked_at: string | null;
};
type NoteRow = { id: string; created_at: string; metadata: Record<string, any> | null };

const LABEL: Record<string, string> = {
  company_name: "your company name",
  what_we_sell: "what you sell",
  who_we_serve: "who you serve",
  markets: "your markets",
  industry: "your industry",
  location: "your location",
  founded: "when you were founded",
};
const FROM: Record<string, string> = {
  human_confirmed: "you told me",
  onboarding_enrichment: "from your website",
  connector: "from a connector",
  typed_column: "from your settings",
  staff_reviewed: "from our research",
};

export function conflictQuestion(c: { key: string; file_value: string; existing_value: string; existing_source: string; filename: string }): string {
  const what = LABEL[c.key] ?? c.key;
  const from = FROM[c.existing_source] ?? "from earlier";
  return `${c.filename} says ${what} is "${c.file_value}". I have "${c.existing_value}" (${from}). Which is right?`;
}

export async function askNextConflict(input: { tenant_id: string; user_id: string }): Promise<void> {
  const db = tenantClient(asTenantId(input.tenant_id));
  const { data, error } = await db
    .from("memory_note")
    .select("id, created_at, metadata")
    .eq("source", "document_import")
    .not("note_type", "in", PRIVATE_NOTE_TYPES_PGREST_IN)
    .eq("metadata->conflict->>status", "open")
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) return;
  const open = ((data ?? []) as NoteRow[]).filter((n) => n.metadata?.conflict?.status === "open");
  if (open.some((n) => n.metadata?.conflict?.asked_at)) return;
  const next = open[0];
  if (!next) return;
  const c = next.metadata!.conflict as ConflictMeta;

  const { data: existing, error: exErr } = await db
    .from("agent_thread_messages")
    .select("id")
    .eq("sender_role", "assistant")
    .eq("meta->fact_conflict->>note_id", next.id)
    .limit(1);
  if (exErr) return;
  if ((existing ?? []).length > 0) {
    await markAsked(db, next);
    return;
  }

  let thread_id = await latestCgoThread(input.tenant_id, input.user_id);
  if (!thread_id) {
    const created = await db
      .from("agent_threads")
      .insert({ agent_slug: CGO, user_id: input.user_id, title: "Your growth strategy" })
      .select("id")
      .single();
    if (created.error || !created.data) return;
    thread_id = (created.data as { id: string }).id;
  }
  const posted = await db
    .from("agent_thread_messages")
    .insert({
      thread_id,
      sender_role: "assistant",
      body: conflictQuestion({ ...c, filename: String(next.metadata?.filename ?? "A file") }),
      agent_run_id: null,
      meta: { no_run: true, reason: "fact_conflict", fact_conflict: { note_id: next.id }, suggestions: [CONFLICT_USE_FILE, CONFLICT_KEEP] },
    })
    .select("id")
    .single();
  if (posted.error) return;
  await markAsked(db, next);
  await db.from("agent_threads").update({ last_message_at: new Date().toISOString() }).eq("id", thread_id);
}

async function markAsked(db: ReturnType<typeof tenantClient>, note: NoteRow): Promise<boolean> {
  const c = note.metadata!.conflict as ConflictMeta;
  const { data, error } = await db
    .from("memory_note")
    .update({ metadata: { ...note.metadata, conflict: { ...c, asked_at: new Date().toISOString() } } })
    .eq("id", note.id)
    .eq("source", "document_import")
    .select("id");
  return !error && (data ?? []).length === 1;
}
