import { z } from "zod";

export const COMPANY_SOCIAL_PLATFORMS = [
  "linkedin",
  "x",
  "facebook",
  "instagram",
  "youtube",
  "tiktok",
] as const;

export const companySocialPlatformSchema = z.enum(COMPANY_SOCIAL_PLATFORMS);

export const companySocialProfileSchema = z.object({
  platform: companySocialPlatformSchema,
  url: z.string().url().max(2048).nullable(),
  followers: z.string().trim().max(40).nullable(),
});

export const companyProfileInputSchema = z.object({
  website: z.string().url().max(2048),
  industry: z.string().trim().max(200).default(""),
  category: z.string().trim().max(200).default(""),
  founded: z.string().trim().max(40).default(""),
  location: z.string().trim().max(200).default(""),
  social_profiles: z.array(companySocialProfileSchema).max(8).default([]),
});

export type CompanySocialPlatform = z.infer<typeof companySocialPlatformSchema>;
export type CompanySocialProfile = z.infer<typeof companySocialProfileSchema>;
export type CompanyProfileInput = z.infer<typeof companyProfileInputSchema>;

export type CompanyResearchResult = CompanyProfileInput & {
  source_urls: string[];
};

export const COMPANY_FILLABLE_FIELD_KEYS = [
  "primary_icp",
  "buyer",
  "average_customer_value",
  "target_industries",
  "customer_segments",
  "personas",
  "avg_deal_size",
  "gross_margin",
  "net_revenue_retention",
  "customer_lifetime_value",
  "ltv_cac",
] as const;

export type CompanyFillableFieldKey = (typeof COMPANY_FILLABLE_FIELD_KEYS)[number];

export const COMPANY_FIELD_CONFIDENCES = ["low", "medium", "high"] as const;
export type CompanyFieldConfidence = (typeof COMPANY_FIELD_CONFIDENCES)[number];

export const COMPANY_FIELD_METHODS = ["recorded", "calculated", "inferred"] as const;
export type CompanyFieldMethod = (typeof COMPANY_FIELD_METHODS)[number];

export type CompanyFieldInput = { name: string; value: string };

export type CompanyEstimatedField = {
  key: CompanyFillableFieldKey;
  value: string;
  method: CompanyFieldMethod;
  source: string;
  formula: string;
  inputs: CompanyFieldInput[];
  assumptions: string;
  caveats: string;
  confidence: CompanyFieldConfidence | null;
  evidence: string[];
};
