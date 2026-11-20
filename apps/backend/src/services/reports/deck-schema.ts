
import { z } from "zod";

export const MAX_SLIDES = 12;
const MAX_DECK_TITLE = 120;
const MAX_DECK_SUBTITLE = 200;
const MAX_HEADING = 120;
const MAX_SUBHEADING = 200;
const MAX_BULLETS = 8;
const MAX_BULLET = 200;
const MAX_BODY = 600;
const MAX_METRICS = 4;
const MAX_METRIC_VALUE = 24;
const MAX_METRIC_LABEL = 100;
const MAX_NOTES = 400;
const MAX_FOOTER = 200;
const MAX_FILENAME = 120;
export const DECK_PROSE_BUDGET = 12_000;

export const deckMetricSchema = z.object({
  value: z.string().min(1).max(MAX_METRIC_VALUE),
  label: z.string().min(1).max(MAX_METRIC_LABEL),
});
export type DeckMetric = z.infer<typeof deckMetricSchema>;

export const deckColumnSchema = z.object({
  heading: z.string().min(1).max(MAX_HEADING),
  bullets: z.array(z.string().min(1).max(MAX_BULLET)).min(1).max(MAX_BULLETS),
});
export type DeckColumn = z.infer<typeof deckColumnSchema>;

export const DECK_LAYOUTS = [
  "title",
  "bullets",
  "statement",
  "metrics",
  "two_column",
] as const;
export type DeckLayout = (typeof DECK_LAYOUTS)[number];

export const deckSlideSchema = z.object({
  heading: z.string().min(1).max(MAX_HEADING),
  subheading: z.string().max(MAX_SUBHEADING).optional(),
  layout: z.enum(DECK_LAYOUTS).optional(),
  bullets: z.array(z.string().min(1).max(MAX_BULLET)).max(MAX_BULLETS).optional(),
  body: z.string().max(MAX_BODY).optional(),
  metrics: z.array(deckMetricSchema).max(MAX_METRICS).optional(),
  columns: z.array(deckColumnSchema).length(2).optional(),
  notes: z.string().max(MAX_NOTES).optional(),
});
export type DeckSlide = z.infer<typeof deckSlideSchema>;

export const renderDeckInputSchema = z
  .object({
    title: z.string().min(1).max(MAX_DECK_TITLE),
    subtitle: z.string().max(MAX_DECK_SUBTITLE).optional(),
    slides: z.array(deckSlideSchema).min(1).max(MAX_SLIDES),
    footer: z.string().max(MAX_FOOTER).optional(),
    filename: z.string().min(1).max(MAX_FILENAME),
    channel_id: z.string().optional(),
    thread_ts: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.slides.length > MAX_SLIDES) {
      return;
    }
    let total = (val.title?.length ?? 0) + (val.subtitle?.length ?? 0) + (val.footer?.length ?? 0);
    for (const s of val.slides) {
      total +=
        s.heading.length +
        (s.subheading?.length ?? 0) +
        (s.body?.length ?? 0) +
        (s.notes?.length ?? 0) +
        (s.bullets ?? []).reduce((a, b) => a + b.length, 0) +
        (s.metrics ?? []).reduce((a, m) => a + m.value.length + m.label.length, 0) +
        (s.columns ?? []).reduce(
          (a, c) => a + c.heading.length + c.bullets.reduce((x, b) => x + b.length, 0),
          0,
        );
    }
    if (total > DECK_PROSE_BUDGET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `deck prose is ${total} chars; the budget is ${DECK_PROSE_BUDGET}. Cut copy or cut slides — slide text is headlines and short lines, not paragraphs. Do NOT retry with the same volume in a second call.`,
      });
    }
  });

export type RenderDeckInput = z.infer<typeof renderDeckInputSchema>;

export function resolveLayout(slide: DeckSlide, index: number): DeckLayout {
  if (slide.layout) return slide.layout;
  if (slide.columns && slide.columns.length === 2) return "two_column";
  if (slide.metrics && slide.metrics.length > 0) return "metrics";
  if (slide.bullets && slide.bullets.length > 0) return "bullets";
  if (index === 0) return "title";
  return "statement";
}
