import {
  currentBoundCampaign,
  withBoundCampaign,
} from "@/services/ads-wallet/campaign-context";
import type { CampaignBinding } from "@/services/ads-wallet/bindings";
import { adsFx, adsUsd } from "@/services/ads-wallet/fx";
import { withChatgptWriteTracking } from "./write-tracking";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { ExpectedToolError } from "@/services/tools/types";
import {
  readActiveAdBudget,
  reserveAdSpend,
  commitAdSpend,
  dropAdSpendHold,
  settleAdSpendAfterError,
  releaseAdSpendForObject,
  rebaseAdSpendForObject,
} from "@/services/decisions/ad-budget";
import { recordAdObjectChanges } from "@/services/decisions/ad-changes";
const dispatch = new AsyncLocalStorage<string>();
export function withApprovedChatgptDispatch<T>(
  tenantId: string,
  fn: () => Promise<T>,
) {
  return dispatch.run(tenantId, fn);
}
type Campaign = {
  id: string;
  name?: string;
  status?: string;
  updated_at?: number;
  budget?: {
    daily_spend_limit_micros?: number;
    lifetime_spend_limit_micros?: number;
  };
  [key: string]: unknown;
};
export async function withWorkspaceGrowthBudget<T>(
  tenantId: string,
  previous: Campaign,
  next: Campaign,
  operation: string,
  write: () => Promise<T>,
  account?: { binding: CampaignBinding; currency: string },
): Promise<T> {
  if (account && currentBoundCampaign() !== account.binding)
    return withBoundCampaign(account.binding, () =>
      withWorkspaceGrowthBudget(
        tenantId,
        previous,
        next,
        operation,
        write,
        account,
      ),
    );
  if (dispatch.getStore() === tenantId) return write();
  const bound = currentBoundCampaign();
  const objectId =
    bound?.funding_source === "provider" ? bound.id : previous.id;
  const stopping = next.status === "paused" || next.status === "archived";
  const fx = stopping ? null : await adsFx(account?.currency ?? "USD");
  const usd = (micros: number) => (fx ? adsUsd(micros / 1e6, fx) : null);
  const increasing =
    !stopping &&
    next.status === "active" &&
    (operation !== "campaign" ||
      previous.status !== "active" ||
      Number(next.budget?.daily_spend_limit_micros ?? 0) >
        Number(previous.budget?.daily_spend_limit_micros ?? 0) ||
      Number(next.budget?.lifetime_spend_limit_micros ?? 0) >
        Number(previous.budget?.lifetime_spend_limit_micros ?? 0) ||
      next.start_time !== previous.start_time ||
      next.end_time !== previous.end_time);
  const budget = increasing ? await readActiveAdBudget(tenantId) : null;
  const daily = next.budget?.daily_spend_limit_micros;
  const lifetime = next.budget?.lifetime_spend_limit_micros;
  const rate =
    typeof daily === "number"
      ? usd(daily)
      : typeof lifetime === "number" && fx && budget && budget.days_left > 0
        ? Math.ceil((adsUsd(lifetime / 1e6, fx) / budget.days_left / 2) * 100) /
          100
        : null;
  const key = `chatgpt-ui:${createHash("sha256")
    .update(
      JSON.stringify([
        tenantId,
        previous.id,
        previous.updated_at,
        next,
        operation,
        budget?.id,
        new Date().toISOString().slice(0, 10),
      ]),
    )
    .digest("hex")}`;
  if (
    increasing &&
    budget &&
    (rate === null || !Number.isFinite(rate) || rate <= 0)
  )
    throw new ExpectedToolError(
      "chatgpt_ads_conflict",
      "The campaign budget could not be verified against Growth.",
    );
  const prevDaily = previous.budget?.daily_spend_limit_micros;
  const raiseOnly =
    operation === "campaign" &&
    previous.status === "active" &&
    typeof daily === "number" &&
    typeof prevDaily === "number" &&
    daily > prevDaily &&
    next.start_time === previous.start_time &&
    next.end_time === previous.end_time &&
    Number(next.budget?.lifetime_spend_limit_micros ?? 0) <=
      Number(previous.budget?.lifetime_spend_limit_micros ?? 0);
  const hold =
    increasing && budget && rate !== null
      ? await reserveAdSpend(
          { id: key, tenant_id: tenantId, exec_source: "workspace" },
          raiseOnly
            ? {
                platform: "chatgpt",
                op: "raise",
                object_id: objectId,
                daily_delta_usd: usd(Number(daily) - Number(prevDaily))!,
              }
            : {
                platform: "chatgpt",
                op: "resume",
                object_id: objectId,
                daily_delta_usd: rate,
              },
        )
      : { status: "no_budget" as const };
  if (hold.status === "refused")
    throw new ExpectedToolError("chatgpt_ads_conflict", hold.error);
  if (increasing && budget && hold.status !== "held")
    throw new ExpectedToolError(
      "chatgpt_ads_conflict",
      "Growth budget changed before this campaign write. Refresh and retry.",
    );
  if (hold.status === "held") {
    try {
      const r = await tenantRpc(
        asTenantId(tenantId),
        "note_chatgpt_workspace_hold",
        {
          p_idem_key: hold.idem_key,
          p_target: {
            kind: "chatgpt_workspace",
            campaign_id: objectId,
            provider_campaign_id: previous.id,
            campaign_binding_id: bound?.id,
            daily_budget_usd: typeof daily === "number" ? usd(daily) : null,
            currency: account?.currency ?? "USD",
            fx,
            status: next.status,
            operation,
          },
        },
      );
      if (r.error || r.data !== true)
        throw new Error("Hold target could not be saved");
    } catch {
      await dropAdSpendHold(hold);
      throw new ExpectedToolError(
        "chatgpt_ads_conflict",
        "Growth could not record this change safely. Nothing was sent; refresh and retry.",
      );
    }
  }
  let result: T;
  let sent = false;
  try {
    result = await withChatgptWriteTracking(() => {
      sent = true;
    }, write);
  } catch (e) {
    if (!sent) await dropAdSpendHold(hold);
    else await settleAdSpendAfterError(hold, e);
    throw e;
  }
  await commitAdSpend(hold, objectId);
  if (operation === "campaign" && stopping)
    await releaseAdSpendForObject(tenantId, "chatgpt", objectId);
  if (
    operation === "campaign" &&
    rate !== null &&
    typeof previous.budget?.daily_spend_limit_micros === "number" &&
    typeof daily === "number" &&
    daily < previous.budget.daily_spend_limit_micros
  )
    await rebaseAdSpendForObject(
      tenantId,
      "chatgpt",
      objectId,
      rate,
      `${key}:rebase`,
      usd(previous.budget.daily_spend_limit_micros - daily)!,
    );
  if (operation === "campaign") {
    const statusChanged = previous.status !== next.status;
    const dailyChanged =
      previous.budget?.daily_spend_limit_micros !==
      next.budget?.daily_spend_limit_micros;
    const common = {
      platform: "chatgpt" as const,
      object_id: objectId,
      campaign_id: objectId,
      object_name: next.name ?? null,
      level: "campaign" as const,
      source: "outside" as const,
      action_table: null,
      action_id: null,
      before_status: previous.status?.toUpperCase() ?? null,
      after_status: next.status?.toUpperCase() ?? null,
      before_daily_usd:
        previous.budget?.daily_spend_limit_micros == null
          ? null
          : usd(previous.budget.daily_spend_limit_micros),
      after_daily_usd: daily == null ? null : usd(daily),
    };
    try {
      await recordAdObjectChanges(tenantId, [
        ...(statusChanged
          ? [{ ...common, change_kind: "status" as const }]
          : []),
        ...(dailyChanged
          ? [{ ...common, change_kind: "budget" as const }]
          : []),
      ]);
    } catch {
    }
  }
  return result;
}
