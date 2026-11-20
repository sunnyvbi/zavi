
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
