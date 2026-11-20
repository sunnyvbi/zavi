
export const HUMAN_FACING_SLUGS: ReadonlySet<string> = new Set([
  "performance-marketer",
  "pm",
  "research",
  "advisor",
  "growth-lead",
  "qa",
  "engineer",
  "fundraising",
  "dispute-response",
  "content-design",
]);

const LEAD_WORD_CAP = 120;

export type ShapeReportLeadArgs = {
  trigger: string | null | undefined;
  agentSlug: string | null | undefined;
  hasEnvelope: boolean;
  body: string;
};

export type ShapeReportLeadResult = {
  lead: string;
  collapsed: boolean;
  full: string;
};

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function extractLead(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let seenHeader = 0;
  let started = false;
  for (const line of lines) {
    const isHeader = /^\s{0,3}#{1,6}\s/.test(line);
    if (isHeader) {
      seenHeader += 1;
      if (!started) continue;
      if (seenHeader >= 2) break;
      continue;
    }
    if (line.trim().length === 0 && !started) continue;
    started = true;
    out.push(line);
    if (wordCount(out.join(" ")) >= LEAD_WORD_CAP) break;
  }
  let lead = out.join("\n").trim();
  const words = lead.split(/\s+/);
  if (words.length > LEAD_WORD_CAP) {
    const capped = words.slice(0, LEAD_WORD_CAP).join(" ");
    const endsOnTerminal = /[.!?]$/.test(capped);
    const lastSentenceEnd = endsOnTerminal
      ? capped.length - 1
      : Math.max(
          capped.lastIndexOf(". "),
          capped.lastIndexOf("! "),
          capped.lastIndexOf("? "),
          capped.lastIndexOf(".\n"),
          capped.lastIndexOf("!\n"),
          capped.lastIndexOf("?\n"),
        );
    const MIN_LEAD_CHARS = Math.floor(capped.length / 2);
    lead =
      lastSentenceEnd >= MIN_LEAD_CHARS
        ? capped.slice(0, lastSentenceEnd + 1).trim()
        : capped.replace(/[\s,;:.\-]+$/, "");
  }
  return lead;
}

export function shapeReportLead(args: ShapeReportLeadArgs): ShapeReportLeadResult {
  const body = typeof args.body === "string" ? args.body : "";
  const noop: ShapeReportLeadResult = { lead: body, collapsed: false, full: body };

  const trigger = args.trigger ?? "";
  if (trigger !== "slack") return noop;
  if (!args.agentSlug || !HUMAN_FACING_SLUGS.has(args.agentSlug)) return noop;
  if (!args.hasEnvelope) return noop;
  if (wordCount(body) <= LEAD_WORD_CAP) return noop;

  const lead = extractLead(body);
  if (lead.length === 0 || wordCount(lead) >= wordCount(body) * 0.8) return noop;

  return { lead, collapsed: true, full: body };
}
