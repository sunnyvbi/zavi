
import { z } from "zod";

export const CONTENT_DECISIONS = [
  "reword",
  "restructure",
  "remove",
  "change_format",
  "no_content",
  "add_microcopy",
] as const;
export const contentDecisionSchema = z.enum(CONTENT_DECISIONS);
export type ContentDecision = (typeof CONTENT_DECISIONS)[number];

export const evidenceItemSchema = z.object({
  source: z.string(),
  detail: z.string(),
});
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

const contentDesignOptionalFields = {
  user_need: z.string().optional(),
  evidence: z.array(evidenceItemSchema).optional(),
  content_decision: contentDecisionSchema.optional(),
  hypothesis: z.string().optional(),
  success_signal: z.string().optional(),
} satisfies z.ZodRawShape;

const sharedRecommendationFields = {
  title: z.string(),
  meta_description: z.string().optional(),
  target_keyword: z.string().optional(),
  body: z.string(),
  rationale: z.string().optional(),
  expected_impact: z.string().optional(),
  ...contentDesignOptionalFields,
} satisfies z.ZodRawShape;

const newBlogPostRecommendationSchema = z.object({
  change_type: z.enum(["new_page", "new_blog_post"]),
  slug: z.string(),
  ...sharedRecommendationFields,
});

const newLandingPageRecommendationSchema = z.object({
  change_type: z.literal("new_landing_page"),
  path: z.string(),
  ...sharedRecommendationFields,
});

const existingContentRecommendationSchema = z.object({
  change_type: z.enum([
    "improve_existing_page",
    "refresh_existing_post",
    "add_internal_links",
  ]),
  path: z.string(),
  ...sharedRecommendationFields,
});

const componentCopyRecommendationSchema = z.object({
  change_type: z.literal("component_copy"),
  path: z.string(),
  edits: z
    .array(
      z.object({
        old_string: z.string(),
        new_string: z.string(),
      }),
    )
    .min(1),
  user_need: z.string(),
  evidence: z.array(evidenceItemSchema).min(1),
  content_decision: contentDecisionSchema,
  hypothesis: z.string().optional(),
  success_signal: z.string().optional(),
  title: z.string().optional(),
  rationale: z.string().optional(),
});

export type ContentSeoComponentCopyRecommendation = z.infer<
  typeof componentCopyRecommendationSchema
>;

export const contentSeoRecommendationSchema = z.discriminatedUnion("change_type", [
  newBlogPostRecommendationSchema,
  newLandingPageRecommendationSchema,
  existingContentRecommendationSchema,
  componentCopyRecommendationSchema,
]);

export type ContentSeoRecommendation = z.infer<
  typeof contentSeoRecommendationSchema
>;

export const contentSeoDigestSchema = z.object({
  rendered_markdown: z.string(),
  recommendations: z.array(z.unknown()).optional(),
});

export type ContentSeoDigest = z.infer<typeof contentSeoDigestSchema>;
