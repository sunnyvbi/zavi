
export type JunkReason = "raw_json" | "tagged_envelope" | "agent_transcript" | "one_run_state" | "meta_narration";

const FENCE_RE = /```(?:json)?/gi;
const LEADING_TAG_RE = /^\s*<([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?:\s[^>]*)?>/;
const TASK_CARD_RE = /^\s*Task\s+[—-]\s+[a-z0-9_-]+\s*:/i;
const ROLE_LINE_RE = /^\s*(?:\*\*)?[a-z][a-z0-9_-]*\s+\((?:assistant|agent|system)\)(?:\*\*)?\s*:/gim;
const AGENT_FIELD_RE = /"(?:agent_slug|run_id|agent_run_id|decision_class|tool_name)"\s*:/;
const ONE_RUN_RE =
  /\b(?:this|the current|the latest) (?:run|session|turn)\b|\b(?:during|in) (?:this|the current) (?:run|session)\b|\bfor now,? (?:the agent|i) (?:could|can)(?:n['o]t| not)\b/i;

const AGENT_NARRATION_RE =
  /\bthe (?:agent|assistant|model|reply)\s+(?:explicitly\s+)?(?:(?:said|says|stated|noted|mentioned|claimed)\s+(?:it|that|there)\b|did(?:n['’]t| not)\s+(?:confirm|check|verify|see)\b)/i;
const MEMORY_SELF_RE =
  /\b(?:saved|stored) memory (?:already )?(?:holds|has|says|contains|records|shows)\b|\bmemory already (?:holds|has|says|contains|records|shows)\b|\balready (?:saved|stored) in memory\b/i;
const RUN_SUBJECT_RE =
  /\b(?:the|this|that)\s+(?:(?:(?:latest|last|previous|current|channel|agent['’]s)\s+)?(?:run|reply)|(?:channel|agent['’]s)\s+(?:read|response))\s+(?:also\s+|only\s+|just\s+)?(?:mentioned|mentions|said|says|noted|notes|found|finds|reported|reports|showed|shows|returned|returns|stated|states|confirmed|confirms|surfaced|surfaces|listed|lists|described|describes|referenced|references|cited|cites)\b(?!\s+(?:in|by|on|at|during|for|to)\b)/i;
const MEMORY_AGREE_RE =
  /\b(?:consistent|in line|in agreement|agrees?|aligns?|aligned|matches|matching|tallies)\s+with\s+(?:the\s+|what\s+(?:is|was)\s+)?(?:already\s+|previously\s+)?(?:saved|stored)\b(?!-)|\bmatch(?:es)? what (?:is|was) (?:already )?(?:saved|stored|in memory|on record)\b|\bas (?:already|previously) (?:saved|stored)\b/i;

function stripFences(text: string): string {
  return text.replace(FENCE_RE, "").trim();
}

export function isRawJson(text: string): boolean {
  const t = stripFences(text);
  if (t.length < 2) return false;
  const first = t[0];
  if (first !== "{" && first !== "[") return false;
  try {
    const v = JSON.parse(t);
    return typeof v === "object" && v !== null;
  } catch {
    const keyed = (t.match(/"[a-z_][a-z0-9_]*"\s*:/gi) ?? []).length;
    return keyed >= 3;
  }
}

export function junkReasonForText(text: string): JunkReason | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  if (LEADING_TAG_RE.test(t)) return "tagged_envelope";
  if (isRawJson(t)) return "raw_json";
  if (TASK_CARD_RE.test(t)) return "agent_transcript";
  const roleLines = (t.match(ROLE_LINE_RE) ?? []).length;
  if (roleLines >= 2) return "agent_transcript";
  if (AGENT_FIELD_RE.test(t) && (t.match(/[{}]/g) ?? []).length >= 2) return "agent_transcript";
  return null;
}

export function junkReasonForRunOutput(text: string): JunkReason | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  if (LEADING_TAG_RE.test(t)) return "tagged_envelope";
  if (isRawJson(t)) return "raw_json";
  return null;
}

export function junkReasonForCandidate(c: { title: string; body: string }): JunkReason | null {
  const whole = junkReasonForText(c.body) ?? junkReasonForText(c.title);
  if (whole) return whole;
  const both = `${c.title}\n${c.body}`;
  if (ONE_RUN_RE.test(both)) return "one_run_state";
  if (AGENT_NARRATION_RE.test(both) || MEMORY_SELF_RE.test(both) || RUN_SUBJECT_RE.test(both) || MEMORY_AGREE_RE.test(both)) {
    return "meta_narration";
  }
  return null;
}
