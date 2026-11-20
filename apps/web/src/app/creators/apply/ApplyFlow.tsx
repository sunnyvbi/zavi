"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Briefcase, Check, CreditCard, Globe, Link2, Mail, Pencil, RotateCcw, Upload } from "lucide-react";
import { parseSocial } from "@zavi/shared";
import { createBrowserSupabase } from "@/lib/supabase";
import { trackEvent, trackEventDeferred } from "@/lib/analytics/events";
import {
  detectInAppBrowser,
  externalBrowserLink,
  watchOpenAttempt,
  withoutAuthErrors,
  type ExternalBrowserLink,
  type InAppBrowser,
} from "@/lib/inAppBrowser";
import { creatorApi, CreatorApiError, landingFor, type CreatorMe, type CreatorSetup, type EarnMode } from "@/lib/creator/api";
import { CREATOR_SIGNUP_FLAG } from "@/lib/creator/finishSignup";
import { useSignedInCreator } from "@/lib/creator/useSignedInCreator";
import { fetchInvitePrefill } from "@/lib/creator/invite";
import { PHOTO_ACCEPT, uploadProfilePhoto } from "@/lib/creator/photo";
import {
  CREATOR_NICHES,
  LANE_PLATFORMS,
  PAYOUT_REGIONS_LINE,
  PLATFORM_KEY,
  SELF_REPORTED,
  canPay,
  SOCIAL_PLACEHOLDER,
  defaultPackage,
  platformFromKey,
  priceCents,
  socialError,
  toPackagePayload,
  type LanePlatform,
  type PackageSpec,
} from "@/lib/creator/packageSpec";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  BTN_SMALL,
  Card,
  BackButton,
  Chip,
  CreatorFrame,
  FIELD,
  FieldError,
  PackageBuilder,
  RING,
  SocialLink,
  Spine,
  StepSkeleton,
} from "@/components/creator/ui";
import {
  useAffiliateBase,
  AffiliateLinkCard,
  AffiliateTermsCard,
  ProRow,
  useHasBusiness,
} from "@/components/creator/affiliateParts";

export const APPLY_STEPS = [
  { id: "goal", label: "How you earn" },
  { id: "account", label: "Your age" },
  { id: "make", label: "What you make" },
  { id: "photo", label: "Photo (optional)" },
  { id: "package", label: "First package" },
] as const;
type StepId = (typeof APPLY_STEPS)[number]["id"];
const isStep = (v: string | null | undefined): v is StepId => APPLY_STEPS.some((s) => s.id === v);

export const GOAL_HREF = "/creators/apply?step=goal";

export function stepsFor(mode: EarnMode | null | undefined): readonly { id: StepId; label: string }[] {
  return mode === "affiliate" ? APPLY_STEPS.filter((s) => s.id === "goal" || s.id === "account" || s.id === "make") : APPLY_STEPS;
}

export function nextStepHref(step: StepId, mode: EarnMode | null = null): string | null {
  const steps = stepsFor(mode);
  const i = steps.findIndex((s) => s.id === step);
  const next = i >= 0 ? steps[i + 1] : undefined;
  return next ? `/creators/apply?step=${next.id}` : null;
}

export function modeOf(p: { affiliate: boolean; jobs: boolean }): EarnMode | null {
  return p.affiliate && p.jobs ? "both" : p.affiliate ? "affiliate" : p.jobs ? "jobs" : null;
}

export function breakLine(mode: EarnMode | null): string {
  if (mode === "affiliate") return "Your affiliate link is ready as soon as setup is done.";
  if (mode === "both") return "Your affiliate link is ready, and businesses can find and book you, once you have a package.";
  return "Businesses can find and book you once you have a package.";
}

type FieldErrors = Partial<Record<string, string>>;

type Draft = {
  goals: { affiliate: boolean; jobs: boolean };
  age: string;
  lanes: LanePlatform[];
  handles: Record<string, string>;
  followers: Record<string, string>;
  niches: string[];
  pkg: PackageSpec;
};

const EMPTY: Draft = {
  goals: { affiliate: false, jobs: false },
  age: "18",
  lanes: [],
  handles: {},
  followers: {},
  niches: ["Tech"],
  pkg: defaultPackage(),
};

export const AGE_OPTIONS = Array.from({ length: 80 - 18 + 1 }, (_, i) => 18 + i);

function normalize(platform: LanePlatform, raw: string) {
  const r = parseSocial(PLATFORM_KEY[platform], raw);
  return r.ok ? r.value : null;
}

export function validate(step: StepId, d: Draft): FieldErrors {
  const e: FieldErrors = {};
  if (step === "goal" && !d.goals.affiliate && !d.goals.jobs) e.goal = "Pick at least one.";
  if (step === "account") {
    const age = Number(d.age);
    if (!d.age || !Number.isInteger(age)) e.age = "Pick your age.";
    else if (age < 18) e.age = "You need to be 18 or older to sell on Zavi.";
  }
  if (step === "make") {
    if (d.lanes.length === 0) e.lanes = "Pick at least one platform.";
    else if (d.lanes.some((l) => !String(d.handles[l] ?? "").trim())) e.lanes = "Add a profile link or handle for each platform you picked.";
    else if (d.lanes.some((l) => !normalize(l, d.handles[l] ?? "")))
      e.lanes = "Fix the profile link marked below. Paste the link to your profile, or your @handle.";
    else if (d.lanes.some((l) => !(Number(String(d.followers[l] ?? "").replace(/[^0-9]/g, "")) > 0)))
      e.lanes = "Add a follower number for each platform you picked.";
    if (d.niches.length === 0) e.niches = "Pick at least one niche.";
  }
  if (step === "package") {
    if (!priceCents(d.pkg.price)) e.price = "Set a price.";
  }
  return e;
}

function errText(e: unknown, fallback: string): string {
  return e instanceof CreatorApiError || e instanceof Error ? e.message : fallback;
}

export default function ApplyFlow() {
  const params = useSearchParams();
  const step = params?.get("step");
  const state = params?.get("state");
  const ref = params?.get("ref");
  const invite = params?.get("invite");
  const finish = params?.get("finish") === "1";
  const screen = finish
    ? "finish"
    : state === "live"
      ? "live"
      : step === "photo"
        ? "photo"
        : isStep(step)
          ? step
          : "signup";

  useEffect(() => {
    return trackEventDeferred("creator_onboarding_step_viewed", { step: screen, invited: !!ref });
  }, [screen, ref]);

  if (finish) return <FinishSignup />;
  if (state === "live") return <CreatorFrame><LiveScreen /></CreatorFrame>;
  if (step === "photo") return <PhotoStep />;
  if (isStep(step)) return <SetupStep key={step} step={step} />;
  return <SignupGate invitedBy={ref ? refToName(ref) : null} refSlug={ref} inviteToken={invite} />;
}

function SignupGate(props: { invitedBy: string | null; refSlug?: string | null; inviteToken?: string | null }) {
  const checking = useSignedInCreator("/creator");
  if (checking) {
    return (
      <CreatorFrame>
        <p className="text-center text-[14px] text-muted">Checking your account…</p>
      </CreatorFrame>
    );
  }
  return <SignupScreen {...props} />;
}

export function refToName(ref: string): string {
  return ref
    .split("-")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

const INVALID = "border-danger focus:border-danger";
const FINISH_NAME_KEY = "zavi.creatorSignupName";
const SIGNUP_CODE_LENGTH = 8;
const CODE_FAILED = "That code didn't work. It may be mistyped or expired. Use the newest email from Zavi, or press Resend code.";

function finishUrl(): string {
  return `/creators/apply?finish=1`;
}

type SignupField = "name" | "email" | "password";

export function validateSignup(v: Record<SignupField, string>): Partial<Record<SignupField, string>> {
  const e: Partial<Record<SignupField, string>> = {};
  if (!v.name.trim()) e.name = "Add your full name.";
  if (!v.email.trim()) e.email = "Enter your email.";
  else if (!/^\S+@\S+\.\S+$/.test(v.email.trim())) e.email = "Enter a valid email.";
  if (!v.password) e.password = "Enter a password.";
  else if (v.password.length < 8) e.password = "Use a password of at least 8 characters.";
  return e;
}

function SignupScreen({ invitedBy, inviteToken }: { invitedBy: string | null; refSlug?: string | null; inviteToken?: string | null }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [checkEmail, setCheckEmail] = useState(false);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = window.setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => window.clearTimeout(t);
  }, [cooldown]);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<SignupField, string>>>({});
  const [inApp, setInApp] = useState<InAppBrowser | null>(null);
  const [outLink, setOutLink] = useState<ExternalBrowserLink | null>(null);
  const [openStuck, setOpenStuck] = useState(false);
  const [pageLink, setPageLink] = useState("");
  const stopOpenWatch = useRef<(() => void) | null>(null);
  useEffect(() => () => stopOpenWatch.current?.(), []);

  useEffect(() => {
    const ua = window.navigator.userAgent;
    const found = detectInAppBrowser(ua);
    setInApp(found);
    if (!found) return;
    const clean = withoutAuthErrors(window.location.href);
    setPageLink(clean);
    setOutLink(externalBrowserLink(clean, ua));
    return trackEventDeferred("in_app_browser_detected", { app: found.app ?? "unknown", screen: "creator_signup" });
  }, []);

  useEffect(() => {
    if (!inviteToken) return;
    let live = true;
    void fetchInvitePrefill(inviteToken).then((p) => {
      if (!live || !p) return;
      setName((v) => v || p.name);
      setEmail((v) => v || p.email);
    });
    return () => {
      live = false;
    };
  }, [inviteToken]);

  function change(field: SignupField, value: string, set: (v: string) => void) {
    set(value);
    if (!fieldErrors[field]) return;
    const next = validateSignup({ name, email, password, [field]: value });
    setFieldErrors((prev) => ({ ...prev, [field]: next[field] }));
  }

  async function signUp() {
    setError(null);
    setGoogleError(null);
    const errs = validateSignup({ name, email, password });
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    trackEvent("creator_signup_submitted", { method: "password", invited: !!invitedBy });
    try {
      const supabase = createBrowserSupabase();
      const { data, error: e } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: { full_name: name.trim(), [CREATOR_SIGNUP_FLAG]: "creator" },
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(finishUrl())}`,
        },
      });
      let session = data.session;
      const existing = !!e || (!session && !!data.user && (data.user.identities?.length ?? 0) === 0);
      if (existing) {
        const signed = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (signed.error?.code === "email_not_confirmed") {
          try {
            await sendSignupCode();
          } catch (sendErr) {
            if (!/only request this after/i.test(sendErr instanceof Error ? sendErr.message : "")) throw sendErr;
            setCheckEmail(true);
            setCooldown(60);
            setCode("");
            setNotice("Enter the code we emailed you a moment ago.");
          }
          return;
        }
        if (signed.error || !signed.data.session) {
          throw new Error(e?.message ?? "You already have an account with this email. Sign in instead.");
        }
        session = signed.data.session;
      }
      if (!session) {
        trackEvent("creator_signup_confirm_sent");
        setCheckEmail(true);
        setCooldown(30);
        setCode("");
        return;
      }
      await enterCreatorArea();
    } catch (e2) {
      trackEvent("creator_signup_failed");
      setError(errText(e2, "Could not create your account. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function enterCreatorArea() {
    const signup = await creatorApi.signup(name.trim());
    trackEvent(signup.created ? "creator_signup_completed" : "creator_logged_in", { method: "password" });
    const h = await creatorApi.home();
    router.replace(afterSignup(signup.created, landingFor(h.home, "/creator")));
  }

  async function sendSignupCode() {
    const { error: e } = await createBrowserSupabase().auth.resend({ type: "signup", email: email.trim() });
    if (e) throw new Error(e.message);
    setCheckEmail(true);
    setCooldown(30);
    setCode("");
  }

  async function verifyCode(value: string) {
    if (value.length < SIGNUP_CODE_LENGTH || verifying) return;
    setVerifying(true);
    setError(null);
    setNotice(null);
    try {
      const { data, error: e } = await createBrowserSupabase().auth.verifyOtp({ email: email.trim(), token: value, type: "signup" });
      if (e || !data.session) throw new Error(CODE_FAILED);
      trackEvent("creator_signup_code_verified");
      try {
        window.sessionStorage.setItem(FINISH_NAME_KEY, name.trim());
      } catch {
      }
      router.replace(finishUrl());
      return;
    } catch (e2) {
      trackEvent("creator_signup_failed");
      setError(errText(e2, CODE_FAILED));
      setVerifying(false);
    }
  }

  async function resendCode() {
    if (cooldown > 0) return;
    setError(null);
    try {
      await sendSignupCode();
      setNotice("We sent a new code. Only the newest one works.");
    } catch (e2) {
      setError(errText(e2, "Could not send a new code. Try again in a moment."));
    }
  }

  async function google() {
    setError(null);
    setGoogleError(null);
    const redirectTo = `${window.location.origin}/api/auth/callback?next=${encodeURIComponent(finishUrl())}`;
    trackEvent("oauth_started", { provider: "google", mode: "creator_signup" });
    const { error: e } = await createBrowserSupabase().auth.signInWithOAuth({ provider: "google", options: { redirectTo } });
    if (e) setGoogleError(e.message);
  }

  return (
    <CreatorFrame>
      <div className="mx-auto max-w-[440px] animate-step-in motion-reduce:animate-none">
        {invitedBy && (
          <Card className="mb-6 flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-foreground text-white">
              <Mail className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <p className="text-[14px] font-semibold text-foreground">Invited by {invitedBy}</p>
              <p className="mt-1 text-[14px] leading-relaxed text-muted">{invitedBy} wants to hire you on Zavi.</p>
            </div>
          </Card>
        )}
        <h1 className="text-center text-[28px] font-bold leading-tight tracking-tight text-foreground sm:text-[32px]">Join Zavi as a creator</h1>
        <p className="mt-2.5 text-center text-[14px] leading-relaxed text-muted">
          Earn commission by referring customers to Zavi, or get hired by businesses for videos and keep 85% of every job.
        </p>
        {checkEmail ? (
          <form
            noValidate
            className="mt-7"
            onSubmit={(e) => {
              e.preventDefault();
              void verifyCode(code);
            }}
          >
            <p className="text-[15px] font-semibold text-foreground">Confirm your email.</p>
            <p className="mt-1.5 text-[14px] leading-relaxed text-muted">
              We sent an {SIGNUP_CODE_LENGTH}-digit code to <span className="font-medium text-foreground">{email.trim()}</span>. Enter it to finish
              creating your account. It expires in 60 minutes.
            </p>
            <div className="mt-5">
              <Label htmlFor="signup-code">Verification code</Label>
            </div>
            <input
              id="signup-code"
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              disabled={verifying}
              maxLength={SIGNUP_CODE_LENGTH}
              placeholder={"12345678".slice(0, SIGNUP_CODE_LENGTH)}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, "").slice(0, SIGNUP_CODE_LENGTH);
                setCode(v);
                setError(null);
                if (v.length === SIGNUP_CODE_LENGTH) void verifyCode(v);
              }}
              className={`${FIELD} h-12 px-4 text-center text-[20px] tracking-[0.5em] tabular-nums`}
            />
            {error && <p className="mt-3 text-[13px] text-red-600">{error}</p>}
            {notice && !error && <p className="mt-3 text-[13px] text-emerald-700">{notice}</p>}
            <button type="submit" disabled={verifying || code.length < SIGNUP_CODE_LENGTH} className={`${BTN_PRIMARY} mt-4 w-full`}>
              {verifying ? "Verifying" : "Continue"}
            </button>
            <div className="mt-4 flex items-center justify-between text-[13px] text-muted">
              <button type="button" onClick={() => void resendCode()} disabled={verifying || cooldown > 0} className="hover:text-foreground disabled:opacity-50">
                {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setCheckEmail(false);
                  setCode("");
                  setError(null);
                  setNotice(null);
                }}
                disabled={verifying}
                className="hover:text-foreground disabled:opacity-50"
              >
                Use a different email
              </button>
            </div>
            <p className="mt-5 rounded-xl bg-black/[0.03] px-3.5 py-3 text-[14px] leading-relaxed text-foreground/80">
              <span className="font-semibold text-foreground">Can&apos;t find the email?</span> Check your spam or junk folder. It comes from{" "}
              <span className="font-medium text-foreground">support@zaviagent.com</span>.
            </p>
          </form>
        ) : (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void signUp();
            }}
          >
            <div className="mt-7 space-y-4">
              <div>
                <Label htmlFor="signup-name">Full name</Label>
                <input
                  id="signup-name"
                  value={name}
                  onChange={(e) => change("name", e.target.value, setName)}
                  placeholder="Full name"
                  autoComplete="name"
                  aria-invalid={!!fieldErrors.name}
                  className={`${FIELD} h-12 px-4 ${fieldErrors.name ? INVALID : ""}`}
                />
                <FieldError>{fieldErrors.name}</FieldError>
              </div>
              <div>
                <Label htmlFor="signup-email">Email</Label>
                <input
                  id="signup-email"
                  type="email"
                  value={email}
                  onChange={(e) => change("email", e.target.value, setEmail)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  aria-invalid={!!fieldErrors.email}
                  className={`${FIELD} h-12 px-4 ${fieldErrors.email ? INVALID : ""}`}
                />
                <FieldError>{fieldErrors.email}</FieldError>
              </div>
              <div>
                <Label htmlFor="signup-password">Password</Label>
                <input
                  id="signup-password"
                  type="password"
                  value={password}
                  onChange={(e) => change("password", e.target.value, setPassword)}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                  aria-invalid={!!fieldErrors.password}
                  className={`${FIELD} h-12 px-4 ${fieldErrors.password ? INVALID : ""}`}
                />
                <FieldError>{fieldErrors.password}</FieldError>
              </div>
            </div>
            <FieldError>{error}</FieldError>
            <button type="submit" disabled={busy} className={`${BTN_PRIMARY} mt-5 w-full`}>
              {busy ? "Signing up…" : "Sign up"}
            </button>
          </form>
        )}
        <p className="mt-4 text-center text-[14px] text-muted">
          Already have an account?{" "}
          <Link href="/creators/login" className="font-semibold text-foreground underline underline-offset-4">
            Sign in
          </Link>
        </p>
        <div className="my-6 flex items-center gap-3 text-[13px] text-muted">
          <span className="h-px flex-1 bg-black/[0.08]" />
          or
          <span className="h-px flex-1 bg-black/[0.08]" />
        </div>
        {googleError && (
          <p role="alert" className="mb-3 rounded-xl bg-rose-50 px-4 py-3 text-[14px] text-rose-800">
            {googleError}
          </p>
        )}
        {inApp ? (
          <div className="rounded-xl bg-black/[0.03] px-4 py-3 text-[14px] leading-relaxed text-foreground">
            <p>
              Google sign-in doesn&apos;t work inside {inApp.app ? `the ${inApp.app} app` : "this app"}. Sign up with your email above, or open
              this page in Safari or Chrome.
            </p>
            {outLink && (
              <a
                href={outLink.href}
                onClick={() => {
                  trackEvent("in_app_open_browser_clicked", { app: inApp.app ?? "unknown", screen: "creator_signup" });
                  setOpenStuck(false);
                  stopOpenWatch.current?.();
                  stopOpenWatch.current = watchOpenAttempt(() => {
                    stopOpenWatch.current = null;
                    setOpenStuck(true);
                    trackEvent("in_app_open_browser_stuck", { app: inApp.app ?? "unknown", screen: "creator_signup" });
                  });
                }}
                className="mt-2 inline-flex min-h-[44px] items-center font-semibold text-[#027bff] hover:text-[#0264d1]"
              >
                {outLink.label}
              </a>
            )}
            {openStuck && (
              <p role="status" className="mt-1 text-[13px] text-muted">
                Didn&apos;t open? Copy this link and paste it into Safari or Chrome:{" "}
                <span className="select-all break-all text-foreground">{pageLink}</span>
              </p>
            )}
          </div>
        ) : (
        <button type="button" onClick={() => void google()} className={`${BTN_SECONDARY} w-full`}>
          <svg viewBox="0 0 18 18" className="h-4 w-4" aria-hidden="true">
            <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.13-.84 2.09-1.79 2.73v2.27h2.9c1.7-1.56 2.69-3.87 2.69-6.64z" />
            <path fill="#34A853" d="M9 18c2.43 0 4.46-.81 5.95-2.18l-2.9-2.27c-.81.55-1.84.86-3.05.86-2.34 0-4.32-1.58-5.03-3.71H.96v2.33A8.997 8.997 0 009 18z" />
            <path fill="#FBBC05" d="M3.97 10.7a5.41 5.41 0 010-3.4V4.97H.96a8.997 8.997 0 000 8.06l3.01-2.33z" />
            <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.43 1.34l2.58-2.58C13.46.89 11.43 0 9 0A8.997 8.997 0 00.96 4.97L3.97 7.3C4.68 5.17 6.66 3.58 9 3.58z" />
          </svg>
          Continue with Google
        </button>
        )}
        <p className="mt-6 text-center text-[12px] text-muted">
          By signing up, you confirm you are 18 or older and agree to our{" "}
          <Link href="/terms" className="hover:underline">
            Terms
          </Link>{" "}
          and{" "}
          <Link href="/privacy" className="hover:underline">
            Privacy Policy
          </Link>
          .
        </p>
      </div>
    </CreatorFrame>
  );
}

export function afterSignup(created: boolean, landing: string): string {
  return created && landing === "/creator" ? GOAL_HREF : landing;
}

function FinishSignup() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      const { data } = await createBrowserSupabase().auth.getSession();
      const user = data.session?.user;
      if (!user) {
        router.replace("/creators/login");
        return;
      }
      const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
      let typed = "";
      try {
        typed = window.sessionStorage.getItem(FINISH_NAME_KEY) ?? "";
      } catch {
      }
      const name = (typed || String(meta.full_name ?? meta.name ?? user.email?.split("@")[0] ?? "")).trim();
      try {
        const signup = await creatorApi.signup(name || "Creator");
        try {
          window.sessionStorage.removeItem(FINISH_NAME_KEY);
        } catch {
        }
        if (signup.created) {
          trackEvent("creator_signup_completed", { method: user.app_metadata?.provider === "google" ? "google" : "password" });
        }
        const h = await creatorApi.home();
        router.replace(afterSignup(signup.created, landingFor(h.home, "/creator")));
      } catch (e) {
        setError(errText(e, "Could not finish your signup. Try again."));
      }
    })();
  }, [router]);
  return (
    <CreatorFrame>
      <p className="text-center text-[14px] text-muted">{error ?? "Setting up your creator area."}</p>
      {error && (
        <div className="mt-4 flex justify-center">
          <button type="button" onClick={() => window.location.reload()} className={BTN_PRIMARY}>
            Try again
          </button>
        </div>
      )}
    </CreatorFrame>
  );
}

function StartOver({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${RING} inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-cta px-2.5 text-[13px] font-medium text-muted transition-colors hover:text-foreground`}
    >
      <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
      Start over
    </button>
  );
}

function SetupStep({ step }: { step: StepId }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<EarnMode | null>(null);
  const touched = useRef(false);

  useEffect(() => {
    let live = true;
    creatorApi
      .me()
      .then((m) => {
        if (!live) return;
        const saved = m.setup.earn_mode ?? null;
        setMode(saved);
        if (saved && !touched.current) setDraft((d) => ({ ...d, goals: { affiliate: saved !== "jobs", jobs: saved !== "affiliate" } }));
      })
      .catch(() => {
      });
    return () => {
      live = false;
    };
  }, []);

  const shown = step === "goal" ? modeOf(draft.goals) : mode;
  const steps = stepsFor(shown);
  const index = steps.findIndex((s) => s.id === step);

  useEffect(() => {
    if (step !== "make") return;
    creatorApi
      .profile()
      .then((p) => {
        const lanes = p.accounts.map((a) => platformFromKey(a.platform)).filter((x): x is LanePlatform => !!x);
        setDraft((d) => ({
          ...d,
          lanes,
          handles: Object.fromEntries(p.accounts.map((a) => [platformFromKey(a.platform) ?? a.platform, a.handle])),
          followers: Object.fromEntries(
            p.accounts.map((a) => [platformFromKey(a.platform) ?? a.platform, a.followers ? a.followers.toLocaleString("en-US") : ""]),
          ),
          niches: p.niches.length
            ? p.niches.map((n) => CREATOR_NICHES.find((c) => c.toLowerCase() === n.trim().toLowerCase()) ?? n)
            : d.niches,
        }));
      })
      .catch((e: unknown) => {
        if (e instanceof CreatorApiError && e.status === 401) router.replace(`/creators/login?next=${encodeURIComponent(`/creators/apply?step=${step}`)}`);
      })
      .finally(() => setLoading(false));
  }, [step, router]);

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    if (key === "goals") touched.current = true;
    setDraft((p) => ({ ...p, [key]: value }));
    setErrors({});
    setFormError(null);
  }

  async function save() {
    const found = validate(step, draft);
    if (Object.keys(found).length) {
      trackEvent("creator_onboarding_step_invalid", { step, fields: Object.keys(found).join(",") });
      setErrors(found);
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      let result: { setup: CreatorSetup } | null = null;
      if (step === "goal") {
        result = await creatorApi.setupEarn(draft.goals.affiliate, draft.goals.jobs);
        trackEvent("creator_earn_mode_chosen", { mode: result.setup.earn_mode ?? modeOf(draft.goals) });
      }
      if (step === "account") result = await creatorApi.setupAge(Number(draft.age));
      if (step === "make")
        result = await creatorApi.setupMake(
          draft.lanes.map((l) => ({
            platform: PLATFORM_KEY[l],
            handle: draft.handles[l] ?? "",
            followers: Number(String(draft.followers[l] ?? "").replace(/[^0-9]/g, "")),
          })),
          draft.niches,
        );
      if (step === "package") result = await creatorApi.addPackage(toPackagePayload(draft.pkg));
      const complete = result?.setup.complete ?? false;
      const next = result?.setup.earn_mode !== undefined ? result.setup.earn_mode : step === "goal" ? modeOf(draft.goals) : mode;
      trackEvent("creator_onboarding_step_completed", { step, setup_complete: complete });
      const href = nextStepHref(step, next);
      router.push(href ?? (complete ? "/creators/apply?state=live" : "/creator"));
    } catch (e) {
      if (e instanceof CreatorApiError && e.status === 401) {
        router.replace(`/creators/login?next=${encodeURIComponent(`/creators/apply?step=${step}`)}`);
        return;
      }
      trackEvent("creator_onboarding_step_failed", { step });
      setFormError(errText(e, "That did not save. Try again."));
      setBusy(false);
    }
  }

  return (
    <CreatorFrame
      right={
        <StartOver
          onClick={() => {
            setDraft({ ...EMPTY, pkg: defaultPackage() });
            setErrors({});
            setFormError(null);
            if (step !== "account") router.push(stepHref("account"));
          }}
        />
      }
    >
      <div className="animate-step-in motion-reduce:animate-none">
        <Spine steps={steps} currentIndex={index} />
        <div className="mt-7">
          {step === "goal" && <GoalStep draft={draft} errors={errors} update={update} />}
          {step === "account" && <AccountStep draft={draft} errors={errors} update={update} />}
          {step === "make" && <MakeStep draft={draft} errors={errors} update={update} affiliateOnly={mode === "affiliate"} />}
          {step === "package" && <PackageStep draft={draft} errors={errors} update={update} />}
          <FieldError>{formError}</FieldError>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <button type="button" disabled={busy} onClick={save} className={BTN_PRIMARY}>
              {step === "package" ? "Save and go live" : "Save"}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <p className="mt-6 text-[13px] text-muted">
            Need a break?{" "}
            <Link href="/creator" className="font-semibold text-foreground underline underline-offset-4">
              Save and finish later
            </Link>
            . {breakLine(shown)}
          </p>
        </div>
      </div>
    </CreatorFrame>
  );
}

type StepProps = {
  draft: Draft;
  errors: FieldErrors;
  update: <K extends keyof Draft>(k: K, v: Draft[K]) => void;
};

function Heading({ title, blurb }: { title: string; blurb: string }) {
  return (
    <>
      <h1 className="text-[26px] font-bold leading-tight tracking-tight text-foreground sm:text-[30px]">{title}</h1>
      <p className="mt-2.5 text-[14px] leading-relaxed text-muted">{blurb}</p>
    </>
  );
}

function Label({ children, htmlFor }: { children: string; htmlFor?: string }) {
  if (htmlFor) {
    return (
      <label htmlFor={htmlFor} className="mb-2 block text-[14px] font-medium text-foreground">
        {children}
      </label>
    );
  }
  return <span className="mb-2 block text-[14px] font-medium text-foreground">{children}</span>;
}

const GOALS: { id: "affiliate" | "jobs"; Icon: typeof Link2; title: string; body: string; note: string }[] = [
  {
    id: "affiliate",
    Icon: Link2,
    title: "Refer customers (affiliate)",
    body: "Share your link. You get 100% of a referred customer's first 2 monthly payments, then 30% through month 12.",
    note: "No package needed. Your link is ready at the end of setup.",
  },
  {
    id: "jobs",
    Icon: Briefcase,
    title: "Paid creator jobs (marketplace)",
    body: "Businesses book videos from you. You keep 85% of every job.",
    note: "You set up a first package so businesses can book you.",
  },
];

function GoalStep({ draft, errors, update }: StepProps) {
  return (
    <div>
      <Heading title="How do you want to earn?" blurb="Pick one or both. Setup only asks for what you picked." />
      <div className="mt-7 space-y-3">
        {GOALS.map(({ id, Icon, title, body, note }) => {
          const on = draft.goals[id];
          return (
            <button
              key={id}
              type="button"
              aria-pressed={on}
              onClick={() => update("goals", { ...draft.goals, [id]: !on })}
              className={`${RING} flex w-full cursor-pointer items-start gap-3 rounded-2xl border bg-white/90 p-4 text-left shadow-[0_1px_2px_rgba(16,24,40,0.04)] backdrop-blur-sm transition-all duration-150 active:scale-[0.99] ${
                on ? "border-foreground" : "border-black/[0.07] hover:border-black/20"
              }`}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-foreground text-white">
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-semibold text-foreground">{title}</span>
                <span className="mt-1 block text-[14px] leading-relaxed text-muted">{body}</span>
                <span className="mt-1.5 block text-[13px] text-muted">{note}</span>
              </span>
              <span
                aria-hidden="true"
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${on ? "bg-foreground text-white" : "border border-black/15 bg-white"}`}
              >
                {on ? <Check className="h-3 w-3" /> : null}
              </span>
            </button>
          );
        })}
      </div>
      <FieldError>{errors.goal}</FieldError>
    </div>
  );
}

function AccountStep({ draft, errors, update }: StepProps) {
  return (
    <div>
      <Heading title="Your age" blurb="You need to be 18 or older to sell on Zavi. We never show your age." />
      <div className="mt-7 space-y-5">
        <label className="block max-w-[260px]">
          <Label>Age</Label>
          <div className="relative">
            <select
              value={draft.age}
              onChange={(e) => update("age", e.target.value)}
              className={`${FIELD} h-12 appearance-none pl-4 pr-11`}
            >
              <option value="" disabled>
                Select your age
              </option>
              {AGE_OPTIONS.map((a) => (
                <option key={a} value={String(a)}>
                  {a}
                </option>
              ))}
            </select>
            <ChevronDown
              aria-hidden
              className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground/60"
            />
          </div>
          <FieldError>{errors.age}</FieldError>
        </label>
      </div>
    </div>
  );
}

function MakeStep({ draft, errors, update, affiliateOnly = false }: StepProps & { affiliateOnly?: boolean }) {
  const [blurred, setBlurred] = useState<string[]>([]);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <div>
      <Heading
        title="What you make"
        blurb={
          affiliateOnly
            ? "Where you post and what about. You need at least one platform to get your affiliate link."
            : "Businesses filter by platform and niche, and briefs that fit you land in your inbox."
        }
      />
      <div className="mt-7 space-y-6">
        <div>
          <Label>Platforms</Label>
          <div className="flex flex-wrap gap-2">
            {LANE_PLATFORMS.map((p) => (
              <Chip key={p} label={p} selected={draft.lanes.includes(p)} onClick={() => update("lanes", toggle(draft.lanes, p))} />
            ))}
          </div>
          {draft.lanes.length > 0 && (
            <ul className="mt-4 space-y-3">
              {draft.lanes.map((l) => {
                const raw = draft.handles[l] ?? "";
                const found = normalize(l, raw);
                const showError = raw.trim() !== "" && !found && (blurred.includes(l) || Boolean(errors.lanes));
                return (
                  <li key={l} className="rounded-2xl border border-black/[0.07] bg-white/80 p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <span className="text-[14px] font-semibold text-foreground">{l}</span>
                      {found ? (
                        <SocialLink platform={l} handle={found.handle} url={found.url} className="min-w-0 truncate text-[13px]" />
                      ) : null}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px] sm:items-start">
                    <label className="block">
                      <span className="mb-1.5 block text-[14px] font-medium text-muted">Profile link or handle</span>
                      <input
                        value={raw}
                        onChange={(e) => update("handles", { ...draft.handles, [l]: e.target.value })}
                        onBlur={() => {
                          if (!blurred.includes(l)) setBlurred([...blurred, l]);
                        }}
                        placeholder={SOCIAL_PLACEHOLDER[l]}
                        aria-invalid={showError}
                        className={`${FIELD} h-12 px-4`}
                      />
                      {!found && showError ? <FieldError>{socialError(l)}</FieldError> : null}
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-[14px] font-medium text-muted">Followers</span>
                      <input
                        inputMode="numeric"
                        value={draft.followers[l] ?? ""}
                        onChange={(e) => update("followers", { ...draft.followers, [l]: e.target.value.replace(/[^0-9,]/g, "") })}
                        placeholder="48,000"
                        className={`${FIELD} h-12 px-4`}
                      />
                    </label>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <FieldError>{errors.lanes}</FieldError>
          <p className="mt-2 text-[13px] text-muted">
            {affiliateOnly ? (
              <>Zavi looks at these before your first payout.</>
            ) : (
              <>Businesses see your profile link and each follower number, with the label &ldquo;{SELF_REPORTED}&rdquo;.</>
            )}
          </p>
        </div>
        <div>
          <Label>Niches</Label>
          <div className="flex flex-wrap gap-2">
            {CREATOR_NICHES.map((n) => (
              <Chip key={n} label={n} selected={draft.niches.includes(n)} onClick={() => update("niches", toggle(draft.niches, n as string))} />
            ))}
          </div>
          <FieldError>{errors.niches}</FieldError>
        </div>
      </div>
    </div>
  );
}

function PackageStep({ draft, errors, update }: StepProps) {
  return (
    <div>
      <Heading title="Your first package" blurb="What a business can book from you. You can add more later in Profile." />
      <Card className="mt-7">
        <PackageBuilder value={draft.pkg} onChange={(pkg) => update("pkg", pkg)} errors={errors} />
      </Card>
      <p className="mt-4 text-[13px] text-muted">
        Once saved, you can change a package&apos;s title, description and price and turn it on or off. What is delivered stays fixed, so every
        booking matches what was sold.
      </p>
    </div>
  );
}

function PhotoStep() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const index = APPLY_STEPS.findIndex((s) => s.id === "photo");
  const nextHref = nextStepHref("photo") ?? "/creator";

  useEffect(() => {
    let live = true;
    creatorApi
      .profile()
      .then((p) => live && setPhotoUrl(p.photo_url ?? null))
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      await uploadProfilePhoto(file);
      const p = await creatorApi.profile().catch(() => null);
      setPhotoUrl(p?.photo_url ?? URL.createObjectURL(file));
    } catch (e) {
      if (e instanceof CreatorApiError && e.status === 401) {
        router.replace(`/creators/login?next=${encodeURIComponent("/creators/apply?step=photo")}`);
        return;
      }
      setError(errText(e, "The upload did not finish. Try again."));
    } finally {
      setBusy(false);
    }
  }

  const picker = (
    <input
      type="file"
      accept={PHOTO_ACCEPT}
      disabled={busy}
      className="sr-only"
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) void upload(f);
        e.target.value = "";
      }}
    />
  );

  return (
    <CreatorFrame right={<StartOver onClick={() => router.push(stepHref("account"))} />}>
      <div className="animate-step-in motion-reduce:animate-none">
        <div className="relative">
          <BackButton href={stepHref("make")} />
          <Spine steps={APPLY_STEPS} currentIndex={index} hrefFor={(id) => stepHref(id as StepId)} />
        </div>
        <div className="mt-7">
          <Heading
            title="Add a profile photo"
            blurb="Optional. Businesses see it on your card in Find creators. JPG, PNG or WebP, up to 5 MB."
          />
          <FieldError>{error}</FieldError>
          {loading ? (
            <div
              role="status"
              aria-label="Loading"
              className="mt-7 h-44 w-full max-w-[420px] animate-pulse rounded-2xl bg-black/[0.05] motion-reduce:animate-none"
            />
          ) : photoUrl ? (
            <div className="mt-7 flex items-center gap-5">
              <div className="relative h-28 w-28 shrink-0 overflow-hidden rounded-full border border-black/10 bg-white">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photoUrl} alt="Your profile photo" className="h-full w-full object-cover" />
                {busy && (
                  <span className="absolute inset-0 flex items-center justify-center bg-white/70">
                    <span
                      className="h-7 w-7 animate-spin rounded-full border-[3px] border-black/10 border-t-foreground motion-reduce:animate-none"
                      role="status"
                      aria-label="Uploading"
                    />
                  </span>
                )}
              </div>
              <div>
                <p className="text-[14px] font-medium text-foreground">{busy ? "Uploading your photo…" : "Looking good"}</p>
                <label className={`mt-2 inline-block text-[14px] font-medium text-foreground underline underline-offset-4 ${busy ? "pointer-events-none opacity-40" : "cursor-pointer"}`}>
                  Replace photo
                  {picker}
                </label>
              </div>
            </div>
          ) : (
            <label
              aria-busy={busy || loading}
              className={`mt-7 flex h-44 w-full max-w-[420px] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-black/20 bg-white/70 text-center transition-colors ${
                busy ? "pointer-events-none" : "cursor-pointer hover:border-black/40 hover:bg-white"
              }`}
            >
              {busy ? (
                <>
                  <span
                    className="h-9 w-9 animate-spin rounded-full border-[3px] border-black/10 border-t-foreground motion-reduce:animate-none"
                    role="status"
                    aria-label="Uploading"
                  />
                  <span className="text-[14px] font-medium text-foreground">Uploading your photo…</span>
                  <span className="text-[13px] text-muted">This only takes a moment</span>
                </>
              ) : (
                <>
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/[0.05] text-foreground">
                    <Upload className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="text-[14px] font-medium text-foreground">Click to choose a photo</span>
                  <span className="text-[13px] text-muted">JPG, PNG or WebP, up to 5 MB</span>
                </>
              )}
              {picker}
            </label>
          )}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link
              href={nextHref}
              className={`${photoUrl ? BTN_PRIMARY : BTN_SECONDARY} ${busy ? "pointer-events-none opacity-40" : ""}`}
              aria-disabled={busy}
              tabIndex={busy ? -1 : undefined}
            >
              {photoUrl ? (
                <>
                  Continue <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </>
              ) : (
                "Skip for now"
              )}
            </Link>
          </div>
        </div>
      </div>
    </CreatorFrame>
  );
}

function LiveScreen() {
  const [me, setMe] = useState<CreatorMe | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    creatorApi
      .me()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setLoaded(true));
  }, []);
  if (!loaded) return <p className="text-center text-[14px] text-muted">Loading.</p>;
  const needsCountry = !!me && !canPay(me.creator.country_code);
  const mode = me?.setup?.earn_mode ?? null;
  if (me && (mode === "affiliate" || mode === "both")) return <AffiliateLiveScreen me={me} both={mode === "both"} needsCountry={needsCountry} />;
  return <JobsLiveScreen needsCountry={needsCountry} />;
}

function LiveTick() {
  return (
    <div className="flex justify-center">
      <span className="flex h-14 w-14 animate-pop-in items-center justify-center rounded-full bg-emerald-600 text-white motion-reduce:animate-none">
        <Check className="h-6 w-6" aria-hidden="true" />
      </span>
    </div>
  );
}

function CountryCard() {
  return (
    <div className="mt-7 rounded-2xl border border-amber-200 bg-amber-50/80 px-4 py-3">
      <p className="text-[14px] font-semibold text-foreground">One more thing: add your country</p>
      <p className="mt-1 text-[14px] leading-relaxed text-muted">
        Businesses can book you once you add it. Until then you are hidden from Find creators. {PAYOUT_REGIONS_LINE}.
      </p>
    </div>
  );
}

function JobsLiveScreen({ needsCountry }: { needsCountry: boolean }) {
  return (
    <div className="animate-step-in motion-reduce:animate-none">
      <LiveTick />
      <div className="mt-7 text-center">
        <h1 className="text-[30px] font-bold leading-tight tracking-tight text-foreground">You&apos;re live on Zavi</h1>
        <p className="mx-auto mt-3 max-w-[380px] text-[14px] leading-relaxed text-muted">
          Your profile and first package are saved. Bookings, messages and briefs will land in your inbox.
        </p>
      </div>
      {needsCountry ? <CountryCard /> : null}
      <div className="mt-7 grid gap-3 sm:grid-cols-2">
        {needsCountry ? (
          <Link href="/creator" className={`${BTN_PRIMARY} w-full`}>
            Add your country
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        ) : (
          <Link href="/creator" className={`${BTN_PRIMARY} w-full`}>
            Go to your inbox
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        )}
        <Link href="/creator/profile" className={`${BTN_SECONDARY} w-full`}>
          <Pencil className="h-4 w-4" aria-hidden="true" />
          Edit your profile
        </Link>
      </div>
      <p className="mt-6 text-center text-[13px] text-muted">
        We also emailed you a link to your creator area. Set up payouts in{" "}
        <Link href="/creator/earnings" className="font-semibold underline">
          Earnings
        </Link>{" "}
        any time, so you are paid as soon as a business approves your work.
      </p>
    </div>
  );
}

function AffiliateLiveScreen({ me, both, needsCountry }: { me: CreatorMe; both: boolean; needsCountry: boolean }) {
  const affiliateBase = useAffiliateBase();
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasBusiness = useHasBusiness();
  const payoutsSet = !!me.payout_account?.details_submitted;
  const unpayableCountry = !!me.creator.country_code;
  useEffect(() => {
    creatorApi
      .affiliate()
      .then((a) => setCode(a.code))
      .catch((e: unknown) => setError(errText(e, "Your link did not load. Open your affiliate page to see it.")));
  }, []);
  const setUpPayouts = async () => {
    setBusy(true);
    setError(null);
    try {
      window.location.href = (await creatorApi.onboardingLink()).url;
    } catch (e) {
      setError(errText(e, "Stripe did not open. Try again."));
      setBusy(false);
    }
  };
  return (
    <div className="animate-step-in motion-reduce:animate-none">
      <LiveTick />
      <div className="mt-7 text-center">
        <h1 className="text-[30px] font-bold leading-tight tracking-tight text-foreground">
          {both ? "You're live on Zavi" : "Your affiliate link is ready"}
        </h1>
        <p className="mx-auto mt-3 max-w-[460px] text-[14px] leading-relaxed text-muted">
          {both
            ? "Your profile and first package are saved, and your affiliate link is ready to share."
            : "Share it anywhere. When someone you send subscribes to Zavi, you earn commission."}
        </p>
      </div>
      {code ? (
        <AffiliateLinkCard
          link={`${affiliateBase}${code}`}
          Card={Card}
          small={BTN_SMALL}
          className="mt-7"
          onCopyFailed={() => setError("Copy did not work. Select the link and copy it instead.")}
        />
      ) : null}
      <FieldError>{error}</FieldError>
      <div className="mt-4">
        <AffiliateTermsCard Card={Card} />
      </div>
      <Card className="mt-4">
        <ul className="space-y-2">
          <li className="flex flex-wrap items-center gap-3 rounded-xl border border-black/[0.07] bg-white px-4 py-3">
            <CreditCard className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
            <span className="min-w-[200px] flex-1 text-[14px] text-foreground">
              Set up payouts with Stripe
              <span className="block text-[13px] text-muted">
                {payoutsSet
                  ? "Your commissions go to your bank once $20 is ready."
                  : needsCountry && unpayableCountry
                    ? "Payouts for your country are handled by our team."
                    : needsCountry
                    ? "Add your country first. Payouts need it."
                    : "So your commissions can reach your bank. Stripe handles your tax forms."}
              </span>
            </span>
            {payoutsSet ? (
              <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-success">
                <Check className="h-4 w-4" aria-hidden="true" />
                Payouts set up
              </span>
            ) : needsCountry && unpayableCountry ? null : needsCountry ? (
              <Link href={both ? "/creator" : "/creator/affiliate"} className={BTN_SMALL}>
                Add your country
              </Link>
            ) : (
              <button type="button" disabled={busy} onClick={setUpPayouts} className={BTN_SMALL}>
                Set up payouts
              </button>
            )}
          </li>
          <li className="rounded-xl border border-black/[0.07] bg-white px-4 py-3">
            <ProRow small={BTN_SMALL} hasBusiness={hasBusiness} />
          </li>
        </ul>
      </Card>
      {both && needsCountry ? <CountryCard /> : null}
      <div className="mt-7 grid gap-3 sm:grid-cols-2">
        {both && needsCountry ? (
          <Link href="/creator" className={BTN_PRIMARY}>
            <Globe className="h-4 w-4" aria-hidden="true" />
            Add your country
          </Link>
        ) : (
          <Link href="/creator/affiliate" className={BTN_PRIMARY}>
            Go to your affiliate page
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        )}
        <Link href="/creator/profile" className={BTN_SECONDARY}>
          <Pencil className="h-4 w-4" aria-hidden="true" />
          Edit your profile
        </Link>
      </div>
      <p className="mt-6 text-center text-[13px] text-muted">We also emailed you your link and a way back to your creator area.</p>
    </div>
  );
}
