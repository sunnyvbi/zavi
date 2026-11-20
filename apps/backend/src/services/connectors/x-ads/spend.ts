import { ExpectedToolError } from "@/services/tools/types";
import {
  commitAdSpend,
  dropAdSpendHold,
  reserveAdSpend,
  type AdSpendHold,
  type AdSpendOp,
} from "@/services/decisions/ad-budget";
import type { XExecRow } from "./execute";

export async function reserveXSpend(
  row: XExecRow,
  op: AdSpendOp,
  objectId: string | null,
  daily: number,
  currency: string | null,
  bound: { lifetime_usd?: number; ends_on?: string; lifetime_daily_usd?: number } = {},
): Promise<AdSpendHold> {
  if (!row.id)
    throw new ExpectedToolError(
      "x_ads_action_missing",
      "A persisted approval id is required before opening X Ads spend.",
    );
  const hold = await reserveAdSpend(
    { ...row, id: row.id },
    {
      platform: "x",
      op,
      object_id: objectId,
      daily_delta_usd: bound.lifetime_usd != null ? (bound.lifetime_daily_usd ?? daily) : daily,
      currency: currency ?? "UNKNOWN",
      ...(op === "create" ? { ...(bound.lifetime_usd != null ? { lifetime_usd: bound.lifetime_usd } : {}), ...(bound.ends_on ? { ends_on: bound.ends_on } : {}) } : {}),
    },
  );
  if (hold.status === "refused")
    throw new ExpectedToolError("x_ads_budget_refused", hold.error);
  if (row.approved_by_source === "cgo" && hold.status !== "held")
    throw new ExpectedToolError(
      "x_ads_budget_required",
      "Autopilot requires an active shared ad budget and a spend reservation.",
    );
  return hold;
}
export async function settleXSpend(
  hold: AdSpendHold,
  objectId: string | null,
  error?: unknown,
  wrote = false,
) {
  if (!error) {
    await commitAdSpend(hold, objectId);
    return;
  }
  if (
    !wrote ||
    (error instanceof ExpectedToolError &&
      [
        "x_ads_refused",
        "x_ads_forbidden",
        "x_ads_rate_limited",
        "x_ads_not_found",
        "x_ads_permission_denied",
      ].includes(error.code))
  )
    await dropAdSpendHold(hold);
}
