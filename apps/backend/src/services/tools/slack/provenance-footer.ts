
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActorAuthorityEnvelopeV1 } from "@/services/agents/actor-envelope";

const FOOTER_MARK = "⁣";

export function firstNameOf(displayName: string | null | undefined): string | null {
  const n = (displayName ?? "").trim();
  if (!n) return null;
  const first = n.split(/\s+/)[0];
  return first || null;
}

export async function resolveActorFirstName(
  svc: SupabaseClient,
  tenant_id: string,
  slack_user_id: string,
  team_id?: string,
): Promise<string | null> {
  try {
    let q = svc
      .from("team_member_identities")
      .select("team_members!inner(display_name)")
      .eq("tenant_id", tenant_id)
      .eq("provider", "slack")
      .eq("external_id", slack_user_id);
    if (team_id) q = q.eq("team_id", team_id);
    const { data, error } = await q.maybeSingle<{ team_members: { display_name: string | null } | null }>();
    if (error || !data) return null;
    return firstNameOf(data.team_members?.display_name);
  } catch {
    return null;
  }
}

export async function buildRequestedByFooter(
  svc: SupabaseClient,
  tenant_id: string,
  actor: ActorAuthorityEnvelopeV1 | undefined,
  currentText: string,
): Promise<string | null> {
  if (!actor) return null;
  if (actor.actor_source !== "slack" || !actor.resolved_tenant_member) return null;
  if (!actor.slack_user_id) return null;
  if (currentText.includes(FOOTER_MARK)) return null;
  const first = await resolveActorFirstName(svc, tenant_id, actor.slack_user_id, actor.slack_team_id);
  if (!first) return null;
  return `${FOOTER_MARK}\n\n_Requested by ${first}_`;
}

export async function withRequestedByFooter(
  svc: SupabaseClient,
  tenant_id: string,
  actor: ActorAuthorityEnvelopeV1 | undefined,
  text: string,
): Promise<string> {
  const footer = await buildRequestedByFooter(svc, tenant_id, actor, text);
  return footer ? `${text}${footer}` : text;
}

export async function resolveApproverLabel(
  svc: SupabaseClient,
  tenant_id: string,
  approver_user_id: string | null | undefined,
): Promise<string | null> {
  const uid = typeof approver_user_id === "string" ? approver_user_id.trim() : "";
  if (!uid || !tenant_id) return null;
  try {
    const { data, error } = await svc.rpc("resolve_decision_actors", {
      p_tenant_id: tenant_id,
      p_user_ids: [uid],
    });
    if (error) return null;
    const rows = (data ?? []) as Array<{ user_id: string; label: string }>;
    const label = rows.find((r) => r.user_id === uid)?.label;
    if (!label) return null;
    return label === "Zavi staff" ? label : firstNameOf(label);
  } catch {
    return null;
  }
}

export const CGO_APPROVER_LABEL = "Autopilot";

export async function withApprovedByFooter(
  svc: SupabaseClient,
  tenant_id: string,
  approver_user_id: string | null | undefined,
  text: string,
  approver_source?: string | null,
): Promise<string> {
  if (!approver_user_id) return text;
  if (text.includes(FOOTER_MARK)) return text;
  const label =
    approver_source === "cgo"
      ? CGO_APPROVER_LABEL
      : await resolveApproverLabel(svc, tenant_id, approver_user_id);
  if (!label) return text;
  return `${text}${FOOTER_MARK}\n\n_Approved by ${label}_`;
}
