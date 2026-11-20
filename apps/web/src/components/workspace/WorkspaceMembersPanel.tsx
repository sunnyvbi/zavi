"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { apiFetch } from "@/lib/api";
import { useDismissableMenu } from "@/hooks/useDismissableMenu";
import { useDialogHost } from "@/lib/workspace/useDialogHost";
import {
  canManageMembers,
  isMember,
  isOwner,
  ROLE_INFO,
  type Member,
  type TenantRole,
} from "@/lib/members";
import { InviteMemberModal } from "@/components/InviteMemberModal";
import { roleChangeOptions, useWorkspaceMembers } from "@/hooks/useWorkspaceMembers";

export function WorkspaceMembersPanel({
  role,
  currentUserId,
  embedded = false,
  title,
  subtitle,
}: {
  role: TenantRole;
  currentUserId: string;
  embedded?: boolean;
  title?: string;
  subtitle?: string;
}) {
  const {
    state,
    busyAction,
    actionError,
    actionSuccess,
    runAction,
    changeRole,
    cancelInvite,
    inviteSucceeded,
  } = useWorkspaceMembers();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [transferTargetId, setTransferTargetId] = useState<string | null>(null);
  const [memberQuery, setMemberQuery] = useState("");
  const [inviteQuery, setInviteQuery] = useState("");

  const canManage = canManageMembers(role);
  const ownerOnly = isOwner(role);
  const readOnly = isMember(role);

  const filteredMembers = useMemo(() => {
    if (state.kind !== "ready") return [];
    const q = memberQuery.trim().toLowerCase();
    if (!q) return state.members;
    return state.members.filter((m) => m.email.toLowerCase().includes(q));
  }, [state, memberQuery]);

  const filteredInvites = useMemo(() => {
    if (state.kind !== "ready") return [];
    const q = inviteQuery.trim().toLowerCase();
    if (!q) return state.invites;
    return state.invites.filter((inv) => inv.email.toLowerCase().includes(q));
  }, [state, inviteQuery]);

  return (
    <div className="team-surface-enter">
      {}
      <div
        className={`mb-5 flex items-start gap-4 ${
          embedded && !title ? "justify-end" : "justify-between"
        }`}
      >
        {!embedded && (
          <div>
            <h1 className="font-display text-[26px] font-semibold tracking-tight text-ink">
              Members
            </h1>
            <p className="mt-1 text-[16px] text-inkMuted">
              {readOnly
                ? "Everyone in this workspace."
                : "Invite teammates as an admin, member or viewer."}
            </p>
          </div>
        )}
        {embedded && title && (
          <div className="flex flex-col gap-2">
            <h2 className="text-[20px] font-semibold leading-[28px] tracking-tight text-ink">
              {title}
            </h2>
            {subtitle && (
              <p className="text-[14px] leading-6 text-inkMuted">
                {subtitle}
              </p>
            )}
          </div>
        )}
        {canManage && (
          <button
            type="button"
            onClick={() => setInviteOpen(true)}
            className="team-primary-action inline-flex h-10 shrink-0 items-center gap-2 rounded-full pl-4 pr-5 text-[14px] font-semibold shadow-sm transition-[background-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:shadow-md active:translate-y-0"
          >
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            Invite a member
          </button>
        )}
      </div>

    <div
      data-testid="team-members-surface"
      className="team-surface-enter rounded-3xl border border-rule bg-cream p-4 shadow-[0_1px_2px_rgba(14,15,17,0.03),0_12px_36px_rgba(14,15,17,0.04)]"
    >
      {actionError && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-700"
        >
          {actionError}
        </div>
      )}

      {actionSuccess && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13px] text-emerald-700"
        >
          {actionSuccess}
        </div>
      )}

      {state.kind === "loading" && <MembersTableSkeleton />}

      {state.kind === "error" && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-4 text-[13px] text-rose-700">
          {state.message}
        </div>
      )}

      {state.kind === "ready" && (
        <div className="flex flex-col gap-8">
          {}
          <section className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2.5">
              <p className="flex-1 text-[16px] font-semibold tracking-tight text-ink">
                Members ({state.members.length})
              </p>
              {state.members.length > 0 && (
                <SearchField
                  value={memberQuery}
                  onChange={setMemberQuery}
                />
              )}
            </div>

            <div data-testid="members-table" className="overflow-x-auto rounded-2xl border border-rule bg-bone/25">
              <table className="w-full table-fixed border-collapse">
                <colgroup>
                  <col className="w-[42%]" />
                  <col className="w-[18%]" />
                  <col className="w-[22%]" />
                  <col className="w-[18%]" />
                </colgroup>
                <thead>
                  <tr className="bg-bone/70">
                    <Th>Email</Th>
                    <Th>Role</Th>
                    <Th>Joined</Th>
                    <Th>Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {filteredMembers.length === 0 ? (
                    <EmptyRow>
                      {memberQuery
                        ? "No members match that search."
                        : "No members yet."}
                    </EmptyRow>
                  ) : (
                    filteredMembers.map((m) => {
                      const isSelf = m.user_id === currentUserId;
                      return (
                        <tr key={m.user_id} className="transition-colors duration-200 hover:bg-bone/45">
                          <Td>
                            <span className="flex min-w-0 max-w-full items-baseline gap-2.5">
                              <span className="truncate text-[14px] font-medium text-ink">
                                {m.email}
                              </span>
                              {isSelf && (
                                <span className="shrink-0 text-[13px] text-inkMuted">
                                  (You)
                                </span>
                              )}
                            </span>
                          </Td>
                          <Td>
                            <RoleBadge role={m.role} />
                          </Td>
                          <Td>
                            <span className="whitespace-nowrap text-[14px] font-medium text-ink">
                              {formatDate(m.joined_at)}
                            </span>
                          </Td>
                          <Td>
                            <RowMenu
                              busy={busyAction !== null}
                              items={
                                canManage && m.role !== "owner"
                                  ? [
                                      ...roleChangeOptions(role, m, currentUserId).map((r) => ({
                                        label: `Make ${ROLE_INFO[r].label.toLowerCase()}`,
                                        onClick: () => void changeRole(m, r),
                                      })),
                                      ownerOnly && {
                                        label: "Transfer ownership",
                                        danger: true,
                                        onClick: () =>
                                          setTransferTargetId(m.user_id),
                                      },
                                      {
                                        label: "Revoke access",
                                        danger: true,
                                        onClick: () => {
                                          if (
                                            !confirm(
                                              `Revoke ${m.email}? They'll lose access immediately. Their past runs stay visible to owners and admins.`,
                                            )
                                          )
                                            return;
                                          void runAction(
                                            "revoke member",
                                            () =>
                                              apiFetch(
                                                `/api/v1/members/${m.user_id}`,
                                                { method: "DELETE" },
                                              ),
                                            `${m.email} was removed from the team.`,
                                          );
                                        },
                                      },
                                    ]
                                  : []
                              }
                            />
                          </Td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {}
          {state.invites.length > 0 && (
          <>
          <div className="h-px w-full bg-rule" />

          <section className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2.5">
              <p className="flex-1 text-[16px] font-semibold tracking-tight text-ink">
                Open invites ({state.invites.length})
              </p>
              <SearchField
                value={inviteQuery}
                onChange={setInviteQuery}
              />
            </div>

            <div data-testid="open-invites-table" className="overflow-x-auto rounded-2xl border border-rule bg-bone/25">
              <table className="w-full table-fixed border-collapse">
                <colgroup>
                  <col className="w-[42%]" />
                  <col className="w-[18%]" />
                  <col className="w-[22%]" />
                  <col className="w-[18%]" />
                </colgroup>
                <thead>
                  <tr className="bg-bone/70">
                    <Th>Email</Th>
                    <Th>Role</Th>
                    <Th>Invited</Th>
                    <Th align="right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {filteredInvites.length === 0 ? (
                    <EmptyRow>
                      {inviteQuery
                        ? "No invites match that search."
                        : "No invites are waiting for a response."}
                    </EmptyRow>
                  ) : (
                    filteredInvites.map((inv) => (
                      <tr key={inv.id} className="transition-colors duration-200 hover:bg-bone/45">
                        <Td>
                          <span className="block truncate text-[14px] font-medium text-ink">
                            {inv.email}
                          </span>
                        </Td>
                        <Td>
                          <RoleBadge role={inv.role} />
                        </Td>
                        <Td>
                          <span className="whitespace-nowrap text-[14px] font-medium text-ink">
                            {formatDate(inv.invited_at)}
                          </span>
                        </Td>
                        <Td>
                          {}
                          <div className="flex justify-end">
                          {canManage ? (
                            <button
                              type="button"
                              onClick={() => void cancelInvite(inv)}
                              disabled={busyAction !== null}
                              aria-label={`Cancel invite for ${inv.email}`}
                              className="rounded-cta px-2.5 py-1.5 text-[14px] font-semibold text-rose-600 transition-[background-color,color,opacity] duration-200 hover:bg-rose-500/10 hover:text-rose-500 disabled:opacity-50"
                            >
                              {busyAction === `cancel invite:${inv.id}`
                                ? "Cancelling…"
                                : "Cancel"}
                            </button>
                          ) : (
                            <span className="text-[13px] text-[#747c88]">
                              -
                            </span>
                          )}
                          </div>
                        </Td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
          </>
          )}
        </div>
      )}
    </div>

      {(() => {
        const transferTarget =
          transferTargetId && state.kind === "ready"
            ? state.members.find((m) => m.user_id === transferTargetId)
            : undefined;
        if (!transferTarget) return null;
        return (
          <TransferOwnershipModal
            member={transferTarget}
            busy={busyAction !== null}
            onClose={() => setTransferTargetId(null)}
            onConfirm={async () => {
              const ok = await runAction(
                "transfer ownership",
                () =>
                  apiFetch(
                    `/api/v1/members/${transferTarget.user_id}/transfer-ownership`,
                    { method: "POST", body: "{}" },
                  ),
                `${transferTarget.email} is now the owner.`,
              );
              if (ok) setTransferTargetId(null);
            }}
          />
        );
      })()}

      {!readOnly && (
        <InviteMemberModal
          open={inviteOpen}
          onClose={() => setInviteOpen(false)}
          onInvited={inviteSucceeded}
        />
      )}
    </div>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={`px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-inkMuted ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td className="border-t border-rule px-6 py-3.5 align-middle">
      {children}
    </td>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <tr>
      <td
        colSpan={5}
        className="border-t border-rule px-6 py-8 text-center text-[13px] text-inkMuted"
      >
        {children}
      </td>
    </tr>
  );
}

function MembersTableSkeleton() {
  return (
    <section className="flex flex-col gap-2.5" aria-hidden>
      <div className="flex items-center gap-2.5">
        <div className="h-5 w-32 animate-pulse rounded bg-bone" />
        <div className="ml-auto h-9 w-[256px] animate-pulse rounded-xl bg-bone" />
      </div>
      <div className="overflow-hidden rounded-2xl border border-rule">
        <div className="flex items-center gap-4 bg-bone/70 px-6 py-3">
          <div className="h-3 w-[28%] rounded bg-ink/10" />
          <div className="h-3 w-[10%] rounded bg-ink/10" />
          <div className="h-3 w-[24%] rounded bg-ink/10" />
          <div className="h-3 w-[14%] rounded bg-ink/10" />
          <div className="ml-auto h-3 w-[12%] rounded bg-ink/10" />
        </div>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="flex items-center gap-4 border-t border-rule px-6 py-3.5"
          >
            <div className="h-4 w-[28%] animate-pulse rounded bg-bone" />
            <div className="h-[22px] w-[52px] animate-pulse rounded-full bg-bone" />
            <div className="h-4 w-[24%] animate-pulse rounded bg-bone" />
            <div className="h-4 w-[88px] animate-pulse rounded bg-bone" />
            <div className="ml-auto h-5 w-5 animate-pulse rounded bg-bone" />
          </div>
        ))}
      </div>
    </section>
  );
}

function SearchField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex h-9 w-[256px] max-w-[48%] items-center gap-2 rounded-full border border-rule bg-cream px-3 transition-[border-color,box-shadow,background-color] duration-200 focus-within:border-ink/30 focus-within:bg-bone/30 focus-within:ring-2 focus-within:ring-ink/10">
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4 shrink-0 text-inkLight"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Search team"
        placeholder="Search team…"
        className="w-full bg-transparent text-[13px] text-ink placeholder:text-inkLight focus:outline-none"
      />
    </label>
  );
}

export function RoleBadge({ role }: { role: TenantRole }) {
  const cls =
    role === "owner"
      ? "team-role-owner"
      : role === "admin"
        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
        : role === "viewer"
          ? "border border-rule bg-cream text-inkMuted"
          : "bg-bone text-ink";
  return (
    <span
      className={`inline-flex items-center rounded-full px-1.5 py-1 text-[12px] font-medium capitalize leading-none ${cls}`}
    >
      {role}
    </span>
  );
}

type MenuItem = { label: string; onClick: () => void; danger?: boolean };

function RowMenu({
  items,
  busy,
}: {
  items: Array<MenuItem | false | undefined>;
  busy: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const scopeRef = useRef({
    contains: (n: Node | null) =>
      Boolean(ref.current?.contains(n) || menuRef.current?.contains(n)),
  });
  const { open, toggle, close } = useDismissableMenu(
    scopeRef as unknown as RefObject<HTMLElement>,
    btnRef,
  );
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const real = items.filter((i): i is MenuItem => Boolean(i));
  const host = useDialogHost(open);

  const place = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    setPos({
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onReposition = () => close(false);
    window.addEventListener("scroll", onReposition, true);
    window.addEventListener("resize", onReposition);
    return () => {
      window.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition);
    };
  }, [open, close]);

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [open, pos]);

  if (real.length === 0) {
    return (
      <span className="inline-flex h-8 items-center text-[13px] text-inkLight/60">
        No actions
      </span>
    );
  }

  return (
    <div ref={ref} className="relative inline-block">
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-label="Member actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex h-8 w-8 items-center justify-center rounded-cta text-ink transition-[background-color,transform] duration-200 enabled:hover:scale-105 enabled:hover:bg-bone disabled:cursor-default disabled:opacity-30"
      >
        {}
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          fill="currentColor"
          className="h-[18px] w-[18px]"
        >
          <circle cx="12" cy="5" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="12" cy="19" r="1.7" />
        </svg>
      </button>
      {open &&
        pos &&
        host &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ top: pos.top, right: pos.right }}
            className="team-menu-enter fixed z-50 min-w-[180px] overflow-hidden rounded-xl border border-rule bg-cream py-1.5 shadow-[0_12px_36px_rgba(25,25,25,0.16)]"
          >
            {real.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  item.onClick();
                }}
                className={`block w-full px-3 py-2 text-left text-[13px] transition-colors hover:bg-bone ${
                  item.danger ? "text-rose-600" : "text-ink"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>,
          host,
        )}
    </div>
  );
}

function formatDate(value: string | null): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value.slice(0, 10);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function TransferOwnershipModal({
  member,
  busy,
  onClose,
  onConfirm,
}: {
  member: Member;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
}) {
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const matches = typed.trim().toLowerCase() === member.email.toLowerCase();

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const submit = () => {
    if (!matches || busy) return;
    void onConfirm();
  };

  return (
    <div
      className="dialog-scrim fixed inset-0 z-50 flex items-center justify-center px-4"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="transfer-ownership-title"
        className="team-dialog-enter w-full max-w-md rounded-3xl border border-rule bg-cream p-6 shadow-[0_24px_80px_rgba(0,0,0,0.28)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          id="transfer-ownership-title"
          className="mb-1 text-[16px] font-semibold tracking-tight text-[#0e0f11]"
        >
          Transfer ownership
        </div>
        <p className="mb-4 text-[13px] leading-relaxed text-[#595959]">
          <span className="font-medium text-[#1f1f1f]">{member.email}</span>{" "}
          becomes the Owner and you become an Admin. This{" "}
          <span className="font-medium text-[#cb2029]">cannot be undone.</span>
        </p>
        <label className="mb-1.5 block text-[14px] font-medium text-[#1f1f1f]">
          Type their email to confirm
        </label>
        <input
          ref={inputRef}
          type="email"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          disabled={busy}
          placeholder={member.email}
          autoComplete="off"
          className="w-full rounded-lg border border-ink/[0.12] bg-white px-3 py-2 text-[16px] text-[#1f1f1f] placeholder:text-[#a3a3a3] focus:border-ink/30 focus:outline-none focus:ring-2 focus:ring-ink/10 disabled:opacity-50"
        />
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex h-10 items-center rounded-cta border border-ink/[0.08] bg-white px-3 text-[13px] font-medium text-[#1f1f1f] transition-colors hover:bg-bone/40 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !matches}
            className="inline-flex h-10 items-center rounded-cta bg-[#cb2029] px-4 text-[13px] font-medium text-white transition-colors hover:bg-[#b01c24] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Transferring…" : "Transfer ownership"}
          </button>
        </div>
      </div>
    </div>
  );
}
