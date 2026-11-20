import { z } from "zod";

const HTTP_URL = z
  .string()
  .url()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), "url must be http(s)");

export const sourceSchema = z.object({
  n: z.number().int().min(1),
  title: z.string().min(1).max(400),
  url: HTTP_URL,
  accessed_at: z.string().min(1).max(50),
  source_type: z.string().max(60).optional(),
});
export type Source = z.infer<typeof sourceSchema>;

export const validationChipSchema = z.object({
  tier: z.enum(["validated", "inferred", "assumption", "high-risk"]),
  text: z.string().min(1).max(600),
  supporting_source_indices: z.array(z.number().int().min(1)).max(40).default([]),
});
export type ValidationChip = z.infer<typeof validationChipSchema>;

export const statTileSchema = z.object({
  value: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
  citation: z.number().int().min(1).optional(),
  prior_value: z.string().max(60).optional(),
  as_of: z.string().max(40).optional(),
});

export const themeBarSchema = z.object({
  label: z.string().min(1).max(160),
  pct: z.number().min(0).max(100),
  quote: z.string().max(600).optional(),
  citations: z.array(z.number().int().min(1)).max(40).default([]),
});

export const sentimentSchema = z
  .object({ pos: z.number().min(0).max(100), neu: z.number().min(0).max(100), neg: z.number().min(0).max(100) })
  .refine((s) => Math.round(s.pos + s.neu + s.neg) === 100, "sentiment pos+neu+neg must equal 100");
export type Sentiment = z.infer<typeof sentimentSchema>;

const cites = z.array(z.number().int().min(1)).max(40).default([]);

export const personaCardSchema = z.object({
  index: z.number().int().min(1),
  name: z.string().min(1).max(120),
  tagline: z.string().min(1).max(200),
  fields: z.object({
    primary_need: z.string().max(300),
    pain_point: z.string().max(300),
    behavior: z.string().max(300),
    valued_feature: z.string().max(300),
    source_of_awareness: z.string().max(300),
  }),
  buy_likelihood: z.number().int().min(0).max(5),
  commentary_md: z.string().max(1200),
  citations: cites,
});

export const lensFindingSchema = z.object({
  lens: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
  stat_tiles: z.array(statTileSchema).max(8).optional(),
  theme_bars: z.array(themeBarSchema).max(10).optional(),
  sentiment: sentimentSchema.optional(),
  takeaways: z.array(z.string().max(600)).max(12).default([]),
  prose_md: z.string().max(6000).default(""),
  sources: cites,
  provenance: z
    .object({
      fetched_urls: z.array(z.string().max(2048)).max(40).default([]),
      fetch_errors: z.number().int().min(0).default(0),
      poisoned: z.boolean().default(false),
      reason: z.string().max(400).optional(),
    })
    .default({ fetched_urls: [], fetch_errors: 0, poisoned: false }),
});
export type LensFinding = z.infer<typeof lensFindingSchema>;

export const blockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hero"),
    title: z.string().min(1).max(300),
    subtitle: z.string().max(400).optional(),
    big_stat: z.object({ value: z.string().max(60), label: z.string().max(160) }).optional(),
  }),
  z.object({
    type: z.literal("exec_summary"),
    pull_quote: z.string().max(800).optional(),
    stat_tiles: z.array(statTileSchema).max(8).optional(),
    prose_md: z.string().max(6000),
    citations: cites,
  }),
  z.object({ type: z.literal("stat_tiles"), tiles: z.array(statTileSchema).max(8) }),
  z.object({ type: z.literal("persona_cards"), cards: z.array(personaCardSchema).max(6) }),
  z.object({
    type: z.literal("qa_grid"),
    items: z.array(z.object({ question: z.string().max(300), answer_md: z.string().max(2000), citations: cites })).max(8),
  }),
  z.object({ type: z.literal("theme_bars"), title: z.string().max(160).optional(), bars: z.array(themeBarSchema).max(10) }),
  z.object({ type: z.literal("sentiment_meter"), sentiment: sentimentSchema }),
  z.object({
    type: z.literal("cards_grid"),
    cards: z
      .array(
        z.object({
          title: z.string().max(200),
          body_md: z.string().max(2000),
          meta: z.object({ label: z.string().max(80), value: z.string().max(80) }).optional(),
          citations: cites,
        }),
      )
      .max(12),
  }),
  z.object({
    type: z.literal("competitive_table"),
    rows: z
      .array(
        z.object({
          brand: z.string().max(200),
          price: z.string().max(120).optional(),
          positioning: z.string().max(600),
          gap: z.string().max(600),
          citations: cites,
        }),
      )
      .max(12),
  }),
  z.object({
    type: z.literal("material_moves"),
    items: z
      .array(
        z.object({
          competitor: z.string().max(120),
          move: z.string().max(300),
          why_now: z.string().max(600),
          citations: cites,
        }),
      )
      .max(8),
  }),
  z.object({
    type: z.literal("gap_list"),
    items: z.array(z.object({ category: z.string().max(80), title: z.string().max(200), body_md: z.string().max(2000), citations: cites })).max(12),
  }),
  z.object({
    type: z.literal("recommendations"),
    items: z
      .array(z.object({ index: z.number().int().min(1), label: z.string().max(80), title: z.string().max(200), body_md: z.string().max(2000), citations: cites }))
      .max(12),
  }),
  z.object({
    type: z.literal("risks"),
    items: z.array(z.object({ tone: z.enum(["warn", "info"]), title: z.string().max(200), body_md: z.string().max(2000), citations: cites })).max(12),
  }),
  z.object({ type: z.literal("validation"), chips: z.array(validationChipSchema).max(20) }),
  z.object({ type: z.literal("source_list"), sources: z.array(sourceSchema).max(60) }),
  z.object({ type: z.literal("markdown"), body_md: z.string().max(8000) }),
  z.object({
    type: z.literal("table"),
    title: z.string().max(200).optional(),
    columns: z.array(z.string().max(120)).max(12),
    rows: z.array(z.array(z.string().max(800)).max(20)).max(40),
    citations: cites,
  }),
]);
export type Block = z.infer<typeof blockSchema>;
