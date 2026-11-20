
export interface Rater {
  id: string;
  family: "claude" | "codex" | "grok";
  lens: string;
}

export const RATERS: Rater[] = [
  { id: "busy-founder", family: "grok", lens: "You are the busy founder of this business. Read the notes cold. Would you act on them? Are they short? Is each ask clear and answerable in one line?" },
  { id: "head-of-growth", family: "grok", lens: "You are an experienced head of growth. Given ONLY what the agent saw each day, was its diagnosis reasonable, and what would you have done differently?" },
  { id: "skeptic", family: "grok", lens: "You are a skeptic. Find claims the data shown does not support, any claim that something caused a result, and any overreaction to noise." },
  { id: "restraint", family: "grok", lens: "Judge restraint. Did the agent change too much, nag, repeat asks, or flip a decision it had made?" },
  { id: "cost", family: "grok", lens: "Judge value for effort. Count the reviews. Was each review worth running given what it changed or told the founder?" },
];

export function raterPrompt(rater: Rater, transcriptMd: string): string {
  return [
    `You are rating an AI head-of-growth agent that ran a business for 14 days.`,
    rater.lens,
    ``,
    `Reply with JSON only: {"score": <1-10>, "quote": "<exact line from the transcript that most drove your score>", "why": "<one sentence>"}`,
    ``,
    `--- TRANSCRIPT ---`,
    transcriptMd,
  ].join("\n");
}

export interface RaterScore {
  rater: string;
  score: number;
  quote: string;
  why: string;
}

export function parseRaterReply(rater: string, text: string, transcriptMd: string): RaterScore {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`${rater}: no JSON in reply`);
  let j: { score?: unknown; quote?: unknown; why?: unknown };
  try {
    j = JSON.parse(m[0]);
  } catch {
    throw new Error(`${rater}: reply JSON does not parse`);
  }
  const score = Number(j.score);
  if (!Number.isInteger(score) || score < 1 || score > 10) throw new Error(`${rater}: score must be an integer 1-10`);
  const quote = String(j.quote ?? "").trim();
  if (quote.length < 12) throw new Error(`${rater}: quote is too short to check`);
  if (!transcriptMd.includes(quote)) throw new Error(`${rater}: quote is not in the transcript`);
  return { rater, score, quote, why: String(j.why ?? "") };
}

export type ModelCaller = (family: Rater["family"], prompt: string) => Promise<string>;

export async function ratePanel(transcriptMd: string, call: ModelCaller): Promise<RaterScore[]> {
  const out: RaterScore[] = [];
  for (const r of RATERS) out.push(parseRaterReply(r.id, await call(r.family, raterPrompt(r, transcriptMd)), transcriptMd));
  return out;
}
