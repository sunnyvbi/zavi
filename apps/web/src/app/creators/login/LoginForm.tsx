"use client";

import Link from "next/link";
import { ArrowRight, Mail } from "lucide-react";
import { Card, CreatorFrame, FIELD, RING } from "@/components/creator/ui";
import { useSearchParams } from "next/navigation";
import { plainNext } from "@/lib/safe-next";
import { useSignedInCreator } from "@/lib/creator/useSignedInCreator";
import { useCreatorLogin } from "./useCreatorLogin";

const PRIMARY = `${RING} inline-flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-foreground px-4 text-[14px] font-medium text-white transition-all duration-200 hover:bg-foreground/90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40`;
const TEXT_BTN = `${RING} inline-flex min-h-11 cursor-pointer items-center rounded-cta text-[14px] font-medium text-muted underline underline-offset-4 hover:text-foreground`;

const WRONG_PASSWORD = "That email and password don't match. Try again, reset your password, or sign in with a code.";
const CODE_EXPIRED = "That code has expired. Codes work for 10 minutes. Send a new code and use the newest one.";

function Label({ children, htmlFor }: { children: string; htmlFor: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-2 block text-[14px] font-medium text-foreground">
      {children}
    </label>
  );
}

export default function LoginForm() {
  const params = useSearchParams();
  const checking = useSignedInCreator(plainNext(params?.get("next")));
  if (checking) {
    return (
      <CreatorFrame>
        <p className="text-center text-[14px] text-muted">Checking your account…</p>
      </CreatorFrame>
    );
  }
  return <SignInForm />;
}

function SignInForm() {
  const { mode, setMode, email, setEmail, password, setPassword, code, setCode,
    err, setErr, other, emailErr, setEmailErr, busy, signIn, sendCode, verifyCode, sendReset, invitee } = useCreatorLogin();
  const heading = mode === "forgot" || mode === "forgot-sent" ? "Reset your password" : "Sign in to your creator area";

  const emailOk = /^\S+@\S+\.\S+$/.test(email.trim());

  return (
    <CreatorFrame
      right={
        <Link href="/creators/apply" className={`${RING} rounded-lg px-2 py-2 text-[14px] font-medium text-muted hover:text-foreground`}>
          New creator? Apply
        </Link>
      }
    >
      <h1 className="text-[26px] font-bold leading-tight tracking-tight text-foreground sm:text-[30px]">{heading}</h1>
      <p className="mt-2.5 text-[14px] leading-relaxed text-muted">Your bookings, briefs, jobs and payouts are here.</p>

      <Card className="mt-8">
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!emailOk && mode !== "forgot-sent") {
              setEmailErr("Enter the email you signed up with.");
              return;
            }
            if (mode === "password") void signIn();
            else if (mode === "code") void sendCode();
            else if (mode === "code-sent") void verifyCode();
            else if (mode === "forgot") void sendReset();
          }}
        >
          <div>
            <Label htmlFor="email">Email</Label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setEmailErr(null);
              }}
              className={`${FIELD} h-12 px-4`}
            />
            {emailErr && (
              <p role="alert" className="mt-2 text-[13px] font-medium text-rose-700">
                {emailErr}
              </p>
            )}
          </div>

          {other && (
            <p role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-[14px] text-rose-800">
              {other}
            </p>
          )}

          {mode === "password" && (
            <>
              <div>
                <Label htmlFor="password">Password</Label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  aria-invalid={err === "password" || undefined}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setErr(null);
                  }}
                  className={`${FIELD} h-12 px-4 ${err === "password" ? "border-rose-300" : ""}`}
                />
                {err === "password" && (
                  <p role="alert" className="mt-2 text-[13px] font-medium text-rose-700">
                    {WRONG_PASSWORD}
                  </p>
                )}
                <button type="button" onClick={() => setMode("forgot")} className={`${TEXT_BTN} mt-1`}>
                  Forgot password
                </button>
              </div>
              <button type="submit" disabled={busy} className={PRIMARY}>
                {busy ? "Signing in…" : "Sign in"}
                {!busy && <ArrowRight className="h-4 w-4" aria-hidden="true" />}
              </button>
              <button type="button" onClick={() => setMode("code")} className={`${TEXT_BTN} justify-center`}>
                Email me a code instead
              </button>
            </>
          )}

          {mode === "code" && (
            <>
              <button type="submit" disabled={busy} className={PRIMARY}>
                {!busy && <Mail className="h-4 w-4" aria-hidden="true" />}
                {busy ? "Sending…" : "Email me a code"}
              </button>
              <button type="button" onClick={() => setMode("password")} className={`${TEXT_BTN} justify-center`}>
                Use my password instead
              </button>
            </>
          )}

          {mode === "code-sent" && (
            <>
              {err === "code" ? (
                <p role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-[14px] text-rose-800">
                  {CODE_EXPIRED}
                </p>
              ) : (
                <p className="rounded-xl bg-emerald-50 px-4 py-3 text-[14px] text-emerald-800">
                  We sent an 8 digit code to {email.trim()}. It works for 10 minutes.
                </p>
              )}
              <div>
                <Label htmlFor="code">Code</Label>
                <input
                  id="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, "").slice(0, 8))}
                  className={`${FIELD} h-12 px-4 tracking-[0.3em]`}
                />
              </div>
              <button type="submit" disabled={busy} className={PRIMARY}>
                {busy ? "Signing in…" : "Sign in"}
                {!busy && <ArrowRight className="h-4 w-4" aria-hidden="true" />}
              </button>
              <div className="flex flex-wrap justify-center gap-x-5">
                <button type="button" disabled={busy} onClick={() => void sendCode()} className={TEXT_BTN}>
                  Send a new code
                </button>
                <button type="button" onClick={() => setMode("password")} className={TEXT_BTN}>
                  Use my password instead
                </button>
              </div>
            </>
          )}

          {mode === "forgot" && (
            <>
              <button type="submit" disabled={busy} className={PRIMARY}>
                {busy ? "Sending…" : "Email me a reset link"}
              </button>
              <button type="button" onClick={() => setMode("password")} className={`${TEXT_BTN} justify-center`}>
                Back to sign in
              </button>
            </>
          )}

          {mode === "forgot-sent" && (
            <>
              <p className="rounded-xl bg-emerald-50 px-4 py-3 text-[14px] text-emerald-800">
                If {email.trim()} has a creator account, a reset link is on its way.
              </p>
              <button type="button" onClick={() => setMode("password")} className={`${TEXT_BTN} justify-center`}>
                Back to sign in
              </button>
            </>
          )}
        </form>
      </Card>

      {invitee && (
        <p className="mt-6 text-center text-[12px] text-muted">
          Signing in with a code creates your creator account. By continuing, you confirm you are 18 or older.
        </p>
      )}
      <p className="mt-6 text-center text-[14px] text-muted">
        New creator?{" "}
        <Link href="/creators/apply" className="font-semibold text-foreground underline underline-offset-4">
          Apply
        </Link>
      </p>
    </CreatorFrame>
  );
}
