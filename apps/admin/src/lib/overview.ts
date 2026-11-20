
export type NeedsRow = {
  kind: "failed_runs" | "crons" | "decisions" | "stuck_runs" | "cost_spike";
  severity: "red" | "amber" | "blue";
  title: string;
  detail: string;
  href: string;
  cta: string;
};

export type Overview = {
  generated_at: string;
  truncated: boolean;
  needs_you_now: NeedsRow[];
  tenants: { total: number; new_7d: number; daily_total: number[] };
  runs: {
    last_24h: number;
    failed_24h: number;
    prev_week_24h: number;
    failure_rate_24h: number | null;
    delta_pct: number | null;
    top_failing_agent: { agent_slug: string; count: number } | null;
    daily: Array<{ day: string; ok: number; failed: number; other: number }>;
  };
  decisions: { pending: number; pending_older_48h: number; daily_new: number[] };
  stuck_runs: { count: number; sla_minutes: number; oldest: Array<{ tenant: string; agent_slug: string | null; age_min: number }> };
  crons: {
    healthy: number;
    degraded: number;
    down: number;
    failing: Array<{ name: string; ok_24h: number; fail_24h: number }>;
    recent_failures: Array<{ name: string; at: string | null; error: string | null }>;
  };
  spend: {
    today_usd: number;
    avg_daily_7d_usd: number;
    delta_pct: number | null;
    daily_usd: number[];
    top_today: Array<{ tenant_id: string; label: string; usd: number }>;
    spikes: Array<{ tenant_id: string; label: string; cost_24h: number; avg_daily_7d: number; x_multiple: number }>;
  };
  feedback_7d: { operator_up: number; operator_down: number; staff_up: number; staff_down: number };
  activity: Array<{ id: number; at: string; tenant_slug: string | null; verb: string; detail: Record<string, string | number | boolean> }>;
};

export type NavBadges = Partial<Record<string, { count: number; tone: "amber" | "red" }>>;

export function navBadges(o: Overview | null): NavBadges {
  if (!o) return {};
  const b: NavBadges = {};
  if (o.decisions.pending > 0) b["/decisions"] = { count: o.decisions.pending, tone: "amber" };
  if (o.runs.failed_24h > 0) b["/errors"] = { count: o.runs.failed_24h, tone: "red" };
  if (o.stuck_runs.count > 0) b["/stuck-runs"] = { count: o.stuck_runs.count, tone: "amber" };
  const crons = (o.crons?.down ?? 0) + (o.crons?.degraded ?? 0);
  if (crons > 0) b["/crons"] = { count: crons, tone: (o.crons?.down ?? 0) > 0 ? "red" : "amber" };
  return b;
}

export function netScore(up: number, down: number): number | null {
  const total = up + down;
  return total === 0 ? null : Math.round(((up - down) / total) * 100);
}

export function sparkPoints(values: number[], w = 200, h = 28): string {
  if (values.length === 0) return "";
  if (values.length === 1) return `0,${h / 2} ${w},${h / 2}`;
  const mx = Math.max(...values);
  const mn = Math.min(...values);
  const span = mx - mn;
  return values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = span === 0 ? h / 2 : h - 2 - ((v - mn) / span) * (h - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function usd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export type DeltaMode = "neutral" | "up-is-good" | "up-is-bad";
export type DeltaTone = "good" | "bad" | "neutral";

export function deltaTone(pct: number, mode: DeltaMode): DeltaTone {
  if (mode === "neutral" || pct === 0) return "neutral";
  const up = pct > 0;
  return (mode === "up-is-bad" ? up : !up) ? "bad" : "good";
}

export function signedPct(n: number): string {
  return `${n > 0 ? "+" : n < 0 ? "-" : ""}${Math.abs(n)}%`;
}

export function relTime(iso: string | null, nowMs = Date.now()): string {
  if (!iso) return "";
  const mins = Math.floor((nowMs - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${Math.max(mins, 0)} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.floor(hrs / 24)} d ago`;
}

export function dayLabel(day: string, first: boolean): string {
  const d = new Date(`${day}T00:00:00Z`);
  const n = d.getUTCDate();
  if (first || n === 1) return d.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return String(n);
}

export function activityText(verb: string, detail: Record<string, string | number | boolean>): string {
  const slug = typeof detail.slug === "string" ? detail.slug : null;
  if (verb === "connector.connected") return slug ? `Connected ${slug}` : "Connected a connector";
  if (verb === "connector.connect_failed") return slug ? `Failed to connect ${slug}` : "A connector failed to connect";
  if (verb === "deliverable.produced") return "Produced a deliverable";
  return verb.replace(/[._]/g, " ");
}
