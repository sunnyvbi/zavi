
import { tenantRpc, asTenantId } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import type { getApprovalCardRef, updateApprovalCard } from "@/services/slack/approval-post-target";

export const BUDGET_CHANGE_FAMILIES: ReadonlySet<string> = new Set([
  "meta_ads.update_ad_set_budget",
  "meta_ads.update_campaign_budget",
  "google_ads.update_campaign_budget",
  "chatgpt_ads.update_campaign_budget",
  "tiktok_ads.update_budget",
  "reddit_ads.update_budget",
  "x_ads.update_campaign",
]);

export function isBudgetChangeClass(cls: string | null | undefined): boolean {
  return typeof cls === "string" && BUDGET_CHANGE_FAMILIES.has(cls.replace(/_review$/, ""));
}

export const CLOSED_CARD_TEXT =
  "Closed: the budget changed before this was approved, so it was based on an old amount. Zavi proposes again from the new budget.";

export type RetireDeps = {
  rpc: typeof tenantRpc;
  cardRef: typeof getApprovalCardRef;
  updateCard: typeof updateApprovalCard;
};

const slack = () => import("@/services/slack/approval-post-target");
const DEFAULT_DEPS: RetireDeps = {
  rpc: tenantRpc,
  cardRef: async (...a) => (await slack()).getApprovalCardRef(...a),
  updateCard: async (...a) => (await slack()).updateApprovalCard(...a),
};

export async function retireStaleBudgetProposals(
  tenantId: string,
  source: { kind: "channel_action" | "decision"; id: string; execClass: string | null | undefined },
  deps: Partial<RetireDeps> = {},
): Promise<{ stale: string[]; superseded: string[] }> {
  const none = { stale: [] as string[], superseded: [] as string[] };
  if (!isBudgetChangeClass(source.execClass)) return none;
  const d = { ...DEFAULT_DEPS, ...deps };
  try {
    const { data, error } = await d.rpc(asTenantId(tenantId), "retire_stale_budget_proposals", {
      p_tenant_id: tenantId,
      p_source_kind: source.kind,
      p_source_id: source.id,
    });
    if (error) throw new Error(error.message);
    const out = (data ?? {}) as { ok?: boolean; code?: string; stale?: unknown; superseded?: unknown };
    if (out.ok !== true) {
      return none;
    }
    const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    const result = { stale: ids(out.stale), superseded: ids(out.superseded) };
    if (result.stale.length + result.superseded.length > 0) {
      void logEvent({
        level: "info",
        source: "channels.retire_stale_budget",
        code: "budget.proposals_retired",
        message: `${source.kind} ${source.id} retired ${result.stale.length} card(s), ${result.superseded.length} decision(s)`,
        tenant_id: tenantId,
      });
    }
    for (const decisionId of result.superseded) {
      const ref = await d.cardRef(decisionId, tenantId);
      if (ref) await d.updateCard({ tenant_id: tenantId, ref, text: CLOSED_CARD_TEXT });
    }
    return result;
  } catch (e) {
    void logEvent({
      level: "warn",
      source: "channels.retire_stale_budget",
      code: "budget.proposals_retire_failed",
      message: `${source.kind} ${source.id}: ${(e as Error).message}`.slice(0, 500),
      tenant_id: tenantId,
    });
    return none;
  }
}
