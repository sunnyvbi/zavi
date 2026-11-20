"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase";
import { apiUrl } from "@/lib/api";
import { plainNext } from "@/lib/safe-next";
import { creatorApi, landingFor } from "@/lib/creator/api";
import { fetchInvitePrefill, type InvitePrefill } from "@/lib/creator/invite";
import { creatorHome, signedUpAsCreator } from "@/lib/creator/finishSignup";
import { trackEvent, trackEventDeferred } from "@/lib/analytics/events";

type Mode = "password" | "code" | "code-sent" | "forgot" | "forgot-sent";

const SCREENS: Record<Mode, string> = {
  password: "sign_in",
  code: "email_code",
  "code-sent": "verify_code",
  forgot: "forgot_password",
  "forgot-sent": "reset_sent",
};

async function postAuth(path: string, body: unknown): Promise<void> {
  const res = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(j?.error?.message ?? "That did not send. Try again in a moment.");
  }
}

export function useCreatorLogin() {
  const router = useRouter();
  const params = useSearchParams();
  const next = plainNext(params?.get("next"));
  const inviteToken = params?.get("invite") ?? null;

  async function land(user?: { email?: string | null; user_metadata?: Record<string, unknown> | null } | null) {
    if (invitee && email.trim().toLowerCase() === invitee.email.toLowerCase()) {
      try {
        const signup = await creatorApi.signup(invitee.name.trim() || invitee.email.split("@")[0]);
        if (signup.created) trackEvent("creator_signup_completed", { method: "email_code", invited: true });
      } catch {
      }
    }
    try {
      const { home: h, created } = signedUpAsCreator(user) ? await creatorHome(user, email) : { home: await creatorApi.home(), created: false };
      if (created) trackEvent("creator_signup_completed", { method: "recovered_at_sign_in", invited: false });
      router.replace(landingFor(h.home, next));
    } catch {
      trackEvent("auth_failed", { step: "creator_account_open" });
      setOther("You are signed in, but we could not open your account. Try again in a moment.");
      setBusy(false);
    }
  }
  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState<"password" | "code" | null>(null);
  const [other, setOther] = useState<string | null>(null);
  const [emailErr, setEmailErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invitee, setInvitee] = useState<InvitePrefill | null>(null);

  useEffect(() => {
    if (!inviteToken) return;
    let live = true;
    void fetchInvitePrefill(inviteToken).then((p) => {
      if (!live || !p) return;
      setInvitee(p);
      setEmail((v) => v || p.email);
      setMode((m) => (m === "password" ? "code" : m));
    });
    return () => {
      live = false;
    };
  }, [inviteToken]);

  async function signIn() {
    setBusy(true);
    setErr(null);
    setOther(null);
    trackEvent("login_submitted", { method: "password", audience: "creator" });
    const { data, error } = await createBrowserSupabase().auth.signInWithPassword({ email: email.trim(), password });
    if (error || !data.session) {
      trackEvent("auth_failed", { step: "creator_password_login" });
      setErr("password");
      setBusy(false);
      return;
    }
    await land(data.session.user);
  }

  async function sendCode() {
    setBusy(true);
    setErr(null);
    setOther(null);
    try {
      trackEvent("login_submitted", { method: "email_code", audience: "creator" });
      await postAuth("/api/auth/email/send-otp", { email: email.trim() });
      setCode("");
      setMode("code-sent");
    } catch (e) {
      trackEvent("auth_failed", { step: "creator_email_code_send" });
      setOther((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode() {
    setBusy(true);
    setErr(null);
    setOther(null);
    const { data, error } = await createBrowserSupabase().auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
    if (error || !data.session) {
      trackEvent("auth_failed", { step: "creator_email_code_verify" });
      setErr("code");
      setBusy(false);
      return;
    }
    await land(data.session.user);
  }

  async function sendReset() {
    setBusy(true);
    setOther(null);
    try {
      const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent("/reset-password")}`;
      await postAuth("/api/auth/email/send-reset", { email: email.trim(), redirectTo });
      trackEvent("password_reset_requested", { audience: "creator" });
      setMode("forgot-sent");
    } catch (e) {
      trackEvent("auth_failed", { step: "creator_password_reset" });
      setOther((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    return trackEventDeferred("auth_screen_viewed", { screen: SCREENS[mode], audience: "creator" });
  }, [mode]);

  return { mode, setMode, email, setEmail, password, setPassword, code, setCode,
    err, setErr, other, emailErr, setEmailErr, busy, signIn, sendCode, verifyCode, sendReset, invitee };
}
