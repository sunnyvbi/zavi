
import { apiFetch } from "@/lib/api";

export type PlanRoute = "sendgrid" | "mailchimp" | "klaviyo" | "zavi_list";
export type PlanStatus = "planned" | "drafting" | "ready" | "scheduled" | "sending" | "sent" | "skipped" | "blocked" | "reconciling";

export type CardOutcomeStatus =
  | "held"
  | "sent"
  | "partially_sent"
  | "outcome_unknown"
  | "stopped"
  | "failed"
  | "not_sent"
  | "queued"
  | "approved"
  | "dispatching"
  | "sending"
  | "waiting_for_tomorrow"
  | "rejected";

export type CardOutcome = {
  status: CardOutcomeStatus | (string & {});
  sent: number | null;
  total: number | null;
  unknown: number | null;
  may_have_sent: boolean;
  reason: string | null;
  pause_hold: "paused" | "resumed" | null;
};

export type PlannedEmail = {
  id: string;
  route: PlanRoute;
  list_id: string;
  list_name: string;
  planned_at: string;
  planned_label: string;
  timezone: string;
  angle: string;
  why: string | null;
  source: "email_agent" | "growth_agent" | "founder";
  status: PlanStatus;
  status_reason: string | null;
  reason: string | null;
  content_version: number;
  schedule_gen: number;
  card: { rail: "channel_actions" | "decisions"; id: string } | null;
  vetoed: boolean;
  scheduled: { variant: number; count: number; by: string; at: string } | null;
  unattended: boolean;
  sent_at: string | null;
  hold?: { since: string; unresolved: boolean } | null;
  draft_requested?: boolean;
  blocked_fix?: "draft_now" | "change_topic" | null;
  card_status?: CardOutcome | null;
};

export type HeldSend = { rail: "channel_actions" | "decisions"; card_id: string; list_key: string; since: string; since_label: string; card_status?: CardOutcome | null };

export type WeeklyBlock = "autopilot_off" | "paused" | "no_list" | "sender_unavailable";

export type PlanView = {
  role: string | null;
  timezone: string;
  timezone_unread?: boolean;
  next_plan_at: string | null;
  next_plan_label: string | null;
  autopilot_on: boolean | null;
  weekly_eligible?: boolean | null;
  weekly_block?: WeeklyBlock | null;
  items: PlannedEmail[];
  holds: HeldSend[];
  released: string[];
};

export class PlanError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 0,
    public readonly readable: boolean = false,
  ) {
    super(message);
    this.name = "PlanError";
  }
}

export function isAmbiguousPlanError(e: unknown): boolean {
  return !(e instanceof PlanError && e.status >= 400 && e.status < 500 && e.readable);
}

export const requestTimeout = { ms: 30_000 };

export function withTimeout<T>(p: Promise<T>, ms: number = requestTimeout.ms): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function timedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(requestTimeout.ms) : undefined;
  return withTimeout(apiFetch(path, signal ? { ...init, signal } : init));
}

export const PLAN_LEAD_HOURS = 26;
const PLAN_SLACK_MS = 60_000;
export const PLAN_TOO_SOON = `An email is planned at least ${PLAN_LEAD_HOURS} hours ahead, so Zavi can draft it the day before.`;

const sameWall = (a: { date: string; time: string }, b: { date: string; time: string }) => a.date === b.date && a.time === b.time;

export function wallParts(iso: string, tz: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year").padStart(4, "0")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

export function wallInstant(wall: { date: string; time: string }, tz: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(wall.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(wall.time)) return null;
  const naive = Date.parse(`${wall.date}T${wall.time}:00Z`);
  if (Number.isNaN(naive) || new Date(naive).toISOString().slice(0, 16) !== `${wall.date}T${wall.time}`) return null;
  const offsetAt = (ms: number) => {
    const p = wallParts(new Date(ms).toISOString(), tz);
    return Date.parse(`${p.date}T${p.time}:00Z`) - Math.floor(ms / 60_000) * 60_000;
  };
  const candidates = new Set<number>();
  for (const probe of [naive - 14 * 3_600_000, naive, naive + 14 * 3_600_000]) candidates.add(naive - offsetAt(probe));
  const hits = [...candidates].filter((ms) => Number.isFinite(ms) && sameWall(wallParts(new Date(ms).toISOString(), tz), wall)).sort((a, b) => a - b);
  return hits.length ? new Date(hits[0]).toISOString() : null;
}

export function plannedTooSoon(wall: { date: string; time: string }, tz: string, now: number = Date.now()): boolean {
  const at = wallInstant(wall, tz);
  return at !== null && Date.parse(at) < now + PLAN_LEAD_HOURS * 3_600_000 + PLAN_SLACK_MS;
}

export const PLAN_MAX_DAYS = 14;
export const PLAN_TOO_FAR = `An email is planned at most ${PLAN_MAX_DAYS} days ahead.`;

export function planLatestDay(tz: string, now: number = Date.now()): string {
  return wallParts(new Date(now + PLAN_MAX_DAYS * 86_400_000).toISOString(), tz).date;
}

export function plannedTooFar(wall: { date: string; time: string }, tz: string | null, now: number = Date.now()): boolean {
  if (/^\+?\d{5,}-/.test(wall.date)) return true;
  const at = tz ? wallInstant(wall, tz) : null;
  return at !== null && Date.parse(at) > now + PLAN_MAX_DAYS * 86_400_000;
}

export const PLAN_FALLBACK = "That did not work. Try again.";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await timedFetch(path, init);
  } catch {
    throw new PlanError("network", "We could not reach Zavi. Check your connection and try again.");
  }
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (!res.ok) {
    const message = body?.error?.message;
    throw new PlanError(body?.error?.code ?? "error", message ?? PLAN_FALLBACK, res.status, !!message);
  }
  return body as T;
}

const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const getPlan = () =>
  request<PlanView & { ok: true }>("/api/workspace/email-plan").then((r) => ({
    ...r,
    items: Array.isArray(r.items) ? r.items : [],
    holds: Array.isArray(r.holds) ? r.holds : [],
    released: Array.isArray(r.released) ? r.released : [],
  }));

export const planEmail = (b: { route: PlanRoute; list_id: string; date: string; time: string; angle: string; request_id: string }) =>
  post<{ ok: true; id: string; label: string; timezone: string; list_name: string; replayed: boolean }>("/api/workspace/email-plan", b);

export const movePlanned = (id: string, b: { date: string; time: string; schedule_gen: number; timezone: string }) => post(`/api/workspace/email-plan/${id}/move`, b);
export const changePlannedAngle = (id: string, b: { angle: string; content_version: number }) => post(`/api/workspace/email-plan/${id}/angle`, b);
export const skipPlanned = (id: string) => post(`/api/workspace/email-plan/${id}/skip`);
export const draftPlannedNow = (id: string) => post(`/api/workspace/email-plan/${id}/draft-now`);
export const schedulePlanned = (id: string, b: { variant: number; schedule_gen: number; content_version: number; request_id: string }) =>
  post<{ ok: true; replayed?: boolean; status?: string }>(`/api/workspace/email-plan/${id}/schedule`, b);
export const withdrawPlanned = (id: string) => post(`/api/workspace/email-plan/${id}/withdraw`);
export const confirmNotSent = (rail: HeldSend["rail"], cardId: string, reason: string) =>
  post(`/api/workspace/email-plan/holds/${rail}/${cardId}/not-sent`, { reason });

export function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
