
import { loadTenantRoleFor } from "@/services/auth/tenant-role";
import { NON_TENANT_APPROVAL_SOURCES } from "@/services/decisions/ads-approval-authority";
import { chatgptActionRaisesSpend } from "./raises-spend";

export type ChatgptApproverRow = {
  tenant_id: string;
  decision_class: string;
  body: unknown;
  approved_by?: string | null;
  approved_by_source?: string | null;
};

export type ChatgptApproverRefusal = { ok: false; held_for_founder: true; code: string; error: string };

export async function chatgptApproverRefusal(
  d: ChatgptApproverRow,
  loadRole: typeof loadTenantRoleFor = loadTenantRoleFor,
): Promise<ChatgptApproverRefusal | null> {
  if (!d.approved_by || NON_TENANT_APPROVAL_SOURCES.has(d.approved_by_source ?? "")) return null;
  if (!chatgptActionRaisesSpend(d.decision_class, d.body)) return null;
  let role: string | null;
  try {
    role = await loadRole(d.approved_by, d.tenant_id);
  } catch {
    return { ok: false, held_for_founder: true, code: "chatgpt_ads_role_unavailable", error: "The approver's workspace role could not be checked. Nothing in ChatGPT Ads changed; approve again in a minute." };
  }
  if (role === "owner" || role === "admin") return null;
  return { ok: false, held_for_founder: true, code: "chatgpt_ads_admin_required", error: "Only a workspace owner or admin can approve a ChatGPT Ads launch, budget increase or switching a campaign on. Nothing in ChatGPT Ads changed." };
}
