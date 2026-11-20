
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

export type FeedbackRow = { rating: number | null; created_by_role: string | null };
export type FeedbackTally = {
  operator_up: number;
  operator_down: number;
  staff_up: number;
  staff_down: number;
};

export function tallyFeedback(rows: FeedbackRow[]): FeedbackTally {
  const t: FeedbackTally = { operator_up: 0, operator_down: 0, staff_up: 0, staff_down: 0 };
  for (const row of rows) {
    const staff = row.created_by_role === "staff";
    if (row.rating === 1) {
      if (staff) t.staff_up++;
      else t.operator_up++;
    } else if (row.rating === -1) {
      if (staff) t.staff_down++;
      else t.operator_down++;
    }
  }
  return t;
}

export async function staffStats(_req: Request, res: Response): Promise<void> {
  assertStaff(_req);
  const sb = serviceClient();
  const since24 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [tenantsHead, runs24h, runs24hFail, decisionsPending, feedback7d] =
    await Promise.all([
      sb.from("tenants").select("id", { head: true, count: "exact" }),
      sb
        .from("agent_runs")
        .select("id", { head: true, count: "exact" })
        .gte("enqueued_at", since24),
      sb
        .from("agent_runs")
        .select("id", { head: true, count: "exact" })
        .in("status", ["failed", "parse_failed", "dispatch_error"])
        .gte("enqueued_at", since24),
      sb
        .from("decisions")
        .select("id", { head: true, count: "exact" })
        .eq("status", "proposed"),
      sb
        .from("agent_feedback")
        .select("id, rating, created_by_role", { count: "exact" })
        .gte("created_at", since7d),
    ]);

  const feedback_7d = tallyFeedback((feedback7d.data ?? []) as FeedbackRow[]);

  res.json({
    tenants: tenantsHead.count ?? 0,
    runs_24h: runs24h.count ?? 0,
    runs_24h_failed: runs24hFail.count ?? 0,
    decisions_pending: decisionsPending.count ?? 0,
    feedback_7d,
  });
}
