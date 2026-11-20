
"use client";

import { deliverSignupLocation, primeSignupLocation, readySignupLocation } from "@/lib/signup-location";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase";
import { trackEvent, trackEventDeferred } from "@/lib/analytics/events";
import { isOnboardingNext, START_ROUTE } from "@/lib/onboardingRoutes";
import { AuthStepError, authFailedProps } from "./authFailure";
import { apiUrl } from "@/lib/api";
import { isCreatorPath, plainNext } from "@/lib/safe-next";
import { liveFromInNext } from "@/lib/marketing/liveFrom";
import { creatorApi, landingFor } from "@/lib/creator/api";
import { useSignedInFounder } from "./useSignedInFounder";

function isCreatorAreaNext(next: string): boolean {
  return isCreatorPath(next);
}
import { AuthShell } from "@/components/auth/AuthShell";
import { AuthMarketingPanel } from "@/components/auth/AuthMarketingPanel";
import { readStash } from "@/app/start/ideaStartStorage";
import { useScanCompletedEvent, websiteScanFromNext, websiteScanLine } from "@/app/start/websiteScan";
import {
  AUTH_BODY,
  AUTH_ERROR,
  AUTH_EYEBROW,
  AUTH_FIELD,
  AUTH_FIELD_INVALID,
  AUTH_H1,
  AUTH_LABEL,
  AUTH_SUBMIT,
} from "@/components/auth/authUi";
import { Input } from "@/components/Input";
import { AUTH_OUTAGE_MESSAGE, authFailureMessage, isAuthOutage } from "@/lib/authOutage";
import { humanAuthMessage, loginErrorParamMessage } from "./authMessages";
import { InboxLinks } from "./InboxLinks";
import {
  detectInAppBrowser,
  externalBrowserLink,
  watchOpenAttempt,
  withoutAuthErrors,
  type ExternalBrowserLink,
  type InAppBrowser,
} from "@/lib/inAppBrowser";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}

type LoginMode = "password" | "otp" | "forgot" | "signup";

type CodeKind = "signin" | "signup" | "unconfirmed" | "unconfirmed_earlier";

const RESEND_WINDOW_RE = /only request this after/i;

function isResendWindow(e: unknown, raw?: string): boolean {
  return RESEND_WINDOW_RE.test(raw ?? (e as { message?: string } | null)?.message ?? "");
}

const CODE_FAILED_MESSAGE = "That code didn't work. It may be mistyped or expired. Use the newest email from Zavi, or press Resend code.";

function codeFailureMessage(raw: string, status?: number | null): string {
  const m = raw.toLowerCase();
  if (m.includes("expired") || m.includes("invalid") || m.includes("otp")) return CODE_FAILED_MESSAGE;
  return authFailureMessage(raw, status);
}

const AUTH_SCREEN: Record<LoginMode, string> = {
  password: "sign_in",
  otp: "email_code",
  forgot: "forgot_password",
  signup: "sign_up",
};

type OAuthProvider = "github" | "google" | "slack_oidc" | "azure";
type ShownProvider = Exclude<OAuthProvider, "azure">;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN = 8;

const OTP_LENGTH = 8;

const AUTOFILL_ANIMATION = "zavi-autofill-start";

function validateEmail(v: string): string | null {
  if (!v) return "Email is required.";
  if (!EMAIL_RE.test(v)) return "Enter a valid email address (e.g. you@company.com).";
  return null;
}

function validatePassword(v: string, isSignup: boolean): string | null {
  if (!v) return "Password is required.";
  if (isSignup && v.length < PASSWORD_MIN) {
    return `Password must be at least ${PASSWORD_MIN} characters.`;
  }
  return null;
}

function friendlyAuthError(raw: string, status?: number | null): string {
  const m = raw.toLowerCase();
  if ((status ?? 0) >= 500 || isAuthOutage(raw)) return AUTH_OUTAGE_MESSAGE;
  if (m.includes("already registered") || m.includes("already exists") || m.includes("user already")) {
    return "You already have an account with this email. Switch to Sign in below.";
  }
  if (m.includes("password should be") || m.includes("password is too") || m.includes("weak password")) {
    return `Password is too weak. Use at least ${PASSWORD_MIN} characters, ideally with a mix of letters and numbers.`;
  }
  if (m.includes("invalid email") || m.includes("email address") && m.includes("invalid")) {
    return "That email address doesn't look right. Double-check and try again.";
  }
  if (m.includes("invalid login") || m.includes("invalid credentials") || (m.includes("invalid") && !m.includes("email"))) {
    return "Email or password didn't match. If you signed up with GitHub, Google or Slack, use that button. Forgot your password? Reset it below, or click \"Sign up\" if you don't have an account yet.";
  }
  if (m.includes("rate") || m.includes("too many")) {
    return "Too many attempts. Wait a moment and try again.";
  }
  return humanAuthMessage(raw);
}

async function resendSignupCode(supabase: ReturnType<typeof createBrowserSupabase>, address: string): Promise<void> {
  const { error } = await supabase.auth.resend({ type: "signup", email: address });
  if (error) {
    throw Object.assign(new AuthStepError(friendlyAuthError(error.message, error.status), error.code, error.status), { raw: error.message });
  }
}

function LoginInner() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const wantSignup = useSearchParams().get("signup") === "1";
  const [mode, setMode] = useState<LoginMode>(wantSignup ? "signup" : "password");
  const [codeFromSignup, setCodeFromSignup] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const [submitting, setSubmitting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [oauthSubmitting, setOauthSubmitting] = useState<OAuthProvider | null>(null);
  const [sent, setSent] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [codeKind, setCodeKind] = useState<CodeKind>("signin");
  const codeAccepted = useRef(false);
  const [error, setError] = useState<string | null>(() => loginErrorParamMessage(searchParams.get("error")));
  const [resendCooldown, setResendCooldown] = useState(0);
  const next = plainNext(searchParams.get("next")) ?? "/workspace";
  const checking = useSignedInFounder(next);
  const go = async () => {
    if (!isCreatorAreaNext(next)) {
      router.replace(next);
      return;
    }
    let home: "/workspace" | "/creator" | "/start";
    try {
      home = (await creatorApi.home()).home;
    } catch {
      throw new Error("You are signed in, but we could not open your account. Try again in a moment.");
    }
    router.replace(landingFor(home, next));
  };

  const fromOnboarding = isOnboardingNext(next);
  const websiteScan = websiteScanFromNext(next);
  const websiteOnboarding =
    fromOnboarding && searchParams.get("intent") !== "build" && new URLSearchParams(next.split("?")[1] ?? "").has("website");
  const scanStatus = useScanCompletedEvent(websiteScan?.scanId ?? null);
  const scanLine = websiteScan ? websiteScanLine(websiteScan.host, scanStatus) : null;
  const fromLive = liveFromInNext(next);
  const screen = sent
    ? codeKind === "signin"
      ? "verify_code"
      : "signup_code"
    : resetSent
      ? "reset_sent"
      : AUTH_SCREEN[mode];
  useEffect(() => {
    if (checking) return;
    return trackEventDeferred("auth_screen_viewed", { screen, from_onboarding: fromOnboarding, from_live: fromLive ?? undefined });
  }, [checking, screen, fromOnboarding, fromLive]);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const id = window.setTimeout(() => setResendCooldown((s) => s - 1), 1000);
    return () => window.clearTimeout(id);
  }, [resendCooldown]);

  useEffect(() => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return;
    const id = window.setTimeout(() => primeSignupLocation(email), 400);
    return () => window.clearTimeout(id);
  }, [email]);

  async function sendCode(addressedEmail: string) {
    const locationTicket = readySignupLocation(addressedEmail);
    const res = await fetch(apiUrl("/api/auth/email/send-otp"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: addressedEmail, ...(locationTicket ? { location_ticket: locationTicket } : {}) }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new AuthStepError(
        authFailureMessage(j?.error?.message ?? "Could not send code. Try again in a moment.", res.status),
        "send_failed",
        res.status,
      );
    }
  }

  async function submitOtp(e: React.FormEvent) {
    e.preventDefault();
    const ee = validateEmail(email);
    if (ee) {
      setError(ee);
      return;
    }
    setSubmitting(true);
    setError(null);
    trackEvent("login_submitted", { method: "email_code" });
    try {
      await sendCode(email);
      setCodeKind("signin");
      setSent(true);
      setResendCooldown(30);
      setCode("");
    } catch (e2) {
      trackEvent("auth_failed", { step: "email_code_send", ...authFailedProps(e2) });
      setError(humanAuthMessage(e2));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    trackEvent("login_submitted", { method: "password" });
    try {
      const supabase = createBrowserSupabase();
      const { data, error: e2 } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (e2?.code === "email_not_confirmed") {
        try {
          await resendSignupCode(supabase, email);
          trackEvent("signup_code_resent", { reason: "unconfirmed_sign_in" });
          openCodeScreen("unconfirmed");
        } catch (sendErr) {
          if (!isResendWindow(sendErr, (sendErr as { raw?: string }).raw)) throw sendErr;
          openCodeScreen("unconfirmed_earlier");
          setResendCooldown(60);
        }
        setSubmitting(false);
        return;
      }
      if (e2) {
        throw new AuthStepError(friendlyAuthError(e2.message, e2.status), e2.code, e2.status);
      }
      if (!data.session) {
        throw new AuthStepError("Sign-in succeeded but no session was created.", "no_session");
      }
      await go();
    } catch (e3) {
      trackEvent("auth_failed", { step: "password_login", ...authFailedProps(e3) });
      setError(humanAuthMessage(e3));
      setSubmitting(false);
    }
  }

  async function submitSignup(e: React.FormEvent) {
    e.preventDefault();
    const ee = validateEmail(email);
    const pe = validatePassword(password, true);
    if (ee || pe) {
      setError(ee || pe);
      return;
    }
    setSubmitting(true);
    setError(null);
    trackEvent("signup_submitted", { method: "password", from_onboarding: fromOnboarding });
    try {
      const supabase = createBrowserSupabase();
      const locationTicket = readySignupLocation(email);
      const { data, error: e2 } = await supabase.auth.signUp({
        email,
        password,
        options: {
          ...(locationTicket ? { data: { growth_signup_location_ticket: locationTicket.signature } } : {}),
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next ?? "/start")}`,
        },
      });
      if (e2) {
        throw new AuthStepError(friendlyAuthError(e2.message, e2.status), e2.code, e2.status);
      }
      if (data.user && locationTicket) void deliverSignupLocation(data.user.id, locationTicket, data.session?.access_token);
      if (data.session) {
        await go();
        return;
      }
      if (data.user && (data.user.identities?.length ?? 0) === 0) {
        throw new AuthStepError(friendlyAuthError("User already registered"), "user_already_exists");
      }
      openCodeScreen("signup");
      setSubmitting(false);
    } catch (e3) {
      trackEvent("auth_failed", { step: "signup", ...authFailedProps(e3) });
      setError(humanAuthMessage(e3));
      setSubmitting(false);
    }
  }

  function openCodeScreen(kind: CodeKind) {
    setCodeKind(kind);
    setSent(true);
    setResendCooldown(30);
    setCode("");
    setError(null);
  }

  async function submitForgot(e: React.FormEvent) {
    e.preventDefault();
    const ee = validateEmail(email);
    if (ee) {
      setError(ee);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent("/reset-password")}`;
      const res = await fetch(apiUrl("/api/auth/email/send-reset"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, redirectTo }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(authFailureMessage(j?.error?.message ?? "Could not send reset email. Try again.", res.status));
      }
      setResetSent(true);
      trackEvent("password_reset_requested");
    } catch (e3) {
      setError(humanAuthMessage(e3));
    } finally {
      setSubmitting(false);
    }
  }

  async function submit(e: React.FormEvent) {
    if (mode === "password") return submitPassword(e);
    if (mode === "signup") return submitSignup(e);
    if (mode === "forgot") return submitForgot(e);
    return submitOtp(e);
  }

  function enterSignup() {
    trackEvent("signup_started", { from_onboarding: fromOnboarding });
    setMode("signup");
    setEmail("");
    setPassword("");
    setError(null);
  }
  function backToSignin() {
    setMode("password");
    setError(null);
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (code.length < OTP_LENGTH) return;
    setVerifying(true);
    setError(null);
    try {
      if (!codeAccepted.current) {
        const supabase = createBrowserSupabase();
        const { data, error: e2 } = await supabase.auth.verifyOtp({
          email,
          token: code,
          type: codeKind === "signin" ? "email" : "signup",
        });
        if (e2) throw new AuthStepError(codeFailureMessage(e2.message, e2.status), e2.code, e2.status);
        if (!data.session) throw new AuthStepError("Verification succeeded but no session was created.", "no_session");
        codeAccepted.current = true;
      }
      await go();
    } catch (e3) {
      trackEvent("auth_failed", { step: codeKind === "signin" ? "email_code_verify" : "signup_code_verify", ...authFailedProps(e3) });
      setError(humanAuthMessage(e3));
      setVerifying(false);
    }
  }

  async function resend() {
    if (resendCooldown > 0) return;
    setSubmitting(true);
    setError(null);
    try {
      if (codeKind === "signin") await sendCode(email);
      else await resendSignupCode(createBrowserSupabase(), email);
      codeAccepted.current = false;
      setResendCooldown(30);
      setCode("");
    } catch (e2) {
      setError(humanAuthMessage(e2));
    } finally {
      setSubmitting(false);
    }
  }

  async function oauth(provider: OAuthProvider) {
    setOauthSubmitting(provider);
    setError(null);
    trackEvent("oauth_started", { provider, mode, from_onboarding: fromOnboarding });
    try {
      const supabase = createBrowserSupabase();
      const oauthNext = isCreatorAreaNext(next) ? "/start" : next;
      const redirectTo = `${window.location.origin}/api/auth/callback?next=${encodeURIComponent(oauthNext)}`;
      const { error: e } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo },
      });
      if (e) throw new Error(authFailureMessage(e.message, e.status));
    } catch (e2) {
      setError(humanAuthMessage(e2));
      setOauthSubmitting(null);
    }
  }

  function reset() {
    setSent(false);
    setResetSent(false);
    setCodeKind("signin");
    codeAccepted.current = false;
    setEmail("");
    setPassword("");
    setCode("");
    setError(null);
    setResendCooldown(0);
  }

  return (
    <AuthShell
      panelVariant={searchParams.get("intent") === "build" ? "build" : fromLive ? "live" : undefined}
      aside={websiteOnboarding ? <AuthMarketingPanel fromWebsite otpSent={sent} /> : undefined}
      backHref={websiteOnboarding ? START_ROUTE : undefined}
    >
      {checking ? (
        <p role="status" className={AUTH_BODY}>Checking your account…</p>
      ) : sent ? (
        <VerifyState
          kind={codeKind}
          email={email}
          code={code}
          setCode={setCode}
          verify={verify}
          verifying={verifying}
          submitting={submitting}
          resendCooldown={resendCooldown}
          error={error}
          onResend={resend}
          onReset={reset}
        />
      ) : resetSent ? (
        <ResetSentState email={email} onReset={reset} />
      ) : (
        <FormState
          email={email}
          setEmail={setEmail}
          password={password}
          setPassword={setPassword}
          mode={mode}
          setMode={setMode}
          codeFromSignup={codeFromSignup}
          setCodeFromSignup={setCodeFromSignup}
          submit={submit}
          onEnterSignup={enterSignup}
          onBackToSignin={backToSignin}
          oauth={oauth}
          submitting={submitting}
          oauthSubmitting={oauthSubmitting}
          error={error}
          scanLine={scanLine}
          buildSignup={searchParams.get("intent") === "build"}
          onboarding={websiteOnboarding}
        />
      )}
    </AuthShell>
  );
}

function FormState({
  email,
  setEmail,
  password,
  setPassword,
  mode,
  setMode,
  codeFromSignup,
  setCodeFromSignup,
  submit,
  onEnterSignup,
  onBackToSignin,
  oauth,
  submitting,
  oauthSubmitting,
  error,
  scanLine = null,
  buildSignup = false,
  onboarding = false,
}: {
  email: string;
  setEmail: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  mode: LoginMode;
  setMode: (m: LoginMode) => void;
  codeFromSignup: boolean;
  setCodeFromSignup: (v: boolean) => void;
  submit: (e: React.FormEvent) => Promise<void>;
  onEnterSignup: () => void;
  onBackToSignin: () => void;
  oauth: (p: OAuthProvider) => Promise<void>;
  submitting: boolean;
  oauthSubmitting: OAuthProvider | null;
  error: string | null;
  scanLine?: string | null;
  buildSignup?: boolean;
  onboarding?: boolean;
}) {
  const anyBusy = submitting || oauthSubmitting !== null;
  const [savedIdea, setSavedIdea] = useState<string | null>(null);
  useEffect(() => {
    if (!buildSignup) return;
    const idea = readStash()?.idea?.replace(/\s+/g, " ").trim();
    setSavedIdea(idea ? (idea.length > 160 ? `${idea.slice(0, 159).trimEnd()}…` : idea) : null);
  }, [buildSignup]);
  const isForgot = mode === "forgot";
  const isSignup = mode === "signup";
  const signingUp = isSignup || (mode === "otp" && codeFromSignup);
  const chooseCode = () => {
    setCodeFromSignup(isSignup);
    setMode("otp");
  };
  const onboardingSignup = onboarding && signingUp;
  const oauthButton = `inline-flex h-12 w-full items-center justify-center gap-2.5 ${onboardingSignup ? "rounded-full" : "rounded-cta"} border border-[#e5e5e5] bg-white px-4 text-[16px] font-medium tracking-[-0.15px] text-[#171717] transition-colors hover:border-[#171717] disabled:cursor-not-allowed disabled:opacity-50`;
  const [showPassword, setShowPassword] = useState(false);

  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  useEffect(() => {
    setEmailError(null);
    setPasswordError(null);
  }, [mode]);

  const [inApp, setInApp] = useState<InAppBrowser | null>(null);
  const [openStuck, setOpenStuck] = useState(false);
  const stopOpenWatch = useRef<(() => void) | null>(null);
  useEffect(() => () => stopOpenWatch.current?.(), []);
  useEffect(() => {
    const ua = window.navigator.userAgent;
    const found = detectInAppBrowser(ua);
    setInApp(found);
    if (!found) return;
    return trackEventDeferred("in_app_browser_detected", { app: found.app ?? "unknown", screen: "login" });
  }, []);
  const [linkCopy, setLinkCopy] = useState<"idle" | "copied" | "failed">("idle");
  function shareableLink(): string {
    const url = new URL(withoutAuthErrors(window.location.href));
    if (signingUp) url.searchParams.set("signup", "1");
    else url.searchParams.delete("signup");
    return url.toString();
  }
  const outLink: ExternalBrowserLink | null = inApp ? externalBrowserLink(shareableLink(), window.navigator.userAgent) : null;
  async function copyLink() {
    try {
      await window.navigator.clipboard.writeText(shareableLink());
      setLinkCopy("copied");
    } catch {
      setLinkCopy("failed");
    }
  }

  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const adoptField = useCallback(
    (el: HTMLInputElement | null, current: string, apply: (v: string) => void) => {
      if (!el || !el.value || el.value === current) return;
      const value = el.value;
      el.value = value;
      apply(value);
    },
    [],
  );
  const adoptAutofill = useCallback(() => {
    adoptField(emailRef.current, email, setEmail);
    adoptField(passwordRef.current, password, setPassword);
  }, [adoptField, email, password, setEmail, setPassword]);

  useEffect(() => {
    adoptAutofill();
    const id = window.setTimeout(adoptAutofill, 300);
    return () => window.clearTimeout(id);
  }, [adoptAutofill]);

  const adoptRef = useRef(adoptAutofill);
  adoptRef.current = adoptAutofill;

  useEffect(() => {
    const again = () => window.setTimeout(() => adoptRef.current(), 0);
    const opts = { capture: true, passive: true } as const;
    const events = ["pointerdown", "keydown", "focusin", "touchstart"] as const;
    for (const ev of events) document.addEventListener(ev, again, opts);
    return () => {
      for (const ev of events) document.removeEventListener(ev, again, opts);
    };
  }, []);

  const revealPoll = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (revealPoll.current !== null) window.clearInterval(revealPoll.current);
    },
    [],
  );
  const watchForReveal = () => {
    if (revealPoll.current !== null) return;
    let ticks = 0;
    revealPoll.current = window.setInterval(() => {
      ticks += 1;
      adoptRef.current();
      const revealed = [emailRef, passwordRef].every((r) => !r.current || !!r.current.value);
      if (revealed || ticks >= 40) {
        if (revealPoll.current !== null) window.clearInterval(revealPoll.current);
        revealPoll.current = null;
      }
    }, 250);
  };

  const onAutofillAnimation = (e: React.AnimationEvent<HTMLInputElement>) => {
    if (e.animationName !== AUTOFILL_ANIMATION) return;
    adoptAutofill();
    if (!e.currentTarget.value) watchForReveal();
  };

  const passwordRequired = mode === "password" || isSignup;

  const emailValid = validateEmail(email) === null;
  const passwordValid = !passwordRequired || validatePassword(password, isSignup) === null;
  const submitDisabled = anyBusy || !emailValid || !passwordValid;

  const labelled: Record<ShownProvider, React.ReactNode> = {
    github: (
      <button
        key="github"
        type="button"
        onClick={() => oauth("github")}
        disabled={anyBusy}
        className={oauthButton}
      >
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden>
        <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 005.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
        {oauthSubmitting === "github" ? "Redirecting…" : "Continue with GitHub"}
      </button>
    ),
    google: (
      <button
        key="google"
        type="button"
        onClick={() => oauth("google")}
        disabled={anyBusy}
        className={oauthButton}
      >
        <svg viewBox="0 0 18 18" className="h-4 w-4" aria-hidden>
        <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.13-.84 2.09-1.79 2.73v2.27h2.9c1.7-1.56 2.69-3.87 2.69-6.64z" />
        <path fill="#34A853" d="M9 18c2.43 0 4.46-.81 5.95-2.18l-2.9-2.27c-.81.55-1.84.86-3.05.86-2.34 0-4.32-1.58-5.03-3.71H.96v2.33A8.997 8.997 0 009 18z" />
        <path fill="#FBBC05" d="M3.97 10.7a5.41 5.41 0 010-3.4V4.97H.96a8.997 8.997 0 000 8.06l3.01-2.33z" />
        <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.43 1.34l2.58-2.58C13.46.89 11.43 0 9 0A8.997 8.997 0 00.96 4.97L3.97 7.3C4.68 5.17 6.66 3.58 9 3.58z" />
        </svg>
        {oauthSubmitting === "google" ? "Redirecting…" : "Continue with Google"}
      </button>
    ),
    slack_oidc: (
      <button
        key="slack_oidc"
        type="button"
        onClick={() => oauth("slack_oidc")}
        disabled={anyBusy}
        className={oauthButton}
      >
        <svg viewBox="130 12.5 16 16" className="h-4 w-4" aria-hidden>
        <path fill="#E01E5A" d="M133.351 22.5779C133.351 23.5 132.597 24.2532 131.675 24.2532C130.753 24.2532 130 23.5 130 22.5779C130 21.6558 130.753 20.9026 131.675 20.9026H133.351V22.5779ZM134.195 22.5779C134.195 21.6558 134.948 20.9026 135.87 20.9026C136.792 20.9026 137.545 21.6558 137.545 22.5779V26.7727C137.545 27.6948 136.792 28.448 135.87 28.448C134.948 28.448 134.195 27.6948 134.195 26.7727V22.5779Z" />
        <path fill="#36C5F0" d="M135.87 15.8506C134.948 15.8506 134.195 15.0974 134.195 14.1753C134.195 13.2532 134.948 12.5 135.87 12.5C136.792 12.5 137.545 13.2532 137.545 14.1753V15.8506H135.87ZM135.87 16.6948C136.792 16.6948 137.545 17.4481 137.545 18.3701C137.545 19.2922 136.792 20.0455 135.87 20.0455H131.675C130.753 20.0455 130 19.2922 130 18.3701C130 17.4481 130.753 16.6948 131.675 16.6948H135.87Z" />
        <path fill="#2EB67D" d="M142.649 18.3701C142.649 17.4481 143.403 16.6948 144.325 16.6948C145.247 16.6948 146 17.4481 146 18.3701C146 19.2922 145.247 20.0455 144.325 20.0455H142.649V18.3701ZM141.805 18.3701C141.805 19.2922 141.052 20.0455 140.13 20.0455C139.208 20.0455 138.455 19.2922 138.455 18.3701V14.1753C138.455 13.2532 139.208 12.5 140.13 12.5C141.052 12.5 141.805 13.2532 141.805 14.1753V18.3701Z" />
        <path fill="#ECB22E" d="M140.13 25.1494C141.052 25.1494 141.805 25.9026 141.805 26.8247C141.805 27.7468 141.052 28.5 140.13 28.5C139.208 28.5 138.455 27.7468 138.455 26.8247V25.1494H140.13ZM140.13 24.3052C139.208 24.3052 138.455 23.552 138.455 22.6299C138.455 21.7078 139.208 20.9546 140.13 20.9546H144.325C145.247 20.9546 146 21.7078 146 22.6299C146 23.552 145.247 24.3052 144.325 24.3052H140.13Z" />
        </svg>
        {oauthSubmitting === "slack_oidc" ? "Redirecting…" : "Continue with Slack"}
      </button>
    ),
  };
  const tile: Record<ShownProvider, React.ReactNode> = {
    github: (
      <button
        key="github"
        type="button"
        onClick={() => oauth("github")}
        disabled={anyBusy}
        aria-label="Continue with GitHub"
        title="Continue with GitHub"
        className="inline-flex h-14 w-14 items-center justify-center rounded-[16px] border border-[#e5e5e5] bg-white transition-colors hover:border-[#171717] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {oauthSubmitting === "github" ? (
          <Loader2 className="h-[22px] w-[22px] animate-spin text-[#525252]" aria-hidden />
        ) : (
          <svg viewBox="0 0 16 16" className="h-[22px] w-[22px]" fill="currentColor" aria-hidden>
          <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 005.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
        )}
      </button>
    ),
    google: (
      <button
        key="google"
        type="button"
        onClick={() => oauth("google")}
        disabled={anyBusy}
        aria-label="Continue with Google"
        title="Continue with Google"
        className="inline-flex h-14 w-14 items-center justify-center rounded-[16px] border border-[#e5e5e5] bg-white transition-colors hover:border-[#171717] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {oauthSubmitting === "google" ? (
          <Loader2 className="h-[22px] w-[22px] animate-spin text-[#525252]" aria-hidden />
        ) : (
          <svg viewBox="0 0 18 18" className="h-[22px] w-[22px]" aria-hidden>
          <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.13-.84 2.09-1.79 2.73v2.27h2.9c1.7-1.56 2.69-3.87 2.69-6.64z" />
          <path fill="#34A853" d="M9 18c2.43 0 4.46-.81 5.95-2.18l-2.9-2.27c-.81.55-1.84.86-3.05.86-2.34 0-4.32-1.58-5.03-3.71H.96v2.33A8.997 8.997 0 009 18z" />
          <path fill="#FBBC05" d="M3.97 10.7a5.41 5.41 0 010-3.4V4.97H.96a8.997 8.997 0 000 8.06l3.01-2.33z" />
          <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.43 1.34l2.58-2.58C13.46.89 11.43 0 9 0A8.997 8.997 0 00.96 4.97L3.97 7.3C4.68 5.17 6.66 3.58 9 3.58z" />
          </svg>
        )}
      </button>
    ),
    slack_oidc: (
      <button
        key="slack_oidc"
        type="button"
        onClick={() => oauth("slack_oidc")}
        disabled={anyBusy}
        aria-label="Continue with Slack"
        title="Continue with Slack"
        className="inline-flex h-14 w-14 items-center justify-center rounded-[16px] border border-[#e5e5e5] bg-white transition-colors hover:border-[#171717] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {oauthSubmitting === "slack_oidc" ? (
          <Loader2 className="h-[22px] w-[22px] animate-spin text-[#525252]" aria-hidden />
        ) : (
          <svg viewBox="130 12.5 16 16" className="h-[22px] w-[22px]" aria-hidden>
          <path fill="#E01E5A" d="M133.351 22.5779C133.351 23.5 132.597 24.2532 131.675 24.2532C130.753 24.2532 130 23.5 130 22.5779C130 21.6558 130.753 20.9026 131.675 20.9026H133.351V22.5779ZM134.195 22.5779C134.195 21.6558 134.948 20.9026 135.87 20.9026C136.792 20.9026 137.545 21.6558 137.545 22.5779V26.7727C137.545 27.6948 136.792 28.448 135.87 28.448C134.948 28.448 134.195 27.6948 134.195 26.7727V22.5779Z" />
          <path fill="#36C5F0" d="M135.87 15.8506C134.948 15.8506 134.195 15.0974 134.195 14.1753C134.195 13.2532 134.948 12.5 135.87 12.5C136.792 12.5 137.545 13.2532 137.545 14.1753V15.8506H135.87ZM135.87 16.6948C136.792 16.6948 137.545 17.4481 137.545 18.3701C137.545 19.2922 136.792 20.0455 135.87 20.0455H131.675C130.753 20.0455 130 19.2922 130 18.3701C130 17.4481 130.753 16.6948 131.675 16.6948H135.87Z" />
          <path fill="#2EB67D" d="M142.649 18.3701C142.649 17.4481 143.403 16.6948 144.325 16.6948C145.247 16.6948 146 17.4481 146 18.3701C146 19.2922 145.247 20.0455 144.325 20.0455H142.649V18.3701ZM141.805 18.3701C141.805 19.2922 141.052 20.0455 140.13 20.0455C139.208 20.0455 138.455 19.2922 138.455 18.3701V14.1753C138.455 13.2532 139.208 12.5 140.13 12.5C141.052 12.5 141.805 13.2532 141.805 14.1753V18.3701Z" />
          <path fill="#ECB22E" d="M140.13 25.1494C141.052 25.1494 141.805 25.9026 141.805 26.8247C141.805 27.7468 141.052 28.5 140.13 28.5C139.208 28.5 138.455 27.7468 138.455 26.8247V25.1494H140.13ZM140.13 24.3052C139.208 24.3052 138.455 23.552 138.455 22.6299C138.455 21.7078 139.208 20.9546 140.13 20.9546H144.325C145.247 20.9546 146 21.7078 146 22.6299C146 23.552 145.247 24.3052 144.325 24.3052H140.13Z" />
          </svg>
        )}
      </button>
    ),
  };
  const providerOrder: ShownProvider[] = (
    isSignup && !onboardingSignup ? (["google", "github", "slack_oidc"] as ShownProvider[]) : (["github", "google", "slack_oidc"] as ShownProvider[])
  ).filter((p) => !(inApp && p === "google"));

  return (
    <>
      {(isForgot || signingUp) && (
        <p className={onboardingSignup ? "text-[14px] font-normal leading-5 tracking-[-0.15px] text-[#737373] compact:hidden" : AUTH_EYEBROW}>
          {isForgot ? "Reset password" : "Create account"}
        </p>
      )}
      <h1 className={AUTH_H1}>
        {isForgot ? "Forgot your password?" : signingUp ? "Create your workspace." : "Open your workspace."}
      </h1>
      {scanLine && (
        <p role="status" aria-live="polite" className="mt-2 truncate text-sm text-[#525252] lg:hidden">
          {scanLine}
        </p>
      )}
      {isForgot && (
        <p className={AUTH_BODY}>
          Enter your email and we&apos;ll send a link to set a new one.
        </p>
      )}
      {signingUp && !onboardingSignup && (
        <p className="mt-2 text-[16px] font-medium leading-[1.55] tracking-[-0.15px] text-[#171717]">
          {buildSignup ? "Create a free account and Zavi builds your website. No card." : "Create a free account to see your growth plan. No card."}
        </p>
      )}
      {signingUp && buildSignup && savedIdea && (
        <p data-testid="saved-idea" className="mt-2 line-clamp-3 text-[14px] leading-[1.5] tracking-[-0.15px] text-[#525252]">
          Your idea is saved: &ldquo;{savedIdea}&rdquo;
        </p>
      )}

      {!isForgot && (
      <>
      {inApp && (
        <div className="mt-6 rounded-[12px] border border-[#f0f0f0] bg-[#fafafa] p-3 text-[14px] leading-[1.5] tracking-[-0.15px] text-[#171717]">
          <p>
            Google sign-in doesn&apos;t work inside {inApp.app ? `the ${inApp.app} app` : "this app"}. Open
            zaviagent.com in Safari or Chrome.
          </p>
          {outLink && (
            <a
              href={outLink.href}
              onClick={() => {
                trackEvent("in_app_open_browser_clicked", { app: inApp.app ?? "unknown", screen: "login" });
                setOpenStuck(false);
                stopOpenWatch.current?.();
                stopOpenWatch.current = watchOpenAttempt(() => {
                  stopOpenWatch.current = null;
                  setOpenStuck(true);
                  trackEvent("in_app_open_browser_stuck", { app: inApp.app ?? "unknown", screen: "login" });
                });
              }}
              className="mt-2 mr-4 inline-flex min-h-[44px] items-center font-semibold text-[#027bff] transition-colors hover:text-[#0264d1]"
            >
              {outLink.label}
            </a>
          )}
          {openStuck && (
            <p role="status" className="text-[13px] text-[#525252]">
              Didn&apos;t open? Copy this link and paste it into Safari or Chrome:{" "}
              <span className="select-all break-all text-[#171717]">{shareableLink()}</span>
            </p>
          )}
          <button
            type="button"
            onClick={copyLink}
            className="mt-2 min-h-[44px] font-semibold text-[#027bff] transition-colors hover:text-[#0264d1]"
          >
            {linkCopy === "copied" ? "Link copied" : "Copy link"}
          </button>
          {linkCopy === "failed" && (
            <p className="text-[13px] text-[#525252]">
              Copy this link and open it in Safari or Chrome:{" "}
              <span className="select-all break-all text-[#171717]">{shareableLink()}</span>
            </p>
          )}
        </div>
      )}
      {inApp && mode !== "otp" && (
        <button
          type="button"
          onClick={chooseCode}
          disabled={anyBusy}
          className="mt-3 inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-cta bg-[#0e0f11] px-4 text-[16px] font-medium tracking-[-0.15px] text-white transition-colors hover:bg-[#404040] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Email me a code
        </button>
      )}
      <div className="mt-6 space-y-2.5 compact:hidden">
        {providerOrder.map((p) => labelled[p])}
      </div>
      <div className="mt-6 hidden justify-center gap-4 compact:flex">
        {(isSignup ? [...providerOrder].sort((x, y) => Number(y === "google") - Number(x === "google")) : providerOrder).map((p) => tile[p])}
      </div>
        {}

      <div className={`my-5 flex items-center gap-3 tracking-[-0.15px] ${onboardingSignup ? "text-[13px] font-normal text-[#737373]" : "text-[16px] font-medium text-[#0e0f11] compact:text-[13px] compact:font-normal compact:text-[#595959]"}`}>
        <div className="h-px flex-1 bg-[rgba(10,31,58,0.1)]" />
        <span className="whitespace-nowrap">or continue with email</span>
        <div className="h-px flex-1 bg-[rgba(10,31,58,0.1)]" />
      </div>
      </>
      )}

      <form onSubmit={submit} noValidate>
        <label className={AUTH_LABEL} htmlFor="email">
          Email
        </label>
        <Input
          id="email"
          ref={emailRef}
          onAnimationStart={onAutofillAnimation}
          type="email"
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setEmailError(null);
          }}
          onBlur={() => setEmailError(validateEmail(email))}
          placeholder="you@company.com"
          autoComplete="email"
          disabled={anyBusy}
          aria-invalid={emailError ? true : undefined}
          aria-describedby={emailError ? "email-error" : undefined}
          className={
            emailError
              ? `${AUTH_FIELD} ${AUTH_FIELD_INVALID}`
              : AUTH_FIELD
          }
        />
        {emailError && (
          <p
            id="email-error"
            className={AUTH_ERROR}
          >
            {emailError}
          </p>
        )}

        {(mode === "password" || isSignup) && (
          <>
            <div className="mb-1.5 mt-3 flex items-baseline justify-between">
              <label className="text-[13px] font-medium tracking-[-0.15px] text-[#171717]" htmlFor="password">
                Password
              </label>
              {!isSignup && (
                <button
                  type="button"
                  onClick={() => setMode("forgot")}
                  disabled={anyBusy}
                  className="text-[12px] tracking-[-0.15px] text-[#525252] transition-colors hover:text-[#171717] disabled:opacity-50 -my-[13px] py-[13px] pl-4"
                >
                  Forgot password?
                </button>
              )}
            </div>
            <div className="relative">
              <Input
                id="password"
                ref={passwordRef}
                onAnimationStart={onAutofillAnimation}
                type={showPassword ? "text" : "password"}
                required
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setPasswordError(null);
                }}
                onBlur={() => setPasswordError(validatePassword(password, isSignup))}
                placeholder={isSignup ? "At least 8 characters" : "Your password"}
                autoComplete={isSignup ? "new-password" : "current-password"}
                minLength={isSignup ? PASSWORD_MIN : undefined}
                disabled={anyBusy}
                aria-invalid={passwordError ? true : undefined}
                aria-describedby={passwordError ? "password-error" : undefined}
                className={
                  passwordError
                    ? `${AUTH_FIELD} pr-11 ${AUTH_FIELD_INVALID}`
                    : `${AUTH_FIELD} pr-11`
                }
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                disabled={anyBusy}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-[#a1a1a1] transition-colors hover:text-[#171717] disabled:opacity-50"
              >
                {}
                {showPassword ? (
                  <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                )}
              </button>
            </div>
            {passwordError && (
              <p
                id="password-error"
                className={AUTH_ERROR}
              >
                {passwordError}
              </p>
            )}
            {isSignup && !passwordError && (
              <p className="mt-1.5 text-[12px] tracking-[-0.15px] text-[#a1a1a1]">
                At least {PASSWORD_MIN} characters.
              </p>
            )}
          </>
        )}

        {}
        <div
          role="alert"
          aria-live="polite"
          className={error ? "mt-3" : ""}
        >
          {error && (
            <p className="text-[13px] tracking-[-0.15px] text-[#dc2626]">
              {error}
            </p>
          )}
        </div>

        {mode === "password" ? (
          <>
            <button
              type="submit"
              disabled={submitDisabled}
              aria-busy={submitting || undefined}
              className={AUTH_SUBMIT}
            >
              {submitting ? (
                <>
                  <Spinner /> Signing in…
                </>
              ) : (
                "Sign in"
              )}
            </button>
            <p className="mt-3 text-center text-[13px] tracking-[-0.15px] text-[#525252]">
              Don&apos;t have an account?{" "}
              <button
                type="button"
                onClick={onEnterSignup}
                disabled={anyBusy}
                className="font-semibold text-[#027bff] transition-colors hover:text-[#0264d1] disabled:cursor-not-allowed disabled:opacity-50 -my-[13px] py-[13px]"
              >
                Sign up
              </button>
            </p>
          </>
        ) : isSignup ? (
          <>
            <button
              type="submit"
              disabled={submitDisabled}
              aria-busy={submitting || undefined}
              className={onboardingSignup ? `${AUTH_SUBMIT} !rounded-full disabled:!bg-[#f0f0f0] disabled:!text-[#a1a1a1] disabled:!opacity-100` : AUTH_SUBMIT}
            >
              {submitting ? (
                <>
                  <Spinner /> Creating account…
                </>
              ) : (
                "Create account"
              )}
            </button>
            <p className="mt-3 text-center text-[13px] tracking-[-0.15px] text-[#525252]">
              Already have an account?{" "}
              <button
                type="button"
                onClick={onBackToSignin}
                disabled={anyBusy}
                className="font-semibold text-[#027bff] transition-colors hover:text-[#0264d1] disabled:cursor-not-allowed disabled:opacity-50 -my-[13px] py-[13px]"
              >
                Sign in
              </button>
            </p>
          </>
        ) : mode === "otp" ? (
          <button
            type="submit"
            disabled={anyBusy || !emailValid}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-cta bg-[#0e0f11] px-4 py-3 text-[16px] font-medium tracking-[-0.15px] text-white transition-colors hover:bg-[#404040] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Sending code…" : "Email me a code"}
          </button>
        ) : (
          <button
            type="submit"
            disabled={anyBusy || !emailValid}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-cta bg-[#0e0f11] px-4 py-3 text-[16px] font-medium tracking-[-0.15px] text-white transition-colors hover:bg-[#404040] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Sending link…" : "Email reset link"}
          </button>
        )}
      </form>

      {mode === "password" ? (
        <>
          <div className="my-5 flex items-center gap-3 text-[11px] uppercase tracking-[2px] text-[#a1a1a1]">
            <div className="h-px flex-1 bg-[#f5f5f5]" />
            or
            <div className="h-px flex-1 bg-[#f5f5f5]" />
          </div>
          <button
            type="button"
            onClick={chooseCode}
            disabled={anyBusy}
            className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-cta border-[1.5px] border-[#f0f0f0] bg-white px-4 py-3 text-[14px] font-semibold tracking-[-0.15px] text-[#1f1f1f] transition-colors hover:border-[#171717] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Send me a code via email instead
          </button>
        </>
      ) : mode === "otp" ? (
        <button
          type="button"
          onClick={() => setMode(codeFromSignup ? "signup" : "password")}
          disabled={anyBusy}
          className="mt-3 text-[13px] tracking-[-0.15px] text-[#525252] transition-colors hover:text-[#171717] disabled:opacity-50"
        >
          ← Use email + password instead
        </button>
      ) : isSignup ? null : (
        <button
          type="button"
          onClick={() => setMode("password")}
          disabled={anyBusy}
          className="mt-3 text-[13px] tracking-[-0.15px] text-[#525252] transition-colors hover:text-[#171717] disabled:opacity-50"
        >
          ← Back to sign in
        </button>
      )}

      <p className="mt-6 text-[12px] leading-[1.55] tracking-[-0.15px] text-[#a1a1a1]">
        By continuing you agree to our{" "}
        <Link href="/terms" className="underline transition-colors hover:text-[#171717]">
          terms
        </Link>{" "}
        and{" "}
        <Link href="/privacy" className="underline transition-colors hover:text-[#171717]">
          privacy policy.
        </Link>
        <br />
        Sessions last 7 days.
      </p>
    </>
  );
}

const CODE_SCREEN_COPY: Record<CodeKind, { eyebrow?: string; title: string; body: (email: React.ReactNode) => React.ReactNode }> = {
  signin: {
    title: `Enter the ${OTP_LENGTH}-digit code.`,
    body: (e) => <>We sent a one-time code to {e}. It expires in 60 minutes.</>,
  },
  signup: {
    title: "Confirm your email.",
    body: (e) => <>We sent an {OTP_LENGTH}-digit code to {e}. Enter it to finish creating your account. It expires in 60 minutes.</>,
  },
  unconfirmed: {
    eyebrow: "Finish signing up",
    title: "Confirm your email first.",
    body: (e) => <>{e} has an account that was never confirmed. We just sent a new {OTP_LENGTH}-digit code. Enter it to open your workspace.</>,
  },
  unconfirmed_earlier: {
    eyebrow: "Finish signing up",
    title: "Confirm your email first.",
    body: (e) => <>{e} has an account that was never confirmed. Enter the {OTP_LENGTH}-digit code we emailed you a moment ago, or press Resend code when it unlocks.</>,
  },
};

function VerifyState({
  kind,
  email,
  code,
  setCode,
  verify,
  verifying,
  submitting,
  resendCooldown,
  error,
  onResend,
  onReset,
}: {
  kind: CodeKind;
  email: string;
  code: string;
  setCode: (v: string) => void;
  verify: (e: React.FormEvent) => Promise<void>;
  verifying: boolean;
  submitting: boolean;
  resendCooldown: number;
  error: string | null;
  onResend: () => Promise<void>;
  onReset: () => void;
}) {
  const isDev = process.env.NODE_ENV !== "production";
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (code.length === OTP_LENGTH && !verifying) {
      const form = inputRef.current?.form;
      if (form) {
        form.requestSubmit();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  return (
    <>
      {CODE_SCREEN_COPY[kind].eyebrow && (
        <p className="text-[12px] uppercase leading-4 tracking-[2.4px] text-[#027bff]">
          {CODE_SCREEN_COPY[kind].eyebrow}
        </p>
      )}
      <h1 className="mt-2 text-[28px] font-medium leading-[1.1] tracking-[-1px] text-[#171717]">
        {CODE_SCREEN_COPY[kind].title}
      </h1>
      <p className="mt-3 text-[16px] leading-[1.6] tracking-[-0.15px] text-[#525252]">
        {CODE_SCREEN_COPY[kind].body(<span className="font-medium text-[#171717]">{email}</span>)}
      </p>
      <InboxLinks email={email} className="mt-5" />

      <form onSubmit={verify} className="mt-6">
        <label htmlFor="otp-code" className={AUTH_LABEL}>
          Verification code
        </label>
        <Input
          ref={inputRef}
          unstyled
          id="otp-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          maxLength={OTP_LENGTH}
          pattern={`[0-9]{${OTP_LENGTH}}`}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, OTP_LENGTH))}
          placeholder={"123456789".slice(0, OTP_LENGTH)}
          disabled={verifying}
          className="
            w-full rounded-lg border border-[#e5e5e5] bg-white
            px-4 py-3 text-center text-[20px] tabular-nums tracking-[0.5em]
            transition-colors placeholder:text-[#a1a1a1]
            focus:border-[#171717] focus:outline-none focus:ring-4 focus:ring-[#171717]/10
            disabled:opacity-60
          "
        />
        {error && (
          <p role="alert" aria-live="polite" className="mt-3 text-[13px] tracking-[-0.15px] text-[#dc2626]">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={verifying || code.length < OTP_LENGTH}
          className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-cta bg-[#0e0f11] px-4 py-3 text-[16px] font-medium tracking-[-0.15px] text-white transition-colors hover:bg-[#404040] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {verifying ? "Verifying…" : "Continue"}
        </button>
      </form>

      <div className="mt-5 flex items-center justify-between text-[13px] tracking-[-0.15px] text-[#525252]">
        <button
          type="button"
          onClick={onResend}
          disabled={submitting || verifying || resendCooldown > 0}
          className="transition-colors hover:text-[#171717] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting
            ? "Sending…"
            : resendCooldown > 0
              ? `Resend in ${resendCooldown}s`
              : "Resend code"}
        </button>
        <button
          type="button"
          onClick={onReset}
          disabled={verifying}
          className="transition-colors hover:text-[#171717] disabled:opacity-50"
        >
          Use a different email →
        </button>
      </div>

      <p className="mt-5 rounded-[10px] bg-[#f7f6f3] px-3.5 py-3 text-[14px] leading-[1.5] tracking-[-0.15px] text-[#3d3d3d]">
        <span className="font-semibold text-[#171717]">Can&apos;t find the email?</span> Check your spam or junk folder. It
        comes from <span className="font-medium text-[#171717]">support@zaviagent.com</span>.
      </p>

      {isDev && (
        <div className="mt-6 rounded-md border border-[#e5e5e5] bg-[#f5f3f1] px-3 py-2 text-[11px] tracking-[-0.15px] text-[#525252]">
          <span className="mr-1.5 uppercase tracking-wide text-[#a1a1a1]">
            dev
          </span>
          Local emails go to{" "}
          <a
            href="http://127.0.0.1:54324"
            target="_blank"
            rel="noopener"
            className="font-medium text-[#171717] underline transition-colors hover:text-[#404040]"
          >
            Supabase Inbucket
          </a>
          .
        </div>
      )}
    </>
  );
}

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function ResetSentState({ email, onReset }: { email: string; onReset: () => void }) {
  return (
    <>
      <h1 className="mt-2 text-[28px] font-medium leading-[1.1] tracking-[-1px] text-[#171717]">
        Reset link sent.
      </h1>
      <p className="mt-3 text-[16px] leading-[1.6] tracking-[-0.15px] text-[#525252]">
        We emailed a password-reset link to{" "}
        <span className="font-medium text-[#171717]">{email}</span>. Click the link to set a new password.
      </p>
      <InboxLinks email={email} className="mt-5" />
      <button
        type="button"
        onClick={onReset}
        className="mt-6 text-[13px] tracking-[-0.15px] text-[#525252] transition-colors hover:text-[#171717]"
      >
        ← Use a different email
      </button>
      <p className="mt-6 text-[12px] leading-[1.55] tracking-[-0.15px] text-[#a1a1a1]">
        Can&apos;t find the email? Check your spam folder. The sender is{" "}
        <code className="rounded bg-[#f5f5f5] px-1 py-0.5 text-[11px] text-[#525252]">
          support@zaviagent.com
        </code>
        .
      </p>
    </>
  );
}
