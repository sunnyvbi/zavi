
import { z } from "zod";

const tierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type FundraisingTier = z.infer<typeof tierSchema>;

const optionalStr = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => v ?? "");

const channelSegmentSchema = z.enum([
  "email-ready",
  "linkedin-only",
  "warm-intro",
  "missing-contact",
  "do-not-contact",
]);
export type FundraisingChannelSegment = z.infer<typeof channelSegmentSchema>;

const copyVariantsSchema = z.object({
  cold_email: z
    .object({
      subject: optionalStr(200),
      body: optionalStr(8000),
    })
    .optional(),
  warm_intro_blurb: optionalStr(1500),
  linkedin_dm: optionalStr(1500),
  followup_1: optionalStr(2000),
  followup_2: optionalStr(2000),
});
export type FundraisingCopyVariants = z.infer<typeof copyVariantsSchema>;

const investorSchema = z.object({
  firm: z.string().max(300).default(""),
  name: optionalStr(200),
  tier: tierSchema,
  channel_segment: channelSegmentSchema.optional(),
  copy_variants: copyVariantsSchema.optional(),
  focus: optionalStr(600),
  stage_focus: optionalStr(300),
  check_size: optionalStr(200),
  fit_rationale: optionalStr(600),
  contact_hint: optionalStr(600),
  suggested_message: optionalStr(1500),
  source: z.enum(["investor_db", "web"]).default("investor_db"),
  source_url: optionalStr(600),
  evidence_text: optionalStr(600),
  source_kind: z
    .enum([
      "investor_directory",
      "investor_listicle",
      "fund_profile",
      "portfolio_or_news",
      "other",
    ])
    .optional(),
  evidence_span: optionalStr(400),
});

export const adviceBasisSchema = z.enum([
  "brain",
  "investor_db",
  "phase_state",
  "playbook",
]);
export type FundraisingAdviceBasis = z.infer<typeof adviceBasisSchema>;

const adviceItemSchema = z.object({
  key: optionalStr(120),
  status: z.enum(["good", "watch", "gap"]).optional(),
  verdict: z.string().max(2000),
  basis: adviceBasisSchema,
  source_ref: optionalStr(400),
});
export type FundraisingAdviceItem = z.infer<typeof adviceItemSchema>;

export const ADVICE_TOPICS = [
  "readiness",
  "round_design",
  "meeting_prep",
  "objection",
] as const;
export type FundraisingAdviceTopicValue = (typeof ADVICE_TOPICS)[number];

export const adviceSchema = z.object({
  topic: z.enum(ADVICE_TOPICS).optional(),
  readiness: z.array(adviceItemSchema).max(12).optional(),
  round_design: z
    .object({
      ask: optionalStr(200),
      cap: optionalStr(200),
      dilution_pct: optionalStr(40),
      runway_months: optionalStr(40),
      verdict: optionalStr(2000),
      basis: adviceBasisSchema,
      source_ref: optionalStr(400),
    })
    .optional(),
  meeting_prep: z
    .object({
      partner: optionalStr(200),
      thesis: optionalStr(2000),
      objections: z.array(adviceItemSchema).max(6).optional(),
      questions: z.array(z.string().max(400)).max(6).optional(),
    })
    .optional(),
  objection_answer: adviceItemSchema.optional(),
  dos: z.array(z.string().max(400)).max(8).optional(),
  donts: z.array(z.string().max(400)).max(8).optional(),
});
export type FundraisingAdvice = z.infer<typeof adviceSchema>;

export const DEEP_NO_PERSON_REFUSAL =
  "I won't write a message to a person I couldn't verify — name the partner first.";

const deepSourceSchema = z.object({
  url: optionalStr(600),
  claim: optionalStr(600),
});
export type FundraisingDeepSource = z.infer<typeof deepSourceSchema>;

const deepPushbackSchema = z.object({
  objection: optionalStr(600),
  honest_answer: optionalStr(2000),
});
export type FundraisingDeepPushback = z.infer<typeof deepPushbackSchema>;

export const deepDossierSchema = z.object({
  firm: z.string().max(300).default(""),
  name: optionalStr(200),
  identity_key: optionalStr(400),
  who_they_are: optionalStr(6000),
  why_this_company: optionalStr(6000),
  how_to_reach: z
    .object({
      warm_path: optionalStr(2000),
      best_channel: optionalStr(300),
      who_to_go_through: optionalStr(1000),
    })
    .optional(),
  draft_message: optionalStr(6000),
  no_draft_reason: optionalStr(600),
  pushbacks: z.array(deepPushbackSchema).max(8).default([]),
  sources: z.array(deepSourceSchema).max(40).default([]),
});
export type FundraisingDeepDossier = z.infer<typeof deepDossierSchema>;

export const fundraisingEnvelopeSchema = z.object({
  stage: optionalStr(60),
  stage_rationale: optionalStr(600),
  investors: z.array(investorSchema).max(300).default([]),
  mode: z.enum(["source", "strategy", "advise", "deep"]).optional(),
  deep: deepDossierSchema.optional(),
  advice: adviceSchema.optional(),
  cadence: optionalStr(1000),
  rollout_plan: optionalStr(4000),
  rendered_markdown: z.string().min(1).max(40000),
});

export type FundraisingEnvelope = z.infer<typeof fundraisingEnvelopeSchema>;
export type FundraisingInvestor = z.infer<typeof investorSchema>;
