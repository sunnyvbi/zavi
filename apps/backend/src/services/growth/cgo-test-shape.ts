import { z } from "zod";

export const line = (max: number) => z.string().transform((s) => s.trim().replace(/\s+/g, " ").slice(0, max)).pipe(z.string().min(1));

export const moveTestSchema = z.object({
  variable: line(120),
  budget_usd: z.number().finite().nonnegative().optional(),
  envelope: z.literal("server").optional().catch(undefined),
  baseline: line(160),
  baseline_daily_usd: z.number().finite().positive().max(1_000_000).optional(),
  success_if: line(160),
  stop_if: line(160).optional(),
  stop_rule: z.enum(["budget_or_deadline", "business_loss"]).optional(),
  readout_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type MoveTest = z.infer<typeof moveTestSchema>;

export function parseMoveTest(v: unknown): MoveTest | undefined {
  const r = moveTestSchema.safeParse(v);
  return r.success ? r.data : undefined;
}

export function parseBudgetTest(v: unknown): { test?: MoveTest; baselineInvalid: boolean; unreadable: boolean } {
  if (v == null) return { baselineInvalid: false, unreadable: false };
  const test = parseMoveTest(v);
  if (test) return { test, baselineInvalid: false, unreadable: false };
  if (typeof v === "object" && !Array.isArray(v) && "baseline_daily_usd" in v) {
    const { baseline_daily_usd: _b, ...rest } = v as Record<string, unknown>;
    const loose = parseMoveTest(rest);
    if (loose) return { test: loose, baselineInvalid: true, unreadable: false };
  }
  return { baselineInvalid: false, unreadable: true };
}
