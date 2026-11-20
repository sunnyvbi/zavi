
import { serviceClient } from "@/services/supabase";
import { PRIVATE_NOTE_TYPES_PGREST_IN } from "./index";

export type FeedbackNoteRow = {
  body_markdown: string;
  tags: string[];
  source: string;
  source_ref: string | null;
  created_at: string;
};

const RECENT_FEEDBACK_SLOTS = 25;
const EVERGREEN_CORRECTION_SLOTS = 15;

export function mergeFeedbackBuckets(
  evergreen: FeedbackNoteRow[],
  recent: FeedbackNoteRow[],
): FeedbackNoteRow[] {
  const merged: FeedbackNoteRow[] = [];
  const seen = new Set<string>();
  const push = (rows: FeedbackNoteRow[]) => {
    for (const row of rows) {
      const key = row.body_markdown;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
    }
  };
  push(evergreen);
  push(recent);
  return merged;
}

export async function loadRecentFeedbackForAgent(
  tenant_id: string,
  agent_slug: string,
  windowDays: number = 14,
): Promise<FeedbackNoteRow[]> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const sb = serviceClient();
  const agentTag = `agent:${agent_slug}`;

  const recentP = sb
    .from("memory_note")
    .select("body_markdown, tags, source, source_ref, created_at, note_type")
    .eq("tenant_id", tenant_id)
    .gte("created_at", since)
    .is("superseded_by", null)
    .is("archived_at", null)
    .contains("tags", [agentTag])
    .or(
      [
        "source.eq.operator_feedback",
        "source.eq.praxis_staff",
        "note_type.eq.agent_feedback",
      ].join(","),
    )
    .not("note_type", "in", PRIVATE_NOTE_TYPES_PGREST_IN)
    .order("created_at", { ascending: false })
    .limit(RECENT_FEEDBACK_SLOTS);

  const evergreenP = sb
    .from("memory_note")
    .select("body_markdown, tags, source, source_ref, created_at, note_type")
    .eq("tenant_id", tenant_id)
    .is("superseded_by", null)
    .is("archived_at", null)
    .contains("tags", [agentTag, "admin-correction"])
    .not("note_type", "in", PRIVATE_NOTE_TYPES_PGREST_IN)
    .order("created_at", { ascending: false })
    .limit(EVERGREEN_CORRECTION_SLOTS);

  const [recentRes, evergreenRes] = await Promise.all([recentP, evergreenP]);
  if (recentRes.error) {
    console.warn(
      `[memory] loadRecentFeedbackForAgent (recent) failed for ${agent_slug}: ${recentRes.error.message}`,
    );
  }
  if (evergreenRes.error) {
    console.warn(
      `[memory] loadRecentFeedbackForAgent (evergreen) failed for ${agent_slug}: ${evergreenRes.error.message}`,
    );
  }

  return mergeFeedbackBuckets(
    (evergreenRes.data ?? []) as FeedbackNoteRow[],
    (recentRes.data ?? []) as FeedbackNoteRow[],
  );
}
