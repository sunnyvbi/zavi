
import { jaccard } from "@/services/memory/write-gate";

export type FollowUpKind = "correction" | "frustration" | "rephrase";

const PREDICATE =
  /\b(wrong|incorrect|inaccurate|not (right|correct|true|it|what i (asked|meant|wanted|said))|isn'?t (right|correct|true|it|what)|wasn'?t (right|correct|true|what)|that'?s not|you (missed|ignored|forgot|skipped|misread|got it wrong)|it was \S+ not|not \S+ but)\b/i;

const NO_OPENER = /^(no|nope|nah)\b[\s,.!-]+/i;
const STRAIGHT_CORRECTIONS: RegExp[] = [
  /^(that'?s|this is|that is|it'?s|its)\s+(wrong|incorrect|not (right|correct|it|true|what i (asked|meant|wanted)))\b/i,
  /^(wrong|incorrect)\b/i,
  /^not what i (asked|meant|wanted)\b/i,
  /^still (wrong|broken|not (right|working|it))\b/i,
  /^why did you\b/i,
  /^(that|it) (didn'?t|did not|doesn'?t|does not) work\b/i,
  /^you (didn'?t|did not|missed|ignored|forgot|skipped)\b/i,
  /^i asked (for|about)\b/i,
  /^stop\b[\s,.!-]+(that'?s|this is|it'?s|wrong)\b/i,
];
const TRY_AGAIN = /^(please\s+)?try again\b/i;
const DEFERRAL = /\b(tomorrow|later|tonight|next (week|month|time)|when\b|after\b|once\b|in (a|an|\d+) )/i;
const I_SAID = /^i (said|meant)\b/i;
const CONTRAST = /\b(not|instead|rather)\b/i;
const YOU_SAID = /^you (said|told me|claimed)\b/i;
const CONTRADICTION_CUE = /\b(but|however|wrong|incorrect|instead|isn'?t (true|right|correct)|wasn'?t (true|right|correct)|i asked)\b/i;

const FRUSTRATION: RegExp[] = [
  /\bkeeps? (on )?happening\b/i,
  /\b(you|it|this|zavi) keeps? (on )?(doing|making|giving|saying|getting|failing|breaking|repeating|ignoring|forgetting|looping|asking|running|calling)\b/i,
  /\b(happen\w*|fail\w*|broke\w*|break\w*|wrong|crash\w*|error\w*|loop\w*|retr(y|ies|ied|ying))\b[^.?!\n]{0,30}\brepeatedly\b|\brepeatedly\b[^.?!\n]{0,30}\b(fail\w*|wrong|broke\w*|break\w*|crash\w*|error\w*|happen\w*)\b/i,
  /\bover and over\b/i,
  /\bhow many (more )?times (do|did|does|must|should|will|have|has|am|can) (i|we|you)\b[^.?!]{0,25}\b(tell|ask|say|explain|repeat|remind|correct|fix|type|write|do (this|that)|break|fail|get (this|it|that) wrong)/i,
  /\b(can'?t|cannot|don'?t|do not|won'?t|no longer)\s+(really\s+|even\s+|want to\s+|ever\s+)?trust\s+(you|zavi|your\b|anything you|what you|this (agent|thing|tool))/i,
  /\b(stop(ped)? trusting|lost (all )?(my )?trust in) (you|zavi)\b/i,
  /^seriously\s*[?!.,]|\bseriously\s*[?!]|\bare you (serious|kidding)\b/i,
  /^(useless|ridiculous|pathetic|unbelievable|unacceptable)\b/i,
  /\b(this|that|it|you|you'?re|you are|this is|that'?s|it'?s|so|completely|totally|absolutely|utterly)\s+(is\s+|was\s+|are\s+)?(useless|ridiculous|pathetic|unacceptable)\b/i,
  /\bstop doing (that|this)\b/i,
  /\bsame mistake\b|\bsame (error|problem|issue|thing) again\b/i,
  /\bstill (not|isn'?t|doesn'?t|don'?t) (working|work|fixed)\b/i,
  /\bevery (single )?time (i|we) (ask|tell|try|say|run|check|use)\b/i,
  /\b(fails?|breaks?|wrong|crash(es)?) every (single )?time\b/i,
  /\bi give up\b/i,
  /\b(this|that|it|you|you'?re)( is| was| are|'s)? (a |such a |a total |a complete )?waste of (my |our )?time\b|\bwast(ing|ed) (my|our) time\b/i,
  /\b(not|ugh|argh|seriously)[\s,.!]+again\b/i,
  /\b(you|it|this|zavi) (did (it|that|this)|is doing (it|that|this)|broke|failed|crashed|looped|messed (it )?up|screwed (it )?up|got (it|this|that) wrong|ignored|forgot)\b[^.?!]{0,30}\bagain\b/i,
  /\b(wrong|broken|failed|failing|stuck|looping)\s+again\b/i,
];
const NUMBER_TIMES = /\b(\d+|two|three|four|five|six|seven|eight|nine|ten|so many|too many|multiple|several) times\b(?!\s+(a|an|per|each|every|more|less|faster|slower|bigger|smaller|higher|lower|cheaper|as)\b)/i;
const TIMES_CUE = /\b(in a row|happen\w*|told you|asked you|same|fail\w*|broke|broken|wrong|keeps?|again|repeatedly)\b/i;

const MIN_REPHRASE_WORDS = 3;

function stripQuotes(s: string): string {
  return s
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .replace(/"[^"]*"|“[^”]*”|(?<![A-Za-z0-9])'[^'\n]{3,}'(?![A-Za-z0-9])/g, " ")
    .trim();
}

function isFrustration(raw: string): boolean {
  const text = stripQuotes(raw);
  if (!text) return false;
  if (FRUSTRATION.some((re) => re.test(text))) return true;
  return text.split(/[.?!\n]+/).some((s) => NUMBER_TIMES.test(s) && TIMES_CUE.test(s));
}

function contentWordCount(s: string): number {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2).length;
}

function isCorrection(raw: string): boolean {
  const text = stripQuotes(raw);
  if (!text) return false;
  if (NO_OPENER.test(text)) return PREDICATE.test(text.replace(NO_OPENER, ""));
  if (TRY_AGAIN.test(text)) return !DEFERRAL.test(text);
  if (YOU_SAID.test(text)) return CONTRADICTION_CUE.test(text);
  if (I_SAID.test(text)) return CONTRAST.test(text);
  return STRAIGHT_CORRECTIONS.some((re) => re.test(text));
}

export function classifyFollowUp(args: {
  next: string;
  prevUser: string | null;
  prevReply: string | null;
  rephraseSimilarity: number;
  allowRephrase: boolean;
}): FollowUpKind | null {
  const next = (args.next ?? "").trim();
  if (!next) return null;
  if (isCorrection(next)) return "correction";
  if (isFrustration(next)) return "frustration";

  if (!args.allowRephrase) return null;
  const prevUser = (args.prevUser ?? "").trim();
  if (!prevUser) return null;
  if ((args.prevReply ?? "").trim().endsWith("?")) return null;
  if (contentWordCount(next) < MIN_REPHRASE_WORDS || contentWordCount(prevUser) < MIN_REPHRASE_WORDS) return null;
  if (jaccard(next, prevUser) >= args.rephraseSimilarity) return "rephrase";
  return null;
}
