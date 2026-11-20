import { commitAdSpend, reserveAdSpend, settleAdSpendAfterError, type AdSpendHold, type AdSpendOp } from "@/services/decisions/ad-budget";

export type LinkedInExecRow = {
  tenant_id: string;
  body: unknown;
  id?: string;
  exec_source?: string;
  decision_class?: string;
  approved_by?: string | null;
  approved_by_source?: string | null;
};

type Refusal = { ok: false; code: string; error: string };

export async function holdLinkedInSpend(
  d: LinkedInExecRow,
  ask: { op: AdSpendOp; object_id: string | null; cents: number; currency: string | null },
): Promise<{ ok: true; hold: AdSpendHold } | { ok: false; result: Refusal }> {
  const cgo = d.approved_by_source === "cgo";
  const required = (why: string): { ok: false; result: Refusal } => ({ ok: false, result: { ok: false, code: "linkedin_ads_budget_required", error: `Autopilot changes on LinkedIn must be held against your ad budget, and ${why}, so Zavi did not change anything.` } });
  if (ask.currency !== "USD" || !(ask.cents > 0) || !d.id) {
    if (!cgo) return { ok: true, hold: { status: "no_budget" } };
    return required(ask.currency !== "USD" ? "this ad account is not in US dollars" : "the amount to hold could not be read");
  }
  const hold = await reserveAdSpend(
    { id: d.id, tenant_id: d.tenant_id, exec_source: d.exec_source, decision_class: d.decision_class, approved_by: d.approved_by, approved_by_source: d.approved_by_source, body: d.body },
    { platform: "linkedin", op: ask.op, object_id: ask.object_id, daily_delta_usd: ask.cents / 100, currency: "USD", ...(ask.op === "create" ? { paused: true } : {}) },
  );
  if (hold.status === "refused") return { ok: false, result: { ok: false, code: "linkedin_ads_budget_refused", error: hold.error } };
  if (cgo && hold.status !== "held") return required("no ad budget is active");
  return { ok: true, hold };
}

export const ledgerIdOf = (campaignId: string, bindingId: string | null | undefined) => bindingId || campaignId;

export { commitAdSpend, settleAdSpendAfterError };
