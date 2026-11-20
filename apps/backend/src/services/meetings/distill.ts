
import { z } from "zod";
import { DEFAULT_MODEL } from "@/services/anthropic";
import { callModel } from "@/services/llm/call-model";
import { extractJsonObject } from "@/services/llm/extract-json";
import { renderUntrustedBlock } from "@/services/agents/prompt-injection";
import { asTranscriptText, type TranscriptSegment } from "./recall";

export const ATOM_TYPES = [
  "blocker",
  "decision",
  "spec_fact",
  "commitment",
  "policy",
  "capacity_signal",
] as const;

const atomSchema = z.object({
  atom_type: z.enum(ATOM_TYPES),
  title: z.string().min(3).max(200),
  body: z.string().max(2000).default(""),
  owner: z.string().max(120).nullish(),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
  memory_class: z.enum(["canonical", "active_ops", "watchlist"]),
  source_excerpt: z.string().max(600).default(""),
});

export type MeetingAtom = z.infer<typeof atomSchema>;

const MAX_ATOMS = 15;
const MAX_TRANSCRIPT_CHARS = 100_000;
const DISTILL_LLM_MAX_ATTEMPTS = 3;

const SYSTEM = `You distill a team standup transcript into OPERATING DELTAS for a company memory system. You are ruthless about signal vs noise.

Extract ONLY:
- blocker: someone is blocked, on what, by whom/what (memory_class active_ops)
- commitment: a person committed to a deliverable, with owner + due if stated (active_ops)
- decision: a decision was made or explicitly frozen (canonical if durable product/process truth, active_ops if short-lived coordination)
- spec_fact: durable product behavior stated verbally (thresholds, rules, flows) (canonical)
- policy: durable operating policy (capacity allocations, cadences, processes) (canonical)
- capacity_signal: someone is free/overloaded/returning (active_ops)

DROP entirely (do not emit): same-day logistics ("talk after the call"), per-person status narration already tracked in ticketing systems, pleasantries, anything you cannot ground in the transcript.

Rules:
- Every atom MUST include source_excerpt: a short verbatim quote (or tight paraphrase marked with ~) from the transcript that grounds it.
- DATE RESOLUTION: the standup date is given in the user message. Resolve every relative reference ("today", "EOD", "by tomorrow", "this afternoon") to a concrete YYYY-MM-DD ANCHORED ON THAT STANDUP DATE — "today" = the standup date, "tomorrow" = the day after. Never emit a due_date earlier than the standup date for a commitment made "today".
- Confidence: high only when the statement is explicit and attributed; low when inferred or the transcript is garbled. Transcripts come from speech recognition — names and numbers may be misheard; when a number/threshold matters, keep confidence at most medium unless repeated.
- canonical is reserved for durable truth a support or PM agent should rely on for months. When unsure between canonical and active_ops, pick active_ops.
- At most ${MAX_ATOMS} atoms. Fewer, better atoms beat coverage.

Return ONLY a JSON object: {"atoms": [...]} with fields atom_type, title, body, owner, due_date (YYYY-MM-DD or null), confidence, memory_class, source_excerpt.
Start your response with the character { and end it with }. No preamble sentence, no explanation, no markdown fences, no trailing prose. If there is nothing to extract, return {"atoms": []}.`;

const EPHEMERAL_MARKERS: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b(today|tonight|tomorrow|yesterday)\b/i,
  /\bthis (morning|afternoon|evening|sprint|slice|release|week|cycle)\b/i,
  /\b(next|last) (sprint|release|week)\b/i,
  /\b(by )?eod\b/i,
  /\bon (mon|tue|wed|thur|thu|fri|sat|sun)(day|nesday|rsday|urday)?\b/i,
  /\b(just |now |newly )?(published|went live|is live|are live|now live|shipped)\b/i,
];

export function gateEphemeralCanonical(atoms: MeetingAtom[]): MeetingAtom[] {
  return atoms.map((a) => {
    if (a.memory_class !== "canonical") return a;
    const synthesis = `${a.title} ${a.body}`;
    if (EPHEMERAL_MARKERS.some((re) => re.test(synthesis))) {
      return { ...a, memory_class: "active_ops" as const };
    }
    return a;
  });
}

export async function distillTranscript(
  transcript: TranscriptSegment[] | string,
  context: { tenant_name?: string | null; meeting_date: string },
): Promise<MeetingAtom[]> {
  const text = asTranscriptText(transcript).slice(0, MAX_TRANSCRIPT_CHARS);
  if (text.trim().length < 50) return [];

  const userMsg = [
    `Company: ${context.tenant_name ?? "unknown"}. Standup date: ${context.meeting_date}.`,
    renderUntrustedBlock("meeting_transcript", text),
  ].join("\n\n");

  const { text: raw } = await callModel({
    provider: "anthropic",
    model: DEFAULT_MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [
      { role: "user", content: userMsg },
    ],
    timeoutMs: 120_000,
    maxAttempts: DISTILL_LLM_MAX_ATTEMPTS,
  });

  const parsed = extractJsonObject(raw);
  if (parsed === null) {
    throw new Error(`distill output not parseable as JSON (model returned ${raw.length} chars)`);
  }

  const atomsRaw = (parsed as { atoms?: unknown[] })?.atoms;
  if (!Array.isArray(atomsRaw)) return [];

  const atoms: MeetingAtom[] = [];
  for (const a of atomsRaw.slice(0, MAX_ATOMS)) {
    const r = atomSchema.safeParse(a);
    if (r.success) atoms.push(r.data);
  }
  return gateEphemeralCanonical(atoms);
}

export function defaultExpiry(
  memory_class: MeetingAtom["memory_class"],
  now: Date,
): Date | null {
  if (memory_class === "active_ops") {
    return new Date(now.getTime() + 72 * 3600_000);
  }
  if (memory_class === "watchlist") {
    return new Date(now.getTime() + 14 * 24 * 3600_000);
  }
  return null;
}
