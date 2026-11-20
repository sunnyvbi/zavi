"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  Globe,
  Layers,
  Loader2,
  Mail,
  MapPin,
  Monitor,
  MousePointerClick,
  Package,
  Pencil,
  Plus,
  Quote,
  Sparkles,
  Target,
  TrendingUp,
  Users,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { firstTouchForSignup } from "@/lib/analytics/first-touch";
import { signupAttribution, urlAttribution } from "@/lib/marketing/liveFrom";
import { faviconUrlFromDomain } from "@/lib/favicon";
import { TurnstileWidget } from "./LaunchVideoForm";

type Step = "site" | "confirm" | "audience" | "extras" | "material" | "ready";
type Option = { label: string; value: string };
type Prefill = Record<string, string>;
type Draft = Record<string, unknown> & { prefill?: Prefill | null; brief?: string; site_url?: string };

type Turn = {
  step: Step;
  message: string;
  options: Option[];
  allowFreeText: boolean;
  draft: Draft;
};

const BTN =
  "inline-flex h-12 cursor-pointer items-center justify-center gap-2 rounded-cta px-4 text-[14px] font-medium transition-all duration-200 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40";
const PRIMARY = `${BTN} bg-[#09090b] text-white hover:bg-[#09090b]/90`;
const INPUT =
  "h-12 w-full rounded-xl border border-black/[0.08] bg-white px-4 text-[14px] text-[#09090b] shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition-[border-color,box-shadow] duration-200 placeholder:text-[#71717a] focus:border-[#09090b]/40 focus:shadow-[0_0_0_4px_rgba(9,9,11,0.12)] focus:outline-none";
const AREA =
  "w-full resize-none rounded-xl border border-black/[0.08] bg-white px-3.5 py-2.5 text-[14px] leading-relaxed text-[#09090b] shadow-[0_1px_2px_rgba(16,24,40,0.04)] placeholder:text-[#a1a1aa] focus:border-[#09090b]/40 focus:shadow-[0_0_0_4px_rgba(9,9,11,0.12)] focus:outline-none";
const EYEBROW = "text-[12px] font-semibold uppercase tracking-[0.08em] text-[#71717a]";

const FIELDS: Array<{
  key: string;
  label: string;
  icon: typeof Globe;
  max: number;
  rows: number;
  hint?: string;
  wide?: boolean;
}> = [
  { key: "brief", label: "What you are launching", icon: Sparkles, max: 4000, rows: 4, wide: true },
  { key: "product_name", label: "Product", icon: Package, max: 80, rows: 1 },
  { key: "cta_text", label: "Button text", icon: MousePointerClick, max: 40, rows: 1 },
  { key: "one_liner", label: "One-liner", icon: Quote, max: 160, rows: 2, wide: true },
  { key: "audience", label: "Who it is for", icon: Users, max: 120, rows: 2 },
  { key: "problem", label: "What is broken today", icon: Target, max: 240, rows: 3 },
  { key: "features", label: "What it should show off", icon: Layers, max: 2000, rows: 4, hint: "One per line", wide: true },
  { key: "screen", label: "The main screen", icon: Monitor, max: 600, rows: 3 },
  { key: "metrics", label: "Real numbers", icon: TrendingUp, max: 200, rows: 3, hint: "Label|Value, one per line" },
  { key: "regions", label: "Where you operate", icon: MapPin, max: 400, rows: 2, hint: "Two or more, comma separated", wide: true },
];

const READ_STEPS = [
  "Opening your site",
  "Reading what you sell",
  "Working out who it is for",
  "Looking for real numbers",
  "Picking what the film should show",
];

function hostOf(url: string): string {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function fieldValue(draft: Draft, key: string): string {
  if (key === "brief") return (draft.brief as string) ?? "";
  return draft.prefill?.[key] ?? "";
}

function FieldDisplay({ k, value }: { k: string; value: string }) {
  if (k === "features") {
    const lines = value.split("\n").map((l) => l.trim()).filter(Boolean);
    return (
      <ul className="space-y-1">
        {lines.map((l, i) => (
          <li key={i} className="flex gap-2 text-[14px] leading-snug text-[#09090b]">
            <Check aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#167f50]" />
            {l}
          </li>
        ))}
      </ul>
    );
  }
  if (k === "metrics") {
    const lines = value.split("\n").map((l) => l.split("|").map((s) => s.trim())).filter((p) => p[0]);
    return (
      <div className="flex flex-wrap gap-4">
        {lines.map(([label, v], i) => (
          <div key={i}>
            <p className="text-[20px] font-bold leading-none tracking-tight text-[#09090b]">{v || "?"}</p>
            <p className="mt-1 text-[12px] text-[#71717a]">{label}</p>
          </div>
        ))}
      </div>
    );
  }
  if (k === "regions") {
    return (
      <div className="flex flex-wrap gap-2">
        {value.split(",").map((r) => r.trim()).filter(Boolean).map((r) => (
          <span key={r} className="rounded-full bg-black/[0.04] px-2.5 py-1 text-[13px] text-[#09090b]">
            {r}
          </span>
        ))}
      </div>
    );
  }
  return <p className="whitespace-pre-line text-[14px] leading-relaxed text-[#09090b]">{value}</p>;
}

function FoundCard({
  field,
  value,
  index,
  onSave,
}: {
  field: (typeof FIELDS)[number];
  value: string;
  index: number;
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const Icon = field.icon;
  const empty = !value.trim();

  const save = () => {
    onSave(text.trim().slice(0, field.max));
    setEditing(false);
  };

  return (
    <div
      className={`rise group rounded-2xl border p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)] backdrop-blur transition-colors duration-200 ${
        field.wide ? "sm:col-span-2" : ""
      } ${empty && !editing ? "border-dashed border-black/[0.12] bg-white/60" : "border-black/[0.08] bg-white/95"}`}
      style={{ animationDelay: `${index * 90}ms` }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`${EYEBROW} inline-flex items-center gap-2`}>
          <Icon aria-hidden="true" className="h-3.5 w-3.5" />
          {field.label}
        </span>
        {!editing && !empty ? (
          <button
            type="button"
            onClick={() => {
              setText(value);
              setEditing(true);
            }}
            className="inline-flex cursor-pointer items-center gap-1 rounded-cta px-1.5 py-0.5 text-[12px] font-medium text-[#71717a] opacity-70 transition-opacity hover:bg-black/[0.04] hover:text-[#09090b] group-hover:opacity-100"
          >
            <Pencil aria-hidden="true" className="h-3 w-3" /> Edit
          </button>
        ) : null}
      </div>

      <div className="mt-2.5">
        {editing ? (
          <div className="space-y-2">
            <textarea
              autoFocus
              rows={field.rows}
              value={text}
              maxLength={field.max}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
                if (e.key === "Escape") setEditing(false);
              }}
              placeholder={field.hint}
              aria-label={field.label}
              className={AREA}
            />
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-[#a1a1aa]">{field.hint ?? ""}</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="cursor-pointer rounded-cta px-3 py-1.5 text-[13px] font-medium text-[#71717a] hover:bg-black/[0.04]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={save}
                  className="cursor-pointer rounded-cta bg-[#09090b] px-3 py-1.5 text-[13px] font-medium text-white hover:bg-[#09090b]/90"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        ) : empty ? (
          <button
            type="button"
            onClick={() => {
              setText("");
              setEditing(true);
            }}
            className="inline-flex cursor-pointer items-center gap-2 text-[14px] text-[#71717a] hover:text-[#09090b]"
          >
            <Plus aria-hidden="true" className="h-4 w-4" /> Not on your site. Add it
          </button>
        ) : (
          <FieldDisplay k={field.key} value={value} />
        )}
      </div>
    </div>
  );
}

function ReadingSteps({ host, done }: { host: string; done: boolean }) {
  const [at, setAt] = useState(0);
  useEffect(() => {
    if (done) {
      setAt(READ_STEPS.length);
      return;
    }
    const id = setInterval(() => setAt((a) => Math.min(a + 1, READ_STEPS.length - 1)), 1600);
    return () => clearInterval(id);
  }, [done]);
  const icon = faviconUrlFromDomain(host);
  const [iconFailed, setIconFailed] = useState(false);
  return (
    <div className="py-2">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center overflow-hidden rounded-xl border border-black/[0.08] bg-white">
          {icon && !iconFailed ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={icon} alt="" className="h-5 w-5" onError={() => setIconFailed(true)} />
          ) : (
            <Globe aria-hidden="true" className="h-5 w-5 text-[#71717a]" />
          )}
        </span>
        <div>
          <p className="text-[16px] font-semibold tracking-tight text-[#09090b]">Reading {host}</p>
          <p className="text-[13px] text-[#71717a]">This takes about ten seconds.</p>
        </div>
      </div>
      <ol className="mt-6 space-y-3" aria-live="polite">
        {READ_STEPS.map((label, i) => {
          const state = i < at ? "done" : i === at ? "now" : "later";
          return (
            <li key={label} className="flex items-center gap-3">
              <span
                className={`grid h-6 w-6 place-items-center rounded-full transition-colors duration-300 ${
                  state === "done"
                    ? "bg-[#09090b] text-white"
                    : state === "now"
                      ? "bg-white shadow-[0_0_0_1px_rgba(9,9,11,0.12)]"
                      : "bg-black/[0.04]"
                }`}
              >
                {state === "done" ? (
                  <Check aria-hidden="true" className="h-3.5 w-3.5" />
                ) : state === "now" ? (
                  <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin text-[#09090b]" />
                ) : null}
              </span>
              <span
                className={`text-[14px] transition-colors duration-300 ${
                  state === "later" ? "text-[#a1a1aa]" : "text-[#09090b]"
                } ${state === "now" ? "font-medium" : ""}`}
              >
                {label}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ZaviSays({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-3">
      <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#09090b]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/zavi-mark.svg" alt="" className="h-5 w-5" />
      </span>
      <p className="whitespace-pre-line pt-1.5 text-[20px] font-semibold leading-snug tracking-tight text-[#09090b]">{text}</p>
    </div>
  );
}

export function LaunchVideoChat({ onUseForm }: { onUseForm: () => void }) {
  const [turn, setTurn] = useState<Turn>({
    step: "site",
    message: "",
    options: [],
    allowFreeText: true,
    draft: {},
  });
  const [stage, setStage] = useState<"site" | "reading" | "found" | "ask">("site");
  const [readDone, setReadDone] = useState(false);
  const [site, setSite] = useState("");
  const [text, setText] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canReview, setCanReview] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [captcha, setCaptcha] = useState<{ required: boolean; siteKey: string | null } | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaBroken, setCaptchaBroken] = useState(false);
  const [captchaNonce, setCaptchaNonce] = useState(0);
  const topRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/public/launch-video/config", { method: "GET" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { captcha?: { required?: boolean; site_key?: string | null } };
        if (!cancelled)
          setCaptcha({ required: data?.captcha?.required === true, siteKey: data?.captcha?.site_key ?? null });
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const keepInView = () =>
    requestAnimationFrame(() => {
      if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: "smooth" });
    });

  const send = useCallback(
    async (payload: { choice?: string; input?: string; missing?: string[]; step?: Step }, from?: Turn) => {
      const base = from ?? turn;
      setError(null);
      setBusy(true);
      try {
        const r = await apiFetch("/api/public/launch-video/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ step: base.step, draft: base.draft, ...payload }),
        });
        const body = (await r.json()) as Turn & { error?: { message?: string } };
        if (!r.ok || body.error) {
          setError(body.error?.message ?? "Something went wrong. Please try again.");
          return null;
        }
        setTurn(body);
        setText("");
        return body;
      } catch {
        setError("Something went wrong. Please try again.");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [turn],
  );

  const readSite = async () => {
    const url = site.trim();
    if (!url) return;
    setStage("reading");
    setReadDone(false);
    const next = await send({ input: url }, { ...turn, step: "site", draft: {} });
    if (!next) {
      setStage("site");
      return;
    }
    if (next.step === "site") {
      setError(next.message);
      setStage("site");
      return;
    }
    setReadDone(true);
    setTimeout(() => {
      setStage(next.draft.prefill ? "found" : "ask");
      keepInView();
    }, 600);
  };

  const editField = (key: string, value: string) => {
    setTurn((t) => {
      if (key === "brief") return { ...t, draft: { ...t.draft, brief: value } };
      return { ...t, draft: { ...t.draft, prefill: { ...(t.draft.prefill ?? {}), [key]: value } } };
    });
  };

  const confirmFound = async () => {
    if (turn.step !== "confirm") {
      setStage("ask");
      keepInView();
      return;
    }
    const next = await send({ choice: "yes" });
    if (next) {
      setStage("ask");
      keepInView();
    }
  };

  const answer = async (payload: { choice?: string; input?: string }) => {
    const next = await send(payload);
    if (next) keepInView();
  };

  const generate = useCallback(async () => {
    setError(null);
    setCanReview(false);
    setBusy(true);
    const pf = (turn.draft.prefill ?? {}) as Record<string, string>;
    try {
      const r = await apiFetch("/api/public/launch-video/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attribution: signupAttribution(firstTouchForSignup(), urlAttribution(window.location.search)),
          email,
          company: pf.product_name ?? "",
          product_name: pf.product_name ?? "",
          one_liner: pf.one_liner ?? "",
          features: pf.features ?? "",
          audience: pf.audience ?? "",
          problem: pf.problem ?? "",
          metrics: pf.metrics ?? "",
          regions: pf.regions ?? "",
          screen: pf.screen ?? "",
          cta_text: pf.cta_text || "Get started",
          cta_url: (turn.draft.site_url as string) ?? "",
          tone: "confident",
          theme: "swiss",
          brief: (turn.draft.brief as string) ?? "",
          grammar: (turn.draft.grammar as string) ?? "",
          ...(captchaToken ? { captcha_token: captchaToken } : {}),
        }),
      });
      const body = (await r.json()) as {
        job_id?: string;
        error?: { code?: string; message?: string; missing?: Array<{ field: string }> };
      };
      if (body.error?.code === "insufficient_material") {
        const missing = (body.error.missing ?? []).map((m) => m.field);
        setBusy(false);
        await send({ step: "material", missing }, { ...turn, step: "material" });
        return;
      }
      if (!r.ok || body.error || !body.job_id) {
        if (captcha?.required) {
          setCaptchaToken(null);
          setCaptchaNonce((n) => n + 1);
        }
        setError(body.error?.message ?? "Something went wrong. Please try again.");
        const code = body.error?.code ?? "";
        const fixable =
          code === "author_failed" ||
          code === "brief_invalid" ||
          ((body.error as { recoverable?: boolean } | undefined)?.recoverable === true && !code.startsWith("email_") && code !== "invalid_email");
        setCanReview(!!turn.draft.prefill && fixable);
        return;
      }
      setJobId(body.job_id);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }, [turn, email, send, captchaToken, captcha]);

  const errorBox = error ? (
    <div
      role="alert"
      className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[14px] text-rose-800"
    >
      <span>{error}</span>
      {canReview ? (
        <button
          type="button"
          onClick={() => {
            setError(null);
            setCanReview(false);
            setStage("found");
            keepInView();
          }}
          className="shrink-0 cursor-pointer rounded-cta bg-white px-3 py-1.5 text-[13px] font-medium text-[#09090b] shadow-[0_0_0_1px_rgba(9,9,11,0.12)] hover:bg-black/[0.03]"
        >
          Review details
        </button>
      ) : null}
    </div>
  ) : null;

  const formLink = (
    <p className="mt-6 text-center text-[14px] text-[#71717a]">
      Prefer a form?{" "}
      <button
        type="button"
        onClick={onUseForm}
        className="cursor-pointer font-semibold text-[#09090b] underline-offset-4 transition-colors duration-200 hover:underline"
      >
        Fill it in instead
      </button>
    </p>
  );

  if (jobId) {
    return (
      <div className="rise py-10 text-center">
        <span aria-hidden="true" className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[#09090b]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/zavi-mark.svg" alt="" className="h-7 w-7" />
        </span>
        <p className="mt-5 text-[24px] font-bold tracking-tight text-[#09090b]">Making it now.</p>
        <p className="mx-auto mt-3 max-w-[340px] text-[14px] leading-relaxed text-[#71717a]">
          It takes a few minutes. I will email it to <span className="font-medium text-[#09090b]">{email}</span> when
          it is done.
        </p>
      </div>
    );
  }

  if (stage === "site") {
    return (
      <div ref={topRef}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void readSite();
          }}
        >
          <label className="block">
            <span className="mb-2 block text-[14px] font-medium text-[#09090b]">Your website</span>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <span aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#71717a]">
                  <Globe className="h-[18px] w-[18px]" />
                </span>
                <input
                  type="text"
                  inputMode="url"
                  autoComplete="url"
                  value={site}
                  onChange={(e) => setSite(e.target.value)}
                  placeholder="yourcompany.com"
                  maxLength={300}
                  className={`${INPUT} pl-11`}
                />
              </div>
              <button type="submit" disabled={!site.trim() || busy} className={PRIMARY}>
                Read it <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </button>
            </div>
          </label>
          <p className="mt-3 text-[13px] text-[#71717a]">
            Zavi reads your site and pulls out what the film needs. You can change anything after.
          </p>
        </form>
        {errorBox}
        {formLink}
      </div>
    );
  }

  if (stage === "reading") {
    return (
      <div ref={topRef}>
        <ReadingSteps host={hostOf(site)} done={readDone} />
      </div>
    );
  }

  if (stage === "found") {
    const host = hostOf((turn.draft.site_url as string) || site);
    const found = FIELDS.filter((f) => fieldValue(turn.draft, f.key).trim()).length;
    return (
      <div ref={topRef}>
        <div className="rise flex items-start justify-between gap-3">
          <div>
            <p className="text-[22px] font-bold tracking-tight text-[#09090b]">Here is what I found</p>
            <p className="mt-1 text-[14px] text-[#71717a]">
              {found} things on {host}. Click anything to change it.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setStage("site");
              setError(null);
            }}
            className="shrink-0 cursor-pointer rounded-cta px-2 py-1 text-[13px] font-medium text-[#71717a] hover:bg-black/[0.04] hover:text-[#09090b]"
          >
            Change site
          </button>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {FIELDS.map((f, i) => (
            <FoundCard
              key={f.key}
              field={f}
              index={i}
              value={fieldValue(turn.draft, f.key)}
              onSave={(v) => editField(f.key, v)}
            />
          ))}
        </div>
        {errorBox}
        <div className="mt-6 flex flex-col items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void confirmFound()}
            className={`${PRIMARY} w-full sm:w-auto sm:px-8`}
          >
            {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
            Looks right, continue <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  const canSend = text.trim().length > 0 && !busy;
  return (
    <div ref={topRef} key={`${turn.step}:${turn.message}`} className="rise">
      {turn.step === "ready" ? (
        <div>
          <ZaviSays text={turn.message || "Where should I send it?"} />
          <div className="mt-6 space-y-3">
            <div className="relative">
              <span aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#71717a]">
                <Mail className="h-[18px] w-[18px]" />
              </span>
              <input
                type="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                aria-label="Where should we send it?"
                className={`${INPUT} pl-11`}
              />
            </div>
            {captcha?.required && captcha.siteKey && !captchaBroken ? (
              <TurnstileWidget
                key={captchaNonce}
                siteKey={captcha.siteKey}
                onToken={setCaptchaToken}
                onUnavailable={() => setCaptchaBroken(true)}
              />
            ) : null}
            <button
              type="button"
              disabled={busy || !email.includes("@") || (captcha?.required === true && !captchaToken)}
              onClick={() => void generate()}
              className={`${PRIMARY} w-full`}
            >
              {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
              Make my launch video <ArrowRight className="h-4 w-4" aria-hidden />
            </button>
            {captcha?.required && captchaBroken ? (
              <p role="alert" className="text-center text-[13px] text-rose-800">
                The verification widget could not load. Check your connection or an ad blocker, then reload the page.
              </p>
            ) : (
              <p className="text-center text-[12px] leading-relaxed text-[#a1a1aa]">
                By continuing you agree to Zavi&apos;s{" "}
                <a href="/terms" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-[#71717a]">
                  Terms of Service
                </a>{" "}
                and{" "}
                <a href="/privacy" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-[#71717a]">
                  Privacy Policy
                </a>
                .
              </p>
            )}
          </div>
        </div>
      ) : (
        <div>
          <ZaviSays text={turn.message} />
          {turn.options.length > 0 ? (
            <div className={`mt-6 grid gap-3 ${turn.options.length > 1 ? "sm:grid-cols-2" : ""}`}>
              {turn.options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  disabled={busy}
                  onClick={() => void answer({ choice: o.value })}
                  className="flex cursor-pointer items-center justify-between gap-3 rounded-2xl border border-black/[0.08] bg-white px-4 py-4 text-left text-[14px] font-medium text-[#09090b] shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition-all duration-200 hover:border-[#09090b]/30 hover:shadow-[0_6px_18px_-10px_rgba(16,24,40,0.3)] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {o.label}
                  <ArrowRight aria-hidden="true" className="h-4 w-4 text-[#71717a]" />
                </button>
              ))}
            </div>
          ) : null}
          {turn.allowFreeText ? (
            <form
              className="mt-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (canSend) void answer({ input: text });
              }}
            >
              <textarea
                autoFocus={turn.options.length === 0}
                rows={3}
                value={text}
                maxLength={2000}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && canSend) {
                    e.preventDefault();
                    void answer({ input: text });
                  }
                }}
                placeholder={turn.options.length > 0 ? "Or say it in your own words" : "Type your answer"}
                aria-label={turn.message}
                className={AREA}
              />
              <div className="flex justify-end">
                <button type="submit" disabled={!canSend} className={PRIMARY}>
                  {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
                  Continue <ArrowRight aria-hidden="true" className="h-4 w-4" />
                </button>
              </div>
            </form>
          ) : null}
        </div>
      )}
      {errorBox}
      {formLink}
    </div>
  );
}
