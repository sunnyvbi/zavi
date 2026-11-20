"use client";

import { useState } from "react";
import { reportStartCard, StartCardApiError } from "@/lib/start-card/api";
import { StartCardCaptcha, captchaReady } from "./Captcha";
import { useStartCardCaptcha } from "./useTurnstileConfig";

type Outcome = "verify_sent" | "received";

export function ReportRemoveForm({ publicId, domain }: { publicId: string; domain: string }) {
  const cfg = useStartCardCaptcha();
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [attempt, setAttempt] = useState(0);

  if (outcome) {
    return (
      <div role="status" className="mt-4 rounded-xl bg-[#f6f7f9] p-4 text-[14px]">
        {outcome === "verify_sent" ? (
          <>
            <p className="font-semibold">Check your inbox</p>
            <p className="mt-1 text-inkMuted">
              We sent a link to {email}. Click it and this result is removed straight away. The link works once.
            </p>
          </>
        ) : (
          <>
            <p className="font-semibold">Thanks, we got it</p>
            <p className="mt-1 text-inkMuted">
              We review every report within 24 hours. To remove this result yourself, use an email address at {domain}.
            </p>
          </>
        )}
      </div>
    );
  }

  const valid = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email.trim()) && reason.trim().length >= 3;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || busy || !captchaReady(cfg, token)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await reportStartCard({
        public_id: publicId,
        email: email.trim(),
        reason: reason.trim(),
        turnstile_token: token,
      });
      setOutcome(res.state);
    } catch (err) {
      setError(err instanceof StartCardApiError ? err.message : "Something went wrong. Please try again.");
      setToken(null);
      setAttempt((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 flex flex-col gap-3 rounded-xl bg-[#f6f7f9] p-4 text-[14px]">
      <p className="text-[14px] text-inkMuted">
        Is this your business? Use an email address at <b className="font-semibold text-ink">{domain}</b> and we&apos;ll
        send a one-click removal link. Anything else goes to our team, who reply within 24 hours.
      </p>
      <label className="flex flex-col gap-1">
        <span className="font-medium">Your email</span>
        <input
          type="email"
          required
          maxLength={320}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={`you@${domain}`}
          className="min-h-11 rounded-lg border border-black/10 bg-white px-3 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-medium">What&apos;s wrong?</span>
        <textarea
          required
          maxLength={1000}
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Remove this result, or tell us what's wrong."
          className="rounded-lg border border-black/10 bg-white px-3 py-2 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
        />
      </label>
      <StartCardCaptcha key={attempt} cfg={cfg} onToken={setToken} />
      {error && (
        <p role="alert" className="text-[13px] text-rose-700">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={!valid || busy || !captchaReady(cfg, token)}
        className="min-h-11 self-start rounded-cta bg-ink px-4 text-[14px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Sending…" : "Send"}
      </button>
    </form>
  );
}
