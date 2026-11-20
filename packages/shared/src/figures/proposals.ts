
const CHANGE_VERBS =
  "cut|raise|lower|increase|decrease|reduce|set|move|bump|drop|scale|shift|change|boost|trim|cap|put|bring|lift|double|halve|adjust|reset";

const CHANGE_VERB_G = new RegExp(`(?<![\\w-])(?:${CHANGE_VERBS})(?![\\w-])`, "gi");
const IMPERATIVE_PREFIX = /^(?:(?:then|and|so|please|also|next|first|instead|just)[,\s]+)*$/i;
const CHAINED = new RegExp(`^(?:(?:then|and|so|please|also|next|first|instead|just)[,\\s]+)*(?:${CHANGE_VERBS})\\b.*\\b(?:and|then)$`, "i");
const MODAL_BEFORE_VERB =
  /\b(?:i['’]ll|i will|i['’]d|i would|we['’]ll|we will|we['’]d|we would|should|could|would|let['’]s|let me|i recommend|we recommend|recommend|suggest|propose|plan to|planning to|going to|want to|i can|we can|i['’]m going to)(?:\s+(?:that|you|we|i|just|also|then|probably|instead|first|now))*$/i;
const NOT_GOVERNED =
  /^(?:if|when|whenever|where|wherever|why|how|whether|because|since|as|about|although|though|whereas|that|which|who|while|until|unless|once|after|before|should|would|could|will|can|may|might|must|goes|go|going|went|gets|get|got|is|are|was|were|be|been|reaches|reached|hits|hit|falls|fell|rises|rose|stays|stayed|climbs|climbed|grows|grew|comes|came|amounts|amounted|jumps|jumped)$/i;
const CHANGE_WORD = new RegExp(`^(?:${CHANGE_VERBS})$`, "i");
const SUBJECT_OR_LINK = /^(?:i|we|you|they|he|she|it|and|then|to|also)$/i;
function isVerbUse(prev: string | undefined): boolean {
  if (!prev) return true;
  return SUBJECT_OR_LINK.test(prev) || /^[A-Z]/.test(prev);
}
const MAX_OBJECT_WORDS = 6;
const NEGATION = /\b(?:don['’]t|do not|doesn['’]t|didn['’]t|never|not|no longer|won['’]t|shouldn['’]t|wouldn['’]t|avoid|instead of)\b/i;
const PAST =
  /\b(?:yesterday|last (?:week|month|year|night|time)|ago|already|earlier|previously|was|were|had|has been|have been|spent|cost|paid|earned|got|made|returned|booked|clicked)\b/i;
const ENDS_IN_TO = /\bto$/i;
const SCENARIO_START = /^at$/i;
const SCENARIO_AFTER = /^\s*(?:a|per|each|every)\s+(?:day|week|month)\b/i;

const BOUNDARY = /[.!?;:\n]/;
const MAX_CLAUSE = 200;

function plain(s: string): string {
  return s.replace(/[*_`~|]+/g, "").replace(/^\s*(?:[-+>#]+|\d+[.)])\s+/, "");
}

function clauseStart(text: string, at: number): number {
  const stop = Math.max(0, at - MAX_CLAUSE);
  for (let i = at - 1; i >= stop; i--) {
    const c = text[i];
    if (c === "." && /\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "")) continue;
    if (BOUNDARY.test(c)) return i + 1;
  }
  return stop;
}

function clauseEnd(text: string, from: number): number {
  const stop = Math.min(text.length, from + MAX_CLAUSE);
  for (let i = from; i < stop; i++) {
    const c = text[i];
    if (c === "." && /\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "")) continue;
    if (BOUNDARY.test(c)) return i;
  }
  return stop;
}

function proposesTarget(before: string): boolean {
  if (!ENDS_IN_TO.test(before)) return false;
  const verbs = [...before.matchAll(CHANGE_VERB_G)].reverse();
  for (const verb of verbs) {
    if (verb.index === undefined) continue;
    const object = before.slice(verb.index + verb[0].length, before.length - 2).trim();
    const words = object ? object.split(/\s+/) : [];
    if (
      words.length > MAX_OBJECT_WORDS ||
      object.includes(",") ||
      words.some((w) => NOT_GOVERNED.test(w.replace(/[^\w'’]/g, ""))) ||
      words.some((w, i) => CHANGE_WORD.test(w) && isVerbUse(words[i - 1]))
    ) {
      return false;
    }
    const prefix = before.slice(0, verb.index).trim();
    if (IMPERATIVE_PREFIX.test(prefix) || CHAINED.test(prefix) || MODAL_BEFORE_VERB.test(prefix)) return true;
  }
  return false;
}

export function proposalKey(raw: string): string | null {
  const unit = raw.includes("%") ? "%" : /[$\p{Sc}]/u.test(raw) ? "$" : null;
  if (!unit) return null;
  const m = raw.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? `${unit}${n}` : null;
}

export function isProposalAt(text: string, at: number, raw: string, proposedSoFar?: ReadonlySet<string>): boolean {
  const key = proposalKey(raw);
  if (!key) return false;
  const start = clauseStart(text, at);
  const end = clauseEnd(text, at + raw.length);
  const before = plain(text.slice(start, at)).trim();
  const after = plain(text.slice(at + raw.length, end));
  if (NEGATION.test(before) || PAST.test(before) || PAST.test(after)) return false;

  if (ENDS_IN_TO.test(before)) return proposesTarget(before);
  if (SCENARIO_START.test(before) && SCENARIO_AFTER.test(after)) {
    return proposedSoFar?.has(key) ?? false;
  }
  return false;
}
