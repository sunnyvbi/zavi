
import { z } from "zod";

const digestSectionsSchema = z
  .object({
    weekly_summary: z.string(),
    anomalies: z.string(),
    proposed_reallocation: z.string(),
    new_tests: z.string(),
    risks: z.string(),
    so_what_trend: z.string(),
    confidence: z.string(),
    blind_spots: z.string(),
  })
  .partial()
  .optional()
  .catch(() => undefined);

export const growthDigestSchema = z.object({
  rendered_markdown: z.string(),
  machine_digest: z.string().optional(),
  digest_sections: digestSectionsSchema,
});

export type GrowthDigest = z.infer<typeof growthDigestSchema>;
