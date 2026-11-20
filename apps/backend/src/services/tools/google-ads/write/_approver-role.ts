
import { googleActionRaisesSpend } from "@zavi/shared";
import { loadTenantRoleFor } from "@/services/auth/tenant-role";
import { NON_TENANT_APPROVAL_SOURCES } from "@/services/decisions/ads-approval-authority";

export type GoogleApproverRow = {
  tenant_id: string;
  decision_class: string;
  body: unknown;
  approved_by?: string | null;
  approved_by_source?: string | null;
};

export type GoogleApproverRefusal = { ok: false; held_for_founder: true; code: string; error: string };

export type GoogleApproverDeps = {
  loadRole: typeof loadTenantRoleFor;
  liveKeywordNegative: (tenant_id: string, scope: "ad_group" | "campaign", parent_id: string, criterion_id: string) => Promise<boolean>;
};

const defaultDeps: GoogleApproverDeps = {
  loadRole: loadTenantRoleFor,
  liveKeywordNegative: async (tenant_id, scope, parent_id, criterion_id) => {
    const { gadsGetKeyword } = await import("../_client");
    const live = await gadsGetKeyword(
      tenant_id,
      scope === "ad_group" ? { level: "ad_group", ad_group_id: parent_id } : { level: "campaign", campaign_id: parent_id },
      criterion_id,
    );
    return live.negative === true;
  },
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

async function judgedBody(d: GoogleApproverRow, deps: GoogleApproverDeps): Promise<unknown> {
  const b = obj(d.body);
  if (d.decision_class !== "google_ads.remove_resource" || b.level !== "keyword") return d.body;
  const { criterion_negative: _stored, ...rest } = b;
  const scope = b.scope === "ad_group" || b.scope === "campaign" ? b.scope : null;
  if (!scope || typeof b.parent_id !== "string" || typeof b.criterion_id !== "string") return rest;
  try {
    return { ...rest, criterion_negative: await deps.liveKeywordNegative(d.tenant_id, scope, b.parent_id, b.criterion_id) };
  } catch {
    return rest;
  }
}

export async function googleApproverRefusal(d: GoogleApproverRow, deps: GoogleApproverDeps = defaultDeps): Promise<GoogleApproverRefusal | null> {
  if (!d.approved_by || NON_TENANT_APPROVAL_SOURCES.has(d.approved_by_source ?? "")) return null;
  if (!googleActionRaisesSpend(d.decision_class, await judgedBody(d, deps))) return null;
  let role: string | null;
  try {
    role = await deps.loadRole(d.approved_by, d.tenant_id);
  } catch {
    return { ok: false, held_for_founder: true, code: "google_ads_role_unavailable", error: "The approver's workspace role could not be checked. Nothing in Google Ads changed; approve again in a minute." };
  }
  if (role === "owner" || role === "admin") return null;
  return {
    ok: false,
    held_for_founder: true,
    code: "google_ads_admin_required",
    error: "Only a workspace owner or admin can approve a Google Ads change that can raise spend. Nothing in Google Ads changed.",
  };
}
