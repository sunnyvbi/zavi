
type Change = { label: string; decision_id: string; approved: boolean; code: string | null };
type Row = { change: Change; outcome: { state: string } | null };

export function landedChanges<C extends Change>(e: unknown): C[] {
  const changes = (e as { body?: { changes?: unknown } } | null)?.body?.changes;
  if (!Array.isArray(changes)) return [];
  return changes.filter(
    (c): c is C => !!c && typeof c === "object" && typeof (c as Change).decision_id === "string" && (c as Change).decision_id !== "" && typeof (c as Change).label === "string",
  );
}

export type NewCampaignState = "open" | "done" | "sending" | "waiting";

export function newCampaignState(rows: ReadonlyArray<Row>): NewCampaignState {
  const sent = rows.filter((r) => r.change.decision_id !== "" && r.outcome?.state !== "refused");
  if (sent.length === 0) return "open";
  if (sent.some((r) => r.outcome?.state === "done")) return "done";
  if (sent.some((r) => !r.change.approved || r.outcome?.state === "waiting")) return "waiting";
  return "sending";
}
