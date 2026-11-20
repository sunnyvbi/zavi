
import type { SupabaseClient } from "@supabase/supabase-js";

export type TenantRole = "owner" | "admin" | "member" | "viewer";

export const ROLE_REFUSED_EVENT = "zavi:workspace-role-refused";

export type Member = {
  user_id: string;
  email: string;
  role: TenantRole;
  joined_at: string | null;
};

export type OpenInvite = {
  id: string;
  email: string;
  role: "admin" | "member" | "viewer";
  invited_at: string | null;
};

export async function fetchMyRole(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<TenantRole | null> {
  const role = await readMyRole(supabase, tenantId);
  return role === "unread" ? null : role;
}

export async function readMyRole(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<TenantRole | null | "unread"> {
  const { data: userRes, error: userError } = await supabase.auth.getUser();
  const userId = userRes.user?.id;
  if (!userId) return userError ? "unread" : null;
  const { data, error } = await supabase
    .from("tenant_users")
    .select("role")
    .eq("user_id", userId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) return "unread";
  if (!data) return null;
  const role = (data as { role: string | null }).role;
  if (role === "owner" || role === "admin" || role === "member" || role === "viewer") {
    return role;
  }
  return role ? "viewer" : null;
}

export function canManageMembers(role: TenantRole | null): boolean {
  return role === "owner" || role === "admin";
}

export function isOwner(role: TenantRole | null): boolean {
  return role === "owner";
}

export function isMember(role: TenantRole | null): boolean {
  return role === "member" || role === "viewer";
}

export function isViewer(role: TenantRole | null): boolean {
  return role === "viewer";
}

export const ROLE_INFO: Record<Exclude<TenantRole, "owner">, { label: string; help: string }> = {
  admin: { label: "Admin", help: "Everything a member can do, plus billing, team and connections." },
  member: { label: "Member", help: "Uses every agent and channel. Can't change billing, team or connections." },
  viewer: { label: "Viewer", help: "Read-only. Sees the workspace but can't run agents or approve anything." },
};
