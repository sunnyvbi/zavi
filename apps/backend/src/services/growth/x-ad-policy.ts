import { createBody } from "@/services/connectors/x-ads/schema";
import {
  listXFundingInstruments,
  xAdsTenantToken,
} from "@/services/connectors/x-ads/client";
import { assertXWriteAccess } from "@/services/connectors/x-ads/resources";
import type {
  UnattendedAction,
  UnattendedFacts,
  UnattendedVerdict,
} from "./unattended-policy";

type Action = Extract<UnattendedAction, { kind: "ad" }>;
export function evaluateXAd(
  action: Action,
  facts: UnattendedFacts,
): UnattendedVerdict {
  if (action.exec_class !== "x_ads.create_campaign")
    return {
      verdict: "ask_founder",
      reasons: ["x_existing_objects_need_founder"],
    };
  const parsed = createBody.safeParse(action.payload);
  if (!parsed.success) return { verdict: "deny", reasons: ["body_unreadable"] };
  const b = parsed.data;
  const reasons: string[] = [];
  const origin = (action.payload as Record<string, unknown>).origin;
  if (origin === "x_organic_trial") reasons.push("organic_trial_needs_founder");
  if (origin === "user_initiated_chat" || origin === "user_initiated_ledger")
    reasons.push("founder_staged_change");
  if (facts.channelAutorun !== true) reasons.push("channel_asks_first");
  if (facts.spendUpUnderBudget !== true) reasons.push("no_ad_budget");
  if (!facts.goal?.present || facts.goal.numberTrusted !== true)
    reasons.push("goal_number_untrusted");
  if (facts.openAdvice !== "clear" || facts.refsResolved !== true)
    reasons.push("open_advice_unreadable_or_conflicting");
  if (b.currency !== "USD") reasons.push("x_currency_unsupported");
  if (b.new_post) reasons.push("x_new_post_needs_founder");
  if (!b.locations.length) reasons.push("no_location_target");
  if (
    !b.end_time ||
    !b.total_budget ||
    Date.parse(b.end_time) <= Math.max(Date.parse(b.start_time), Date.now())
  )
    reasons.push("x_finite_budget_and_schedule_required");
  const nextMonth = new Date();
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 1);
  nextMonth.setUTCHours(0, 0, 0, 0);
  if (
    b.launch === "ACTIVE" &&
    b.end_time &&
    Date.parse(b.end_time) > nextMonth.getTime()
  )
    reasons.push("x_launch_outside_reserved_month");
  if (b.launch === "ACTIVE" && b.objective === "WEBSITE_CLICKS")
    reasons.push("x_conversion_health_unverified");
  if (facts.x?.ready !== true)
    reasons.push("x_permissions_or_funding_unverified");
  return { verdict: reasons.length ? "ask_founder" : "allow", reasons };
}
export async function loadXAdFacts(
  tenantId: string,
  action: Action,
): Promise<{ ready: boolean }> {
  if (action.exec_class !== "x_ads.create_campaign") return { ready: false };
  const b = createBody.parse(action.payload);
  const token = await xAdsTenantToken(tenantId);
  await assertXWriteAccess(token, b.account_id);
  const funding = (await listXFundingInstruments(token, b.account_id)).find(
    (f) => f.id === b.funding_instrument_id,
  );
  return {
    ready: funding?.able_to_fund === true && funding.currency === "USD",
  };
}
