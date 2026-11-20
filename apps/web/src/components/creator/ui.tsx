"use client";

import Image from "next/image";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { Check, ExternalLink, Minus, Play, Plus } from "lucide-react";
import { CREATOR_MARKETPLACE_ENABLED } from "@zavi/shared";
import {
  DELIVERY_DAYS,
  DURATIONS,
  ROUNDS_LINE,
  UGC_LENGTHS,
  autoTitle,
  businessTotal,
  creatorGets,
  money,
  packageTerms,
  packageTitle,
  socialLinkText,
  type LanePlatform,
  type PackageSpec,
} from "@/lib/creator/packageSpec";

export const RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground";

export const FIELD =
  "w-full rounded-xl border border-black/[0.08] bg-white text-[14px] text-foreground shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition-[border-color,box-shadow] duration-200 placeholder:text-muted focus:border-foreground/40 focus:shadow-[0_0_0_4px_rgba(9,9,11,0.12)] focus:outline-none";

export const BTN_PRIMARY = `${RING} inline-flex h-12 cursor-pointer items-center justify-center gap-2 rounded-cta bg-foreground px-4 text-[14px] font-medium text-white transition-all hover:bg-foreground/90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40`;

export const BTN_SECONDARY = `${RING} inline-flex h-12 cursor-pointer items-center justify-center gap-2 rounded-cta border border-black/[0.08] bg-white px-4 text-[14px] font-medium text-foreground shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition-all hover:bg-neutral-50 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40`;

export const BTN_SMALL = `${RING} inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-cta border border-black/[0.08] bg-white px-3 text-[13px] font-semibold text-foreground transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40`;

export function CreatorFrame({ right, children, wide }: { right?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-screen bg-[#f5f5f5] p-3 font-sans text-foreground antialiased md:p-4">
      <div className="relative flex min-h-[calc(100vh-1.5rem)] w-full flex-col overflow-hidden rounded-[28px] border border-[#ebebeb] bg-white md:min-h-[calc(100vh-2rem)]">
        {}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background: [
              "radial-gradient(ellipse 70% 85% at 0% 50%, rgba(255,200,155,0.55) 0%, rgba(255,200,155,0.20) 50%, transparent 75%)",
              "radial-gradient(ellipse 65% 85% at 100% 45%, rgba(135,195,245,0.50) 0%, rgba(135,195,245,0.18) 50%, transparent 75%)",
            ].join(", "),
          }}
        />
        <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between px-4 pt-6 sm:px-8">
          <Link href={CREATOR_MARKETPLACE_ENABLED ? "/creators" : "/creators/login"} className={`${RING} flex items-center rounded-lg p-1`}>
            <Image src="/zavi-wordmark.png" alt="Zavi" width={126} height={52} priority className="h-[24px] w-auto" />
            <span className="ml-2.5 rounded-full border border-[#e5e5e5] bg-white px-2 py-0.5 text-[11px] font-semibold text-muted">
              for creators
            </span>
          </Link>
          {right}
        </header>
        <div className={`relative z-[1] mx-auto flex w-full flex-1 items-center justify-center px-4 pb-10 pt-6 sm:px-8 ${wide ? "max-w-5xl" : "max-w-[600px]"}`}>
          <div className="w-full">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-black/[0.07] bg-white/90 p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)] backdrop-blur-sm ${className}`}>
      {children}
    </div>
  );
}

export function FieldError({ children }: { children?: string | null }) {
  if (!children) return null;
  return (
    <p role="alert" className="mt-2 text-[13px] font-medium text-danger">
      {children}
    </p>
  );
}

export function Chip({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`${RING} min-h-11 cursor-pointer rounded-cta border px-4 py-2 text-[14px] font-medium transition-all duration-150 active:scale-[0.97] ${
        selected
          ? "border-foreground bg-foreground/[0.05] text-foreground"
          : "border-black/10 bg-white text-foreground hover:border-black/20 hover:bg-black/[0.02]"
      }`}
    >
      {selected && <Check className="mr-1.5 -ml-0.5 inline h-3.5 w-3.5 align-[-2px]" aria-hidden="true" />}
      {label}
    </button>
  );
}

export function StepSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="animate-pulse motion-reduce:animate-none">
      <div className="h-8 w-48 rounded-lg bg-black/[0.07]" />
      <div className="mt-3 h-4 w-full max-w-[420px] rounded bg-black/[0.05]" />
      <div className="mt-8 space-y-6">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i}>
            <div className="h-4 w-24 rounded bg-black/[0.06]" />
            <div className="mt-2.5 h-12 w-full max-w-[420px] rounded-xl bg-black/[0.05]" />
          </div>
        ))}
      </div>
      <div className="mt-9 h-12 w-28 rounded-xl bg-black/[0.07]" />
    </div>
  );
}

export function BackButton({ href }: { href: string }) {
  return (
    <Link
      href={href}
      aria-label="Back"
      title="Back"
      className={`${RING} mb-3 inline-flex h-8 w-8 lg:absolute lg:-left-12 lg:top-1/2 lg:mb-0 lg:-translate-y-1/2 items-center justify-center rounded-full border border-black/[0.08] bg-white text-foreground shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition-colors hover:bg-neutral-50`}
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
    </Link>
  );
}

export function Spine({
  steps,
  currentIndex,
  hrefFor,
}: {
  steps: readonly { id: string; label: string }[];
  currentIndex: number;
  hrefFor?: (id: string) => string;
}) {
  return (
    <ol className="flex w-full flex-nowrap items-center gap-2 whitespace-nowrap">
      {steps.map((s, i) => {
        const done = i < currentIndex;
        const now = i === currentIndex;
        return (
          <Fragment key={s.id}>
          <li className="flex shrink-0 items-center">
            {(() => {
              const inner = (
                <>
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold ${
                      done ? "bg-foreground text-white" : now ? "border-2 border-foreground bg-white text-foreground" : "border border-black/15 bg-white text-muted"
                    }`}
                  >
                    {done ? <Check className="h-3 w-3" aria-hidden="true" /> : i + 1}
                  </span>
                  <span
                    className={`text-[12px] font-semibold ${now ? "text-foreground" : "sr-only text-muted sm:not-sr-only"}`}
                    aria-current={now ? "step" : undefined}
                  >
                    {s.label}
                  </span>
                </>
              );
              return done && hrefFor ? (
                <Link href={hrefFor(s.id)} className="flex items-center gap-2 rounded-md hover:opacity-70">
                  {inner}
                </Link>
              ) : (
                <span className="flex items-center gap-2">{inner}</span>
              );
            })()}
          </li>
          {i < steps.length - 1 && <li aria-hidden="true" className="h-px min-w-3 flex-1 bg-black/10" />}
          </Fragment>
        );
      })}
    </ol>
  );
}

export function StatusPill({ tone = "neutral", children }: { tone?: "neutral" | "good" | "wait" | "bad" | "dark"; children: ReactNode }) {
  const cls = {
    neutral: "bg-black/[0.05] text-muted",
    good: "bg-successBg text-success",
    wait: "bg-warnBg text-warn",
    bad: "bg-dangerBg text-danger",
    dark: "bg-foreground text-white",
  }[tone];
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-semibold ${cls}`}>{children}</span>;
}

export function H1({ title, blurb }: { title: string; blurb?: string }) {
  return (
    <>
      <h1 className="text-[28px] font-bold leading-tight tracking-tight text-foreground">{title}</h1>
      {blurb && <p className="mt-2 max-w-[620px] text-[14px] leading-relaxed text-muted">{blurb}</p>}
    </>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">{children}</p>;
}

export function EmptySlot({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-black/[0.14] bg-white/60 px-4 py-6 text-center text-[14px] leading-relaxed text-muted">
      {children}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <p className="py-10 text-center text-[14px] text-muted">Loading {what}.</p>;
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-xl bg-dangerBg px-4 py-3 text-[14px] text-danger">
      {message}
    </p>
  );
}

export function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="mt-0.5 text-[14px] font-semibold text-foreground">{value}</dd>
    </div>
  );
}

const MARK: Record<LanePlatform, { bg: string; text: string }> = {
  TikTok: { bg: "bg-[#0e0f11]", text: "Tk" },
  Instagram: { bg: "bg-gradient-to-br from-[#f58529] via-[#dd2a7b] to-[#8134af]", text: "IG" },
  YouTube: { bg: "bg-[#ff0000]", text: "" },
  X: { bg: "bg-[#0e0f11]", text: "X" },
  LinkedIn: { bg: "bg-[#0a66c2]", text: "in" },
};

export function PlatformIcon({ platform }: { platform: LanePlatform }) {
  const m = MARK[platform];
  return (
    <span aria-hidden="true" className={`inline-flex size-5 shrink-0 items-center justify-center rounded-md text-[9px] font-bold leading-none text-white ${m.bg}`}>
      {platform === "YouTube" ? <Play className="h-2.5 w-2.5 fill-white" /> : m.text}
    </span>
  );
}

export function SocialLink({ platform, handle, url, className = "" }: { platform: LanePlatform; handle: string; url: string; className?: string }) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={`inline-flex items-center gap-1 text-[13px] font-medium text-[#027bff] underline-offset-4 hover:underline ${className}`}>
      {socialLinkText(platform, handle)}
      <ExternalLink className="h-3 w-3" aria-hidden="true" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

function BLabel({ children }: { children: ReactNode }) {
  return <span className="mb-2 block text-[14px] font-medium text-foreground">{children}</span>;
}

export function FeeLine({ price }: { price: number }) {
  if (!(price > 0)) return null;
  return (
    <p className="mt-3 rounded-lg bg-black/[0.03] px-3 py-2 text-[13px] text-muted">
      You get <span className="font-semibold text-foreground">{money(creatorGets(price))}</span> after Zavi&apos;s 15%. The business pays{" "}
      {money(businessTotal(price))}.
    </p>
  );
}

export function Stepper({ value, onChange, max = 10 }: { value: number; onChange: (n: number) => void; max?: number }) {
  return (
    <div className="flex h-12 w-[150px] items-center justify-between rounded-xl border border-black/10 bg-white px-2">
      <button type="button" aria-label="Fewer" onClick={() => onChange(Math.max(1, value - 1))} className={`${RING} flex h-10 w-10 cursor-pointer items-center justify-center rounded-cta hover:bg-black/[0.04]`}>
        <Minus className="h-4 w-4" aria-hidden="true" />
      </button>
      <span className="text-[16px] font-semibold text-foreground">{value}</span>
      <button type="button" aria-label="More" onClick={() => onChange(Math.min(max, value + 1))} className={`${RING} flex h-10 w-10 cursor-pointer items-center justify-center rounded-cta hover:bg-black/[0.04]`}>
        <Plus className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export function PackageBuilder({
  value,
  onChange,
  errors = {},
}: {
  value: PackageSpec;
  onChange: (next: PackageSpec) => void;
  errors?: Partial<Record<string, string>>;
}) {
  const set = (patch: Partial<PackageSpec>) => onChange({ ...value, ...patch });
  const price = Number(value.price);
  return (
    <div className="space-y-6">
      <div>
        <BLabel>How many UGC videos</BLabel>
        <Stepper value={value.qty} onChange={(qty) => set({ qty })} />
      </div>
      <div>
        <BLabel>Delivered in</BLabel>
        <div className="flex flex-wrap gap-2">
          {DELIVERY_DAYS.map((d) => (
            <Chip key={d} label={`${d} days`} selected={value.deliveryDays === d} onClick={() => set({ deliveryDays: d })} />
          ))}
        </div>
        <p className="mt-2 text-[13px] text-muted">Due dates are counted from this.</p>
      </div>
      <div>
        <BLabel>Length</BLabel>
        <div className="flex flex-wrap gap-2">
          {UGC_LENGTHS.map((l) => (
            <Chip key={l} label={`${l} seconds`} selected={value.lengthSec === l} onClick={() => set({ lengthSec: l })} />
          ))}
        </div>
      </div>
      <div>
        <BLabel>Ad rights</BLabel>
        <div className="flex flex-wrap gap-2">
          {DURATIONS.map((d) => (
            <Chip key={d} label={d} selected={value.adRights === d} onClick={() => set({ adRights: d })} />
          ))}
        </div>
        <p className="mt-2 text-[13px] text-muted">How long the business can run your video as a paid ad.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
        <label className="block">
          <BLabel>Price</BLabel>
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[14px] text-muted">$</span>
            <input
              inputMode="decimal"
              aria-label="Price"
              value={value.price}
              onChange={(e) => set({ price: e.target.value.replace(/[^0-9.]/g, "") })}
              placeholder="150"
              className={`${FIELD} h-12 pl-8 pr-4`}
            />
          </div>
          <FieldError>{errors.price}</FieldError>
        </label>
        <label className="block">
          <BLabel>Title</BLabel>
          <input value={value.title} onChange={(e) => set({ title: e.target.value })} placeholder={autoTitle(value)} className={`${FIELD} h-12 px-4`} />
        </label>
      </div>
      <FeeLine price={price} />
      <label className="block">
        <BLabel>Description (optional)</BLabel>
        <textarea
          rows={2}
          value={value.description}
          onChange={(e) => set({ description: e.target.value })}
          placeholder="How you film it, what makes it yours."
          className={`${FIELD} resize-none px-4 py-3 leading-relaxed`}
        />
      </label>
      </section>
      <section>
        <PackagePreview spec={value} />
      </section>
    </div>
  );
}

export function PackagePreview({ spec }: { spec: PackageSpec }) {
  const price = Number(spec.price);
  return (
    <div className="rounded-xl bg-black/[0.03] px-4 py-3.5">
      <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Businesses will see</p>
      <p className="mt-1 text-[14px] font-semibold text-foreground">
        {packageTitle(spec)} · {price > 0 ? money(price) : "$0"}
      </p>
      {spec.description.trim() ? <p className="mt-0.5 text-[13px] text-foreground">{spec.description.trim()}</p> : null}
      <p className="mt-0.5 text-[13px] text-muted">{packageTerms(spec)}</p>
      <p className="mt-2 inline-flex rounded-full bg-black/[0.05] px-2.5 py-1 text-[12px] font-semibold text-foreground">{ROUNDS_LINE}</p>
    </div>
  );
}
