import { loadTenantRoleFor } from "@/services/auth/tenant-role";
import { NON_TENANT_APPROVAL_SOURCES } from "@/services/decisions/ads-approval-authority";
import { channelApproveNeedsAdmin } from "@/services/channels/approve-needs-admin";
import { sharedWalletConsent } from "@/services/ads-wallet/consent";

export type LinkedInApproverRow = { tenant_id: string; exec_class: string; body: unknown; approved_by?: string | null; approved_by_source?: string | null };
export type LinkedInApproverRefusal = { ok: false; held_for_founder: true; code: string; error: string };

export const LINKEDIN_CGO_CONSENT_REQUIRED =
  "Autopilot needs your paid permission before it changes LinkedIn campaigns. Nothing in LinkedIn changed. Review and authorize ad spending, or approve this change yourself.";
export const LINKEDIN_CGO_NOT_HELD =
  "This change can raise LinkedIn spend, and Zavi cannot hold it against your ad budget first, so Autopilot did not make it. Nothing in LinkedIn changed. Approve it yourself to go ahead.";

async function cgoRefusal(d: LinkedInApproverRow, consent: typeof sharedWalletConsent): Promise<LinkedInApproverRefusal | null> {
  const { LINKEDIN_POLICY_CLASSES, linkedinSpendUpNotHeld } = await import("@/services/growth/linkedin-ad-policy");
  if (!LINKEDIN_POLICY_CLASSES.has(d.exec_class)) return null;
  let given = false;
  try {
    given = await consent(d.tenant_id);
  } catch {
    given = false;
  }
  if (!given) return { ok: false, held_for_founder: true, code: "linkedin_ads_consent_required", error: LINKEDIN_CGO_CONSENT_REQUIRED };
  if (linkedinSpendUpNotHeld({ exec_class: d.exec_class, payload: d.body })) return { ok: false, held_for_founder: true, code: "linkedin_ads_change_not_held", error: LINKEDIN_CGO_NOT_HELD };
  return null;
}

export async function linkedinApproverRefusal(
  d: LinkedInApproverRow,
  loadRole: typeof loadTenantRoleFor = loadTenantRoleFor,
  consent: typeof sharedWalletConsent = sharedWalletConsent,
): Promise<LinkedInApproverRefusal | null> {
  if (d.approved_by_source === "cgo") return cgoRefusal(d, consent);
  if (!d.approved_by || NON_TENANT_APPROVAL_SOURCES.has(d.approved_by_source ?? "")) return null;
  if (!channelApproveNeedsAdmin(d.exec_class, d.body)) return null;
  let role: string | null;
  try {
    role = await loadRole(d.approved_by, d.tenant_id);
  } catch {
    return { ok: false, held_for_founder: true, code: "linkedin_ads_role_unavailable", error: "The approver's workspace role could not be checked. Nothing in LinkedIn changed; approve again in a minute." };
  }
  if (role === "owner" || role === "admin") return null;
  return { ok: false, held_for_founder: true, code: "linkedin_ads_admin_required", error: "Only a workspace owner or admin can approve a LinkedIn change that can raise spend, create something or delete something. Nothing in LinkedIn changed." };
}
