"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { loadMembers, membersSnapshot, sortMembers } from "./workspaceMembersCache";

export { sortMembers };
import {
  canManageMembers,
  isOwner,
  ROLE_INFO,
  type Member,
  type OpenInvite,
  type TenantRole,
} from "@/lib/members";
import type { InviteRole } from "@/hooks/useInviteMember";

export type WorkspaceMembersState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; members: Member[]; invites: OpenInvite[] };

const CHANGEABLE_ROLES: InviteRole[] = ["admin", "member", "viewer"];


export function roleChangeOptions(
  viewerRole: TenantRole | null,
  member: Member,
  currentUserId: string | null | undefined,
): InviteRole[] {
  if (!isOwner(viewerRole) || member.role === "owner" || member.user_id === currentUserId) return [];
  return CHANGEABLE_ROLES.filter((r) => r !== member.role);
}

export function canCancelInvites(viewerRole: TenantRole | null): boolean {
  return canManageMembers(viewerRole);
}

export function inviteSentMessage(email: string): string {
  return `Invite sent to ${email}. They'll get an email to join.`;
}

export function roleChangedMessage(email: string, role: InviteRole): string {
  return `${email} is now ${role === "admin" ? "an" : "a"} ${ROLE_INFO[role].label.toLowerCase()}.`;
}

export function useWorkspaceMembers() {
  const [state, setState] = useState<WorkspaceMembersState>(() => {
    const snap = membersSnapshot();
    return snap ? { kind: "ready", ...snap } : { kind: "loading" };
  });
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!actionSuccess) return;
    const id = window.setTimeout(() => setActionSuccess(null), 5000);
    return () => window.clearTimeout(id);
  }, [actionSuccess]);

  useEffect(
    () => () => {
      seq.current += 1;
    },
    [],
  );

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    const loaded = await loadMembers();
    if (mine !== seq.current) return;
    if ("error" in loaded) setState({ kind: "error", message: loaded.error });
    else setState({ kind: "ready", ...loaded });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runAction = useCallback(
    async (label: string, action: () => Promise<Response>, successMsg?: string) => {
      setBusyAction(label);
      setActionError(null);
      setActionSuccess(null);
      try {
        const res = await action();
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
          setActionError(body?.error?.message ?? `Couldn't ${label}.`);
          return false;
        }
        await refresh();
        if (successMsg) setActionSuccess(successMsg);
        return true;
      } catch {
        setActionError(`Couldn't ${label}. Check your connection.`);
        return false;
      } finally {
        setBusyAction(null);
      }
    },
    [refresh],
  );

  const changeRole = useCallback(
    (member: Member, role: InviteRole) =>
      runAction(
        "change role",
        () =>
          apiFetch(`/api/v1/members/${member.user_id}/role`, {
            method: "POST",
            body: JSON.stringify({ role }),
          }),
        roleChangedMessage(member.email, role),
      ),
    [runAction],
  );

  const cancelInvite = useCallback(
    async (invite: OpenInvite) => {
      if (!confirm(`Cancel the invite to ${invite.email}? They won't be able to accept it.`)) return false;
      return runAction(
        `cancel invite:${invite.id}`,
        () => apiFetch(`/api/v1/members/invites/${invite.id}`, { method: "DELETE" }),
        `Invite to ${invite.email} was cancelled.`,
      );
    },
    [runAction],
  );

  const inviteSucceeded = useCallback(
    (email: string) => {
      void refresh();
      setActionError(null);
      setActionSuccess(inviteSentMessage(email));
    },
    [refresh],
  );

  return {
    state,
    refresh,
    busyAction,
    actionError,
    actionSuccess,
    runAction,
    changeRole,
    cancelInvite,
    inviteSucceeded,
  };
}
