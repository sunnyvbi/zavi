
import { z } from "zod";

const SuggestedDispatchSchema = z.object({
  target_agent_slug: z.string().min(1),
  intent: z.string().min(1).max(2000),
});

const Tier1Schema = z.object({
  title: z.string(),
  summary: z.string(),
  evidence: z.array(z.string()),
  promotion_reason: z
    .enum(["rar", "legal", "fraud-correlation", "safety"])
    .optional(),
  estimated_impact_usd: z.number().optional(),
  suggested_dispatch: SuggestedDispatchSchema.optional(),
});

const Tier2Schema = z.object({
  area: z.string(),
  summary: z.string(),
  metrics: z.record(z.string(), z.unknown()).optional(),
});

const Tier3Schema = z.object({
  title: z.string(),
  evidence: z.array(z.string()),
  why_below_t1: z.string(),
});

const Tier4Schema = z.object({
  category: z.string(),
  summary: z.string(),
});

const WeeklyPrioritySchema = z.object({
  agent_slug: z.string(),
  priority: z.string(),
});

export const digestSchema = z.object({
  tier1: z.array(Tier1Schema),
  tier2: z.array(Tier2Schema),
  tier3: z.array(Tier3Schema),
  tier4: z.array(Tier4Schema),
  rendered_markdown: z.string(),
  weekly_priorities: z.array(WeeklyPrioritySchema).optional(),
});

export type Digest = z.infer<typeof digestSchema>;
