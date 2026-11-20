
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Info } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { firstTouchForSignup } from "@/lib/analytics/first-touch";
import { signupAttribution, urlAttribution } from "@/lib/marketing/liveFrom";

type Phase = "form" | "rendering" | "ready" | "emailed" | "error";

const MAX_POLLS = 120;

const VOICEOVER_NOTICE =
  "Your video comes with a music bed. There is no voiceover yet, so everything it says is on screen.";

const JOB_STORAGE_KEY = "zavi.launch-video.job";
const JOB_STORAGE_TTL_MS = 30 * 60 * 1000;

type StoredJob = { id: string; secret: string; at: number };

function rememberJob(job: { id: string; secret: string } | null) {
  try {
    if (!job) window.localStorage.removeItem(JOB_STORAGE_KEY);
    else
      window.localStorage.setItem(
        JOB_STORAGE_KEY,
        JSON.stringify({ ...job, at: Date.now() } satisfies StoredJob),
      );
  } catch {
  }
}

function recallJob(): { id: string; secret: string } | null {
  try {
    const raw = window.localStorage.getItem(JOB_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredJob>;
    if (typeof parsed?.id !== "string" || typeof parsed?.secret !== "string") return null;
    if (typeof parsed.at !== "number" || Date.now() - parsed.at > JOB_STORAGE_TTL_MS) {
      window.localStorage.removeItem(JOB_STORAGE_KEY);
      return null;
    }
    return { id: parsed.id, secret: parsed.secret };
  } catch {
    return null;
  }
}

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      remove: (id: string) => void;
    };
  }
}

export const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export function TurnstileWidget({
  siteKey,
  onToken,
  onUnavailable,
  size,
}: {
  siteKey: string;
  onToken: (t: string | null) => void;
  onUnavailable: () => void;
  size?: "normal" | "compact";
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const cbRef = useRef(onToken);
  cbRef.current = onToken;
  const failRef = useRef(onUnavailable);
  failRef.current = onUnavailable;

  useEffect(() => {
    let widgetId: string | null = null;
    let cancelled = false;

    cbRef.current(null);

    const render = () => {
      if (cancelled || !boxRef.current || !window.turnstile) return;
      widgetId = window.turnstile.render(boxRef.current, {
        sitekey: siteKey,
        ...(size ? { size } : {}),
        callback: (t: string) => cbRef.current(t),
        "expired-callback": () => cbRef.current(null),
        "error-callback": () => cbRef.current(null),
      });
    };

    if (window.turnstile) {
      render();
    } else {
      const SEL = `script[src="${TURNSTILE_SCRIPT}"]`;
      const existing = document.querySelector<HTMLScriptElement & { dataset: DOMStringMap }>(SEL);
      if (existing) {
        if (existing.dataset.failed === "1") failRef.current();
        else {
          let tries = 0;
          const iv = setInterval(() => {
            if (cancelled || window.turnstile) {
              clearInterval(iv);
              render();
            } else if (++tries > 40) {
              clearInterval(iv);
              failRef.current();
            }
          }, 200);
        }
      } else {
        const sc = document.createElement("script");
        sc.src = TURNSTILE_SCRIPT;
        sc.async = true;
        sc.defer = true;
        sc.addEventListener("load", render);
        sc.addEventListener("error", () => {
          sc.dataset.failed = "1";
          failRef.current();
        });
        document.head.appendChild(sc);
      }
    }

    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) {
        try {
          window.turnstile.remove(widgetId);
        } catch {
        }
      }
    };
  }, [siteKey]);

  return <div ref={boxRef} className="mt-2" />;
}

const MAX = {
  product_name: 80,
  company: 120,
  one_liner: 200,
  audience: 160,
  site_url: 300,
  email: 254,
  features: 2000,
  problem: 240,
  metrics: 200,
  regions: 400,
  screen: 600,
} as const;

function withScheme(raw: string): string {
  const v = raw.trim();
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

const DEFAULT_THEME = "swiss";
const DEFAULT_CTA_TEXT = "Learn more";

export function LaunchVideoForm() {
  const [phase, setPhase] = useState<Phase>("form");
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [productName, setProductName] = useState("");
  const [oneLiner, setOneLiner] = useState("");
  const [features, setFeatures] = useState("");
  const [problem, setProblem] = useState("");
  const [metrics, setMetrics] = useState("");
  const [regions, setRegions] = useState("");
  const [screen, setScreen] = useState("");
  const [shortfall, setShortfall] = useState<{ seconds: number; target: number; missing: { field: string; label: string; seconds: number }[] } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [audience, setAudience] = useState("");
  const [company, setCompany] = useState("");
  const theme = DEFAULT_THEME;
  const [ctaText, setCtaText] = useState(DEFAULT_CTA_TEXT);

  const [job, setJob] = useState<{ id: string; secret: string } | null>(null);
  const [captcha, setCaptcha] = useState<{ required: boolean; siteKey: string | null } | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [siteUrl, setSiteUrl] = useState("");
  const [looking, setLooking] = useState(false);
  const [lookupMsg, setLookupMsg] = useState<string | null>(null);
  const [prefilled, setPrefilled] = useState(false);
  const lastFillRef = useRef<Partial<Record<string, string>>>({ cta_text: DEFAULT_CTA_TEXT });
  const [captchaUnavailable, setCaptchaUnavailable] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [magicSent, setMagicSent] = useState(false);
  const [magicSending, setMagicSending] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const genRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/public/launch-video/config", { method: "GET" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { captcha?: { required?: boolean; site_key?: string | null } };
        if (!cancelled)
          setCaptcha({
            required: data?.captcha?.required === true,
            siteKey: data?.captcha?.site_key ?? null,
          });
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const saved = recallJob();
    if (saved) {
      setJob(saved);
      setPhase("rendering");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setErrorMsg(null);
    setShortfall(null);
    setFormError(null);
    try {
      const res = await apiFetch("/api/public/launch-video/generate", {
        method: "POST",
        body: JSON.stringify({
          attribution: signupAttribution(firstTouchForSignup(), urlAttribution(window.location.search)),
          email,
          product_name: productName,
          company,
          one_liner: oneLiner,
          features,
          problem,
          metrics,
          regions,
          screen,
          audience,
          theme,
          cta_text: ctaText,
          cta_url: withScheme(siteUrl),
          captcha_token: captchaToken,
        }),
      });
      if (res.status === 404) {
        setErrorMsg("This is not available yet. Please check back soon.");
        setPhase("error");
        return;
      }
      if (res.status === 429) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        const retryAfter = Number(res.headers.get("Retry-After"));
        const wait =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? ` Try again in ${retryAfter < 90 ? `${retryAfter} seconds` : "a few minutes"}.`
            : "";
        setFormError(`${body?.error?.message ?? "That was a lot of requests at once."}${wait}`);
        setShortfall(null);
        return;
      }
      if (res.status === 400) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string; recoverable?: boolean } } | null;
        if (body?.error?.recoverable) {
          setFormError(body.error.message ?? "Please check the form and try again.");
          setShortfall(null);
          return;
        }
        setErrorMsg(body?.error?.message ?? "Please check the form and try again.");
        setPhase("error");
        return;
      }
      if (res.status === 422) {
        const body = (await res.json().catch(() => null)) as {
          error?: { code?: string; message?: string; seconds?: number; target_seconds?: number; missing?: { field: string; label: string; seconds: number }[] };
        } | null;
        if (body?.error?.code === "insufficient_material") {
          setShortfall({
            seconds: body.error.seconds ?? 0,
            target: body.error.target_seconds ?? 60,
            missing: body.error.missing ?? [],
          });
          setFormError(null);
          return;
        }
        setErrorMsg(body?.error?.message ?? "Please check the form and try again.");
        setPhase("error");
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setErrorMsg(body?.error?.message ?? "Please check the form and try again.");
        setPhase("error");
        return;
      }
      const data = (await res.json()) as { job_id: string; secret: string };
      setJob({ id: data.job_id, secret: data.secret });
      rememberJob({ id: data.job_id, secret: data.secret });
      setPhase("rendering");
    } catch {
      setErrorMsg("Something went wrong. Please try again.");
      setPhase("error");
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (phase !== "rendering" || !job) return;
    stopPolling();
    let polls = 0;
    const poll = async () => {
      if (polls++ >= MAX_POLLS) {
        stopPolling();
        setPhase("emailed");
        return;
      }
      const gen = genRef.current;
      try {
        const res = await apiFetch("/api/public/launch-video/status", {
          method: "POST",
          body: JSON.stringify({ job_id: job.id, secret: job.secret }),
        });
        if (gen !== genRef.current) return;
        if (res.status === 403 || res.status === 400) {
          stopPolling();
          rememberJob(null);
          setJob(null);
          setErrorMsg("That video is no longer available. Please start again.");
          setPhase("error");
          return;
        }
        if (!res.ok) return;
        const data = (await res.json()) as {
          ready: boolean;
          preview_url: string | null;
          status: string;
          error: string | null;
        };
        if (data.status === "failed") {
          stopPolling();
          rememberJob(null);
          setJob(null);
          setErrorMsg("We couldn't finish your video. Please try again.");
          setPhase("error");
          return;
        }
        if (data.ready && data.preview_url) {
          stopPolling();
          setPreviewUrl(data.preview_url);
          setPhase("ready");
        }
      } catch {
      }
    };
    void poll();
    pollRef.current = setInterval(poll, 4000);
    return stopPolling;
  }, [phase, job, stopPolling]);

  const startOver = useCallback(() => {
    genRef.current += 1;
    stopPolling();
    rememberJob(null);
    setMagicSending(false);
    setCaptchaToken(null);
    setJob(null);
    setPreviewUrl(null);
    setErrorMsg(null);
    setMagicSent(false);
    setPhase("form");
  }, [stopPolling]);

  const lookupSite = async () => {
    const url = siteUrl.trim();
    if (!url || looking) return;
    setLooking(true);
    setLookupMsg(null);
    try {
      const res = await apiFetch("/api/public/launch-video/prefill", {
        method: "POST",
        body: JSON.stringify({ url }),
      });
      const body = (await res.json().catch(() => null)) as
        | { fields?: Record<string, string>; error?: { message?: string } }
        | null;
      if (!res.ok || !body?.fields) {
        setLookupMsg(body?.error?.message ?? "We couldn't read that site. Fill the form in by hand.");
        return;
      }
      const f = body.fields;
      const mine = lastFillRef.current;
      const keep = (incoming: string | undefined, key: string) => (cur: string) =>
        incoming && (!cur || cur === mine[key]) ? incoming : cur;
      setProductName(keep(f.product_name, "product_name"));
      setOneLiner(keep(f.one_liner, "one_liner"));
      setFeatures(keep(f.features, "features"));
      setProblem(keep(f.problem, "problem"));
      setMetrics(keep(f.metrics, "metrics"));
      setRegions(keep(f.regions, "regions"));
      setScreen(keep(f.screen, "screen"));
      setAudience(keep(f.audience, "audience"));
      setCtaText(keep(f.cta_text, "cta_text"));
      lastFillRef.current = { ...f };
      setPrefilled(true);
    } catch {
      setLookupMsg("We couldn't read that site. Fill the form in by hand.");
    } finally {
      setLooking(false);
    }
  };

  const sendMagicLink = async () => {
    if (!job || magicSending) return;
    const gen = genRef.current;
    setMagicSending(true);
    try {
      const res = await apiFetch("/api/public/launch-video/send-magic-link", {
        method: "POST",
        body: JSON.stringify({ job_id: job.id, secret: job.secret }),
      });
      if (res.ok && gen === genRef.current) setMagicSent(true);
    } catch {
    } finally {
      if (gen === genRef.current) setMagicSending(false);
    }
  };

  return (
    <>
        {phase === "form" && (
          <form onSubmit={onSubmit} aria-label="Launch video details" className="space-y-5">
            <Field label="Your website" htmlFor="lv-site">
              <div className="mt-2 flex gap-2">
                <input
                  id="lv-site"
                  type="text"
                  inputMode="url"
                  autoComplete="url"
                  required
                  maxLength={MAX.site_url}
                  value={siteUrl}
                  onChange={(e) => {
                    setSiteUrl(e.target.value);
                    if (!e.target.value.trim()) setLookupMsg(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void lookupSite();
                    }
                  }}
                  placeholder="riverbendcycles.com"
                  className={`${INPUT} min-w-0 flex-1`}
                />
                <button
                  type="button"
                  onClick={() => void lookupSite()}
                  disabled={looking || !siteUrl.trim()}
                  className={`${QUIET_BTN} h-12 shrink-0 px-4`}
                >
                  {looking ? "Reading…" : "Read my site"}
                </button>
              </div>
              {lookupMsg && (
                <p className={`mt-2 ${ERROR}`} role="alert">
                  {lookupMsg}
                </p>
              )}
              {prefilled && !lookupMsg && (
                <p className="mt-2 text-[13px] leading-relaxed text-[#167f50]" role="status">
                  Filled in from your site. Everything below is editable. Check it before you
                  generate.
                </p>
              )}
            </Field>
            <Field label="Where should we send it?" htmlFor="lv-email">
              <input
                id="lv-email"
                type="email"
                required
                maxLength={MAX.email}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className={`mt-2 ${INPUT}`}
              />
            </Field>
            <Field label="What are you launching?" htmlFor="lv-product">
              <input
                id="lv-product"
                required
                maxLength={MAX.product_name}
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                placeholder="Riverbend Fit"
                className={`mt-2 ${INPUT}`}
              />
            </Field>
            <Field label="Company" htmlFor="lv-company" optional>
              <input
                id="lv-company"
                maxLength={MAX.company}
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="Riverbend Cycles"
                className={`mt-2 ${INPUT}`}
              />
            </Field>
            <Field label="In one line, what is it?" htmlFor="lv-oneliner">
              <input
                id="lv-oneliner"
                required
                maxLength={MAX.one_liner}
                value={oneLiner}
                onChange={(e) => setOneLiner(e.target.value)}
                placeholder="A ninety minute bike fitting, booked online."
                className={`mt-2 ${INPUT}`}
              />
            </Field>
            <Field label="Who is it for?" htmlFor="lv-audience" optional>
              <input
                id="lv-audience"
                maxLength={MAX.audience}
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                placeholder="Riders buying their first proper road bike."
                className={`mt-2 ${INPUT}`}
              />
            </Field>
            {}
            <Field label="What should it show off?" htmlFor="lv-features">
              <textarea
                id="lv-features"
                required
                value={features}
                onChange={(e) => setFeatures(e.target.value)}
                rows={4}
                maxLength={MAX.features}
                placeholder="Online booking, a proper fitting, and you ride out on your own bike."
                className={`mt-2 ${TEXTAREA}`}
              />
              <p className="mt-2 text-[13px] text-[#595959]">One per line. Around ten, since each one earns a scene.</p>
            </Field>
            <Field label="What is broken today?" htmlFor="lv-problem" optional>
              <textarea
                id="lv-problem"
                value={problem}
                onChange={(e) => setProblem(e.target.value)}
                rows={2}
                maxLength={MAX.problem}
                placeholder="Buying a bike online means guessing your size and hoping."
                className={`mt-2 ${TEXTAREA}`}
              />
            </Field>
            <Field label="Real numbers" htmlFor="lv-metrics" optional>
              <textarea
                id="lv-metrics"
                value={metrics}
                onChange={(e) => setMetrics(e.target.value)}
                rows={2}
                maxLength={MAX.metrics}
                placeholder={"Fittings|2,400\nRiders refitted free|1 in 5"}
                className={`mt-2 ${TEXTAREA}`}
              />
              <p className="mt-2 text-[13px] text-[#595959]">
                Up to 3 lines, each as Label|Value. Only numbers you can stand behind, we never invent one.
              </p>
            </Field>
            <Field label="Where do you operate?" htmlFor="lv-regions" optional>
              <input
                id="lv-regions"
                maxLength={MAX.regions}
                value={regions}
                onChange={(e) => setRegions(e.target.value)}
                placeholder="Bristol, Bath, Exeter"
                className={`mt-2 ${INPUT}`}
              />
              <p className="mt-2 text-[13px] text-[#595959]">Comma separated, two or more. Leave empty to skip that scene.</p>
            </Field>
            {}
            <Field label="What does someone actually do with it?" htmlFor="lv-screen" optional>
              <textarea
                id="lv-screen"
                value={screen}
                onChange={(e) => setScreen(e.target.value)}
                rows={2}
                maxLength={MAX.screen}
                placeholder="Book a slot, get measured, ride out on a bike that fits."
                className={`mt-2 ${TEXTAREA}`}
              />
              <p className="mt-2 text-[13px] text-[#595959]">One sentence. This becomes the shot that shows your product working.</p>
            </Field>
            {formError && (
              <p className="rounded-[18px] border border-[#8c3a1e]/20 bg-[#8c3a1e]/[0.05] px-4 py-3.5 text-[13px] leading-relaxed text-[#0e0f11]" role="alert">
                {formError}
              </p>
            )}
            {shortfall && (
              <div className="rounded-[18px] border border-[#8c3a1e]/20 bg-[#8c3a1e]/[0.05] px-4 py-4" role="status">
                <p className="text-[14px] font-semibold text-[#0e0f11]">
                  There&apos;s enough here for about {Math.round(shortfall.seconds)} seconds. A launch video runs {shortfall.target}.
                </p>
                <p className="mt-1.5 text-[13px] leading-relaxed text-[#595959]">
                  We won&apos;t stretch what you&apos;ve given us to fill the time. Add these and it&apos;s ready:
                </p>
                <ul className="mt-2 list-disc pl-5 text-[13px] leading-relaxed text-[#595959]">
                  {shortfall.missing.map((m) => (
                    <li key={m.field}>
                      {m.label}
                      {m.seconds > 0 && <span className="tabular-nums text-[#8c8c8c]"> +{m.seconds}s</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <VoiceoverNotice />
            {captcha?.required && captcha.siteKey && (
              <TurnstileWidget
                siteKey={captcha.siteKey}
                onToken={setCaptchaToken}
                onUnavailable={() => setCaptchaUnavailable(true)}
              />
            )}
            {captcha?.required && (!captcha.siteKey || captchaUnavailable) && (
              <p className={ERROR} role="alert">
                We can&apos;t load the verification step right now, so submissions are
                paused. Please try again in a few minutes.
              </p>
            )}
            {}
            <button
              type="submit"
              disabled={
                submitting ||
                (captcha?.required === true &&
                  (!captcha.siteKey || captchaUnavailable || !captchaToken))
              }
              className={`${PRIMARY_BTN} w-full`}
            >
              {submitting ? "Starting..." : "Make my launch video"}
              {!submitting && <ArrowRight aria-hidden="true" className="size-4" />}
            </button>
            <p className="text-center text-[13px] text-[#595959]">Free. No account, no card.</p>
          </form>
        )}

        {phase === "rendering" && (
          <div className="py-6 text-center" aria-live="polite">
            <div
              aria-hidden="true"
              className="mx-auto size-10 animate-spin rounded-full border-[3px] border-black/10 border-t-[#0e0f11]"
            />
            <h2 className={`mt-6 ${PANE_TITLE}`}>Making your launch video</h2>
            <p className={`mx-auto mt-3 max-w-[40ch] ${BODY}`}>
              This usually takes a couple of minutes. You can close this tab and come back, and
              we&apos;ll email you when it&apos;s ready.
            </p>
            {}
            <button type="button" onClick={startOver} className={`${QUIET_BTN} mt-6 h-12 px-4`}>
              Start over
            </button>
          </div>
        )}

        {}
        {phase === "emailed" && (
          <div className="py-6 text-center" aria-live="polite">
            <h2 className={PANE_TITLE}>Still rendering</h2>
            <p className={`mx-auto mt-3 max-w-[44ch] ${BODY}`}>
              This one is taking longer than usual. You can close this tab. We&apos;ll email you at{" "}
              <span className="font-semibold text-[#0e0f11]">{email}</span> as soon as your video is
              ready. If nothing arrives in the next few minutes, the render failed and it&apos;s worth
              trying again.
            </p>
            <button type="button" onClick={startOver} className={`${QUIET_BTN} mt-6 h-12 px-4`}>
              Start over
            </button>
          </div>
        )}

        {phase === "ready" && previewUrl && (
          <div className="space-y-5" aria-live="polite">
            <div className="overflow-hidden rounded-[18px] border border-black/[0.07] bg-black">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video src={previewUrl} controls autoPlay muted playsInline className="block w-full" />
            </div>
            <VoiceoverNotice />
            <div>
              <h2 className={PANE_TITLE}>Want the clean, full-quality file?</h2>
              <p className={`mt-2 ${BODY}`}>
                The preview is watermarked and 720p. Sign in and we&apos;ll set up your workspace with the
                clean 1080p file, ready to download. We&apos;ve already emailed you a sign-in link.
              </p>
              {magicSent ? (
                <p className={`mt-4 ${SMALL}`}>
                  Sent. Use the most recent email. An older link stops working once a new one is
                  sent.
                </p>
              ) : (
                <button onClick={sendMagicLink} disabled={magicSending} className={`${PRIMARY_BTN} mt-4 w-full`}>
                  {magicSending ? "Sending..." : "Resend sign-in link"}
                </button>
              )}
              {}
              <button type="button" onClick={startOver} className={`${QUIET_BTN} mt-3 h-12 w-full px-4`}>
                Make another video
              </button>
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className="py-6 text-center">
            <h2 className={PANE_TITLE}>{errorMsg ?? "Something went wrong."}</h2>
            {}
            <button onClick={startOver} className={`${PRIMARY_BTN} mt-6 px-7`}>
              Try again
            </button>
          </div>
        )}
    </>
  );
}

const FOCUS_RING =
  "focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[#0e0f11] focus:shadow-none";
const INPUT = `h-12 w-full rounded-full border border-black/[0.07] bg-white px-4 text-[14px] text-[#0e0f11] placeholder:text-[#595959] ${FOCUS_RING}`;
const TEXTAREA = `w-full rounded-[18px] border border-black/[0.07] bg-white px-4 py-3.5 text-[14px] leading-relaxed text-[#0e0f11] placeholder:text-[#595959] ${FOCUS_RING}`;
const PRIMARY_BTN =
  "inline-flex h-12 items-center justify-center gap-2 rounded-full bg-[#0e0f11] px-6 text-[16px] font-semibold text-white transition-opacity duration-200 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:rounded-full";
const QUIET_BTN =
  "inline-flex items-center justify-center rounded-full border border-black/[0.08] bg-white text-[14px] font-semibold text-[#0e0f11] transition-opacity duration-200 hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:rounded-full";
const SMALL = "text-[13px] leading-relaxed text-[#595959]";
const ERROR = "text-[13px] font-medium leading-relaxed text-[#d92d20]";
const BODY = "text-[14px] leading-relaxed text-[#595959]";
const PANE_TITLE = "text-[20px] font-bold leading-snug tracking-[-0.01em] text-[#0e0f11]";

function VoiceoverNotice() {
  return (
    <p
      role="note"
      data-testid="launch-video-voiceover-notice"
      className="flex items-start gap-2 rounded-2xl bg-white px-4 py-3 text-[13px] leading-relaxed text-[#595959]"
    >
      <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{VOICEOVER_NOTICE}</span>
    </p>
  );
}

function Field(props: { label: string; htmlFor: string; optional?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={props.htmlFor} className="block text-[14px] font-medium text-[#0e0f11]">
        {props.label}
        {}
        {props.optional && <span className="ml-1.5 font-normal text-[#8c8c8c]">{" "}optional</span>}
      </label>
      {props.children}
    </div>
  );
}
