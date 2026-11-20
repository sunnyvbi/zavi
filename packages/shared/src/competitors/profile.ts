import { z } from "zod";

export const COMPETITOR_THREAT_LEVELS = ["low", "medium", "high"] as const;

export const competitorProfileInputSchema = z.object({
  website: z.string().url().max(2048),
  company_name: z.string().trim().min(1).max(200),
  industry: z.string().trim().max(200).default(""),
  positioning: z.string().trim().max(1200).default(""),
  target_audience: z.string().trim().max(600).default(""),
  pricing: z.string().trim().max(400).default(""),
  acquisition_channels: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  threat_level: z.enum(COMPETITOR_THREAT_LEVELS),
});

export type CompetitorProfileInput = z.infer<typeof competitorProfileInputSchema>;

export type CompetitorResearchResult = CompetitorProfileInput & {
  source_urls: string[];
};

