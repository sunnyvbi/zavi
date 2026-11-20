
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { computeScorecard } from "@/services/memory/takes-service";

const querySchema = z
  .object({
    tenant_id: z.string().uuid(),
    holder_type: z.enum(["tenant", "agent", "user", "entity"]).optional(),
    holder_ref: z.string().min(1).max(200).optional(),
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
  })
  .strict();

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 365;
const DEFAULT_SINCE_DAYS = 90;

export async function staffTakesScorecard(req: Request, res: Response): Promise<void> {
  assertStaff(req);

  let q: z.infer<typeof querySchema>;
  try {
    q = querySchema.parse(req.query);
  } catch (e) {
    res.status(400).json({ error: { code: "invalid_query", message: (e as Error).message } });
    return;
  }

  const since = q.since ?? new Date(Date.now() - DEFAULT_SINCE_DAYS * MS_PER_DAY).toISOString();
  const until = q.until ?? new Date().toISOString();
  if (new Date(until).getTime() < new Date(since).getTime()) {
    res.status(400).json({ error: { code: "invalid_range", message: "until < since" } });
    return;
  }
  const rangeDays = (new Date(until).getTime() - new Date(since).getTime()) / MS_PER_DAY;
  if (rangeDays > MAX_RANGE_DAYS) {
    res.status(400).json({
      error: { code: "range_too_large", message: `range > ${MAX_RANGE_DAYS} days` },
    });
    return;
  }

  try {
    const report = await computeScorecard(q.tenant_id, {
      holder_type: q.holder_type,
      holder_ref: q.holder_ref,
      since,
      until,
    });
    if (report.brier_n === 0 && report.actual_rate_n === 0) {
      res.status(404).json({
        error: {
          code: "no_data_yet",
          message: "No resolved bets in window for this tenant.",
        },
      });
      return;
    }
    res.json({ ok: true, report });
  } catch (e) {
    res
      .status(500)
      .json({ error: { code: "scorecard_failed", message: (e as Error).message } });
  }
}
