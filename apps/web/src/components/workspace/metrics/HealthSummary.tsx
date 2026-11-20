"use client";

import { Info } from "lucide-react";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";

type Tone = NonNullable<ChannelMetric["tone"]>;

export type HealthCount = {
  kind: "error" | "warning" | "notice";
  label: string;
  value: number | null;
  sub: string;
};

export type HealthSegment = {
  label: string;
  value: number;
  tone: Tone | "muted";
};

export type ChannelHealth = {
  label: string;
  score: number | null;
  tone?: Tone;
  headline: string;
  note?: string;
  notice?: string;
  help?: string;
  counts: HealthCount[];
  segments?: HealthSegment[];
  segmentsLabel?: string;
};

const RING_STROKE: Record<Tone, string> = {
  good: "stroke-success",
  warn: "stroke-warn",
  bad: "stroke-danger",
};

const COUNT_BOX: Record<HealthCount["kind"], string> = {
  error: "bg-dangerBg text-danger",
  warning: "bg-warnBg text-warn",
  notice: "bg-[#EEF3FC] text-[#1E3A78]",
};

const SEGMENT_FILL: Record<HealthSegment["tone"], string> = {
  good: "bg-success",
  warn: "bg-warn",
  bad: "bg-danger",
  muted: "bg-inkMuted/40",
};

const R = 50;
const CIRC = 2 * Math.PI * R;

function Ring({ score, tone }: { score: number | null; tone?: Tone }) {
  const pct = score === null ? 0 : Math.max(0, Math.min(100, score));
  return (
    <svg viewBox="0 0 120 120" className="h-[132px] w-[132px] shrink-0" aria-hidden>
      <circle cx="60" cy="60" r={R} fill="none" strokeWidth="12" className="stroke-bone" />
      {score !== null && (
        <circle
          cx="60"
          cy="60"
          r={R}
          fill="none"
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * CIRC} ${CIRC}`}
          transform="rotate(-90 60 60)"
          className={tone ? RING_STROKE[tone] : "stroke-ink/40"}
        />
      )}
      <text
        x="60"
        y="70"
        textAnchor="middle"
        className={`text-[28px] font-bold ${score === null ? "fill-inkMuted/60" : "fill-ink"}`}
      >
        {score === null ? "-" : `${Math.round(pct)}%`}
      </text>
    </svg>
  );
}

export function HealthSummary({ health }: { health: ChannelHealth }) {
  return (
    <section aria-label={health.label} data-testid="health-summary" className="-mb-2 flex flex-col gap-4 compact:mb-0">
      <div className="flex items-center gap-6 rounded-2xl border border-rule bg-cream p-6 compact:gap-4 compact:p-4">
        <Ring score={health.score} {...(health.tone ? { tone: health.tone } : {})} />
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-ca-action text-ca-secondary">
            {health.label}
            {health.help && (
              <span title={health.help} aria-label={health.help} className="cursor-help">
                <Info className="size-4" aria-hidden />
              </span>
            )}
          </p>
          <p
            data-testid="health-headline"
            className={`mt-1 text-ca-section font-semibold ${health.score === null ? "text-inkMuted" : "text-ca-xdark"}`}
          >
            {health.headline}
          </p>
          {health.note && <p className="mt-1 text-ca-label text-ca-secondary">{health.note}</p>}
        </div>
      </div>

      <div className="rounded-2xl border border-rule bg-cream p-6 compact:p-4">
        <div className="grid grid-cols-3 gap-3 compact:gap-2">
          {health.counts.map((c) => (
            <div key={c.kind} data-testid={`health-count-${c.kind}`} className={`rounded-2xl p-4 compact:px-3 compact:py-2 ${COUNT_BOX[c.kind]}`}>
              <p className="text-ca-label font-medium">{c.label}</p>
              <p className={`mt-0.5 text-[36px] font-bold leading-[44px] tabular-nums ${c.value === null ? "opacity-50" : ""}`}>
                {c.value === null ? "-" : c.value}
              </p>
              <p className="text-ca-action text-ca-secondary">{c.sub}</p>
            </div>
          ))}
        </div>
        {health.segmentsLabel && <p className="mt-6 text-ca-action text-ca-secondary">{health.segmentsLabel}</p>}
        <div className="mt-2 flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-bone" aria-hidden>
          {(health.segments ?? []).map((s) =>
            s.value > 0 ? <span key={s.label} className={`basis-0 ${SEGMENT_FILL[s.tone]}`} style={{ flexGrow: s.value }} /> : null,
          )}
        </div>
        {(health.segments ?? []).length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-ca-action text-ca-secondary">
            {(health.segments ?? []).map((s) => (
              <li key={s.label} className="flex items-center gap-2">
                <span className={`inline-block size-2.5 rounded-full ${SEGMENT_FILL[s.tone]}`} aria-hidden />
                {s.label} <b className="ml-1 font-semibold text-ca-xdark">{s.value}</b>
              </li>
            ))}
          </ul>
        )}
      </div>
      {health.notice && (
        <p
          role="status"
          data-testid="health-notice"
          className="rounded-xl bg-warnBg px-4 py-2 text-[13px] leading-snug text-warn [@container(min-width:820px)]:col-span-2"
        >
          {health.notice}
        </p>
      )}
    </section>
  );
}
