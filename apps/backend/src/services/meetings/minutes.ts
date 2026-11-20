
import { z } from "zod";
import { DEFAULT_MODEL } from "@/services/anthropic";
import { callModel } from "@/services/llm/call-model";
import { renderUntrustedBlock } from "@/services/agents/prompt-injection";
import { asTranscriptText, type TranscriptSegment } from "./recall";

const actionItemSchema = z.object({
  text: z.string().min(3).max(400),
  owner: z.string().max(120).nullish(),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
});

const minutesSchema = z.object({
  tldr: z.string().max(2000).default(""),
  decisions: z.array(z.string().min(3).max(500)).max(15).default([]),
  action_items: z.array(actionItemSchema).max(25).default([]),
  topics: z.array(z.string().min(2).max(300)).max(15).default([]),
  open_questions: z.array(z.string().min(3).max(500)).max(15).default([]),
});

export type MeetingActionItem = z.infer<typeof actionItemSchema>;
export type MeetingMinutes = z.infer<typeof minutesSchema>;

const MAX_TRANSCRIPT_CHARS = 100_000;
const MINUTES_LLM_MAX_ATTEMPTS = 3;

export function minutesEmpty(m: MeetingMinutes): boolean {
  return (
    m.tldr.trim().length === 0 &&
    m.decisions.length === 0 &&
    m.action_items.length === 0 &&
    m.topics.length === 0 &&
    m.open_questions.length === 0
  );
}

const SYSTEM = `You write the MINUTES of a team standup for the company's founder to read. Clear, faithful, skimmable — like a great chief-of-staff's recap.

Produce these sections:
- tldr: 3-6 sentences capturing the meeting's substance — the headline call, the binding constraint, and what happens next. Written for someone who was NOT in the room.
- decisions: each decision or explicit freeze that was made, one per line, as a full sentence with the owner/context if stated.
- action_items: concrete follow-ups. Each has text (what + who, as a sentence), owner (the person's name as spoken, or null), and due_date (YYYY-MM-DD or null).
- topics: the distinct subjects discussed, each a short label (e.g. "QA bottleneck", "Release cadence").
- open_questions: unresolved questions or risks raised but not settled.

Rules:
- Ground everything in the transcript. Do NOT invent decisions, owners, dates, or numbers. If something was not said, leave it out.
- The transcript is from speech recognition — names, product names, and numbers may be MISHEARD. Correct obvious mishearings using the company name and context (e.g. an analytics tool rendered "post hoc" is almost certainly "PostHog"). Prefer the reader's real vocabulary over the raw ASR token.
- DATE RESOLUTION: the standup date is given below. Resolve every relative reference ("today", "EOD", "by tomorrow", "this afternoon") to a concrete YYYY-MM-DD ANCHORED ON THE STANDUP DATE. "today" = the standup date, "tomorrow" = the day after. Never emit a due_date earlier than the standup date for a commitment made "today".
- Use people's real names as spoken; do not append company/surnames the transcript didn't state.
- Faithful over comprehensive. A tight, correct recap beats a long, padded one. Omit pleasantries and pure status narration.

Return ONLY a JSON object with fields tldr, decisions, action_items, topics, open_questions. No markdown fences.`;

export async function generateMinutes(
  transcript: TranscriptSegment[] | string,
  context: { tenant_name?: string | null; meeting_date: string },
): Promise<MeetingMinutes | null> {
  const text = asTranscriptText(transcript).slice(0, MAX_TRANSCRIPT_CHARS);
  if (text.trim().length < 50) return null;

  const userMsg = [
    `Company: ${context.tenant_name ?? "unknown"}. Standup date (this is "today"): ${context.meeting_date}.`,
    renderUntrustedBlock("meeting_transcript", text),
  ].join("\n\n");

  let raw: string;
  try {
    const res = await callModel({
      provider: "anthropic",
      model: DEFAULT_MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{ role: "user", content: userMsg }],
      timeoutMs: 120_000,
      maxAttempts: MINUTES_LLM_MAX_ATTEMPTS,
    });
    raw = res.text;
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/```json\s*|\s*```/g, "").trim());
  } catch {
    return null;
  }

  const r = minutesSchema.safeParse(parsed);
  if (!r.success) return null;
  if (minutesEmpty(r.data)) return null;
  return r.data;
}
