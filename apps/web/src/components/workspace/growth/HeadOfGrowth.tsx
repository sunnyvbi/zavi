"use client";

import { useRef, useState, type ReactNode, type RefObject } from "react";
import { Check, ChevronRight, Eye, Hand, Loader, ShieldAlert, Sparkles } from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { GrowthChannel, HeadOfGrowth, NoteSection, NoteSectionRow } from "@/lib/workspace/useGrowthPlan";
import { channelName } from "./GrowthChannels";

const MISTAKE_WINDOW_MS = 30 * 86_400_000;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayLabel(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
const withinWindow = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && t >= Date.now() - MISTAKE_WINDOW_MS;
};
const reducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function celebrate(el: HTMLElement | null) {
  if (!el || reducedMotion() || typeof document === "undefined") return;
  const r = el.getBoundingClientRect();
  const ox = r.left + r.width / 2;
  const oy = r.top + r.height / 2;
  const cols = ["#34c759", "#0e0f11", "#ffffff", "#7ee2a0", "#9a9a9a", "#1f1f1f"];
  for (let i = 0; i < 90; i++) {
    const c = document.createElement("span");
    const w = 5 + Math.random() * 6;
    const h = w * (Math.random() < 0.5 ? 1 : 2.2);
    const col = cols[i % cols.length];
    Object.assign(c.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: `${w}px`,
      height: `${h}px`,
      borderRadius: "2px",
      background: col,
      boxShadow: col === "#ffffff" ? "0 0 0 1px rgba(0,0,0,.12)" : "none",
      pointerEvents: "none",
      zIndex: "60",
    });
    document.body.appendChild(c);
    const ang = ((-90 + (Math.random() * 140 - 70)) * Math.PI) / 180;
    const sp = 380 + Math.random() * 420;
    const dx = Math.cos(ang) * sp;
    const dy = Math.sin(ang) * sp;
    const rot = Math.random() * 720 - 360;
    if (typeof c.animate !== "function") {
      c.remove();
      continue;
    }
    const anim = c.animate(
      [
        { transform: `translate(${ox}px,${oy}px) rotate(0deg)`, opacity: 1 },
        { transform: `translate(${ox + dx * 0.7}px,${oy + dy * 0.7}px) rotate(${rot * 0.6}deg)`, opacity: 1, offset: 0.45 },
        { transform: `translate(${ox + dx}px,${oy + dy + 520}px) rotate(${rot}deg)`, opacity: 0 },
      ],
      { duration: 1300 + Math.random() * 900, easing: "cubic-bezier(.15,.7,.35,1)", fill: "forwards" },
    );
    anim.onfinish = () => c.remove();
  }
  const badge = document.createElement("div");
  badge.setAttribute("role", "status");
  badge.className =
    "pointer-events-none fixed left-1/2 top-[26%] z-[61] flex items-center gap-2.5 rounded-full bg-[#0e0f11] px-[22px] py-3.5 text-[16px] font-bold tracking-[-0.01em] text-white shadow-[0_18px_50px_-12px_rgba(0,0,0,.45)] animate-[apCeleb_2.3s_cubic-bezier(.2,1.2,.3,1)_forwards]";
  const dot = document.createElement("span");
  dot.className = "size-2.5 rounded-full bg-[#34c759] animate-[apPing_1.2s_ease-out_2]";
  badge.appendChild(dot);
  badge.appendChild(document.createTextNode("Welcome to Autopilot"));
  document.body.appendChild(badge);
  setTimeout(() => badge.remove(), 2400);
}

function FlowSwitch({
  on,
  busy,
  disabled = false,
  onFlip,
  trackRef,
}: {
  on: boolean;
  busy: boolean;
  disabled?: boolean;
  onFlip: () => void;
  trackRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={trackRef}
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Autopilot"
      disabled={busy || disabled}
      onClick={onFlip}
      className="relative isolate block h-16 w-full overflow-hidden rounded-full bg-[#eeede8] shadow-[inset_0_2px_6px_rgba(0,0,0,.09),inset_0_-1px_0_#fff] outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-4 disabled:cursor-wait"
    >
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 rounded-full bg-[linear-gradient(90deg,#34c759,#7ee2a0,#34c759,#7ee2a0,#34c759)] bg-[length:300%_100%] shadow-[inset_0_2px_6px_rgba(20,90,45,.28)] transition-[width,opacity] duration-700 ease-[cubic-bezier(.3,1.3,.5,1)] ${
          on ? "w-full opacity-100 motion-safe:animate-[apDrift_7s_linear_.75s_infinite]" : "w-16 opacity-0"
        }`}
      />
      <span
        className={`relative z-[1] flex h-full items-center justify-center text-[14px] font-bold tracking-[-0.01em] transition-colors duration-500 ${
          on ? "text-white" : "text-[#8b857a]"
        }`}
      >
        {on ? "Autopilot on" : "Autopilot off"}
      </span>
      <span
        aria-hidden="true"
        className={`absolute top-1.5 z-[2] grid size-[52px] place-items-center rounded-full bg-[radial-gradient(circle_at_35%_28%,#fff_0_35%,#f1f0ec_100%)] shadow-[0_5px_14px_rgba(0,0,0,.18),0_1px_2px_rgba(0,0,0,.1)] transition-[left] duration-700 ease-[cubic-bezier(.3,1.3,.5,1)] ${
          on ? "left-[calc(100%-58px)]" : "left-1.5"
        }`}
      >
        <ChevronRight
          className={`h-[18px] w-[18px] transition-[transform,color] duration-500 ${on ? "rotate-180 text-[#34c759]" : "text-[#b0aa9f]"}`}
          strokeWidth={2.4}
        />
      </span>
    </button>
  );
}

function Seal({ on }: { on: boolean }) {
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden="true"
      className={`size-9 flex-none drop-shadow-[0_4px_8px_rgba(0,0,0,.2)] transition-transform duration-700 ${on ? "-rotate-[8deg] scale-[1.04]" : ""}`}
    >
      <defs>
        <linearGradient id="hog-seal" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5a5a5a" />
          <stop offset=".55" stopColor="#0e0f11" />
          <stop offset="1" stopColor="#2b2b2b" />
        </linearGradient>
        <linearGradient id="hog-shine" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".5" />
          <stop offset=".6" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        fill="url(#hog-seal)"
        className={on ? "origin-center motion-safe:animate-[apSpin_40s_linear_.6s_infinite]" : ""}
        style={{ transformBox: "fill-box" }}
        d="M32 2l5.2 4.3 6.6-1.3 3 6 6.4 2 .3 6.7 5 4.5-2.4 6.3 2.4 6.3-5 4.5-.3 6.7-6.4 2-3 6-6.6-1.3L32 62l-5.2-4.3-6.6 1.3-3-6-6.4-2-.3-6.7-5-4.5L7.9 33.5 5.5 27.2l5-4.5.3-6.7 6.4-2 3-6 6.6 1.3z"
      />
      <circle cx="32" cy="32" r="19" fill="none" stroke="#fff" strokeOpacity=".7" strokeWidth="1.2" strokeDasharray="1.5 2.6" />
      <path d="M23.5 32.5l5.8 5.8 11.2-12" fill="none" stroke="#fff" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
      <ellipse cx="32" cy="18" rx="20" ry="12" fill="url(#hog-shine)" />
    </svg>
  );
}

function HowItWorks({ label = "How it works" }: { label?: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-block" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <button
        type="button"
        aria-describedby="hog-how"
        aria-expanded={show}
        onFocus={() => setShow(true)}
        onBlur={() => setShow(false)}
        onClick={() => setShow((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setShow(false);
        }}
        className="text-[12px] font-semibold text-ink underline-offset-2 hover:underline"
      >
        {label}
      </button>
      <span
        id="hog-how"
        role="tooltip"
        className={`absolute bottom-[calc(100%+10px)] right-0 z-20 w-max max-w-[260px] rounded-[10px] bg-[#0e0f11] px-3 py-2.5 text-[12px] font-medium leading-[1.5] text-white shadow-[0_10px_24px_-10px_rgba(0,0,0,.45)] transition-[opacity,transform] duration-200 after:absolute after:right-[22px] after:top-full after:border-[6px] after:border-transparent after:border-t-[#0e0f11] after:content-[''] ${
          show ? "visible translate-y-0 opacity-100" : "invisible translate-y-1 opacity-0"
        }`}
      >
        Each change Autopilot makes has a &quot;This was a mistake&quot; button.
        <br />
        Mark it within 30 days and we undo the change and refund the credits it used. Daily or monthly credits that have
        reset since don&apos;t come back.
      </span>
    </span>
  );
}

function Section({ icon, title, tone, children }: { icon: ReactNode; title: string; tone: string; children: ReactNode }) {
  return (
    <div className="mt-4 first:mt-0">
      <p className={`flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.08em] ${tone}`}>
        {icon}
        {title}
      </p>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function Dot({ className = "bg-inkMuted/50" }: { className?: string }) {
  return <span aria-hidden="true" className={`mt-[0.55em] size-[5px] shrink-0 rounded-full ${className}`} />;
}

const SHORT_LINES = 2;
const LONG_LINE = 160;

function Plain({ lines, dot, full = true }: { lines: string[]; dot?: string; full?: boolean }) {
  const shown = full ? lines : lines.slice(0, SHORT_LINES);
  return (
    <ul className="space-y-2">
      {shown.map((l, i) => (
        <li key={i} className="flex gap-2.5 text-[14px] leading-[1.5] text-inkSoft">
          <Dot className={dot} />
          <span className={full ? undefined : "line-clamp-2"}>{l}</span>
        </li>
      ))}
    </ul>
  );
}

export function noteIsLong(sections: string[][]): boolean {
  return sections.some((lines) => lines.length > SHORT_LINES || lines.some((l) => l.length > LONG_LINE));
}

type Claim = { kind: "goal"; goal_id: string } | { kind: "channel"; channel_slug: string };
type ClaimState = "busy" | { said: string };

type ClaimReply = {
  claim_sent?: boolean;
  refund?: { status?: string; credits?: number; forfeited?: number; untracked?: number };
  error?: { message?: string };
};

const RESET_NOTE = "Credits from a daily or monthly allowance that has reset since don't come back.";

export function claimOutcome(r: ClaimReply): string {
  const refund = r.refund;
  const checking =
    r.claim_sent === false
      ? "We couldn't file the rest automatically: email support@zaviagent.com and we'll refund what's owed."
      : "We're checking the rest and will refund what's owed within 1 business day.";
  if (refund?.status === "refunded") {
    const parts = [`Undone. We refunded ${(refund.credits ?? 0).toLocaleString("en-US")} credits to your wallet.`];
    if ((refund.forfeited ?? 0) > 0) parts.push(RESET_NOTE);
    if ((refund.untracked ?? 0) > 0) parts.push(checking);
    return parts.join(" ");
  }
  if (refund?.status === "untracked") {
    return r.claim_sent === false
      ? "Undone. We couldn't check its credits automatically: email support@zaviagent.com and we'll refund what's owed."
      : "Undone. We're checking which credits it used and will refund what's owed within 1 business day.";
  }
  if (refund?.status === "already_claimed") return "Undone. That check-in's credits were already handled by an earlier claim.";
  if (refund?.status === "expired") return "Undone. The credits it used came from a daily or monthly allowance that has reset since, so there is nothing to refund.";
  if (refund?.status === "already_refunded") return "Undone. The credits for that check-in were already refunded.";
  if (refund?.status === "nothing_charged") return "Undone. That change didn't use any credits.";
  return r.claim_sent === false
    ? "Undone. We couldn't file the refund automatically: email support@zaviagent.com and we'll refund it."
    : "Undone. We'll refund the credits it used to your wallet within 1 business day.";
}

export const AUTOPILOT_LINE =
  "Autopilot lets Zavi run every channel your plan includes by itself, including ads within your ad budget and marketing email sends. Set any channel to ask you first. Posts and code changes still wait for you.";
export const AUTOPILOT_OWNER_ONLY = "Only owners and admins can change Autopilot.";

export function HeadOfGrowthCard({
  hog,
  unavailable,
  channels,
  canClaim = true,
  canSwitch = true,
  adBudget,
  onChanged,
  part = "all",
}: {
  hog: HeadOfGrowth | undefined;
  unavailable: boolean;
  channels: readonly GrowthChannel[];
  canClaim?: boolean;
  canSwitch?: boolean;
  adBudget?: ReactNode;
  onChanged: () => Promise<void>;
  part?: "all" | "switch" | "note";
}) {
  const [on, setOn] = useState(hog?.autopilot === true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<Record<string, ClaimState>>({});
  const [fullNote, setFullNote] = useState(false);
  const trackRef = useRef<HTMLButtonElement>(null);
  const note = hog?.note ?? null;
  const next = dayLabel(note?.next_review_at);

  const flip = async () => {
    const want = !on;
    setOn(want);
    setSaving(true);
    setError(null);
    if (want) celebrate(trackRef.current);
    try {
      const res = await apiFetch("/api/workspace/growth/autopilot", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: want }),
      });
      if (!res.ok) {
        setOn(!want);
        setError(res.status === 403 ? AUTOPILOT_OWNER_ONLY : "Could not save that. Try again.");
        return;
      }
      await onChanged();
    } catch {
      setOn(!want);
      setError("Could not save that. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const goalFor = (line: string) => {
    const hits = (hog?.undoable ?? []).filter(
      (u) => u.prev_objective && withinWindow(u.at) && line.startsWith(`Goal "${u.prev_objective}"`),
    );
    return hits.length === 1 ? hits[0] : undefined;
  };
  const pausedFor = (line: string) =>
    channels.find(
      (c) => c.cgo_reason && !c.plan_selected && withinWindow(c.cgo_set_at) && line.startsWith(`Paused ${channelName(c.slug) ?? c.slug}.`),
    );

  const forget = (key: string) =>
    setClaimed((m) => {
      const rest = { ...m };
      delete rest[key];
      return rest;
    });

  const claim = async (key: string, body: Claim) => {
    setClaimed((m) => ({ ...m, [key]: "busy" }));
    setError(null);
    try {
      const res = await apiFetch("/api/workspace/growth/autopilot-mistake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as ClaimReply;
      if (!res.ok) {
        forget(key);
        setError(json.error?.message ?? "Could not undo that. Try again.");
        return;
      }
      setClaimed((m) => ({ ...m, [key]: { said: claimOutcome(json) } }));
      await onChanged();
    } catch {
      forget(key);
      setError("Could not undo that. Try again.");
    }
  };

  const changedLine = (line: string, i: number) => {
    const g = goalFor(line);
    const p = g ? undefined : pausedFor(line);
    const key = g ? `goal:${g.goal_id}` : p ? `channel:${p.slug}` : `line:${i}`;
    const state = claimed[key];
    const done = typeof state === "object";
    const body: Claim | null = g ? { kind: "goal", goal_id: g.goal_id } : p ? { kind: "channel", channel_slug: p.slug } : null;
    return (
      <li key={i} className="flex flex-wrap items-start gap-2.5 text-[14px] leading-[1.5] text-inkSoft">
        <Dot className="bg-ink" />
        <span className={`min-w-0 flex-1 ${showFull ? "" : "line-clamp-2"} ${done ? "text-inkMuted line-through decoration-inkMuted/70" : ""}`}>{line}</span>
        {canClaim && body && !done && (
          <button
            type="button"
            disabled={state === "busy"}
            onClick={() => void claim(key, body)}
            className="shrink-0 whitespace-nowrap rounded-[7px] border border-rule bg-cream px-2.5 py-0.5 text-[12px] font-semibold text-inkSoft transition-colors hover:bg-creamDeep disabled:opacity-50"
          >
            {state === "busy" ? "Undoing…" : "This was a mistake"}
          </button>
        )}
        {done && (
          <p role="status" className="basis-full pl-[15px] text-[12px] font-semibold text-ink motion-safe:animate-[hogFade_400ms_ease-out]">
            {state.said}
          </p>
        )}
      </li>
    );
  };

  const undoLive = (u: NonNullable<NoteSectionRow["undo"]>): Claim | null => {
    if (u.kind === "goal") {
      const hit = (hog?.undoable ?? []).find((x) => x.goal_id === u.goal_id && withinWindow(x.at));
      return hit ? { kind: "goal", goal_id: u.goal_id } : null;
    }
    const ch = channels.find((c) => c.slug === u.channel_slug && c.cgo_reason && !c.plan_selected && withinWindow(c.cgo_set_at));
    return ch ? { kind: "channel", channel_slug: u.channel_slug } : null;
  };
  const shownSections: NoteSection[] = (note?.sections ?? [])
    .map((sec) => (sec.key === "needs_you" ? { ...sec, rows: sec.rows.filter((r) => r.question_ordinal == null) } : sec))
    .filter((sec) => sec.rows.length > 0 || sec.more);
  const hasUndo = shownSections.some((sec) => sec.rows.some((r) => r.undo));

  const sectionRow = (sec: NoteSection, r: NoteSectionRow, i: number) => {
    const body = r.undo ? undoLive(r.undo) : null;
    const key = body ? (body.kind === "goal" ? `goal:${body.goal_id}` : `channel:${body.channel_slug}`) : `row:${sec.key}:${i}`;
    const state = claimed[key];
    const done = typeof state === "object";
    return (
      <li key={i} className="flex flex-wrap items-start gap-2.5 text-[14px] leading-[1.5] text-inkSoft">
        <Dot className={sec.key === "needs_you" ? "bg-marigoldDeep" : sec.key === "changed" ? "bg-ink" : undefined} />
        <span className={`min-w-0 flex-1 ${showFull ? "" : "line-clamp-2"} ${done ? "text-inkMuted line-through decoration-inkMuted/70" : ""}`}>
          {r.line}
          {r.url && (
            <>
              {" "}
              <a href={r.url} className="whitespace-nowrap font-semibold text-ink underline underline-offset-2 hover:text-inkSoft">
                {r.url_label ?? "Open"}
              </a>
            </>
          )}
          {r.sub && (
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13.5px]">
              {r.sub.map((l, k) => (
                <li key={k}>{l}</li>
              ))}
            </ul>
          )}
        </span>
        {canClaim && body && !done && (
          <button
            type="button"
            disabled={state === "busy"}
            onClick={() => void claim(key, body)}
            className="shrink-0 whitespace-nowrap rounded-[7px] border border-rule bg-cream px-2.5 py-0.5 text-[12px] font-semibold text-inkSoft transition-colors hover:bg-creamDeep disabled:opacity-50"
          >
            {state === "busy" ? "Undoing…" : "This was a mistake"}
          </button>
        )}
        {done && (
          <p role="status" className="basis-full pl-[15px] text-[12px] font-semibold text-ink motion-safe:animate-[hogFade_400ms_ease-out]">
            {state.said}
          </p>
        )}
      </li>
    );
  };
  const SECTION_LOOK: Record<NoteSection["key"], { icon: ReactNode; tone: string }> = {
    needs_you: { icon: <Hand className="h-3.5 w-3.5" aria-hidden="true" />, tone: "text-marigoldDeep" },
    changed: { icon: <Check className="h-3.5 w-3.5" aria-hidden="true" />, tone: "text-ink" },
    decided: { icon: <Check className="h-3.5 w-3.5" aria-hidden="true" />, tone: "text-inkMuted" },
    would_change: { icon: <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />, tone: "text-inkMuted" },
    working_on: { icon: <Loader className="h-3.5 w-3.5" aria-hidden="true" />, tone: "text-inkSoft" },
    blocked: { icon: <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />, tone: "text-inkMuted" },
  };

  const wouldChange = note?.would_change ?? [];
  const collapsible =
    note !== null &&
    (note.sections
      ? noteIsLong([note.saw, ...shownSections.map((sec) => sec.rows.flatMap((r) => [r.line, ...(r.sub ?? [])]))])
      : noteIsLong([note.saw, wouldChange, note.need]) || note.changed.some((l) => l.length > LONG_LINE));
  const showFull = part === "note" || fullNote || !collapsible;

  if (part === "switch") {
    return (
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 text-[13px] leading-[1.5] text-inkMuted">
          {AUTOPILOT_LINE}{" "}
          <HowItWorks label="Money-back guarantee" />
        </p>
        <button
          ref={trackRef}
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Autopilot"
          disabled={saving || !canSwitch}
          title={canSwitch ? undefined : AUTOPILOT_OWNER_ONLY}
          onClick={() => void flip()}
          className="inline-flex shrink-0 items-center gap-2 rounded-full text-[13px] font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inkMuted disabled:cursor-wait"
        >
          <span
            aria-hidden="true"
            className={`relative h-[22px] w-[38px] rounded-full transition-colors duration-150 ${on ? "bg-[linear-gradient(90deg,#1e9d63,#167F50)]" : "bg-rule"}`}
          >
            <span
              className={`absolute top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-[left] duration-150 ${on ? "left-[19px]" : "left-[3px]"}`}
            />
          </span>
          {on ? "Autopilot on" : "Autopilot off"}
        </button>
        {!canSwitch && !error && <p className="basis-full text-[13px] text-inkMuted">{AUTOPILOT_OWNER_ONLY}</p>}
        {error && (
          <p role="alert" className="basis-full text-sm text-warn dark:text-marigold">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <section aria-labelledby="growth-hog-title" className="space-y-4">
      {part === "all" && (
      <>
      {}
      <div>
        <FlowSwitch on={on} busy={saving} disabled={!canSwitch} onFlip={() => void flip()} trackRef={trackRef} />
        <p className="mt-3 px-1 text-[13px] leading-[1.5] text-inkMuted">
          {AUTOPILOT_LINE}
          {!canSwitch && ` ${AUTOPILOT_OWNER_ONLY}`}
        </p>
        {adBudget}
      </div>

      {}
      <div
        className={`flex items-center gap-3 rounded-2xl border px-3.5 py-2.5 transition-[border-color,background] duration-500 ${
          on ? "border-ink/30 bg-creamDeep" : "border-rule bg-cream"
        }`}
      >
        <Seal on={on} />
        <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[14px] font-bold tracking-[-0.01em] text-ink">Autopilot Guarantee</span>
          <span className="rounded-full bg-ink/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.06em] text-ink">Money-back</span>
        </p>
        <HowItWorks />
      </div>
      </>
      )}

      {}
      <div className="rounded-2xl border border-rule px-4 py-4 compact:px-4">
        <h2 className="mb-3 flex items-baseline gap-2 text-[13px] font-medium text-inkMuted">
          <span id="growth-hog-title">Your head of growth</span>
          <span>· latest note</span>
          {next && !unavailable && <span className="ml-auto text-[12px]">{on ? `Next check-in ${next}` : `Next note ${next}`}</span>}
        </h2>
        {unavailable ? (
          <p className="text-[14px] text-inkMuted">Couldn&apos;t load my latest note.</p>
        ) : note === null ? (
          <p className="text-[14px] text-inkMuted">My first note comes after I review your goals and channels.</p>
        ) : note.sections ? (
          <>
            {note.headline && <p className="mb-3 text-[14px] font-semibold leading-[1.45] text-ink">{note.headline}</p>}
            {shownSections.map((sec) => (
              <Section key={sec.key} icon={SECTION_LOOK[sec.key].icon} title={sec.title} tone={SECTION_LOOK[sec.key].tone}>
                <ul className="space-y-2">{(showFull ? sec.rows : sec.rows.slice(0, SHORT_LINES)).map((r, i) => sectionRow(sec, r, i))}</ul>
                {sec.more && (showFull || sec.rows.length <= SHORT_LINES) && (
                  <p className="mt-2 text-[13px] text-inkMuted">
                    {sec.more.line}{" "}
                    <a href={sec.more.url} className="font-semibold text-ink underline underline-offset-2 hover:text-inkSoft">
                      Open
                    </a>
                  </p>
                )}
                {sec.key === "would_change" && (
                  <p className="mt-2 text-[13px] text-inkMuted">
                    {on ? "Autopilot is on. I'll make these changes at my next check-in." : "Turn on Autopilot and I'll make these myself."}
                  </p>
                )}
              </Section>
            ))}
            {note.saw.length > 0 && (
              <Section icon={<Eye className="h-3.5 w-3.5" aria-hidden="true" />} title="What I saw" tone="text-inkMuted">
                <Plain lines={note.saw} full={showFull} />
              </Section>
            )}
            {hasUndo && (
              <p className="mt-3 text-[13px] text-inkMuted">
                Wrong call? Mark it &ldquo;This was a mistake&rdquo; within 30 days and we refund the credits it used.
              </p>
            )}
            {collapsible && part !== "note" && (
              <button
                type="button"
                aria-expanded={fullNote}
                onClick={() => setFullNote((v) => !v)}
                className="mt-3 text-[13px] font-semibold text-inkSoft underline underline-offset-2 hover:text-ink"
              >
                {fullNote ? "Show less" : "Show more"}
              </button>
            )}
          </>
        ) : (
          <>
            {note.saw.length > 0 && (
              <Section icon={<Eye className="h-3.5 w-3.5" aria-hidden="true" />} title="What I saw" tone="text-inkMuted">
                <Plain lines={note.saw} full={showFull} />
              </Section>
            )}
            {note.changed.length > 0 && (
              <Section icon={<Check className="h-3.5 w-3.5" aria-hidden="true" />} title="What I changed" tone="text-ink">
                <ul className="space-y-2">{note.changed.map(changedLine)}</ul>
              </Section>
            )}
            {wouldChange.length > 0 && (
              <Section icon={<Sparkles className="h-3.5 w-3.5" aria-hidden="true" />} title="What I'd change" tone="text-inkMuted">
                <Plain lines={wouldChange} full={showFull} />
                <p className="mt-2 text-[13px] text-inkMuted">
                  {on ? "Autopilot is on. I'll make these changes at my next check-in." : "Turn on Autopilot and I'll make these myself."}
                </p>
              </Section>
            )}
            {note.need.length > 0 && (
              <Section icon={<Hand className="h-3.5 w-3.5" aria-hidden="true" />} title="What I need from you" tone="text-marigoldDeep">
                <Plain lines={note.need} dot="bg-marigoldDeep" full={showFull} />
              </Section>
            )}
            {collapsible && part !== "note" && (
              <button
                type="button"
                aria-expanded={fullNote}
                onClick={() => setFullNote((v) => !v)}
                className="mt-3 text-[13px] font-semibold text-inkSoft underline underline-offset-2 hover:text-ink"
              >
                {fullNote ? "Show less" : "Show more"}
              </button>
            )}
          </>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-warn dark:text-marigold">
          {error}
        </p>
      )}
    </section>
  );
}
