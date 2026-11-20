
import { isCountOnlyHeadline, questionSubject, type NoteItem } from "./cgo-note-items";

export { isCountOnlyHeadline };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
const parseMoney = (s: string) => Number(s.replace(/,/g, ""));
const noEnd = (s: string) => s.replace(/[.\s]+$/, "");

const COUNT_LEAD = /^(?:\d+ things? needs? you\.\s*first:|\d+ changes? made\.)\s*/i;

export function headlineThing(h: string | null | undefined): string | null {
  const s = (h ?? "").replace(/\s+/g, " ").trim().replace(COUNT_LEAD, "").trim();
  if (!s || isCountOnlyHeadline(s)) return null;
  return s;
}

export function noteLead(n: { headline?: string | null; firstAsk?: string | null; firstLine?: string | null }): string | null {
  const held = n.firstAsk ? parseHeldAsk(n.firstAsk) : null;
  if (held) return held.lead;
  const own = headlineThing(n.headline);
  if (own) return own;
  if (n.firstAsk) return questionSubject(n.firstAsk);
  return n.firstLine?.trim() ? questionSubject(n.firstLine) : null;
}

export type HeldDecision = {
  lead: string;
  title: string;
  cost: string | null;
  lastNumbers: string | null;
  heldBecause: string | null;
  recommend: "yes" | "no";
  why: string;
  ifNo: string | null;
  yesLabel: string;
  noLabel: string;
};

const HEAD = /^(?:\d+\.\s+)?I did not (.+?) on my own:\s*(.*)$/s;
const BUDGET = /^(raise|cut) (“.+?”|this campaign) from \$([\d,]+(?:\.\d+)?) to \$([\d,]+(?:\.\d+)?) a day$/;
const STATUS = /^(pause|turn on) (“.+?”)$/;
const CAP = /over your \$[\d,]+(?:\.\d+)? cap/;
const EVIDENCE = /^Last 7 days\b/;

function daysLeftInMonth(now: Date): number {
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return last - now.getUTCDate() + 1;
}

function monthEnd(now: Date): string {
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return `${MONTHS[last.getUTCMonth()]} ${last.getUTCDate()}`;
}

export function parseHeldAsk(ask: string, now: Date = new Date()): HeldDecision | null {
  const m = HEAD.exec(ask.replace(/\s+/g, " ").trim());
  if (!m) return null;
  const what = m[1];
  const sentences = m[2].split(/(?<=[.?!])\s+(?=[A-Z])/).map((s) => s.trim()).filter(Boolean);
  const cap = sentences.find((s) => CAP.test(s)) ?? null;
  const lastNumbers = sentences.find((s) => EVIDENCE.test(s)) ?? null;
  const first = sentences[0]?.replace(/\bZavi (already |cannot )/g, "I $1").replace(/\bwhether Zavi /g, "whether I ");
  const reason = first && sentences[0] !== cap && sentences[0] !== lastNumbers && !/^(Should I|The card is waiting|Add )/.test(first) ? noEnd(first) : null;
  const recommend: "yes" | "no" = cap ? "no" : "yes";
  const why = cap
    ? `Same reason I'd hold it: ${cap.charAt(0).toLowerCase()}${noEnd(cap.slice(1))}.`
    : "I proposed this change; the check above is the only reason I held it.";
  const heldBecause = reason ? `${reason}.` : null;
  const b = BUDGET.exec(what);
  if (b) {
    const [, verb, who, fromS, toS] = b;
    const from = parseMoney(fromS);
    const to = parseMoney(toS);
    const Verb = verb === "raise" ? "Raise" : "Cut";
    const delta = Math.round(Math.abs(to - from) * 100) / 100;
    const rest = Math.round(delta * daysLeftInMonth(now));
    const cost = delta > 0
      ? verb === "raise"
        ? `+${money(delta)} a day, about ${money(rest)} more by ${monthEnd(now)}.`
        : `Saves ${money(delta)} a day, about ${money(rest)} by ${monthEnd(now)}.`
      : null;
    return {
      lead: `${Verb} ${who} to $${toS} a day?`,
      title: `${Verb} ${who} from $${fromS} to $${toS} a day?`,
      cost,
      lastNumbers,
      heldBecause,
      recommend,
      why,
      ifNo: `it stays at $${fromS} a day.`,
      yesLabel: `Yes, ${verb} it`,
      noLabel: `No, keep $${fromS}`,
    };
  }
  const s = STATUS.exec(what);
  const title = `${what.charAt(0).toUpperCase()}${what.slice(1)}?`;
  return {
    lead: questionSubject(title),
    title,
    cost: null,
    lastNumbers,
    heldBecause,
    recommend,
    why,
    ifNo: s ? (s[1] === "pause" ? "it keeps running." : "it stays off.") : null,
    yesLabel: s ? `Yes, ${s[1]} it` : "Yes",
    noLabel: s ? (s[1] === "pause" ? "No, keep it running" : "No, leave it off") : "No",
  };
}

export const DID_MAX = 3;
export const DID_SECTIONS = ["changed", "decided", "working_on", "blocked"] as const;

export function noteWorthSending(note: {
  changed?: readonly string[] | null;
  need?: readonly string[] | null;
  would_change?: readonly string[] | null;
  items?: readonly NoteItem[] | null;
}): boolean {
  if ((note.would_change?.length ?? 0) > 0) return true;
  if (Array.isArray(note.items) && note.items.length > 0) return note.items.some((i) => i.section === "needs_you" || i.section === "changed");
  return (note.changed?.length ?? 0) > 0 || (note.need?.length ?? 0) > 0;
}
