
export type OpenCard = {
  id: string;
  run_id: string;
  status: string;
  snoozed_until?: string | null;
  exec_status: string | null;
  approved_by: string | null;
  steps_done: unknown;
  edited_body: unknown;
  exec_class: string | null;
  customer: boolean;
};

export type NewCard = {
  title: string;
  repeat_of: string | null;
  customer: boolean;
  matched?: boolean;
};

export type SupersedeFlag = { action_id: string; evidence: string };

export function normalizeUuid<T extends string | null>(id: T): T {
  return (typeof id === "string" ? id.trim().toLowerCase() : id) as T;
}

export const REVIEWED_EXEC_CLASSES: ReadonlySet<string> = new Set([
  "chatgpt_ads.create_campaign_bundle",
  "linkedin_ads.create_campaign_bundle",
]);

export function isUntouchedPending(c: OpenCard, nowMs: number = Date.now()): boolean {
  return (
    (c.status === "pending" || (c.status === "snoozed" && snoozeEnded(c.snoozed_until, nowMs))) &&
    c.exec_status === null &&
    c.approved_by === null &&
    !(Array.isArray(c.steps_done) && c.steps_done.length > 0) &&
    (c.edited_body === null || c.edited_body === undefined) &&
    !REVIEWED_EXEC_CLASSES.has(c.exec_class ?? "")
  );
}

function snoozeEnded(until: string | null | undefined, nowMs: number): boolean {
  if (until === undefined) return false;
  if (until === null) return true;
  const end = Date.parse(until);
  return Number.isFinite(end) && end <= nowMs;
}

export function supersededOpenCards(
  runId: string,
  incoming: readonly NewCard[],
  open: readonly OpenCard[],
): SupersedeFlag[] {
  const flags: SupersedeFlag[] = [];
  const seen = new Set<string>();
  for (const old of open) {
    const id = normalizeUuid(old.id);
    if (old.run_id === runId || !isUntouchedPending(old) || seen.has(id)) continue;
    const by = incoming.find(
      (n) =>
        normalizeUuid(n.repeat_of) === id &&
        n.customer === old.customer &&
        (n.matched !== true || old.exec_class === null),
    );
    if (!by) continue;
    seen.add(id);
    flags.push({ action_id: id, evidence: `Replaced by a newer card: ${by.title}`.slice(0, 1000) });
  }
  return flags;
}
