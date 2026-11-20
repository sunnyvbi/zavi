
import { loadTenantRoleFor } from "@/services/auth/tenant-role";
import { NON_TENANT_APPROVAL_SOURCES } from "@/services/decisions/ads-approval-authority";
import { metaActionRaisesSpend } from "./_decision-bodies";

export type MetaApproverRow = {
  tenant_id: string;
  decision_class: string;
  body: unknown;
  approved_by?: string | null;
  approved_by_source?: string | null;
};

export type MetaApproverRefusal = { ok: false; held_for_founder: true; code: string; error: string };

export async function metaApproverRefusal(
  d: MetaApproverRow,
  loadRole: typeof loadTenantRoleFor = loadTenantRoleFor,
): Promise<MetaApproverRefusal | null> {
  if (!d.approved_by || NON_TENANT_APPROVAL_SOURCES.has(d.approved_by_source ?? "")) return null;
  if (!metaActionRaisesSpend(d.decision_class, d.body)) return null;
  let role: string | null;
  try {
    role = await loadRole(d.approved_by, d.tenant_id);
  } catch {
    return { ok: false, held_for_founder: true, code: "meta_ads_role_unavailable", error: "The approver's workspace role could not be checked. Nothing in Meta changed; approve again in a minute." };
  }
  if (role === "owner" || role === "admin") return null;
  return { ok: false, held_for_founder: true, code: "meta_ads_admin_required", error: "Only a workspace owner or admin can approve a Meta launch, budget increase, location change or switching something on. Nothing in Meta changed." };
}
