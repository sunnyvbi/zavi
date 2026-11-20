
import {
  deliverLabel,
  triggerLabel,
  zoneLabel,
  type CustomAgentDeliver,
  type CustomAgentTrigger,
} from "./customAgentCard";

export type BuilderTrigger = {
  id: string;
  kind: "schedule" | "watch";
  cron: string | null;
  tz: string | null;
  interval_minutes: number | null;
  condition: string | null;
  enabled: boolean;
  next_due_at: string | null;
};

export type BuilderRun = {
  id: string;
  status: string;
  test: boolean;
  enqueued_at: string | null;
  finished_at: string | null;
  summary: string | null;
  failure?: string | null;
};

export type BuilderAgent = {
  id: string;
  slug: string;
  name: string;
  role: string | null;
  instructions: string;
  deliver: CustomAgentDeliver | null;
  status: string;
  paused_reason: string | null;
  paused_at?: string | null;
  paused_by_self?: boolean;
  paused_by_name?: string | null;
  triggers: BuilderTrigger[];
  last_run?: BuilderRun | null;
};

export type BuilderRefusal = { code: string; message: string; required_tier?: string };

export type BuilderReceipt = {
  id: string;
  run_id: string | null;
  tool_name: string;
  decision_class: string | null;
  outcome: "attempted" | "succeeded" | "failed" | "blocked_paused";
};

export type BuilderNote = { id: string; text: string; run_id: string | null; created_at: string };

export const PAUSED_AFTER_FAILS = "Paused after 3 runs in a row did not finish.";

export function pausedLine(
  a: Pick<BuilderAgent, "paused_reason" | "paused_at" | "paused_by_self" | "paused_by_name">,
): string | null {
  const who = a.paused_by_self ? "you" : a.paused_by_name || null;
  if (who) {
    const d = a.paused_at ? new Date(a.paused_at) : null;
    const on =
      d && !Number.isNaN(d.getTime())
        ? ` on ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d)}`
        : "";
    return `Paused by ${who}${on}`;
  }
  return a.paused_reason || null;
}

export function plainRunText(output: string): string {
  return output
    .split("\n")
    .map((line) =>
      line
        .replace(/^(\s*)#{1,6}\s+/, "$1")
        .replace(/^(\s*)[-*+]\s+/, "$1• ")
        .replace(/\*\*([^*\n]+)\*\*/g, "$1")
        .replace(/__([^_\n]+)__/g, "$1")
        .replace(/`([^`\n]+)`/g, "$1")
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)"),
    )
    .join("\n");
}

export function whenItRuns(triggers: BuilderTrigger[]): string {
  const parts = triggers
    .map((t): CustomAgentTrigger | null =>
      t.kind === "schedule" && t.cron
        ? { kind: "schedule", cron: t.cron, ...(t.tz ? { tz: t.tz } : {}) }
        : t.kind === "watch" && t.interval_minutes && t.condition
          ? { kind: "watch", interval_minutes: t.interval_minutes, condition: t.condition }
          : null,
    )
    .filter((t): t is CustomAgentTrigger => t !== null)
    .map(triggerLabel);
  return parts.length > 0 ? parts.join("; ") : "Only when you run it";
}

export function sendsResultsTo(deliver: CustomAgentDeliver | null): string {
  return deliverLabel(deliver);
}

export function sendsResultsLine(deliver: CustomAgentDeliver | null): string {
  const base = deliverLabel(deliver);
  return deliver && deliver.kind !== "email" ? `${base}, and by email` : base;
}

export function runResultMarkdown(output: string): string {
  return output.replace(/```watch_result[\s\S]*?```/g, "").trim();
}

export type RunTone = "done" | "failed" | "muted" | "running";

const FAILED = new Set(["error", "failed", "parse_failed", "dispatch_error"]);

export function runStatus(run: Pick<BuilderRun, "status" | "test">): { label: string; tone: RunTone } {
  if (run.status === "success") return { label: "Finished", tone: "done" };
  if (FAILED.has(run.status)) return { label: "Did not finish", tone: "failed" };
  if (run.status === "cancelled") return { label: "Cancelled", tone: "muted" };
  return { label: "Running", tone: "running" };
}

function dayKey(d: Date, tz?: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function clock(d: Date, tz?: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);
}

function dayOffset(d: Date, now: Date, tz?: string): number {
  const a = Date.parse(`${dayKey(d, tz)}T00:00:00Z`);
  const b = Date.parse(`${dayKey(now, tz)}T00:00:00Z`);
  return Math.round((a - b) / 86_400_000);
}

export function pastWhen(iso: string | null, now: Date = new Date(), tz?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const off = dayOffset(d, now, tz);
  if (off === 0) return `Today, ${clock(d, tz)}`;
  if (off === -1) return `Yesterday, ${clock(d, tz)}`;
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(d);
  return `${day}, ${clock(d, tz)}`;
}

export function savedWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const off = dayOffset(d, now);
  if (off === 0) return "Today";
  if (off === -1) return "Yesterday";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d);
}

export function nextRun(agent: Pick<BuilderAgent, "status" | "triggers">, now: Date = new Date()): string {
  if (agent.status === "paused") return "Paused";
  const due = agent.triggers
    .filter((t) => t.enabled && t.next_due_at)
    .map((t) => ({ t, at: new Date(t.next_due_at as string) }))
    .filter((x) => !Number.isNaN(x.at.getTime()))
    .sort((a, b) => a.at.getTime() - b.at.getTime())[0];
  if (!due) return "Not scheduled";
  const mins = Math.round((due.at.getTime() - now.getTime()) / 60_000);
  if (mins <= 0) return "Due now";
  if (mins < 60) return `In ${mins} min`;
  const tz = due.t.tz ?? undefined;
  const zone = tz ? ` (${zoneLabel(tz)})` : "";
  const off = dayOffset(due.at, now, tz);
  if (off === 0) return `Today, ${clock(due.at, tz)}${zone}`;
  if (off === 1) return `Tomorrow, ${clock(due.at, tz)}${zone}`;
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "short", day: "numeric" }).format(due.at);
  return `${day}, ${clock(due.at, tz)}${zone}`;
}

function humanize(raw: string): string {
  const last = raw.split("__").pop() ?? raw;
  const words = last.replace(/[._-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : raw;
}

export function receiptLine(r: BuilderReceipt): string {
  const what = humanize(r.decision_class || r.tool_name);
  switch (r.outcome) {
    case "failed":
      return `${what} (did not go through)`;
    case "blocked_paused":
      return `${what} (not made: the agent was paused)`;
    case "attempted":
      return `${what} (in progress)`;
    default:
      return what;
  }
}

export function receiptsByRun(receipts: BuilderReceipt[]): Map<string, BuilderReceipt[]> {
  const out = new Map<string, BuilderReceipt[]>();
  for (const r of receipts) {
    if (!r.run_id) continue;
    const list = out.get(r.run_id) ?? [];
    list.push(r);
    out.set(r.run_id, list);
  }
  return out;
}

export function findBuilderAgent(agents: BuilderAgent[], idOrSlug: string | null): BuilderAgent | null {
  if (!idOrSlug) return null;
  return agents.find((a) => a.id === idOrSlug || a.slug === idOrSlug) ?? null;
}
