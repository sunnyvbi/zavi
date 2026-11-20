
export type NoteOutcome = "accepted" | "rejected";

const ACCEPT_STATUSES = new Set(["acted"]);
const REJECT_STATUSES = new Set(["rejected"]);

export function aggregateRunOutcome(statuses: string[]): NoteOutcome | null {
  let sawAccept = false;
  let sawReject = false;
  for (const s of statuses) {
    if (ACCEPT_STATUSES.has(s)) sawAccept = true;
    else if (REJECT_STATUSES.has(s)) sawReject = true;
  }
  if (sawAccept) return "accepted";
  if (sawReject) return "rejected";
  return null;
}
