
import {
  stripContradictedSetupClaims,
} from "@/services/agents/run-capabilities";

const DURABLE_NOTE_TYPES: ReadonlySet<string> = new Set([
  "tenant_reference",
  "tenant_project",
]);

const NONEXISTENCE_VERB_RE =
  /\b(?:does ?n['’o]?t exist|not implemented|unimplemented|could ?n['’o]?t (?:locate|find|implement|ship|add)|still missing|not (?:yet )?(?:live|merged|implemented)|cannot be (?:implemented|shipped|added)|never (?:merged|shipped|implemented))\b/i;
const FULL_ABSENCE_VERB_RE =
  /\b(?:block(?:ed|s)?|missing|does ?n['’o]?t exist|not implemented|unimplemented|unavailable|could ?n['’o]?t (?:locate|find|implement|ship|add)|still missing|pending|held by|not (?:yet )?(?:live|merged|available|implemented|reachable)|cannot be (?:implemented|shipped|added)|attempted but|never (?:merged|shipped|implemented))\b/i;
const CAP_NOUN_RE = /\b(?:endpoint|route|api|backend|capability|handler|controller)\b/i;

const NEGATIVE_EXISTENCE_RE =
  /\bno\b[^.?!]*\bfound\b|\bfound\s+no\b|\bno\b[^.?!]*\b(?:configured|set\s*up|wired|installed|present|implemented|in\s+place)\b|\b(?:isn['’]?t|is\s+not|aren['’]?t|are\s+not|wasn['’]?t|weren['’]?t)\s+(?:configured|set\s*up|wired|implemented|present|installed|in\s+place)\b|\b(?:does|do|did)(?:n['’]?t|\s+not)\s+exist\b|\bno\s+such\b|\bthere\s+(?:is|are|was|were)\s+no\b|\bzero\s+(?:hits|results|matches)\b|\breturned\s+(?:zero|no)\s+(?:hits|results|matches)\b|\b(?:could\s*n['’]?t|couldn['’]?t|unable\s+to)\s+find\s+any\b|\bfound\s+nothing\b/i;

const MIN_SUBSTANTIVE_CHARS = 8;

export type SanitizeInput = {
  title: string;
  body: string;
  note_type: string;
  liveConnectors?: readonly string[];
  readBudgetRefused?: boolean;
  dropBlockedCapability?: boolean;
};

export type SanitizeResult = {
  title: string;
  body: string;
  dropped: boolean;
  dropReason: string;
  withheldConnectors: string[];
  sentencesRemoved: number;
};

function substantive(text: string): boolean {
  return text.replace(/\s+/g, "").length >= MIN_SUBSTANTIVE_CHARS;
}

function stripSentences(
  body: string,
  predicate: (sentence: string) => boolean,
): { text: string; removed: number } {
  let removed = 0;
  const parts = body.split(/(?<=[.!?\n])/);
  const out = parts.map((sentence) => {
    if (!predicate(sentence)) return sentence;
    removed += 1;
    return sentence.match(/\n\s*$/)?.[0] ?? "";
  });
  return { text: out.join(""), removed };
}

export function sanitizeDurableClaims(input: SanitizeInput): SanitizeResult {
  const title = typeof input.title === "string" ? input.title : "";
  const body = typeof input.body === "string" ? input.body : "";
  const clean: SanitizeResult = {
    title,
    body,
    dropped: false,
    dropReason: "",
    withheldConnectors: [],
    sentencesRemoved: 0,
  };

  if (!DURABLE_NOTE_TYPES.has(input.note_type)) return clean;

  const connectors = input.liveConnectors ?? [];
  const capVerbs = input.dropBlockedCapability ? FULL_ABSENCE_VERB_RE : NONEXISTENCE_VERB_RE;

  if (connectors.length > 0) {
    const t = stripContradictedSetupClaims(title, connectors);
    if (t.withheld.length > 0) {
      return {
        ...clean,
        dropped: true,
        dropReason: `title asserts disproven connector state (${t.withheld.join(",")})`,
        withheldConnectors: t.withheld,
      };
    }
  }
  let working = body;
  let removed = 0;

  const conn = stripContradictedSetupClaims(working, connectors);
  working = conn.text;

  {
    const r = stripSentences(working, (s) => capVerbs.test(s) && CAP_NOUN_RE.test(s));
    working = r.text;
    removed += r.removed;
  }

  if (input.readBudgetRefused) {
    const r = stripSentences(working, (s) => NEGATIVE_EXISTENCE_RE.test(s));
    working = r.text;
    removed += r.removed;
  }

  const combined = `${title}\n${working}`;
  if (input.dropBlockedCapability && capVerbs.test(combined) && CAP_NOUN_RE.test(combined)) {
    return {
      ...clean,
      dropped: true,
      dropReason: "asserts a blocked/missing capability across title/body",
      withheldConnectors: conn.withheld,
      sentencesRemoved: removed,
    };
  }
  if (NONEXISTENCE_VERB_RE.test(title) && CAP_NOUN_RE.test(title)) {
    return {
      ...clean,
      dropped: true,
      dropReason: "title asserts a non-existent capability",
      withheldConnectors: conn.withheld,
      sentencesRemoved: removed,
    };
  }
  if (input.readBudgetRefused && NEGATIVE_EXISTENCE_RE.test(combined)) {
    return {
      ...clean,
      dropped: true,
      dropReason: "asserts absence across title/body on a read-truncated run",
      withheldConnectors: conn.withheld,
      sentencesRemoved: removed,
    };
  }

  const excisedSomething = conn.withheld.length > 0 || removed > 0;
  if (excisedSomething && !substantive(working)) {
    return {
      ...clean,
      dropped: true,
      dropReason: "nothing substantive left after excising false claims",
      withheldConnectors: conn.withheld,
      sentencesRemoved: removed,
    };
  }

  return {
    title,
    body: working,
    dropped: false,
    dropReason: "",
    withheldConnectors: conn.withheld,
    sentencesRemoved: removed,
  };
}
