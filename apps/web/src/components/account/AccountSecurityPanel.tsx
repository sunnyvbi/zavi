"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase";
import { apiFetch } from "@/lib/api";
import { resetAnalyticsIdentity } from "@/lib/analytics/mixpanel";
import { trackEvent } from "@/lib/analytics/events";
import { Input } from "@/components/Input";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { CookiePrefsButton } from "@/components/marketing/CookiePrefsButton";
import { ROLE_INFO } from "@/lib/members";

const CARD = "rounded-2xl border border-rule bg-white p-4 dark:bg-cream";
const CARD_TITLE = "text-[14px] font-medium text-ink";
const CARD_BODY = "mt-1 text-[14px] leading-[1.55] text-inkMuted";
const PRIMARY_BTN =
  "inline-flex h-10 items-center rounded-cta bg-ink px-4 text-[14px] font-semibold text-cream hover:bg-inkSoft disabled:cursor-not-allowed disabled:opacity-35";
const SECONDARY_BTN =
  "inline-flex h-10 items-center rounded-cta border border-rule px-3.5 text-[14px] font-semibold text-ink hover:bg-creamDeep disabled:opacity-50";
const DANGER_BTN =
  "inline-flex h-10 shrink-0 items-center gap-2 rounded-cta border border-rule bg-transparent px-3.5 text-[14px] font-semibold text-danger transition-colors hover:border-danger/40 hover:bg-danger/10 disabled:opacity-50";
const ERROR_TEXT = "mt-3 text-[13px] text-danger";

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  ...Object.fromEntries(Object.entries(ROLE_INFO).map(([k, v]) => [k, v.label])),
};

function useSoleMemberOnPaidPlan(enabled: boolean): boolean {
  const [show, setShow] = useState(false);
  useEffect(() => {
    setShow(false);
    if (!enabled) return;
    let live = true;
    (async () => {
      try {
        const [membersRes, creditsRes] = await Promise.all([
          apiFetch("/api/v1/members"),
          apiFetch("/api/billing/credits"),
        ]);
        if (!membersRes.ok || !creditsRes.ok) return;
        const members = ((await membersRes.json()) as { members?: unknown }).members;
        const credits = (await creditsRes.json()) as {
          manage_via_portal?: unknown;
          managed_in_store?: unknown;
        };
        const paid = credits.manage_via_portal === true || credits.managed_in_store === true;
        if (live) setShow(Array.isArray(members) && members.length === 1 && paid);
      } catch {
      }
    })();
    return () => {
      live = false;
    };
  }, [enabled]);
  return show;
}

export function AccountSecurityPanel({
  email: emailProp,
  role,
  onOpenBilling,
}: {
  email?: string | null;
  role?: string | null;
  onOpenBilling?: () => void;
}) {
  const router = useRouter();
  const showCancelPlanFirst = useSoleMemberOnPaidPlan(Boolean(onOpenBilling));

  const [email, setEmail] = useState<string | null>(emailProp ?? null);
  useEffect(() => {
    if (emailProp) return;
    let live = true;
    createBrowserSupabase()
      .auth.getUser()
      .then(({ data }) => {
        if (live) setEmail(data.user?.email ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [emailProp]);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pwSubmitting, setPwSubmitting] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);

  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function onChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwSuccess(false);
    if (password.length < 8) {
      setPwError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setPwError("Passwords don't match.");
      return;
    }
    setPwSubmitting(true);
    setPwError(null);
    try {
      const supabase = createBrowserSupabase();
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw new Error(error.message);
      setPassword("");
      setConfirm("");
      setPwSuccess(true);
    } catch (err) {
      setPwError((err as Error).message);
    } finally {
      setPwSubmitting(false);
    }
  }

  async function onDeleteAccount() {
    setDeleteError(null);
    const confirmed = await confirmAction({
      title: "Delete your account?",
      description:
        "This is permanent and cannot be undone. A workspace where you are the only member is deleted with it. A workspace others still use stays with them.",
      confirmLabel: "Delete account",
      tone: "danger",
    });
    if (!confirmed) return;

    setDeleting(true);
    try {
      const res = await apiFetch("/api/account", {
        method: "DELETE",
        body: JSON.stringify({ source: "web" }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = (body as { error?: { message?: string } })?.error?.message;
        throw new Error(msg ?? `Deletion failed (${res.status}).`);
      }

      trackEvent("account_deleted", { source: "web" });
      resetAnalyticsIdentity();
      const supabase = createBrowserSupabase();
      await supabase.auth.signOut({ scope: "global" });
      router.push("/login");
      router.refresh();
    } catch (err) {
      setDeleteError((err as Error).message);
      setDeleting(false);
    }
  }

  async function onSignOutEverywhere() {
    setSigningOut(true);
    setSignOutError(null);
    try {
      const supabase = createBrowserSupabase();
      const { error } = await supabase.auth.signOut({ scope: "global" });
      if (error) throw new Error(error.message);
      trackEvent("logged_out", { scope: "global" });
      resetAnalyticsIdentity();
      router.push("/login");
      router.refresh();
    } catch (err) {
      setSignOutError((err as Error).message);
      setSigningOut(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="account-panel">
      {}
      <section className={CARD}>
        <h3 className={CARD_TITLE}>Signed in as</h3>
        <p className="mt-1 break-all text-[14px] text-ink">{email ?? "-"}</p>
        {role && (
          <p className={CARD_BODY}>
            Your role in this workspace:{" "}
            <span className="font-semibold text-ink">{ROLE_LABEL[role] ?? role}</span>.
            {role !== "owner" && role !== "admin" && " Invites and roles are managed by your workspace owner or admin."}
          </p>
        )}
      </section>

      {}
      <section className={CARD}>
        <h3 className={CARD_TITLE}>Change password</h3>
        <p className={CARD_BODY}>
          Set a new password for your Zavi sign-in. Other devices stay signed in.
        </p>
        <form onSubmit={onChangePassword} className="mt-3 max-w-[420px]">
          <label
            htmlFor="account-new-password"
            className="mb-1.5 block text-[14px] font-medium text-ink"
          >
            New password
          </label>
          <Input
            id="account-new-password"
            type="password"
            required
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setPwSuccess(false);
            }}
            placeholder="At least 8 characters"
            autoComplete="new-password"
            minLength={8}
            disabled={pwSubmitting}
          />
          <label
            htmlFor="account-confirm-password"
            className="mb-1.5 mt-3 block text-[14px] font-medium text-ink"
          >
            Confirm new password
          </label>
          <Input
            id="account-confirm-password"
            type="password"
            required
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
              setPwSuccess(false);
            }}
            autoComplete="new-password"
            minLength={8}
            disabled={pwSubmitting}
          />
          {pwError && (
            <p role="alert" aria-live="polite" className={ERROR_TEXT}>
              {pwError}
            </p>
          )}
          {pwSuccess && (
            <p role="status" aria-live="polite" className="mt-3 text-[13px] text-ink">
              Password updated.
            </p>
          )}
          <button
            type="submit"
            disabled={pwSubmitting || !password || !confirm}
            className={`mt-4 ${PRIMARY_BTN}`}
          >
            {pwSubmitting ? "Saving..." : "Update password"}
          </button>
        </form>
      </section>

      {}
      <section className={CARD}>
        <h3 className={CARD_TITLE}>Active sessions</h3>
        <p className={CARD_BODY}>
          Sign out of Zavi on every device, including this one. Use this if you lost a device or
          think someone else has your sign-in.
        </p>
        {signOutError && (
          <p role="alert" aria-live="polite" className={ERROR_TEXT}>
            {signOutError}
          </p>
        )}
        <button
          type="button"
          onClick={onSignOutEverywhere}
          disabled={signingOut}
          className={`mt-3 ${SECONDARY_BTN}`}
        >
          {signingOut ? "Signing out..." : "Sign out everywhere"}
        </button>
      </section>

      {}
      <section className={CARD}>
        <h3 className={CARD_TITLE}>Cookies</h3>
        <p className={CARD_BODY}>
          Analytics cookies are on unless you turned them off. Change that choice here at any
          time; withdrawing deletes the analytics identifiers from this browser. See the{" "}
          <a href="/cookie-policy" className="underline underline-offset-2 hover:text-ink">
            cookie policy
          </a>
          .
        </p>
        <CookiePrefsButton className={`mt-3 ${SECONDARY_BTN}`} />
      </section>

      {}
      <section className="rounded-2xl border border-danger/20 bg-white p-4 dark:bg-cream">
        <h3 className="text-[14px] font-medium text-danger">Delete account</h3>
        <p className={CARD_BODY}>
          Permanently delete your Zavi account. This cannot be undone. A workspace where you are
          the only member is deleted with it; a workspace others still use stays with them. If you
          are the only owner of a workspace with other members, make someone else an owner first.
        </p>
        {onOpenBilling && showCancelPlanFirst && (
          <p className={CARD_BODY} data-testid="account-cancel-plan-first">
            Deleting does not cancel a paid plan. Cancel it in{" "}
            <button
              type="button"
              onClick={onOpenBilling}
              className="font-semibold text-ink underline underline-offset-2"
            >
              Billing
            </button>{" "}
            first.
          </p>
        )}
        {deleteError && (
          <p role="alert" aria-live="polite" className={ERROR_TEXT}>
            {deleteError}
          </p>
        )}
        <button
          type="button"
          onClick={() => void onDeleteAccount()}
          disabled={deleting}
          className={`mt-3 ${DANGER_BTN}`}
        >
          {deleting ? "Deleting..." : "Delete account"}
        </button>
      </section>
    </div>
  );
}
