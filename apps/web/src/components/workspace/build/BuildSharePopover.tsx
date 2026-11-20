"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Loader2, Users } from "lucide-react";
import { canManageMembers, ROLE_INFO, type Member, type OpenInvite, type TenantRole } from "@/lib/members";
import { useDismissableMenu } from "@/hooks/useDismissableMenu";
import { INVITE_ROLES, isValidInviteEmail, useInviteMember, type InviteRole } from "@/hooks/useInviteMember";
import { canCancelInvites, roleChangeOptions, useWorkspaceMembers } from "@/hooks/useWorkspaceMembers";
import { useWorkspaceOptional } from "@/components/workspace/WorkspaceShell";
import { RoleBadge } from "@/components/workspace/WorkspaceMembersPanel";
import { AuthorAvatar } from "@/components/workspace/AuthorAvatar";
import { Skeleton } from "@/components/workspace/Skeleton";
import { openBillingSettings } from "@/lib/workspace/openBilling";
import { PLANS_HASH } from "@/lib/workspace/pendingPlan";

export const INVITE_SCOPE_COPY = "People you invite join this whole workspace, not just this build.";
export const GENERAL_ACCESS_COPY =
  "Everyone in this workspace can open its builds. Viewers can look but can't change anything.";

export function inviteTitle(workspaceName: string | null | undefined): string {
  const name = workspaceName?.trim();
  return name ? `Invite to ${name}` : "Invite to your workspace";
}

export function personName(email: string): string {
  return email.split("@")[0] || email || "Teammate";
}

export function BuildShareButton({ compact = false }: { compact?: boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { open, toggle, close } = useDismissableMenu(wrapRef, triggerRef);
  return (
    <div ref={wrapRef} className={`relative flex${compact ? " ml-2" : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Share"
        title="Invite people to this workspace"
        className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-[#f0f0f0] bg-white px-3 text-[13px] font-semibold text-[#0e0f11] transition-colors hover:bg-[#f4f4f4]"
      >
        <Users className="h-4 w-4" aria-hidden />
        <span className="compact:sr-only">Share</span>
      </button>
      {open && <BuildSharePopover onClose={() => close()} />}
    </div>
  );
}

export function BuildSharePopover({ onClose }: { onClose: () => void }) {
  const workspace = useWorkspaceOptional();
  const role: TenantRole | null = workspace?.role ?? null;
  const currentUserId = workspace?.currentUserId ?? null;
  const canInvite = canManageMembers(role);
  const inviter = useInviteMember();
  const people = useWorkspaceMembers();
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InviteRole>("member");
  const [roleMenuFor, setRoleMenuFor] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const title = inviteTitle(workspace?.tenantName);

  useEffect(() => {
    const finePointer = typeof window.matchMedia === "function" && window.matchMedia("(pointer: fine)").matches;
    const target = canInvite && finePointer ? emailRef.current : dialogRef.current;
    target?.focus({ preventScroll: true });
  }, [canInvite]);

  const { inviteSucceeded } = people;
  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (inviter.submitting) return;
      const invited = await inviter.invite(email, inviteRole);
      if (!invited) return;
      setEmail("");
      inviteSucceeded(invited);
    },
    [inviter, email, inviteRole, inviteSucceeded],
  );

  const seePlans = useCallback(() => {
    onClose();
    if (workspace) openBillingSettings(workspace.openTab, PLANS_HASH);
    else window.location.hash = PLANS_HASH;
  }, [onClose, workspace]);

  const inlineError = inviter.emailError ?? inviter.userExistsError;
  const busy = people.busyAction !== null;
  const state = people.state;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="absolute right-0 top-[calc(100%+10px)] z-40 flex max-h-[min(560px,calc(100vh-120px))] w-[360px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-[12px] border border-[#f0f0f0] bg-white shadow-lg outline-none compact:fixed compact:left-4 compact:right-4 compact:top-16 compact:w-auto compact:max-w-none"
    >
      <div className="scrollbar-clean min-h-0 flex-1 overflow-y-auto p-4">
        <h3 id={titleId} className="break-words text-[15px] font-semibold text-[#0e0f11]">
          {title}
        </h3>
        <p className="mt-1 text-[12px] leading-5 text-[#595959]">{INVITE_SCOPE_COPY}</p>

        {canInvite ? (
          <form onSubmit={submit} className="mt-3" noValidate>
            <div className="flex min-w-0 gap-2">
              <input
                ref={emailRef}
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  inviter.clearFieldError();
                }}
                placeholder="Invite by email"
                aria-label="Invite by email"
                aria-invalid={inlineError ? true : undefined}
                autoComplete="off"
                disabled={inviter.submitting}
                className="h-9 min-w-0 flex-1 rounded-[8px] border border-rule bg-transparent px-3 text-[13px] text-ink outline-none transition-[border-color,box-shadow] placeholder:text-inkLight focus:border-ink/35 focus:ring-2 focus:ring-ink/10 disabled:opacity-60"
              />
              <span className="relative shrink-0">
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as InviteRole)}
                  aria-label="Role"
                  disabled={inviter.submitting}
                  className="h-9 appearance-none rounded-[8px] border border-rule bg-transparent pl-3 pr-9 text-[13px] text-ink outline-none transition-[border-color,box-shadow] focus:border-ink/35 focus:ring-2 focus:ring-ink/10 disabled:opacity-60"
                >
                  {INVITE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_INFO[r].label}
                    </option>
                  ))}
                </select>
                <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-inkMuted" />
              </span>
            </div>
            {!inviter.seatCapError && (
              <button
                type="submit"
                disabled={inviter.submitting || !isValidInviteEmail(email)}
                className="invite-primary-action mt-2 inline-flex h-8 w-full items-center justify-center gap-2 rounded-full text-[13px] font-semibold disabled:cursor-not-allowed disabled:bg-bone disabled:text-inkLight"
              >
                {inviter.submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                {inviter.submitting ? "Sending…" : "Invite"}
              </button>
            )}
            {inlineError && (
              <p role="alert" className="mt-2 text-[12px] leading-5 text-rose-500">
                {inlineError}
              </p>
            )}
            {inviter.seatCapError && (
              <div role="alert" className="mt-3 rounded-[10px] border border-rule bg-bone/60 px-3 py-2.5">
                <p className="text-[13px] font-semibold text-ink">No seats left</p>
                <p className="mt-0.5 text-[12px] leading-5 text-inkMuted">{inviter.seatCapError}</p>
                <button
                  type="button"
                  onClick={seePlans}
                  className="invite-primary-action mt-2 inline-flex h-8 items-center rounded-full px-3.5 text-[13px] font-semibold"
                >
                  See plans
                </button>
              </div>
            )}
            {inviter.otherError && (
              <div
                role="alert"
                className="mt-2 text-[12px] leading-5 text-rose-500"
              >
                {inviter.otherError}
              </div>
            )}
          </form>
        ) : (
          <p className="mt-3 text-[12px] leading-5 text-[#8c8c8c]">Only workspace owners and admins can invite people.</p>
        )}

        {people.actionError && (
          <div role="alert" className="mt-2 text-[12px] leading-5 text-rose-500">
            {people.actionError}
          </div>
        )}
        {people.actionSuccess && (
          <div
            role="status"
            className="mt-2 text-[12px] leading-5 text-success"
          >
            {people.actionSuccess}
          </div>
        )}

        <p className="mt-4 text-[12px] font-semibold text-[#595959]">People in this workspace</p>
        {state.kind === "loading" && (
          <div
            role="status"
            aria-busy="true"
            aria-label="Loading people"
            className="mt-1"
          >
            {[0, 1].map((i) => (
              <div key={i} className="flex items-center gap-2.5 py-1.5">
                <Skeleton className="h-7 w-7" rounded="rounded-full" delayMs={i * 80} />
                <div className="min-w-0 flex-1">
                  <Skeleton className="h-3.5 w-28" rounded="rounded" delayMs={i * 80} />
                  <Skeleton className="mt-1 h-3 w-40 max-w-full" rounded="rounded" delayMs={i * 80 + 40} />
                </div>
                <Skeleton className="h-[22px] w-[52px]" rounded="rounded-full" delayMs={i * 80} />
              </div>
            ))}
          </div>
        )}
        {state.kind === "error" && (
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="text-[12px] leading-5 text-[#8c8c8c]">{state.message}</p>
            <button
              type="button"
              onClick={() => void people.refresh()}
              className="inline-flex h-7 shrink-0 items-center rounded-full border border-[#f0f0f0] bg-white px-3 text-[12px] font-semibold text-[#0e0f11] transition-colors hover:bg-[#f4f4f4]"
            >
              Retry
            </button>
          </div>
        )}
        {state.kind === "ready" && (
          <ul
            aria-label="People in this workspace"
            className="mt-1"
          >
            {state.members.length === 0 && state.invites.length === 0 && (
              <li className="py-1.5 text-[12px] text-[#8c8c8c]">No one here yet.</li>
            )}
            {state.members.map((m) => (
              <MemberRow
                key={m.user_id}
                member={m}
                self={m.user_id === currentUserId}
                options={roleChangeOptions(role, m, currentUserId)}
                menuOpen={roleMenuFor === m.user_id}
                busy={busy}
                onToggleMenu={() => setRoleMenuFor((v) => (v === m.user_id ? null : m.user_id))}
                onPick={(r) => {
                  setRoleMenuFor(null);
                  void people.changeRole(m, r);
                }}
                onCloseMenu={() => setRoleMenuFor(null)}
              />
            ))}
            {state.invites.map((inv) => (
              <InviteRow
                key={inv.id}
                invite={inv}
                canCancel={canCancelInvites(role)}
                busy={busy}
                cancelling={people.busyAction === `cancel invite:${inv.id}`}
                onCancel={() => void people.cancelInvite(inv)}
              />
            ))}
          </ul>
        )}

        <p className="mt-4 text-[12px] font-semibold text-[#595959]">General access</p>
        <div className="mt-1 flex items-start gap-2.5 py-1.5">
          <AuthorAvatar label={workspace?.tenantName?.trim() || "Workspace"} size="md" />
          <div className="min-w-0 flex-1">
            <p className="break-words text-[13px] font-medium text-ink">
              {workspace?.tenantName?.trim() || "This workspace"}
            </p>
            <p className="mt-0.5 text-[12px] leading-5 text-inkMuted">{GENERAL_ACCESS_COPY}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function PersonText({ email, self, note }: { email: string; self: boolean; note?: string }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="truncate text-[13px] font-medium leading-5 text-ink">
        {personName(email)}
        {self && <span className="ml-1.5 text-[12px] font-normal text-inkMuted">(You)</span>}
        {note && <span className="ml-1.5 text-[11px] font-normal uppercase tracking-wide text-inkLight">{note}</span>}
      </p>
      <p title={email} className="text-[12px] leading-4 text-inkMuted [overflow-wrap:anywhere]">
        {email}
      </p>
    </div>
  );
}

function MemberRow({
  member,
  self,
  options,
  menuOpen,
  busy,
  onToggleMenu,
  onPick,
  onCloseMenu,
}: {
  member: Member;
  self: boolean;
  options: InviteRole[];
  menuOpen: boolean;
  busy: boolean;
  onToggleMenu: () => void;
  onPick: (role: InviteRole) => void;
  onCloseMenu: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (menuOpen) menuRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [menuOpen]);
  return (
    <li>
      <div className="flex items-center gap-2.5 py-2">
        <AuthorAvatar label={personName(member.email)} size="md" />
        <PersonText email={member.email} self={self} />
        <div className="flex shrink-0 items-center gap-1">
          {options.length > 0 ? (
            <button
              type="button"
              onClick={onToggleMenu}
              disabled={busy}
              aria-label={`Change role for ${member.email}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="-mr-1 inline-flex items-center gap-0.5 rounded-full py-0.5 pl-0.5 pr-1 transition-colors hover:bg-[#f4f4f4] disabled:opacity-50"
            >
              <RoleBadge role={member.role} />
              <ChevronDown className="h-3.5 w-3.5 text-[#8c8c8c]" aria-hidden />
            </button>
          ) : (
            <RoleBadge role={member.role} />
          )}
        </div>
      </div>
      {menuOpen && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`Role for ${member.email}`}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onCloseMenu();
            }
          }}
          className="mb-1.5 ml-[38px] overflow-hidden rounded-lg border border-[#ececec] bg-white py-1 shadow-lg"
        >
          {options.map((r) => (
            <button
              key={r}
              type="button"
              role="menuitem"
              onClick={() => onPick(r)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-[#0e0f11] hover:bg-[#f9f9f9]"
            >
              Make {ROLE_INFO[r].label.toLowerCase()}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

function InviteRow({
  invite,
  canCancel,
  busy,
  cancelling,
  onCancel,
}: {
  invite: OpenInvite;
  canCancel: boolean;
  busy: boolean;
  cancelling: boolean;
  onCancel: () => void;
}) {
  return (
    <li className="flex items-center gap-2.5 py-2">
      <AuthorAvatar label={personName(invite.email)} size="md" />
      <PersonText email={invite.email} self={false} note="Invited" />
      <div className="flex shrink-0 items-center gap-1">
        <RoleBadge role={invite.role} />
        {canCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label={`Cancel invite for ${invite.email}`}
            className="-mr-1.5 rounded-full px-1.5 py-1 text-[12px] font-medium text-inkMuted transition-colors hover:bg-rose-500/10 hover:text-rose-600 disabled:opacity-50"
          >
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        )}
      </div>
    </li>
  );
}
