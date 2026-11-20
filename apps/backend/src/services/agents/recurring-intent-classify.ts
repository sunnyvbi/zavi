
const FREQUENCY =
  /\b(daily|nightly|hourly|weekly|biweekly|bi-weekly|fortnightly|monthly|quarterly|everyday|every\s*day|each\s*day|every\s+(morning|evening|night|afternoon|week|weekday|weekend|month|quarter|hour|(\d+|few|couple of|other)\s+(minutes?|hours?|days?|weeks?|months?)|(mon|tues|wednes|thurs|fri|satur|sun)day)|each\s+(morning|evening|night|week|weekday|month|(mon|tues|wednes|thurs|fri|satur|sun)day)|on\s+(mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays|weekdays|weekends)|once\s+a\s+(day|week|month)|twice\s+a\s+(day|week|month)|(once|twice)\s+(daily|weekly)|per\s+(day|week)|on\s+a\s+(schedule|regular\s+basis)|regularly|recurring|repeatedly|going\s+forward|from\s+now\s+on|every\s+time)\b/i;

const WATCH =
  /\b((tell|alert|notify|ping|warn|email|text|message|update)\s+me|let\s+me\s+know|give\s+me\s+a\s+heads[\s-]?up)\s+(when|whenever|if|as\s+soon\s+as|any\s*time|each\s+time)\b|\b(keep\s+(an\s+eye|tabs)\s+on|keep\s+(watching|monitoring|tracking|checking)|watch\s+(for|out\s+for)|monitor|stay\s+on\s+top\s+of)\b/i;

const RECURRING_DELIVERABLE =
  /\b(standups?|stand-ups?|digest|morning\s+brief(ing)?|end[\s-]of[\s-]day\s+(report|summary|update)|eod\s+(report|summary|update)|weekly\s+(report|summary|recap|review)|status\s+report)\b/i;

const BUILD_AGENT =
  /\b(build|create|make|set\s*up|spin\s+up|add)\s+(me\s+)?(a|an|my|another|new|custom|one)?\s*(new\s+|custom\s+)?(agent|bot|automation|workflow|assistant)\b|\bautomate\b/i;

export function isRecurringAsk(message: string): boolean {
  if (typeof message !== "string") return false;
  const text = message.trim();
  if (text.length === 0) return false;
  return (
    FREQUENCY.test(text) ||
    WATCH.test(text) ||
    RECURRING_DELIVERABLE.test(text) ||
    BUILD_AGENT.test(text)
  );
}

export const RECURRING_ASK_BLOCK = [
  "## This message may be a recurring ask",
  "If the user wants this to keep happening (on a schedule, whenever something changes, or as an agent), call `praxis__propose_custom_agent` now, before any other work. Do not answer it once instead, and do not also do today's run inline. If it is a one-off question that only mentions a frequency (for example \"what were my daily bookings last week?\"), ignore this note and answer it normally.",
].join("\n");
