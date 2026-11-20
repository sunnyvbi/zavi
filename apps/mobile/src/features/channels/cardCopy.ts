
export type ExactRow = { item: string; before: string; after: string };
type Tile = { value: string; caption: string };

export type CardCopy = {
  lead: string;
  why: string[];
  steps: string[];
  moreSteps: number;
  gain: string[];
};

const STEP_VERBS = new Set([
  "add", "attach", "block", "change", "check", "create", "cut", "delete", "disable", "do", "don't", "duplicate",
  "enable", "exclude", "give", "go", "in", "keep", "launch", "locate", "lower", "make", "move", "open", "paste",
  "pause", "raise", "remove", "rename", "replace", "review", "set", "shift", "stop", "switch", "tag", "turn",
  "update", "use", "verify",
]);

const MAX_WHY = 3;
const MAX_STEPS = 6;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

function tiles(v: unknown): Tile[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((t): t is Tile => !!t && typeof (t as Tile).value === "string" && typeof (t as Tile).caption === "string")
    .slice(0, 4);
}

export function exactChangeRows(body: Record<string, unknown>): ExactRow[] {
  const rows = rec(body.exact_change).rows;
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (r): r is ExactRow => !!r && typeof r.item === "string" && typeof r.before === "string" && typeof r.after === "string",
  );
}

function isRaw(line: string): boolean {
  return /[a-z0-9]__[a-z0-9]/i.test(line) || /\b[a-z]+(?:_[a-z]+)+\s*[=:]/.test(line) || /\b[A-Z]+_[A-Z_]+\b/.test(line);
}

export function clean(text: string): string {
  return text
    .replace(/\s*\([^()]*\b[a-z]+_[a-z_]+\b[^()]*\)/g, "")
    .replace(/\s*\((?:ID\s*)?\d{6,}\)/gi, "")
    .replace(/,?\s*\bid\s*\d{6,}/gi, "")
    .replace(/\s*\bID\s+[a-z0-9]{6,}\b/gi, "")
    .replace(/\s+\d{9,}\b/g, "")
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
  if (first !== "in") return STEP_VERBS.has(first);
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

function statLine(t: Tile): string {
  const caption = clean(t.caption);
  return isRaw(t.value) ? caption.charAt(0).toUpperCase() + caption.slice(1) : `${t.value} ${caption}`;
}

function evidence(body: Record<string, unknown>) {
  const de = rec(body.decision_evidence);
  const ce = rec(rec(body.step).card_evidence);
  const src = Object.keys(de).length ? de : ce;
  return { stats: tiles(src.stats), estimate: tiles(src.estimate), reason: str(de.reason_text) };
}

export function cardCopy(body: Record<string, unknown>): CardCopy | null {
  const rows = exactChangeRows(body);
  const ev = evidence(body);
  const change = str(body.change_sentence) ? clean(body.change_sentence as string) : null;
  const parts = splitBody(str(rec(body.step).body) ?? "");
  const proof = [...ev.stats.map(statLine), ...(ev.reason ? [clean(ev.reason)] : []), ...parts.reasons].filter((l) => l && !isRaw(l));
  const lead = change ?? proof[0] ?? parts.steps[0] ?? "";
  const why = Array.from(new Set(proof.filter((l) => l !== lead && !l.startsWith(lead.replace(/…$/, ""))))).slice(0, MAX_WHY);
  const all = rows.length ? rows.map((r) => `${r.item}: ${r.before} → ${r.after}`) : parts.steps.filter((s) => s !== lead);
  const copy: CardCopy = {
    lead,
    why,
    steps: all.slice(0, MAX_STEPS),
    moreSteps: Math.max(0, all.length - MAX_STEPS),
    gain: ev.estimate.map(statLine),
  };
  return copy.lead || copy.why.length || copy.steps.length || copy.gain.length ? copy : null;
}
