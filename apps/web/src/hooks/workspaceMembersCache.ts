import { apiFetch } from "@/lib/api";
import type { Member, OpenInvite, TenantRole } from "@/lib/members";

const ROLE_RANK: Record<TenantRole, number> = { owner: 0, admin: 1, member: 2, viewer: 3 };

export function sortMembers(members: Member[]): Member[] {
  return [...members].sort((a, b) => (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9));
}

type MembersSnapshot = { members: Member[]; invites: OpenInvite[] };
let snapshot: MembersSnapshot | null = null;

export function membersSnapshot(): MembersSnapshot | null {
  return snapshot;
}

export async function loadMembers(): Promise<MembersSnapshot | { error: string }> {
  try {
    const [membersRes, invitesRes] = await Promise.all([apiFetch("/api/v1/members"), apiFetch("/api/v1/members/invites")]);
    if (!membersRes.ok) return { error: "Couldn't load team members. Try refreshing." };
    const membersBody = (await membersRes.json()) as { members?: Member[] };
    const invitesBody = invitesRes.ok ? ((await invitesRes.json()) as { invites?: OpenInvite[] }) : { invites: [] };
    const next = { members: sortMembers(membersBody.members ?? []), invites: invitesBody.invites ?? [] };
    snapshot = next;
    return next;
  } catch {
    return { error: "Couldn't reach Zavi to load your team. Check your connection." };
  }
}

export async function prefetchWorkspaceMembers(): Promise<void> {
  await loadMembers();
}

export function resetWorkspaceMembersCache(): void {
  snapshot = null;
}

