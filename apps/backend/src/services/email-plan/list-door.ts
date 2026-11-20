
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { AUTOPILOT_MAX_RECIPIENTS } from "@/services/growth/unattended-email";

export const WORDS: Readonly<Record<string, string>> = {
  not_planned: "Autopilot did not send this: it was not approved for its planned time. Nothing was sent.",
  list_version_changed:
    "Autopilot did not send this planned email: the list was imported again after it was drafted, and the draft is for the earlier import. Nothing was sent. Approve it yourself if it is still right.",
  email_test_list: "Autopilot did not send this planned email: the list is marked as a test list. Nothing was sent.",
  audience_over_limit: `Autopilot did not send this planned email: the list has more than ${AUTOPILOT_MAX_RECIPIENTS.toLocaleString("en-US")} people. Nothing was sent. Approve it yourself if it is still right.`,
  check_failed: "Autopilot did not send this planned email: Zavi could not check it just before sending. Nothing was sent. Approve it yourself if it is still right.",
};

export type ListDoorDeps = {
  check: (tenantId: string, decisionId: string) => Promise<{ ok: boolean; code?: string }>;
  count: (tenantId: string, decisionId: string) => Promise<number | null>;
};

const LIVE: ListDoorDeps = {
  check: async (tenantId, decisionId) => {
    const { data, error } = await tenantRpc(asTenantId(tenantId), "email_plan_unattended_ok", { p_decision_id: decisionId });
    if (error) throw new Error("email_plan_unattended_ok failed");
    return (data ?? { ok: false }) as { ok: boolean; code?: string };
  },
  count: async (tenantId, decisionId) => {
    const { tenantClient } = await import("@/services/tenant-client");
    const { data } = await tenantClient(asTenantId(tenantId)).from("decisions").select("decision_class, body").eq("id", decisionId).maybeSingle<{ decision_class: string; body: unknown }>();
    if (!data) return null;
    const { liveCardCount } = await import("@/services/email-cards/cards");
    return liveCardCount(tenantId, data.decision_class, data.body);
  },
};

export async function plannedListSendRefusal(
  tenantId: string,
  decisionId: string,
  deps: Partial<ListDoorDeps> = {},
): Promise<{ code: string; sentence: string } | null> {
  const d = { ...LIVE, ...deps };
  try {
    const ok = await d.check(tenantId, decisionId);
    if (!ok.ok) {
      const code = ok.code && WORDS[ok.code] ? ok.code : "not_planned";
      return { code: `planned_${code}`, sentence: WORDS[code] };
    }
    const people = await d.count(tenantId, decisionId);
    if (people === null) return { code: "planned_check_failed", sentence: WORDS.check_failed };
    if (people > AUTOPILOT_MAX_RECIPIENTS) return { code: "planned_audience_over_limit", sentence: WORDS.audience_over_limit };
    return null;
  } catch {
    return { code: "planned_check_failed", sentence: WORDS.check_failed };
  }
}
