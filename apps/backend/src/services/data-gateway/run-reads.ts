export type RunReadNote =
  | { kind: "refused"; refused_by: "zavi" | "connector"; reason: string; tables: string[] }
  | { kind: "offline"; machine: string | null; last_seen_at: string | null }
  | { kind: "not_connected" };

export const MAX_RUNS = 500;
const MAX_NOTES_PER_RUN = 20;
const notes = new Map<string, RunReadNote[]>();

function push(run_id: string | null | undefined, n: RunReadNote): void {
  if (!run_id) return;
  const list = notes.get(run_id) ?? [];
  if (list.length < MAX_NOTES_PER_RUN) list.push(n);
  notes.delete(run_id);
  notes.set(run_id, list);
  while (notes.size > MAX_RUNS) {
    const oldest = notes.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    notes.delete(oldest);
  }
}

export function noteRefusal(run_id: string | null | undefined, refused_by: "zavi" | "connector", reason: string, tables: string[]): void {
  push(run_id, { kind: "refused", refused_by, reason, tables });
}
export function noteOffline(run_id: string | null | undefined, machine: string | null, last_seen_at: string | null = null): void {
  push(run_id, { kind: "offline", machine, last_seen_at });
}
export function noteNotConnected(run_id: string | null | undefined): void {
  push(run_id, { kind: "not_connected" });
}
export function peekRunNotes(run_id: string): RunReadNote[] {
  return notes.get(run_id) ?? [];
}
export function takeRunNotes(run_id: string): RunReadNote[] {
  const n = notes.get(run_id) ?? [];
  notes.delete(run_id);
  return n;
}
export type ChatReadMeta = {
  connector_offline?: { machine: string | null; last_seen_at: string | null };
  db_not_connected?: true;
};

export function chatReadMeta(run_id: string | null | undefined): ChatReadMeta {
  if (!run_id) return {};
  const list = takeRunNotes(run_id);
  const out: ChatReadMeta = {};
  const offline = [...list].reverse().find((n): n is Extract<RunReadNote, { kind: "offline" }> => n.kind === "offline");
  if (offline) out.connector_offline = { machine: offline.machine, last_seen_at: offline.last_seen_at };
  if (list.some((n) => n.kind === "not_connected")) out.db_not_connected = true;
  return out;
}

export function _resetRunNotes(): void {
  notes.clear();
}
