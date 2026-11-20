"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ROLE_INFO } from "@/lib/members";
import { RadioCard } from "@/components/RadioCard";
import { useDialogHost } from "@/lib/workspace/useDialogHost";
import { useWorkspaceOptional } from "@/components/workspace/WorkspaceShell";
import { openBillingSettings } from "@/lib/workspace/openBilling";
import { PLANS_HASH } from "@/lib/workspace/pendingPlan";
import { INVITE_ROLES, isValidInviteEmail, useInviteMember, type InviteRole } from "@/hooks/useInviteMember";

type Role = InviteRole;
const ROLE_ORDER: Role[] = INVITE_ROLES;

export type InviteMemberModalProps = {
  open: boolean;
  onClose: () => void;
  onInvited: (email: string) => void;
};

export function InviteMemberModal({
  open,
  onClose,
  onInvited,
}: InviteMemberModalProps) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const inviter = useInviteMember();
  const { status, reset, invite } = inviter;
  const host = useDialogHost(open);
  const workspace = useWorkspaceOptional();
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setEmail("");
      setRole("member");
      reset();
    }
  }, [open, reset]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const invited = await invite(email, role);
      if (invited) {
        onInvited(invited);
        onClose();
      }
    },
    [email, role, invite, onInvited, onClose],
  );

  const errorMessage = status.kind === "error" ? status.message : null;
  useEffect(() => {
    if (errorMessage) errorRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [errorMessage]);

  const seePlans = useCallback(() => {
    onClose();
    if (workspace) openBillingSettings(workspace.openTab, PLANS_HASH);
    else window.location.hash = PLANS_HASH;
  }, [onClose, workspace]);

  if (!open || !host) return null;

  const submitting = inviter.submitting;
  const inlineUserExistsError = inviter.userExistsError;
  const inlineEmailError = inviter.emailError;
  const seatCapError = inviter.seatCapError;
  const otherError = inviter.otherError;

  const canSubmit = !submitting && isValidInviteEmail(email);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-modal-title"
      className="dialog-scrim fixed inset-0 z-50 flex items-center justify-center px-4 py-6"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="team-dialog-enter relative flex max-h-[90vh] w-full max-w-[500px] flex-col overflow-hidden rounded-3xl border border-rule bg-cream shadow-[0_24px_80px_rgba(0,0,0,0.32)]">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          aria-label="Close"
          className="absolute right-5 top-5 z-10 inline-flex size-8 items-center justify-center rounded-full border border-rule bg-bone text-ink transition-colors hover:border-ink/20 hover:bg-creamDeep disabled:opacity-50"
        >
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-4"
          >
            <path d="M6 6 18 18M18 6 6 18" />
          </svg>
        </button>

        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <div className="scrollbar-clean min-h-0 flex-1 overflow-y-auto">
            {}
            <div className="border-b border-rule px-6 pb-5 pt-6 pr-16">
              <h2
                id="invite-modal-title"
                className="text-[21px] font-semibold leading-7 tracking-tight text-ink"
              >
                Invite a teammate
              </h2>
              <p className="mt-1.5 text-[14px] leading-6 text-inkMuted">
                They&apos;ll get an email link to join this workspace.
              </p>
            </div>

            {}
            <div className="px-6 py-4">
              <label
                htmlFor="invite-email"
                className="block text-[14px] font-medium leading-5 text-ink"
              >
                Email
              </label>
              <input
                id="invite-email"
                type="email"
                required
                autoFocus
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  inviter.clearFieldError();
                }}
                placeholder="teammate@company.com"
                autoComplete="off"
                disabled={submitting}
                className="mt-2.5 h-12 w-full rounded-xl border border-rule bg-transparent px-3.5 text-[14px] font-medium text-ink outline-none transition-[border-color,box-shadow] placeholder:text-inkLight focus:border-ink/35 focus:ring-2 focus:ring-ink/10 disabled:opacity-60"
              />
              {inlineEmailError && (
                <p role="alert" className="mt-2 text-[13px] text-rose-500">
                  {inlineEmailError}
                </p>
              )}
              {inlineUserExistsError && (
                <p role="alert" className="mt-2 text-[13px] text-rose-500">
                  {inlineUserExistsError}
                </p>
              )}
            </div>

            <div className="border-t border-rule px-6 py-4">
            <fieldset>
              <legend className="mb-3 text-[14px] font-semibold leading-5 text-ink">
                Role
              </legend>
              <div className="space-y-2.5">
                {ROLE_ORDER.map((r) => (
                  <RadioCard
                    key={r}
                    name="invite-role"
                    value={r}
                    checked={role === r}
                    onSelect={() => setRole(r)}
                    disabled={submitting}
                    label={ROLE_INFO[r].label}
                    description={ROLE_INFO[r].help}
                  />
                ))}
              </div>
            </fieldset>
            </div>

            {seatCapError && (
              <div ref={errorRef} className="px-6 pb-5">
                <div
                  role="alert"
                  className="rounded-xl border border-rule bg-bone/60 px-4 py-3"
                >
                  <p className="text-[14px] font-semibold leading-5 text-ink">
                    No seats left
                  </p>
                  <p className="mt-1 text-[13px] leading-5 text-inkMuted">
                    {seatCapError}
                  </p>
                </div>
              </div>
            )}

            {otherError && (
              <div ref={errorRef} className="px-6 pb-5">
                <div
                  role="alert"
                  className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[13px] text-rose-500"
                >
                  {otherError}
                </div>
              </div>
            )}
          </div>

          {}
          <div className="flex items-center justify-end gap-3 border-t border-rule bg-bone/20 px-6 py-4">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="inline-flex min-h-11 items-center justify-center rounded-full border border-rule bg-transparent px-4 py-2.5 text-[14px] font-semibold text-ink transition-[background-color,border-color,transform] duration-200 hover:-translate-y-px hover:border-ink/20 hover:bg-bone active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
            {seatCapError ? (
              <button
                type="button"
                onClick={seePlans}
                className="invite-primary-action inline-flex min-h-11 min-w-[122px] items-center justify-center rounded-full px-4 py-2.5 text-[14px] font-semibold shadow-sm transition-[background-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:shadow-md active:translate-y-0"
              >
                See plans
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSubmit}
                className="invite-primary-action inline-flex min-h-11 min-w-[122px] items-center justify-center rounded-full px-4 py-2.5 text-[14px] font-semibold shadow-sm transition-[background-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:shadow-md active:translate-y-0 disabled:cursor-not-allowed disabled:bg-bone disabled:text-inkLight disabled:shadow-none"
              >
                {submitting ? "Sending invite…" : "Send Invite"}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>,
    host,
  );
}
