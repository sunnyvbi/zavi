
import type { ExactChangeRow } from "@/lib/workspace/channelActionsApi";
import { actionText, cardEvidence, exactChangeRows, type ActionItem } from "./types";

const STEP_VERBS = new Set([
  "add", "attach", "block", "change", "check", "create", "cut", "delete", "disable", "do", "don't", "duplicate",
  "enable", "exclude", "give", "go", "in", "keep", "launch", "locate", "lower", "make", "move", "open", "paste",
  "pause", "raise", "remove", "rename", "replace", "review", "set", "shift", "stop", "switch", "tag", "take", "turn",
  "update", "use", "verify",
]);

const MAX_WHY = 3;
const MAX_STEPS = 6;
const MAX_LEAD = 220;

export type CardCopy = {
  lead: string;
  leadFull: string;
  leadCut: boolean;
  why: string[];
  steps: string[];
  moreSteps: number;
  gain: string[];
};

function isRaw(line: string): boolean {
  return /[a-z0-9]__[a-z0-9]/i.test(line) || /\b[a-z]+(?:_[a-z]+)+\s*[=:]/.test(line) || /\b[A-Z]+_[A-Z_]+\b/.test(line);
}

export function clean(text: string): string {
  return text
    .replace(/\s*\([^()]*\b[a-z]+_[a-z_]+\b[^()]*\)/g, "")
    .replace(/\s*\((?:ID\s*)?\d{6,}\)/gi, "")
    .replace(/,?\s*\bid\s*\d{6,}/gi, "")
    .replace(/\s*\bID\s+[a-z0-9]{6,}\b/gi, "")
    .replace(/(?<![.!?])\s+\d{9,}\b/g, "")
    .replace(/\s*\bby criterion ID\b/gi, "")
    .replace(/\s*\((?:broad|phrase|exact)\)/gi, "")
    .replace(/\b(ENABLED|PAUSED|REMOVED|ACTIVE)\b/g, (m) => m.toLowerCase())
    .replace(/\b(\d+) conv\b/g, (_, n: string) => `${n} ${n === "1" ? "conversion" : "conversions"}`)
    .replace(/^[-*•]\s+|^\d+[.)]\s+/, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.:;])/g, "$1")
    .trim();
}

function sentences(paragraph: string): string[] {
  const numbered = paragraph.split(/\s*\(\d+\)\s+/);
  const parts = numbered.length > 2 ? numbered.slice(1) : [paragraph];
  return parts.flatMap((p) => p.split(/(?<=[.!?])\s+(?=[A-Z"“(])/));
}

function firstWord(line: string): string {
  return line.replace(/^["“(]/, "").split(/[\s,:]/)[0].toLowerCase();
}

function isStep(line: string): boolean {
  const first = firstWord(line);
  if (first !== "in") return STEP_VERBS.has(first) && !/^["“(]?take rate\b/i.test(line);
  const after = line.match(/^In [^,:]+[,:]\s*(\S+)/)?.[1] ?? "";
  return line.includes(" > ") || STEP_VERBS.has(after.toLowerCase());
}

function splitBody(text: string): { reasons: string[]; steps: string[] } {
  const reasons: string[] = [];
  const steps: string[] = [];
  const push = (line: string) => {
    for (const s of sentences(line.replace(/^Steps:\s*/i, ""))) {
      const c = clean(s);
      if (!c || /:$/.test(c) || isRaw(c)) continue;
      (isStep(c) ? steps : reasons).push(c);
    }
  };
  let verb = "";
  for (const block of text.split(/\n\s*\n/)) {
    for (const raw of block.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (/^([-*•]|\d+[.)])\s+/.test(line)) {
        const item = clean(line);
        steps.push(verb && !isStep(item) ? `${verb} ${item}` : item);
        continue;
      }
      if (/:$/.test(line)) {
        const parts = sentences(line);
        const header = parts.pop() ?? "";
        parts.forEach(push);
        const first = firstWord(header);
        verb = first !== "in" && STEP_VERBS.has(first) ? header.split(/\s/)[0] : "";
        continue;
      }
      verb = "";
      push(line);
    }
  }
  return { reasons, steps };
}

function statLine(t: { value: string; caption: string }): string {
  const caption = clean(t.caption);
  return isRaw(t.value) ? caption.charAt(0).toUpperCase() + caption.slice(1) : `${t.value} ${caption}`;
}

function rowStep(r: ExactChangeRow): string {
  return `${r.item}: ${r.before} → ${r.after}`;
}

function short(text: string): string {
  return text.length > MAX_LEAD ? `${text.slice(0, MAX_LEAD).replace(/\s+\S*$/, "")}…` : text;
}

export function cardCopy(a: ActionItem, grouped: boolean): CardCopy {
  const rows = exactChangeRows(a);
  const ev = cardEvidence(a);
  const change = typeof a.body?.change_sentence === "string" && a.body.change_sentence.trim() ? clean(a.body.change_sentence) : null;
  const body = splitBody(actionText(a) ?? "");
  const proof = [...ev.stats.map(statLine), ...(ev.reason ? [clean(ev.reason)] : []), ...body.reasons].filter((l) => l && !isRaw(l));
  const lead = change ?? proof[0] ?? body.steps[0] ?? "";
  const why = Array.from(new Set(proof.filter((l) => l !== lead && !l.startsWith(lead.replace(/…$/, ""))))).slice(0, MAX_WHY);
  const allSteps = grouped ? [] : rows.length ? rows.map(rowStep) : body.steps.filter((s) => s !== lead);
  return {
    lead: short(lead),
    leadFull: lead,
    leadCut: short(lead) !== lead,
    why,
    steps: allSteps.slice(0, MAX_STEPS),
    moreSteps: Math.max(0, allSteps.length - MAX_STEPS),
    gain: ev.estimate.map(statLine),
  };
}

export function remainingCardProse(full: string, summary: string, shown: string, stepLines: ReadonlySet<string>): string {
  const listMark = /^([-*•]|\d+[.)])\s+/;
  const sentences = full.split("\n").flatMap((line) => line.trim().replace(listMark, "").split(/(?<=[.!?])\s+/)).map((line) => clean(line.trim())).filter(Boolean);
  if (!sentences.some((line) => !summary.includes(line))) return "";
  return full.split("\n").map((line) => {
    const text = line.trim();
    if (!text) return "";
    if (stepLines.has(text.replace(listMark, ""))) return null;
    const marker = text.match(listMark)?.[0] ?? "";
    const kept = text.slice(marker.length).split(/(?<=[.!?])\s+/).filter((part) => part && !shown.includes(part)).join(" ");
    return kept ? marker + kept : null;
  }).filter((line): line is string => line !== null).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
