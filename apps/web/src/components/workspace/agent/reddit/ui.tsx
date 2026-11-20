"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronDown, Lightbulb, type LucideIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";

const GOOD = "bg-[#eaf6ec] text-[#2e7d32]";
const WARN = "bg-[#fdfaf0] text-[#9a7b1a]";
const BAD = "bg-[#fdf2f1] text-[#c0392b]";
const NEUTRAL = "bg-bone text-inkMuted";

export type Tone = "good" | "warn" | "bad" | "neutral" | "orange";

const TONE: Record<Tone, string> = {
  good: GOOD,
  warn: WARN,
  bad: BAD,
  neutral: NEUTRAL,
  orange: "bg-bone text-ink",
};

export const ERROR_CLEAR_MS = 2000;

export function useTransientError(ms = ERROR_CLEAR_MS) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => setError(null), ms);
    return () => clearTimeout(id);
  }, [error, ms]);
  return [error, setError] as const;
}

export function normSub(name: string | null | undefined): string {
  return (name ?? "").trim().replace(/^\/?r\//i, "").replace(/\/+$/, "").toLowerCase();
}

export function subLabel(name: string): string {
  return `r/${name.trim().replace(/^\/?r\//i, "")}`;
}

export function compactNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  const fmt = (v: number, suffix: string) => `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}${suffix}`;
  if (abs >= 1_000_000) return fmt(n / 1_000_000, "M");
  if (abs >= 1_000) return fmt(n / 1_000, "K");
  return String(Math.round(n));
}

export function agoShort(iso: string | null | undefined): string {
  if (!iso) return "-";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "-";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function deltaPct(value: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined || previous === 0) return null;
  return Math.round(((value - previous) / previous) * 100);
}

export function Delta({ value, previous }: { value: number; previous: number | null | undefined }) {
  const pct = deltaPct(value, previous);
  if (pct === null) return null;
  const up = pct > 0;
  const flat = pct === 0;
  const quiet = flat || value === 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[16px] font-medium tabular-nums ${
        quiet ? "text-inkMuted" : up ? "text-[#2e7d32]" : "text-[#c0392b]"
      }`}
      title={`Previous: ${previous}`}
    >
      <span aria-hidden>{flat ? "→" : up ? "↑" : "↓"}</span>
      <span className="sr-only">{flat ? "No change" : up ? "Up" : "Down"}</span>
      {Math.abs(pct)}%
    </span>
  );
}

export function TonePill({ tone, children, className = "" }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[13px] font-semibold ${TONE[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function ScorePill({ label, value, threshold }: { label?: string; value: number; threshold: number }) {
  return (
    <TonePill tone={value >= threshold ? "good" : "neutral"}>
      {label ? `${label} ` : ""}
      {Math.round(value)}/100
    </TonePill>
  );
}

export function relevanceLevel(value: number): "High" | "Medium" | "Low" {
  if (value >= 75) return "High";
  if (value >= 50) return "Medium";
  return "Low";
}

export function RelevanceBar({ value }: { value: number | null }) {
  if (value === null) return <span className="text-[16px] text-inkMuted">-</span>;
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-bone sm:w-24"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={v}
        aria-label="Relevance"
      >
        <div className="h-full rounded-full bg-[#2e7d32]" style={{ width: `${v}%` }} />
      </div>
      <span className="text-[16px] font-semibold tabular-nums text-ink">{v}</span>
      <span className="text-[16px] text-inkMuted">{relevanceLevel(v)}</span>
    </div>
  );
}

export function SectionCard({
  title,
  sub,
  headingId,
  children,
}: {
  title: string;
  sub?: ReactNode;
  headingId?: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="rounded-2xl border border-rule bg-cream p-4">
      <h3 id={headingId} className="text-[16px] font-semibold tracking-tight text-ink">
        {title}
      </h3>
      {sub && <p className="mt-0.5 text-[16px] text-inkMuted">{sub}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function KeywordChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md bg-bone px-1.5 py-0.5 text-[13px] font-medium text-inkSoft">
      {children}
    </span>
  );
}

export function LoadError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-2xl border border-rule bg-cream px-4 py-6 text-center text-[16px] text-ink">
      Couldn&apos;t load {what}.{" "}
      <button type="button" onClick={onRetry} className="font-semibold underline underline-offset-2">
        Retry
      </button>
    </div>
  );
}

export async function startSweep(trigger: "manual"): Promise<string | null> {
  try {
    const res = await apiFetch("/api/reddit/sweep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trigger }),
    });
    if (res.ok) return null;
    if (res.status === 409) return "A scan is already running.";
    if (res.status === 429 || res.status === 403) {
      const body = await res
        .json()
        .then((b: { reason?: unknown; message?: unknown; error?: unknown }) => b)
        .catch(() => undefined);
      const errObj = body?.error && typeof body.error === "object" ? (body.error as { code?: unknown; message?: unknown }) : null;
      const reason =
        typeof body?.reason === "string"
          ? body.reason
          : typeof body?.error === "string"
            ? body.error
            : typeof errObj?.code === "string"
              ? errObj.code
              : undefined;
      const message =
        typeof body?.message === "string" && body.message
          ? body.message
          : typeof errObj?.message === "string" && errObj.message
            ? errObj.message
            : undefined;
      if (message) return message;
      if (res.status === 403) {
        return reason === "plan_upgrade_required"
          ? "Reddit needs the Starter plan ($20/mo)."
          : "Only an owner or an admin can change this.";
      }
      if (reason === "rate_limited") return "A scan ran a few minutes ago. Try again in a few minutes.";
      if (reason === "tenant_cap_reached") return "This week's scan budget is used up. Scans resume as the 7-day window rolls.";
      if (reason === "fleet_cap_reached") return "Zavi has hit today's Reddit scan limit across all workspaces. Try again tomorrow.";
      return "A scan ran a few minutes ago, or this week's scan budget is used up.";
    }
    if (res.status === 422) {
      const reason = await res
        .json()
        .then((b: { reason?: string }) => b?.reason)
        .catch(() => undefined);
      if (reason === "disabled") return "Reddit scanning is turned off.";
      if (reason === "not_configured") return "Reddit scanning isn't set up yet.";
      return "Track a keyword, a competitor or a subreddit first, then scan.";
    }
    return "Couldn't start the scan. Try again in a moment.";
  } catch {
    return "Couldn't reach Zavi. Check your connection.";
  }
}

export type AttentionTone = "auto" | "approval" | "blocker" | "done";

const CHIP_TONE: Record<AttentionTone, string> = {
  auto: "text-inkMuted",
  approval: "text-inkMuted",
  blocker: "text-[#c0392b]",
  done: "text-emerald-600",
};

export function AttentionList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul aria-label={label} className="divide-y divide-rule overflow-hidden rounded-2xl border border-rule bg-cream">
      {children}
    </ul>
  );
}

export function AttentionRow({
  icon: Icon,
  title,
  detail,
  chip,
  tone = "auto",
  action,
  checkbox,
  children,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  detail?: ReactNode;
  chip?: ReactNode;
  tone?: AttentionTone;
  action?: ReactNode;
  checkbox?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="px-4 py-3.5">
      <div className="flex items-start gap-3">
        {checkbox && <div className="mt-0.5 shrink-0">{checkbox}</div>}
        {Icon && <Icon className="mt-0.5 h-[18px] w-[18px] shrink-0 text-inkMuted" aria-hidden />}
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold leading-5 text-ink">{title}</p>
          {detail && <div className="mt-0.5 text-[16px] leading-relaxed text-inkMuted">{detail}</div>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {chip && <span className={`whitespace-nowrap text-[16px] ${CHIP_TONE[tone]}`}>{chip}</span>}
          {action}
        </div>
      </div>
      {children}
    </li>
  );
}

export function WhyThisWorks({ label = "Why this works", children }: { label?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-rule">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] font-semibold uppercase tracking-wide text-inkMuted hover:bg-creamDeep"
      >
        <Lightbulb className="h-3.5 w-3.5 text-marigoldDeep" aria-hidden />
        <span className="flex-1">{label}</span>
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && (
        <div id={id} className="space-y-4 border-t border-rule bg-creamDeep px-4 pb-4 pt-3.5">
          {children}
        </div>
      )}
    </div>
  );
}

export function WhySection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="max-w-[72ch]">
      {title && <h4 className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-inkMuted">{title}</h4>}
      {children}
    </section>
  );
}

export function WhyRationale({ text }: { text: string }) {
  const parts = text
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z][A-Za-z ]{1,28}:\s)/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <div className="space-y-2 text-[16px] leading-6 text-ink">
      {parts.map((p, i) => {
        const m = /^([A-Z][A-Za-z ]{1,28}):\s+([\s\S]*)$/.exec(p);
        return (
          <p key={i}>
            {m ? (
              <>
                <span className="font-semibold">{m[1]}:</span> {m[2]}
              </>
            ) : (
              p
            )}
          </p>
        );
      })}
    </div>
  );
}

export function WhyList({ items, tone = "body" }: { items: string[]; tone?: "body" | "muted" }) {
  return (
    <ul
      className={`list-disc space-y-1.5 pl-5 marker:text-inkMuted ${
        tone === "muted" ? "text-[13px] leading-5 text-inkMuted" : "text-[16px] leading-6 text-ink"
      }`}
    >
      {items.map((t) => (
        <li key={t} className="pl-0.5">
          {t}
        </li>
      ))}
    </ul>
  );
}

export function scrollToInPanel(el: HTMLElement, block: "start" | "center" = "start", gap = 16): boolean {
  let box = el.parentElement;
  while (box) {
    const y = getComputedStyle(box).overflowY;
    if ((y === "auto" || y === "scroll") && box.scrollHeight > box.clientHeight) break;
    box = box.parentElement;
  }
  if (!box) return false;
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const offset = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
  const top =
    block === "center"
      ? box.scrollTop + offset - (box.clientHeight - el.offsetHeight) / 2
      : box.scrollTop + offset - gap;
  if (typeof box.scrollTo === "function") box.scrollTo({ top: Math.max(0, top), behavior: still ? "auto" : "smooth" });
  else box.scrollTop = Math.max(0, top);
  return true;
}
