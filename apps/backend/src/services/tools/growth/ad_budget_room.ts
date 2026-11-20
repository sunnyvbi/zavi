
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { readMonthCount } from "@/services/decisions/ad-month-counter";
import { recordFiguresFromPull } from "@/services/agents/engine/figure-ledger";

export const AD_BUDGET_ROOM_LEDGER_NAME = "growth__ad_budget_room";

const inputSchema = z.object({}).strict();
const cents = (v: number) => Math.round(v * 100) / 100;

export type AdBudgetRoom =
  | { status: "no_budget" }
  | { status: "unreadable"; why: string }
  | {
      status: "read";
      monthly_usd: number;
      month_cap_usd: number;
      spent_usd: number;
      creator_usd: number;
      running_daily_usd: number;
      pending_daily_usd: number;
      days_left: number;
      projection_usd: number;
      room_usd: number;
      over_by_usd: number;
    };

export const adBudgetRoomTool: ToolSpec = {
  name: "growth_ad_budget_room",
  effect: "read",
  description: "This month's ad budget as every approval counts it: projection at full budgets, room or overrun.",
  input_schema: inputSchema,
  async execute(ctx): Promise<AdBudgetRoom> {
    const r = await readMonthCount(ctx.tenant_id);
    if (!r) return { status: "no_budget" };
    if ("unreadable" in r) return { status: "unreadable", why: r.unreadable };
    const c = r.count;
    const out: AdBudgetRoom = {
      status: "read",
      monthly_usd: c.monthly_usd,
      month_cap_usd: c.month_cap_usd,
      spent_usd: c.spent_usd,
      creator_usd: c.creator_usd,
      running_daily_usd: c.running_daily_usd,
      pending_daily_usd: c.pending_daily_usd,
      days_left: c.days_left,
      projection_usd: c.projection_usd,
      room_usd: Math.max(0, cents(c.month_cap_usd - c.projection_usd)),
      over_by_usd: Math.max(0, cents(c.projection_usd - c.month_cap_usd)),
    };
    if (ctx.run_id) {
      try {
        recordFiguresFromPull(ctx.run_id, JSON.stringify(out), AD_BUDGET_ROOM_LEDGER_NAME);
      } catch {
      }
    }
    return out;
  },
};
