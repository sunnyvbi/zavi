export type CustomAgentTrigger =
  | { kind: "schedule"; cron: string; tz?: string }
  | { kind: "watch"; interval_minutes: number; condition: string };

export type CustomAgentDeliver = { kind: string; [k: string]: unknown };

export type CustomAgentDraft = {
  name: string;
  role: string;
  instructions: string;
  tools: string[];
  triggers: CustomAgentTrigger[];
  deliver: CustomAgentDeliver | null;
};

export type CustomAgentCardData =
  | { kind: "draft"; draft: CustomAgentDraft }
  | { kind: "refusal"; refusal: { code: string; message: string; required_tier?: string } };

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function parseTrigger(v: unknown): CustomAgentTrigger | null {
  if (!isObj(v)) return null;
  if (v.kind === "schedule" && typeof v.cron === "string") {
    return { kind: "schedule", cron: v.cron, ...(typeof v.tz === "string" ? { tz: v.tz } : {}) };
  }
  if (v.kind === "watch" && typeof v.interval_minutes === "number" && typeof v.condition === "string") {
    return { kind: "watch", interval_minutes: v.interval_minutes, condition: v.condition };
  }
  return null;
}

export function parseCustomAgentCard(raw: unknown): CustomAgentCardData | null {
  if (!isObj(raw)) return null;
  if (raw.kind === "refusal" && isObj(raw.refusal) && typeof raw.refusal.message === "string") {
    return {
      kind: "refusal",
      refusal: {
        code: String(raw.refusal.code ?? ""),
        message: raw.refusal.message,
        ...(typeof raw.refusal.required_tier === "string" ? { required_tier: raw.refusal.required_tier } : {}),
      },
    };
  }
  if (raw.kind !== "draft" || !isObj(raw.draft)) return null;
  const d = raw.draft;
  if (typeof d.name !== "string" || typeof d.instructions !== "string") return null;
  const triggers = Array.isArray(d.triggers) ? d.triggers.map(parseTrigger) : [];
  if (triggers.some((t) => t === null)) return null;
  return {
    kind: "draft",
    draft: {
      name: d.name,
      role: typeof d.role === "string" ? d.role : "",
      instructions: d.instructions,
      tools: Array.isArray(d.tools) ? d.tools.filter((t): t is string => typeof t === "string") : [],
      triggers: triggers as CustomAgentTrigger[],
      deliver: isObj(d.deliver) && typeof d.deliver.kind === "string" ? (d.deliver as CustomAgentDeliver) : null,
    },
  };
}

export function deliverLabel(d: CustomAgentDeliver | null): string {
  switch (d?.kind) {
    case "chat_thread":
      return "This conversation";
    case "slack_thread":
      return "This Slack thread";
    case "slack_channel":
      return "A Slack channel";
    case "slack_dm":
      return "Your Slack DMs";
    case "whatsapp":
      return "WhatsApp";
    case "telegram":
      return "Telegram";
    case "discord":
      return "Discord";
    case "email":
      return "Email, to your workspace's recipients";
    default:
      return "Not delivered anywhere yet";
  }
}

const ZONE_LABELS: Record<string, string> = {
  "America/Los_Angeles": "PT",
  "America/Vancouver": "PT",
  "America/Denver": "MT",
  "America/Phoenix": "MT",
  "America/Chicago": "CT",
  "America/New_York": "ET",
  "America/Toronto": "ET",
  "Asia/Kolkata": "IST",
  "Asia/Calcutta": "IST",
  "Europe/London": "UK",
  UTC: "UTC",
  "Etc/UTC": "UTC",
  GMT: "UTC",
};

export function zoneLabel(tz: string): string {
  if (ZONE_LABELS[tz]) return ZONE_LABELS[tz];
  const last = tz.split("/").pop() ?? tz;
  return last.replace(/_/g, " ");
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function joinAnd(parts: string[]): string {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function dayPhrase(dow: string): string | null {
  if (dow === "*") return "Every day";
  if (dow === "1-5") return "Weekdays";
  if (dow === "0,6" || dow === "6,0" || dow === "6,7" || dow === "6-7") return "Weekends";
  if (!/^[0-7](,[0-7])*$/.test(dow)) return null;
  const days = [...new Set(dow.split(",").map((d) => Number(d) % 7))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  return `Every ${joinAnd(days.map((d) => DAY_NAMES[d]))}`;
}

function intervalPhrase(min: string, hour: string, dom: string, mon: string, dow: string): string | null {
  if (dom !== "*" || mon !== "*" || dow !== "*") return null;
  const every = (n: number, unit: string) => (n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`);
  const minStep = min.match(/^\*\/(\d{1,2})$/);
  if (minStep && hour === "*") return every(Number(minStep[1]), "minute");
  if (/^\d{1,2}$/.test(min) && Number(min) === 0) {
    if (hour === "*") return every(1, "hour");
    const hourStep = hour.match(/^\*\/(\d{1,2})$/);
    if (hourStep) return every(Number(hourStep[1]), "hour");
  }
  return null;
}

export function scheduleLabel(cron: string, tz?: string): string {
  const fields = cron.trim().split(/\s+/);
  const fallback = `Custom schedule (${cron.trim()})`;
  if (fields.length !== 5) return fallback;
  const [min, hour, dom, mon, dow] = fields;
  const interval = intervalPhrase(min, hour, dom, mon, dow);
  if (interval) return interval;
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour) || dom !== "*" || mon !== "*") return fallback;
  const m = Number(min);
  const h = Number(hour);
  if (m > 59 || h > 23) return fallback;
  const days = dayPhrase(dow);
  if (!days) return fallback;
  const time = `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  return `${days} at ${time}${tz ? ` (${zoneLabel(tz)})` : ""}`;
}

export function triggerLabel(t: CustomAgentTrigger): string {
  if (t.kind === "schedule") return scheduleLabel(t.cron, t.tz);
  return `Checks every ${t.interval_minutes} min: ${t.condition}`;
}

export const CUSTOM_AGENT_HONEST_LINE =
  "Works on its own and can use any tool your workspace has. Anything it does happens for real.";
export const TEST_RUN_CONFIRM = "Run a test now? A test run is a real run, so anything it does happens too.";

export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "success",
  "parse_failed",
  "error",
  "failed",
  "cancelled",
  "dispatch_error",
]);

export type ServerCustomAgent = {
  id: string;
  status: string;
  name: string;
  role?: string;
  instructions?: string;
  triggers?: unknown[];
  deliver?: unknown;
};

export function draftFromServerAgent(hit: ServerCustomAgent, draft: CustomAgentDraft): CustomAgentDraft {
  const triggers = Array.isArray(hit.triggers)
    ? hit.triggers
        .map((t) => {
          const r = t as Record<string, unknown>;
          return parseTrigger({ ...r, tz: r.tz ?? undefined });
        })
        .filter((t): t is CustomAgentTrigger => t !== null)
    : draft.triggers;
  const deliver =
    hit.deliver === null
      ? null
      : isObj(hit.deliver) && typeof hit.deliver.kind === "string"
        ? (hit.deliver as CustomAgentDeliver)
        : draft.deliver;
  return {
    ...draft,
    name: hit.name,
    role: typeof hit.role === "string" ? hit.role : draft.role,
    instructions: typeof hit.instructions === "string" ? hit.instructions : draft.instructions,
    triggers,
    deliver,
  };
}

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
