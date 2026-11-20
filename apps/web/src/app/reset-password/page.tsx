"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase";
import { AuthShell } from "@/components/auth/AuthShell";
import {
  AUTH_BODY,
  AUTH_ERROR,
  AUTH_EYEBROW,
  AUTH_FIELD,
  AUTH_H1,
  AUTH_LABEL,
  AUTH_LINK,
  AUTH_SUBMIT,
} from "@/components/auth/authUi";
import { Input } from "@/components/Input";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionReady, setSessionReady] = useState<boolean | null>(null);

  useEffect(() => {
    const supabase = createBrowserSupabase();
    supabase.auth.getSession().then(({ data }) => {
      setSessionReady(!!data.session);
    });
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const supabase = createBrowserSupabase();
      const { error: e2 } = await supabase.auth.updateUser({ password });
      if (e2) throw new Error(e2.message);
      router.replace("/workspace");
    } catch (e3) {
      setError((e3 as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <AuthShell>
      <p className={AUTH_EYEBROW}>Reset password</p>
      <h1 className={AUTH_H1}>Set a new password.</h1>

      {sessionReady === false ? (
        <p className={AUTH_BODY}>
          This reset link looks expired or invalid. Request a new one from{" "}
          <Link href="/login" className={AUTH_LINK}>
            sign-in
          </Link>
          .
        </p>
      ) : (
        <>
          <p className={AUTH_BODY}>
            Pick something at least 8 characters long. You will be signed straight into your
            workspace.
          </p>
          <form onSubmit={onSubmit} className="mt-6" noValidate>
            <label className={AUTH_LABEL} htmlFor="new-password">
              New password
            </label>
            <Input
              id="new-password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              minLength={8}
              disabled={submitting}
              className={AUTH_FIELD}
            />
            <label className={`mt-4 ${AUTH_LABEL}`} htmlFor="confirm-password">
              Confirm new password
            </label>
            <Input
              id="confirm-password"
              type="password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              disabled={submitting}
              className={AUTH_FIELD}
            />
            {error && (
              <p role="alert" aria-live="polite" className={AUTH_ERROR}>
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={submitting || !password || !confirm}
              className={AUTH_SUBMIT}
            >
              {submitting ? "Saving…" : "Save new password"}
            </button>
          </form>
        </>
      )}
    </AuthShell>
  );
}
