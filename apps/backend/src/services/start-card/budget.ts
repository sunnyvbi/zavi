
import { getNumberSetting } from "@/services/settings";
import { startCardRpc } from "@/services/tenant-client";

export const START_CARD_RESERVE_USD = 1.0;

const LAUNCH_WEEK_FIRST = "2026-10-13";
const LAUNCH_WEEK_LAST = "2026-10-19";
const LAUNCH_WEEK_CEILING_USD = 900;
const DEFAULT_CEILING_USD = 50;

export function budgetDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function defaultDailyCeilingUsd(now: Date = new Date()): number {
  const day = budgetDay(now);
  return day >= LAUNCH_WEEK_FIRST && day <= LAUNCH_WEEK_LAST ? LAUNCH_WEEK_CEILING_USD : DEFAULT_CEILING_USD;
}

export async function resolveDailyCeilingUsd(now: Date = new Date()): Promise<number> {
  const configured = await getNumberSetting("start_card_daily_usd");
  return configured > 0 ? configured : defaultDailyCeilingUsd(now);
}

export type ReserveResult =
  | { ok: true; day: string; amount: number }
  | { ok: false; reason: "full" | "error" };

export async function reserveCardBudget(now: Date = new Date()): Promise<ReserveResult> {
  const day = budgetDay(now);
  try {
    const ceiling = await resolveDailyCeilingUsd(now);
    const { data, error } = await startCardRpc("start_card_budget_reserve", {
      p_day: day,
      p_amount: START_CARD_RESERVE_USD,
      p_ceiling: ceiling,
    });
    if (error) throw new Error(error.message);
    return data === true ? { ok: true, day, amount: START_CARD_RESERVE_USD } : { ok: false, reason: "full" };
  } catch (e) {
    console.error(`[start-card] budget reserve failed, refusing: ${(e as Error).message}`);
    return { ok: false, reason: "error" };
  }
}

async function adjust(day: string, delta: number): Promise<void> {
  if (delta === 0) return;
  const { error } = await startCardRpc("start_card_budget_adjust", { p_day: day, p_delta: delta });
  if (error) throw new Error(`start_card_budget_adjust failed: ${error.message}`);
}

export async function releaseCardBudget(day: string, reserved: number): Promise<void> {
  await adjust(day, -reserved);
}

export async function settleCardBudget(day: string, reserved: number, actual: number): Promise<void> {
  const spent = Math.max(0, Number.isFinite(actual) ? actual : reserved);
  await adjust(day, Number((spent - reserved).toFixed(4)));
}
