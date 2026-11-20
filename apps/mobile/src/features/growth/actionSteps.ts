
export type DoStep = { text: string } | { prefix: string; path: string[] };

export type ActionSteps =
  | { kind: "structured"; do: DoStep[]; notes: string[]; check: string[]; dont: string[]; why: string[] }
  | { kind: "plain"; lines: string[] };

const ABBREVIATIONS = new Set(["e.g", "i.e", "etc", "vs", "approx", "mr", "mrs", "dr", "st", "no"]);

export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuote = false;
  const push = () => {
    const s = current.replace(/\s+/g, " ").trim();
    if (s) out.push(s);
    current = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") {
      push();
      inQuote = false;
      continue;
    }
    current += c;
    if (c === '"') inQuote = !inQuote;
    else if (c === "“") inQuote = true;
    else if (c === "”") inQuote = false;
    const closesQuotedSentence =
      /['"\u2019\u201d]/.test(c) && /[.!?]/.test(current.slice(-2, -1)) && /\s/.test(text[i + 1] ?? " ");
    if (closesQuotedSentence && !inQuote) {
      push();
      continue;
    }
    if (inQuote || !/[.!?]/.test(c)) continue;
    const next = text[i + 1];
    if (next !== undefined && !/\s/.test(next)) continue;
    if (c === ".") {
      const word = current.slice(0, -1).split(/\s/).pop()?.toLowerCase() ?? "";
      if (ABBREVIATIONS.has(word)) continue;
    }
    push();
  }
  push();
  return out;
}

const DONT = /^(?:do not|don['’]t|never|avoid)\s+/i;
const CHECK = /^(?:verify|check|confirm|test|make sure)\b/i;

const VERBS = new Set(
  (
    "add open go set turn replace remove create change update paste publish post write send move " +
    "rename switch enable disable click select pick use include upload submit fix edit copy pause " +
    "start stop launch run build list reply delete duplicate rebuild show connect register point " +
    "configure fill place install exclude resolve apply schedule record"
  ).split(" "),
);

const PATH_SEP = /\s+(?:>|›|→)\s+/;

function pathStep(sentence: string): DoStep | null {
  const parts = sentence.replace(/[.!?]$/, "").split(PATH_SEP);
  if (parts.length < 3) return null;
  const first = parts[0];
  const cut = Math.max(first.lastIndexOf(":"), first.lastIndexOf(","));
  const prefix = cut >= 0 ? first.slice(0, cut + 1).trim() : "";
  const segments = [cut >= 0 ? first.slice(cut + 1) : first, ...parts.slice(1)]
    .map((s) => s.trim().replace(/^["“]|["”]$/g, "").trim())
    .filter(Boolean);
  return segments.length >= 3 ? { prefix, path: segments } : null;
}

function isImperative(sentence: string): boolean {
  const firstWord = (s: string) => s.trim().split(/[\s,:;]/)[0]?.toLowerCase() ?? "";
  if (VERBS.has(firstWord(sentence))) return true;
  const colon = sentence.indexOf(":");
  return colon > 0 && colon <= 60 && VERBS.has(firstWord(sentence.slice(colon + 1)));
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const CONSEQUENCE =
  /\b(?:cost(?:s|ing)?|charg(?:e|es|ed|ing)|spend(?:s|ing)?|spent|permanent(?:ly)?|delet(?:e|es|ed|ing)|paus(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|stop(?:s|ped|ping)?|overwrit(?:e|es|ing)|overwritten|publish(?:es|ed|ing)?|irreversible)\b|\b(?:can['\u2019]t|cannot|can not) be (?:undone|reversed)\b/i;

export function actionSteps(text: string | null | undefined): ActionSteps {
  const sentences = splitSentences(text ?? "");
  const doSteps: DoStep[] = [];
  const check: string[] = [];
  const dont: string[] = [];
  const why: string[] = [];
  const notes: string[] = [];
  for (const s of sentences) {
    if (DONT.test(s)) dont.push(capitalize(s.replace(DONT, "")));
    else if (CHECK.test(s)) check.push(s);
    else {
      const path = pathStep(s);
      if (path) doSteps.push(path);
      else if (isImperative(s)) doSteps.push({ text: s });
      else if (CONSEQUENCE.test(s)) notes.push(s);
      else why.push(s);
    }
  }
  if (doSteps.length === 0) return { kind: "plain", lines: sentences };
  return { kind: "structured", do: doSteps, notes, check, dont, why };
}
