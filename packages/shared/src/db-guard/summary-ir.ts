import { z } from "zod";

export const MAX_IN_VALUES = 20;

const FIELD = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]{0,127}$/);
const SCALAR = z.union([z.string().max(256), z.number().finite(), z.boolean()]);

export const SummaryRequest = z
  .object({
    table: FIELD,
    measures: z
      .array(
        z.union([
          z.object({ fn: z.literal("count") }).strict(),
          z.object({ fn: z.enum(["sum", "avg", "min", "max"]), field: FIELD }).strict(),
        ]),
      )
      .min(1)
      .max(8),
    group_by: z
      .array(z.object({ field: FIELD, bucket: z.enum(["day", "week", "month"]).optional() }).strict())
      .max(3)
      .default([]),
    filters: z
      .array(
        z
          .object({
            field: FIELD,
            op: z.enum(["eq", "gt", "gte", "lt", "lte", "in", "is_null"]),
            value: z.union([SCALAR, z.array(SCALAR).max(MAX_IN_VALUES)]).optional(),
          })
          .strict(),
      )
      .max(10)
      .default([]),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();
export type SummaryRequest = z.infer<typeof SummaryRequest>;

export type SummaryMode = "cloud" | "totals_only";

export const MIN_GROUP_SIZE = 5;

export const TOTALS_ONLY_LIMITATION_NOTE =
  "Totals only stops raw rows leaving your network. Combining many totals can still reveal details, so block any field that must never leave.";
