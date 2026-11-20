
const REMINDER_PATTERNS: readonly RegExp[] = [
  /\bremind me\b/i,
  /\bset (a |an )?reminder\b/i,
  /\bgive me a (reminder|nudge)\b/i,
];

const SOFT_NOTIFY_VERB = /\b(ping|nudge|message|text|dm|notify|email)\s+me\b/i;
const FOLLOWUP_VERB = /\b(follow\s*up|circle\s+back|check\s+back|loop\s+back)\b/i;
const DEFERRAL_CUE =
  /\b(in (a|an|one|two|three|\d+)\s*(min(ute)?s?|hours?|hrs?|days?|weeks?)|at \d{1,2}(:\d{2})?\s*(am|pm)?|later|tonight|tomorrow|next (week|day|morning|mon|tues?|wednes|thurs?|fri|satur|sun)(day)?|(mon|tues|wednes|thurs|fri|satur|sun)day|this (afternoon|evening)|end of (the )?(day|week)|eod|eow|after|once|when)\b/i;

function nearCue(message: string, verb: RegExp): boolean {
  const m = verb.exec(message);
  if (!m) return false;
  const start = Math.max(0, m.index - 40);
  const window = message.slice(start, m.index + m[0].length + 40);
  return DEFERRAL_CUE.test(window);
}

export function isDeferredIntentRequest(message: string): boolean {
  const msg = message.trim();
  if (msg.length === 0) return false;
  if (REMINDER_PATTERNS.some((re) => re.test(msg))) return true;
  if (nearCue(msg, SOFT_NOTIFY_VERB)) return true;
  if (nearCue(msg, FOLLOWUP_VERB)) return true;
  return false;
}
