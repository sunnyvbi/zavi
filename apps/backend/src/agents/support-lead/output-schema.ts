import { z } from "zod";

const supportTriageCardSchema = z
  .object({
    signal_ref: z.string().min(1),
    class: z.enum(["support", "dispute", "fraud", "payout", "other"]),
    severity: z.enum(["P0", "P1", "P2", "P3"]),
    next_step: z.enum([
      "auto_resolve",
      "escalate_founder",
      "route_specialist",
      "no_op",
    ]),
    specialist_slug: z.string().min(1).nullable(),
    evidence: z.array(z.string().min(1)).min(1),
    confidence: z.number().min(0).max(1),
  })
  .superRefine((card, ctx) => {
    if (card.next_step === "route_specialist" && !card.specialist_slug) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["specialist_slug"],
        message: "route_specialist requires a non-null specialist_slug",
      });
    }
    if (card.confidence < 0.6 && card.next_step === "auto_resolve") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["next_step"],
        message: "confidence < 0.6 may not auto_resolve",
      });
    }
  });

export const supportTriageSchema = z.object({
  rendered_markdown: z.string(),
  cards: z.array(supportTriageCardSchema).optional().default([]),
});

export type SupportTriageOutput = z.infer<typeof supportTriageSchema>;
