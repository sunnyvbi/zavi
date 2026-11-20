
import { dayKey } from "@/lib/workspace/dayLabels";

export type SocialPostRow = {
  id: string;
  channel: string;
  status: string;
  scheduled_at: string | null;
  created_at: string;
  external_url: string | null;
  last_error: string | null;
  approved_payload_snapshot: Record<string, unknown> | null;
};

export type CalendarPost = {
  id: string;
  channel: string;
  status: string;
  at: string;
  scheduledAt: string | null;
  snippet: string;
  hasImage: boolean;
  hasVideo: boolean;
  externalUrl: string | null;
  lastError: string | null;
  payload: Record<string, unknown>;
};

export function toCalendarPost(r: SocialPostRow): CalendarPost {
  const payload = ((r.approved_payload_snapshot?.payload ?? {}) as Record<string, unknown>) ?? {};
  const title = typeof payload.title === "string" ? payload.title : "";
  const text = typeof payload.text === "string" ? payload.text : "";
  const firstLine = (title || text).split("\n").find((l) => l.trim()) ?? "";
  const snippet = firstLine.length > 90 ? `${firstLine.slice(0, 87).trimEnd()}…` : firstLine;
  return {
    id: r.id,
    channel: r.channel,
    status: r.status,
    at: r.scheduled_at ?? r.created_at,
    scheduledAt: r.scheduled_at,
    snippet,
    hasImage: typeof payload.image_path === "string",
    hasVideo: typeof payload.video_path === "string",
    externalUrl: r.external_url,
    lastError: r.last_error,
    payload,
  };
}

export function statusTone(status: string): "neutral" | "good" | "warn" | "bad" {
  if (status === "published") return "good";
  if (status === "failed") return "bad";
  if (status === "publishing") return "warn";
  return "neutral";
}

export function isEditable(status: string): boolean {
  return status === "approved" || status === "scheduled";
}

export const ERROR_COPY: Record<string, string> = {
  disconnected: "The account is no longer connected. Reconnect it under Connectors → Integrations and propose the post again.",
  unauthorized_destination: "The connected account can no longer post to that page.",
  vendor_rejected: "The platform rejected it.",
  transient_exhausted: "The platform kept timing out, so Zavi could not confirm whether it posted. Check the platform before proposing it again.",
  channel_disabled: "That channel is switched off in Zavi.",
  snapshot_changed: "The post changed after it was approved. Propose it again.",
};

export function errorCopy(code: string | null): string | null {
  if (!code) return null;
  return ERROR_COPY[code] ?? code.replace(/_/g, " ");
}

export function startOfWeek(anchor: Date): Date {
  const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return d;
}

export function weekDays(anchor: Date): Date[] {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

export function bucketByDay(posts: readonly CalendarPost[]): Map<string, CalendarPost[]> {
  const m = new Map<string, CalendarPost[]>();
  for (const p of [...posts].sort((a, b) => a.at.localeCompare(b.at))) {
    const k = dayKey(p.at);
    const arr = m.get(k);
    if (arr) arr.push(p);
    else m.set(k, [p]);
  }
  return m;
}
