"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase";
import { apiFetch } from "@/lib/api";
import { ROLE_INFO } from "@/lib/members";
import { switchToTenant } from "@/lib/workspace/tenantSwitch";
import { landInInvitedTenant, type LandedTenant } from "./landInInvitedTenant";

type AcceptResponse = LandedTenant;

type Status =
  | { kind: "loading" }
  | { kind: "auth_required"; loginHref: string }
  | { kind: "missing_id" }
  | { kind: "submitting" }
  | { kind: "success"; data: AcceptResponse }
  | { kind: "wrong_account"; resent: false }
  | { kind: "wrong_account"; resent: true; emailMasked: string }
  | { kind: "error"; code: ErrorCode; message: string };

type ErrorCode =
  | "invite_not_found"
  | "invite_revoked"
  | "email_mismatch"
  | "already_accepted"
  | "joined_not_opened"
  | "network"
  | "unknown";

export default function InviteAcceptPage() {
  return (
    <Suspense fallback={<CenteredShell><Spinner /></CenteredShell>}>
      <InviteAcceptInner />
    </Suspense>
  );
}

function InviteAcceptInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const inviteId = searchParams.get("id");
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  const acceptInvite = useCallback(
    async (id: string) => {
      setStatus({ kind: "submitting" });
      try {
        const res = await apiFetch("/api/v1/members/accept", {
          method: "POST",
          body: JSON.stringify({ inviteId: id }),
        });
        if (!res.ok) {
          const errCode = mapErrorCode(res.status);
          if (errCode === "email_mismatch") {
            const supabase = createBrowserSupabase();
            await supabase.auth.signOut({ scope: "local" }).catch(() => {});
            setStatus({ kind: "wrong_account", resent: false });
            return;
          }
          const body = (await res.json().catch(() => null)) as
            | { error?: { message?: string } }
            | null;
          setStatus({
            kind: "error",
            code: errCode,
            message: body?.error?.message ?? defaultErrorMessage(errCode),
          });
          return;
        }
        const supabase = createBrowserSupabase();
        const { data: userData } = await supabase.auth.getUser();
        const userId = userData.user?.id;
        if (!userId) {
          setStatus({
            kind: "error",
            code: "unknown",
            message:
              "Joined the workspace but lost your session. Sign in again to continue.",
          });
          return;
        }
        const landed = await landInInvitedTenant(supabase, userId);
        if (!landed) {
          setStatus({
            kind: "error",
            code: "joined_not_opened",
            message: defaultErrorMessage("joined_not_opened"),
          });
          return;
        }
        setStatus({ kind: "success", data: landed });
      } catch {
        setStatus({
          kind: "error",
          code: "network",
          message:
            "Couldn't reach Zavi to accept the invite. Check your connection and try again.",
        });
      }
    },
    [],
  );

  const [resending, setResending] = useState(false);
  const resendLink = useCallback(async () => {
    if (!inviteId) return;
    setResending(true);
    try {
      const res = await apiFetch(
        `/api/v1/members/invite/${encodeURIComponent(inviteId)}/resend`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; email_masked?: string; error?: { message?: string } }
        | null;
      if (res.ok && body?.ok) {
        setStatus({
          kind: "wrong_account",
          resent: true,
          emailMasked: body.email_masked ?? "your invited email",
        });
      } else {
        setStatus({
          kind: "error",
          code: "unknown",
          message:
            body?.error?.message ??
            "Couldn't send a fresh link. Ask the person who invited you to re-send.",
        });
      }
    } catch {
      setStatus({
        kind: "error",
        code: "network",
        message: "Couldn't reach Zavi. Check your connection and try again.",
      });
    } finally {
      setResending(false);
    }
  }, [inviteId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!inviteId) {
        if (!cancelled) setStatus({ kind: "missing_id" });
        return;
      }
      const supabase = createBrowserSupabase();
      let user = null;
      for (let i = 0; i < 15; i++) {
        const { data } = await supabase.auth.getUser();
        if (cancelled) return;
        if (data.user) {
          user = data.user;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!user) {
        const next = `/invite/accept?id=${encodeURIComponent(inviteId)}`;
        setStatus({
          kind: "auth_required",
          loginHref: `/login?next=${encodeURIComponent(next)}`,
        });
        return;
      }
      await acceptInvite(inviteId);
    })();
    return () => {
      cancelled = true;
    };
  }, [inviteId, acceptInvite]);

  if (status.kind === "loading" || status.kind === "submitting") {
    return (
      <CenteredShell>
        <Spinner />
        <p className="mt-4 text-[16px] text-slate-500">
          {status.kind === "submitting"
            ? "Joining your team workspace…"
            : "Checking your invite…"}
        </p>
      </CenteredShell>
    );
  }

  if (status.kind === "auth_required") {
    return (
      <CenteredShell>
        <Heading>Sign in to accept your invite</Heading>
        <p className="mt-2 text-[16px] text-slate-600 leading-[1.55]">
          You need a Zavi account to join the team. We'll bring you right back
          here after you sign in.
        </p>
        <Link
          href={status.loginHref}
          className="mt-6 inline-flex items-center justify-center rounded-full bg-slate-900 px-4 py-2.5 text-[16px] font-medium text-white transition-colors hover:bg-slate-700"
        >
          Continue to sign in
        </Link>
      </CenteredShell>
    );
  }

  if (status.kind === "missing_id") {
    return (
      <CenteredShell>
        <Heading>This invite link looks broken</Heading>
        <p className="mt-2 text-[16px] text-slate-600 leading-[1.55]">
          The link is missing its invite ID. Ask the person who invited you to
          send a fresh one.
        </p>
      </CenteredShell>
    );
  }

  if (status.kind === "wrong_account") {
    return (
      <CenteredShell>
        <Heading>Wrong account for this invite</Heading>
        {status.resent ? (
          <>
            <p className="mt-2 text-[16px] text-slate-600 leading-[1.55]">
              We've signed you out and sent a fresh sign-in link to{" "}
              <span className="font-medium text-slate-900">{status.emailMasked}</span>.
              Open that email and click the link to join the workspace.
            </p>
            <p className="mt-3 text-[12px] text-slate-400">
              You can close this tab.
            </p>
          </>
        ) : (
          <>
            <p className="mt-2 text-[16px] text-slate-600 leading-[1.55]">
              This invite was sent to a different account than the one you were
              signed into. We've signed you out. Get a fresh sign-in link for
              the invited email to continue.
            </p>
            <button
              type="button"
              disabled={resending}
              onClick={() => void resendLink()}
              className="mt-6 inline-flex items-center justify-center rounded-full bg-slate-900 px-4 py-2.5 text-[16px] font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
            >
              {resending ? "Sending…" : "Send me a fresh sign-in link"}
            </button>
          </>
        )}
      </CenteredShell>
    );
  }

  if (status.kind === "error") {
    const isAlreadyIn =
      status.code === "already_accepted" || status.code === "joined_not_opened";
    const canRetry =
      status.code === "network" || status.code === "unknown";
    return (
      <CenteredShell>
        <Heading>{errorHeadline(status.code)}</Heading>
        <p className="mt-2 text-[16px] text-slate-600 leading-[1.55]">
          {status.message}
        </p>
        {isAlreadyIn && (
          <button
            type="button"
            onClick={() => router.push("/workspace")}
            className="mt-6 inline-flex items-center justify-center rounded-full bg-slate-900 px-4 py-2.5 text-[16px] font-medium text-white transition-colors hover:bg-slate-700"
          >
            Go to workspace
          </button>
        )}
        {!isAlreadyIn && canRetry && (
          <button
            type="button"
            onClick={() => {
              if (inviteId) void acceptInvite(inviteId);
            }}
            className="mt-6 inline-flex items-center justify-center rounded-full border border-slate-300 bg-white px-4 py-2.5 text-[16px] font-medium text-slate-900 transition-colors hover:border-slate-900"
          >
            Try again
          </button>
        )}
      </CenteredShell>
    );
  }

  return <JoinedScreen data={status.data} />;
}

function JoinedScreen({ data }: { data: AcceptResponse }) {
  const router = useRouter();
  const [open, setOpen] = useState<"idle" | "opening" | "failed">("idle");
  const goToWorkspace = async () => {
    if (data.switched) {
      router.push("/workspace");
      return;
    }
    setOpen("opening");
    const ok = await switchToTenant(data.tenant_id).catch(() => false);
    if (ok) router.push("/workspace");
    else setOpen("failed");
  };
  return (
    <CenteredShell>
      <div className="text-[11px] font-mono uppercase tracking-[0.16em] text-skyMuted">
        Invite accepted
      </div>
      <h1 className="mt-2 font-display text-[26px] font-semibold leading-[1.1] tracking-tight text-slate-900">
        You've joined {data.tenant_name}.
      </h1>
      <p className="mt-3 text-[16px] text-slate-600 leading-[1.55]">
        {data.role === "owner" ? (
          <>You're the <span className="font-medium text-slate-900">Owner</span> of this workspace.</>
        ) : (
          <>
            You're {data.role === "admin" ? "an" : "a"}{" "}
            <span className="font-medium text-slate-900">{ROLE_INFO[data.role].label}</span>.{" "}
            {ROLE_INFO[data.role].help}
          </>
        )}
      </p>
      {open === "failed" && (
        <p className="mt-3 text-[16px] text-slate-600 leading-[1.55]">
          Couldn't open {data.tenant_name} yet. Try again in a moment.
        </p>
      )}
      <button
        type="button"
        disabled={open === "opening"}
        onClick={() => void goToWorkspace()}
        className="mt-7 disabled:opacity-50 inline-flex items-center justify-center rounded-full bg-slate-900 px-4 py-2.5 text-[16px] font-medium text-white transition-colors hover:bg-slate-700"
      >
        Go to workspace
      </button>
    </CenteredShell>
  );
}

function mapErrorCode(status: number): ErrorCode {
  if (status === 404) return "invite_not_found";
  if (status === 410) return "invite_revoked";
  if (status === 409) return "already_accepted";
  if (status === 403) return "email_mismatch";
  return "unknown";
}

function defaultErrorMessage(code: ErrorCode): string {
  switch (code) {
    case "invite_not_found":
      return "We couldn't find this invite. It may have been deleted. Ask your operator to re-invite you.";
    case "invite_revoked":
      return "This invite was cancelled. Ask the person who invited you to send a new one.";
    case "email_mismatch":
      return "This invite was sent to a different email address. Sign in with the email that received the invite.";
    case "already_accepted":
      return "You've already joined this workspace. Head straight in.";
    case "joined_not_opened":
      return "You joined the workspace, but we couldn't open it. Pick it in the company switcher.";
    case "network":
      return "Couldn't reach Zavi. Check your connection and try again.";
    default:
      return "Something went wrong accepting this invite. Try again, or contact the person who invited you.";
  }
}

function errorHeadline(code: ErrorCode): string {
  switch (code) {
    case "invite_not_found":
      return "We can't find this invite";
    case "invite_revoked":
      return "This invite was cancelled";
    case "email_mismatch":
      return "Wrong email for this invite";
    case "already_accepted":
      return "You're already in this workspace";
    case "joined_not_opened":
      return "You're in";
    case "network":
      return "Couldn't reach Zavi";
    default:
      return "Something went wrong";
  }
}

function CenteredShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-6 py-12">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white px-8 py-10 shadow-sm">
        {children}
      </div>
    </main>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h1 className="font-display text-[24px] font-semibold leading-[1.15] tracking-tight text-slate-900">
      {children}
    </h1>
  );
}

function Spinner() {
  return (
    <div
      aria-label="Loading"
      role="status"
      className="h-6 w-6 animate-spin rounded-full border-2 border-slate-200 border-t-slate-900"
    />
  );
}
