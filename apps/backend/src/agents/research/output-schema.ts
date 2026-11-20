import { z } from "zod";
import { blockSchema, sourceSchema, validationChipSchema, lensFindingSchema } from "./blocks";
import { normalizeRawResearchEnvelope } from "./normalize";

export const RESEARCH_TEMPLATES = ["customer-intel", "competitor-teardown", "landscape", "freeform"] as const;

const reportSchema = z.object({
  kind: z.literal("report"),
  template: z.enum(RESEARCH_TEMPLATES),
  title: z.string().min(1).max(300),
  subtitle: z.string().max(400).optional(),
  query: z.string().min(1).max(4000),
  blocks: z.array(blockSchema).min(1).max(40),
  lenses: z.array(lensFindingSchema).max(8),
  sources: z.array(sourceSchema).max(60),
  validation: z.array(validationChipSchema).max(20),
  failed_lenses: z.array(z.string().max(60)).max(8),
  generated_at: z.string().min(1).max(50),
});

const clarificationSchema = z.object({
  kind: z.literal("clarification"),
  questions: z.array(z.object({ question: z.string().min(1).max(400), why: z.string().min(1).max(400) })).min(2).max(4),
});

export const researchReportSchema = z.discriminatedUnion("kind", [reportSchema, clarificationSchema]);
export type ResearchReport = z.infer<typeof reportSchema>;
export type ResearchEnvelope = z.infer<typeof researchReportSchema>;

export const researchReportEnvelopeSchema = z.preprocess(
  normalizeRawResearchEnvelope,
  researchReportSchema,
);
