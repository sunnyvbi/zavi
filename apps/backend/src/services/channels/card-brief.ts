export const BRIEF_TITLE_MAX = 72;
export const BRIEF_LEAD_MAX = 170;
export const BRIEF_POINT_MAX = 96;
export const BRIEF_MAX_POINTS = 3;
export const BRIEF_MAX_STEPS = 3;

export type CardBrief = {
  title: string;
  lead: string | null;
  points: string[];
  steps: string[];
};

const LIST_RE = /^\s*(?:[-*•]|\d+[.)])\s+/;

function plain(text: string): string {
  return text
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function clip(text: string, max: number): string {
  const t = plain(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const head = (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, "");
  return `${head}…`;
}

function sentences(text: string): string[] {
  return plain(text).split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/).map((s) => s.trim()).filter(Boolean);
}

function briefTitle(title: string): string {
  const t = plain(title);
  if (t.length <= BRIEF_TITLE_MAX) return t;
  const clause = t.split(/\s[—–-]\s|:\s|;\s/)[0]?.trim() ?? t;
  return clause.length >= 12 && clause.length <= BRIEF_TITLE_MAX ? clause : clip(t, BRIEF_TITLE_MAX);
}

function briefLead(prose: string[]): string | null {
  const all = sentences(prose.join(" "));
  if (!all.length) return null;
  let lead = all[0]!;
  if (lead.length > BRIEF_LEAD_MAX) return clip(lead, BRIEF_LEAD_MAX);
  const next = all[1];
  if (next && lead.length + 1 + next.length <= BRIEF_LEAD_MAX) lead = `${lead} ${next}`;
  return lead;
}

function lines(list: readonly string[], max: number, limit: number): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const line = clip(raw.replace(LIST_RE, ""), limit);
    if (!line || out.includes(line)) continue;
    out.push(line);
    if (out.length === max) break;
  }
  return out;
}

export function cardBrief(i: { title: string; stepBody?: string | null; howTo?: readonly string[] | null }): CardBrief {
  const rows = (i.stepBody ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const prose = rows.filter((l) => !LIST_RE.test(l));
  const listed = rows.filter((l) => LIST_RE.test(l));
  const title = briefTitle(i.title);
  const lead = briefLead(prose);
  return {
    title,
    lead: lead && lead !== title ? lead : null,
    points: lines(listed, BRIEF_MAX_POINTS, BRIEF_POINT_MAX),
    steps: lines(i.howTo ?? [], BRIEF_MAX_STEPS, BRIEF_POINT_MAX),
  };
}

export function briefOfBody(title: string, body: unknown, howTo: readonly string[]): CardBrief {
  const step = body && typeof body === "object" ? (body as { step?: { body?: unknown } }).step : undefined;
  const stepBody = typeof step?.body === "string" ? step.body : null;
  return cardBrief({ title, stepBody, howTo });
}
