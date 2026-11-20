import { listSentEmails, type SentEmailRow } from "./view";

export type EmailChannelMetric = {
  key: "recipients" | "opens" | "clicks";
  value: number;
  unit: string | null;
  window_kind: string;
  day: string;
  grounded: true;
  prev_value: null;
  prev_day: null;
};

const WINDOW_DAYS = 60;

export function emailChannelMetrics(rows: SentEmailRow[], nowMs: number = Date.now()): EmailChannelMetric[] {
  const since = nowMs - WINDOW_DAYS * 86_400_000;
  const done = rows.filter((r) => r.finished_at !== null && Date.parse(r.finished_at) >= since && typeof r.people.sent === "number");
  if (done.length === 0) return [];
  const day = done.map((r) => r.finished_at as string).sort().at(-1)!.slice(0, 10);
  const metric = (key: EmailChannelMetric["key"], value: number): EmailChannelMetric => ({
    key, value, unit: null, window_kind: "point", day, grounded: true, prev_value: null, prev_day: null,
  });
  const out = [metric("recipients", done.reduce((n, r) => n + (r.people.sent ?? 0), 0))];
  for (const key of ["opens", "clicks"] as const) {
    const known = done.map((r) => r[key].value).filter((v): v is number => typeof v === "number");
    if (known.length > 0) out.push(metric(key, known.reduce((n, v) => n + v, 0)));
  }
  return out;
}

export async function readEmailChannelMetrics(tenantId: string, nowMs: number = Date.now(), list: typeof listSentEmails = listSentEmails): Promise<EmailChannelMetric[]> {
  return emailChannelMetrics(await list(tenantId, 200), nowMs);
}
