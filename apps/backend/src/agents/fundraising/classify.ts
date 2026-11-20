
const STRATEGY_RE =
  /\b(outreach plan|outreach strategy|prepare (the |an? )?outreach|prep (the |an? )?outreach|draft (the |an? )?(cold )?emails?|write (the |an? )?(cold )?emails?|draft (the |an? )?outreach|copy variants?|message variants?|prepare to send|ready to send|follow[- ]?up sequence|outreach cadence|linkedin (dm|message|note)|draft (the |an? )?(intro|dm|linkedin))\b/i;

export type FundraisingAdviceTopic =
  | "readiness"
  | "round_design"
  | "meeting_prep"
  | "objection";

const ROUND_DESIGN_RE = /\b(how much should i raise|round (size|design)|how big (a |should )?(my |the )?round)\b/i;
const READINESS_RE = /\b(am i ready|are we ready|readiness)\b|\bshould (i|we) raise\b(?!\s+from)/i;
const MEETING_PREP_RE = /\b(prep me|prepare me|prep for|prepare for|help me prep)\b.*\b(call|meeting|pitch|partner)\b|\bmeeting prep\b|\bprep me for\b/i;
const OBJECTION_RE = /\b(lowball|low[- ]?ball|term sheet|exclusivity|objection|pushback|they want to talk to (my )?customers|wants exclusivity)\b/i;

export function classifyFundraisingAdviceTopic(
  userText: string,
): FundraisingAdviceTopic | undefined {
  if (!userText) return undefined;
  if (ROUND_DESIGN_RE.test(userText)) return "round_design";
  if (READINESS_RE.test(userText)) return "readiness";
  if (MEETING_PREP_RE.test(userText)) return "meeting_prep";
  if (OBJECTION_RE.test(userText)) return "objection";
  return undefined;
}

export type FundraisingChatMode = "source" | "strategy" | "advise" | "deep";

export function classifyFundraisingChatMode(
  userText: string,
): Exclude<FundraisingChatMode, "deep"> {
  if (!userText) return "source";
  if (classifyFundraisingAdviceTopic(userText)) return "advise";
  return STRATEGY_RE.test(userText) ? "strategy" : "source";
}

export type FundraisingStage =
  | "Angel"
  | "Pre-seed"
  | "Seed"
  | "Series A"
  | "Series B+";

export function classifyFundraisingStage(
  userText: string,
): FundraisingStage | undefined {
  if (!userText) return undefined;
  const quoted = userText.match(/structured stage field to ["“]([^"”]+)["”]/i)?.[1];
  const fromQuoted = normalizeStageLabel(quoted ?? "");
  if (fromQuoted) return fromQuoted;

  const lower = userText.toLowerCase();
  if (/\bpre[-\s]?seed\b/.test(lower)) return "Pre-seed";
  if (/\bangel\b/.test(lower)) return "Angel";
  if (/\bseries\s+b(\+|\s+plus|\s+and\s+beyond)?\b/.test(lower)) return "Series B+";
  if (/\bseries\s+a\b/.test(lower)) return "Series A";
  if (/\bseed\b/.test(lower)) return "Seed";
  return undefined;
}

function normalizeStageLabel(v: string): FundraisingStage | undefined {
  const s = v.trim().toLowerCase().replace(/[_-]+/g, " ");
  if (!s) return undefined;
  if (s === "angel") return "Angel";
  if (s === "pre seed" || s === "preseed") return "Pre-seed";
  if (s === "seed") return "Seed";
  if (s === "series a") return "Series A";
  if (
    s === "series b" ||
    s === "series b+" ||
    s === "series b plus" ||
    s === "series b and beyond"
  ) {
    return "Series B+";
  }
  return undefined;
}
