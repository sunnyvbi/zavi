
export type ConnectorOfflineInfo = {
  machine: string | null;
  lastSeenAt: string | null;
  retryText: string | null;
};

export const ANSWER_WITHOUT_DATA_TEXT = "Answer without using my database.";

export const CONNECT_DATABASE_HREF = "/workspace?tab=brain#connector-operator_db";

const MAX_MACHINE = 80;

export function parseConnectorOffline(meta: unknown, retryText: string | null): ConnectorOfflineInfo | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const raw = (meta as Record<string, unknown>).connector_offline;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const machine = typeof r.machine === "string" && r.machine.trim() ? r.machine.trim().slice(0, MAX_MACHINE) : null;
  const lastSeenAt = typeof r.last_seen_at === "string" && Number.isFinite(Date.parse(r.last_seen_at)) ? r.last_seen_at : null;
  const retry = typeof retryText === "string" && retryText.trim() ? retryText : null;
  return { machine, lastSeenAt, retryText: retry };
}

export function parseDbNotConnected(meta: unknown): true | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  return (meta as Record<string, unknown>).db_not_connected === true ? true : undefined;
}

export function ageWords(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "less than a minute";
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? "1 minute" : `${m} minutes`;
  const h = Math.round(m / 60);
  if (h < 48) return h === 1 ? "1 hour" : `${h} hours`;
  return `${Math.round(h / 24)} days`;
}

export function lastSeenLine(info: Pick<ConnectorOfflineInfo, "machine" | "lastSeenAt">, now = Date.now()): string {
  const age = ageWords(info.lastSeenAt, now);
  if (age && info.machine) return `Last seen ${age} ago on ${info.machine}.`;
  if (age) return `Last seen ${age} ago.`;
  if (info.machine) return `Last seen on ${info.machine}.`;
  return "It has not checked in yet.";
}
