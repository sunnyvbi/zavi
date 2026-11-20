
import { randomUUID } from "crypto";
import { z } from "zod";

export const CLARIFY_ENVELOPE_KIND = "clarifying_questions" as const;
export const CLARIFY_SCHEMA_VERSION = 1 as const;

const MAX_QUESTIONS = 5;
const MAX_OPTIONS = 6;
const MAX_HEADER_LEN = 12;
const MAX_TEXT_LEN = 400;

const optionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  description: z.string().max(400).optional(),
  recommended: z.boolean().optional(),
  prefill: z.boolean().optional(),
  preview: z.string().max(2000).optional(),
  provenance: z
    .object({
      source_id: z.string().min(1).max(200).optional(),
      source_type: z.enum(["memory", "connector"]).optional(),
      source_label: z.string().min(1).max(200).optional(),
      excerpt: z.string().max(600).optional(),
    })
    .passthrough()
    .optional(),
});

const questionSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(1000),
  header: z.string().min(1).max(MAX_HEADER_LEN),
  why: z.string().max(600).optional(),
  type: z.enum(["single", "multi", "text"]),
  options: z.array(optionSchema).max(MAX_OPTIONS),
  allow_other: z.boolean(),
  allow_skip: z.boolean().optional(),
  required: z.boolean().optional(),
  max_length: z.number().int().positive().max(8000).optional(),
  sensitive: z.boolean().optional(),
});

export const clarifyEnvelopeSchema = z.object({
  envelope_kind: z.literal(CLARIFY_ENVELOPE_KIND),
  schema_version: z.literal(CLARIFY_SCHEMA_VERSION),
  request_id: z.string().uuid(),
  agent_slug: z.string().min(1).max(80),
  intro: z.string().max(600).optional(),
  questions: z.array(questionSchema).min(1).max(MAX_QUESTIONS),
  submit_label: z.string().max(60).optional(),
});

export type ClarifyOption = z.infer<typeof optionSchema>;
export type ClarifyQuestion = z.infer<typeof questionSchema>;
export type ClarifyEnvelope = z.infer<typeof clarifyEnvelopeSchema>;

export type RawClarifyInput = Record<string, unknown>;

export type BuildClarifyResult = {
  envelope: ClarifyEnvelope;
  bodyText: string;
  degraded: boolean;
  stripped: ClarifyStripCounts;
};

function stampRequestId(): string {
  return randomUUID();
}

export function synthesizeClarifyMarkdown(envelope: ClarifyEnvelope): string {
  const lines: string[] = [];
  lines.push(envelope.intro?.trim() || "I need a few details before I continue.");
  lines.push("");
  envelope.questions.forEach((q, i) => {
    lines.push(`${i + 1}. ${q.text.trim()}`);
  });
  return lines.join("\n");
}

export const GENERIC_CLARIFY_INTRO = "I have a few questions before I continue:";

export function synthesizeClarifyBubbleText(envelope: ClarifyEnvelope): string {
  const intro = envelope.intro?.trim();
  return intro && intro.length > 0 ? intro : GENERIC_CLARIFY_INTRO;
}

const QUESTION_LIST_BOUNDARY =
  /(?:^|\n)[ \t]*\*{0,2}\d+[.)]\*{0,2}(?:[ \t]|\*|$)|(?:^|\n)[ \t]*##+[ \t]*clarif/i;
const HAS_LIST_MARKER = /(?:^|\n)[ \t]*\*{0,2}\d+[.)]/;
export function trimToClarifyIntro(markdown: string): string {
  if (typeof markdown !== "string") return GENERIC_CLARIFY_INTRO;
  const m = markdown.match(QUESTION_LIST_BOUNDARY);
  const prefix = (m && m.index != null ? markdown.slice(0, m.index) : markdown)
    .replace(/^##+\s.*\n?/, "")
    .trim();
  if (prefix.length < 20 || HAS_LIST_MARKER.test(prefix)) {
    return GENERIC_CLARIFY_INTRO;
  }
  return prefix;
}

function buildFreeFormEnvelope(
  agentSlug: string,
  questions: string[],
  intro?: string,
): ClarifyEnvelope {
  const qs = questions
    .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
    .slice(0, MAX_QUESTIONS)
    .map((q, i) => ({
      id: `q${i + 1}`,
      text: q.trim().slice(0, 1000),
      header: `Q${i + 1}`,
      type: "text" as const,
      options: [],
      allow_other: true,
      max_length: MAX_TEXT_LEN,
    }));
  const safeIntro =
    typeof intro === "string" && intro.trim().length > 0
      ? intro.trim().slice(0, 600)
      : undefined;
  return {
    envelope_kind: CLARIFY_ENVELOPE_KIND,
    schema_version: CLARIFY_SCHEMA_VERSION,
    request_id: stampRequestId(),
    agent_slug: agentSlug,
    intro: safeIntro,
    questions:
      qs.length > 0
        ? qs
        : [
            {
              id: "q1",
              text: "Could you share a bit more detail so I can continue?",
              header: "Detail",
              type: "text" as const,
              options: [],
              allow_other: true,
              max_length: MAX_TEXT_LEN,
            },
          ],
  };
}

export function fromLegacyStringQuestions(
  agentSlug: string,
  questions: string[],
  intro?: string,
): BuildClarifyResult {
  const envelope = buildFreeFormEnvelope(agentSlug, questions, intro);
  return { envelope, bodyText: synthesizeClarifyMarkdown(envelope), degraded: false, stripped: { no_prov: 0, bad_source: 0, sensitive: 0 } };
}

export const SENSITIVE_SLUGS: ReadonlySet<string> = new Set([
  "dispute-response",
]);

const SENSITIVE_RE =
  /\b(refund|payout|chargeback|charge|dispute|billing|invoice|price|pricing|credit|balance|withdrawal|payment|bank|tax|delete|deletion|remove|suspend|ban|password|api[ _-]?key|secret|permission|account access)\b|\$/i;

export function clarifyTextLooksSensitive(text: string): boolean {
  return SENSITIVE_RE.test(text);
}

export function isQuestionSensitive(
  q: ClarifyQuestion,
  agentSlug: string,
): boolean {
  if (q.sensitive === true) return true;
  if (SENSITIVE_SLUGS.has(agentSlug)) return true;
  const haystack = [q.text, q.header, q.why ?? "", ...q.options.map((o) => o.label)].join(" ");
  return clarifyTextLooksSensitive(haystack);
}

export function provenanceIsStructurallyValid(opt: ClarifyOption): boolean {
  const p = opt.provenance;
  return !!p && typeof p.source_id === "string" && p.source_id.length > 0;
}

export type ClarifyStripCounts = { no_prov: number; bad_source: number; sensitive: number };

function applyPrefillGuard(
  env: ClarifyEnvelope,
  agentSlug: string,
  realHitIds: ReadonlySet<string>,
): { envelope: ClarifyEnvelope; stripped: ClarifyStripCounts } {
  const stripped: ClarifyStripCounts = { no_prov: 0, bad_source: 0, sensitive: 0 };
  const questions = env.questions.map((q) => {
    const sensitive = isQuestionSensitive(q, agentSlug);
    const options = q.options.map((o) => {
      if (!o.prefill && !o.recommended) return o;
      const p = o.provenance;
      const provValid =
        !!p &&
        p.source_type === "memory" &&
        typeof p.source_id === "string" &&
        realHitIds.has(p.source_id);
      if (!provValid) {
        if (p && (p.source_type !== "memory" || (p.source_id && !realHitIds.has(p.source_id)))) {
          stripped.bad_source += 1;
        } else {
          stripped.no_prov += 1;
        }
        return { ...o, prefill: false, recommended: false };
      }
      if (sensitive && o.prefill) {
        stripped.sensitive += 1;
        return { ...o, prefill: false };
      }
      return o;
    });
    return { ...q, options };
  });
  return { envelope: { ...env, questions }, stripped };
}

export function buildClarifyEnvelope(args: {
  agentSlug: string;
  rawInput: RawClarifyInput;
  realHitIds?: ReadonlySet<string>;
}): BuildClarifyResult {
  const { agentSlug, rawInput } = args;
  const realHitIds = args.realHitIds ?? new Set<string>();

  const candidate = {
    ...rawInput,
    envelope_kind: CLARIFY_ENVELOPE_KIND,
    schema_version: CLARIFY_SCHEMA_VERSION,
    request_id: stampRequestId(),
    agent_slug: agentSlug,
  };

  const parsed = clarifyEnvelopeSchema.safeParse(candidate);
  if (parsed.success) {
    const guarded = applyPrefillGuard(parsed.data, agentSlug, realHitIds);
    return {
      envelope: guarded.envelope,
      bodyText: synthesizeClarifyMarkdown(guarded.envelope),
      degraded: false,
      stripped: guarded.stripped,
    };
  }

  const salvaged = salvageQuestionText(rawInput);
  const envelope = buildFreeFormEnvelope(
    agentSlug,
    salvaged,
    typeof rawInput.intro === "string" ? rawInput.intro : undefined,
  );
  return { envelope, bodyText: synthesizeClarifyMarkdown(envelope), degraded: true, stripped: { no_prov: 0, bad_source: 0, sensitive: 0 } };
}

function salvageQuestionText(rawInput: RawClarifyInput): string[] {
  const qs = rawInput.questions;
  if (!Array.isArray(qs)) return [];
  return qs
    .map((q) => {
      if (typeof q === "string") return q;
      if (q && typeof q === "object" && typeof (q as { text?: unknown }).text === "string") {
        return (q as { text: string }).text;
      }
      return "";
    })
    .filter((t): t is string => t.trim().length > 0);
}
