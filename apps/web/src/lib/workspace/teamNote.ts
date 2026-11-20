
import { apiFetch } from "@/lib/api";

export type TeamNoteSurface = "strip" | "flag";

export type OfferedTeamNote = {
  messageId: string;
  offerId: string;
  note: string;
  offerStop: boolean;
  state: "drafted" | "shown";
  surface: TeamNoteSurface;
  anchorMessageId: string | null;
};

export function parseOfferedTeamNote(row: { id?: unknown; meta?: unknown } | null): OfferedTeamNote | null {
  if (!row || typeof row.id !== "string" || !row.id) return null;
  const m = row.meta as Record<string, unknown> | null | undefined;
  if (!m || typeof m !== "object") return null;
  const state = m.team_note_state;
  if (state !== "drafted" && state !== "shown") return null;
  const d = m.team_note_draft as Record<string, unknown> | undefined;
  if (!d || typeof d !== "object") return null;
  if (typeof d.offer_id !== "string" || !d.offer_id) return null;
  if (typeof d.note !== "string" || !d.note.trim()) return null;
  const anchor = typeof d.anchor_message_id === "string" && d.anchor_message_id ? d.anchor_message_id : null;
  return {
    messageId: row.id,
    offerId: d.offer_id,
    note: d.note,
    offerStop: d.offer_stop === true,
    state,
    surface: d.surface === "strip" && anchor ? "strip" : "flag",
    anchorMessageId: anchor,
  };
}

export function pickStripNote(
  notes: readonly OfferedTeamNote[],
  messages: ReadonlyArray<{ id: string; sender_role: string; created_at: string }>,
): OfferedTeamNote | null {
  const at = new Map<string, string>();
  let newestUser: string | null = null;
  for (const m of messages) {
    at.set(m.id, m.created_at);
    if (m.sender_role === "user" && (newestUser === null || m.created_at > newestUser)) newestUser = m.created_at;
  }
  let best: { note: OfferedTeamNote; anchorAt: string } | null = null;
  for (const n of notes) {
    if (n.surface !== "strip" || !n.anchorMessageId) continue;
    const anchorAt = at.get(n.anchorMessageId);
    if (!anchorAt) continue;
    if (newestUser !== null && newestUser > anchorAt) continue;
    if (!best || anchorAt > best.anchorAt) best = { note: n, anchorAt };
  }
  return best?.note ?? null;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export type ShownGate = { show: boolean; offerStop: boolean };

export async function markTeamNoteShown(messageId: string, via: TeamNoteSurface): Promise<ShownGate> {
  const res = await apiFetch(`/api/team-notes/${messageId}/shown`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: via === "flag" ? JSON.stringify({ via: "flag" }) : "{}",
  });
  if (!res.ok) throw new Error(String(res.status));
  const b = (await res.json()) as { show?: boolean; offer_stop?: boolean } | null;
  return { show: b?.show === true, offerStop: b?.offer_stop === true };
}

export async function sendTeamNote(messageId: string, body: { note: string; extra?: string }): Promise<void> {
  const res = await apiFetch(`/api/team-notes/${messageId}/send`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(String(res.status));
}

export async function dismissTeamNote(messageId: string, stop: boolean): Promise<void> {
  const res = await apiFetch(`/api/team-notes/${messageId}/dismiss`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ stop }),
  });
  if (!res.ok) throw new Error(String(res.status));
}

export function markTeamNoteOpened(messageId: string): void {
  void (async () => {
    try {
      await apiFetch(`/api/team-notes/${messageId}/opened`, { method: "POST" });
    } catch {
    }
  })();
}
