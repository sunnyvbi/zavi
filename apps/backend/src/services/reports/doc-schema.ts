
import { z } from "zod";

const shortText = z.string().trim().min(1).max(200);

export const docStepSchema = z.object({
  title: shortText.describe("What happens at this step, as a short phrase."),
  body: z.string().trim().max(600).optional().describe("One or two sentences of detail."),
  meta: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe("A code anchor or timing note rendered in monospace, e.g. 'calculateHostPayment · 3 AM cron'."),
});

export const docLedgerRowSchema = z.object({
  label: shortText.describe("Left-hand label, e.g. 'Platform fee'."),
  value: shortText.describe("Right-hand value, e.g. '-$183.60'. Pre-formatted — the renderer does not do maths."),
  note: z.string().trim().max(200).optional().describe("Small grey sub-label under the label."),
  emphasis: z
    .enum(["normal", "total", "positive", "negative"])
    .optional()
    .describe("'total' bolds the row; 'positive'/'negative' colour the value."),
});

export const docCalloutSchema = z.object({
  tone: z.enum(["info", "warn", "success"]).describe("Controls colour only."),
  body: z.string().trim().min(1).max(600).describe("The one thing the reader must not miss."),
});

export const docSectionSchema = z.object({
  heading: shortText,
  body_markdown: z
    .string()
    .trim()
    .max(6000)
    .optional()
    .describe("Paragraphs separated by blank lines. **bold** and '- ' bullets supported."),
  steps: z.array(docStepSchema).min(1).max(12).optional().describe("An ORDERED mechanism. Rendered as a numbered pipeline."),
  ledger: z.array(docLedgerRowSchema).min(1).max(20).optional().describe("A worked example. Rendered as a label/value table."),
  callout: docCalloutSchema.optional(),
  table: z
    .object({
      columns: z.array(shortText).min(1).max(6),
      rows: z.array(z.array(z.string().trim().max(300))).min(1).max(60),
    })
    .optional()
    .describe("A plain table. Every row must have exactly as many cells as there are columns."),
});

export const renderDocInputSchema = z.object({
  title: shortText.describe("Shown at the top of the page and used for the filename."),
  subtitle: z
    .string()
    .trim()
    .max(300)
    .optional()
    .describe("One line under the title saying what this document is for."),
  eyebrow: z
    .string()
    .trim()
    .max(80)
    .optional()
    .describe("Small uppercase kicker above the title, e.g. 'Checkout · Money path'."),
  sections: z.array(docSectionSchema).min(1).max(20),
});

export type RenderDocInput = z.infer<typeof renderDocInputSchema>;
export type DocSection = z.infer<typeof docSectionSchema>;
