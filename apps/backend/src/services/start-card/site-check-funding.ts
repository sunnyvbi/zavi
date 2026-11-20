
import { inngest } from "@/../workers/client";
import { CREDIT_USD } from "@/services/agents/credits";
import type { StartCardRow } from "./store";

export const SITE_CHECK_RESERVE_CREDITS = 195;
export const SITE_CHECK_RESERVE_USD = Number((SITE_CHECK_RESERVE_CREDITS * CREDIT_USD).toFixed(4));
export const SITE_CHECK_RUN_CAP = 1;
export const SITE_CHECK_COST_SOURCE = "site_check";

export const TENANT_SETTLE_EVENT = "start-card/tenant.settle";

export function siteCheckCostKey(toolCallId: string): string {
  return `site_check:${toolCallId}`;
}

export function tenantChargeUsd(row: Pick<StartCardRow, "status" | "spent_usd" | "reserved_usd">): number {
  if (row.status !== "done") return 0;
  const spent = Number(row.spent_usd);
  if (!Number.isFinite(spent) || spent <= 0) return 0;
  const cap = Number(row.reserved_usd);
  const reserve = Number.isFinite(cap) && cap > 0 ? cap : SITE_CHECK_RESERVE_USD;
  return Number(Math.min(spent, reserve).toFixed(4));
}

export async function kickTenantSettle(cardId: string): Promise<void> {
  await inngest.send({ name: TENANT_SETTLE_EVENT, data: { card_id: cardId } });
}
