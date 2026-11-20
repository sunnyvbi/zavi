"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { cardEvidence, type ActionItem } from "./types";
import { signupPreviewWeeks } from "@/lib/workspace/channelActionsApi";

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <p className="text-[12px] font-semibold uppercase tracking-wide text-inkMuted">{children}</p>
      {right && <p className="text-[12px] text-inkMuted">{right}</p>}
    </div>
  );
}

export function StatTiles({ tiles, tone = "text-ink" }: { tiles: Array<{ value: string; caption: string }>; tone?: string }) {
  return (
    <div className={`grid gap-3 ${tiles.length >= 3 ? "sm:grid-cols-3" : tiles.length === 2 ? "sm:grid-cols-2" : ""}`}>
      {tiles.map((t, i) => (
        <div key={i} className="rounded-xl border border-rule bg-cream px-4 py-3">
          <p className={`text-[14px] font-bold tabular-nums ${tone}`}>{t.value}</p>
          <p className="mt-0.5 text-[14px] leading-snug text-inkMuted">{t.caption}</p>
        </div>
      ))}
    </div>
  );
}

const INPUT_LABEL: Record<string, string> = {
  impact: "Impact the run estimated (1 to 5)",
  impact_n: "Impact",
  goal_fit: "Fits your plan and goals",
  rank_n: "Where the agent ranked it in its run",
  position: "Position in its run",
  run_of: "Actions in that run",
  previously_rejected: "You rejected a similar action before",
  blocking: "Blocks the rest of this channel",
};

function inputLabel(k: string): string {
  return INPUT_LABEL[k] ?? k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function inputValue(v: unknown): string {
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "None";
  return JSON.stringify(v);
}

export function ScoreWhy({ a }: { a: ActionItem }) {
  const [open, setOpen] = useState(false);
  const inputs = Object.entries(a.score_inputs ?? {}).filter(([, v]) => v !== undefined);
  const hasWhy = !!a.impact_reason || inputs.length > 0 || a.blocking;
  const hasScore = Number.isFinite(a.score) && a.score > 0;
  if (!hasScore && !hasWhy) return null;
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-inkMuted">
        {hasScore && (
          <span data-testid="action-score" className="rounded-md bg-bone px-2 py-0.5 font-medium tabular-nums text-inkSoft">
            Score {Math.round(a.score)}
          </span>
        )}
        {hasWhy && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1 font-medium text-inkMuted underline-offset-2 hover:underline"
          >
            Why it ranks here
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
          </button>
        )}
      </div>
      {open && (
        <div data-testid="action-why" className="mt-2 rounded-xl border border-rule bg-creamDeep px-4 py-3 text-[14px] text-inkSoft">
          {a.blocking && <p className="font-medium text-ink">Blocking: this comes before every other action on the channel.</p>}
          {a.impact_reason && <p className={a.blocking ? "mt-1" : ""}>{a.impact_reason}</p>}
          {inputs.length > 0 && (
            <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
              {inputs.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-inkMuted">{inputLabel(k)}</dt>
                  <dd className="text-right tabular-nums text-ink">{inputValue(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}

export function EstimateBlock({ a }: { a: ActionItem }) {
  const est = cardEvidence(a).estimate;
  if (!est.length) return null;
  return (
    <div>
      <SectionLabel right="estimate">What it should bring</SectionLabel>
      <StatTiles tiles={est} tone="text-emerald-600" />
    </div>
  );
}

export function ActionShell({
  a,
  icon: Icon,
  meta,
  isNew,
  lead,
  children,
  details,
  footer,
}: {
  a: ActionItem;
  icon: LucideIcon;
  meta?: string | null;
  isNew?: boolean;
  lead?: ReactNode;
  children?: ReactNode;
  details?: ReactNode;
  footer: ReactNode;
}) {
  return (
    <article
      className="flex flex-col overflow-hidden rounded-2xl border border-rule bg-cream"
      data-testid={`action-${a.id}`}
      data-action-type={a.action_type}
      data-source={a.source}
    >
      <div className="p-4 sm:p-4">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
          <div className="flex min-w-0 grow basis-[28rem] items-start gap-3">
            <Icon className="mt-0.5 h-5 w-5 shrink-0 text-inkMuted" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-balance text-[16px] font-semibold text-ink [overflow-wrap:anywhere]">{a.title}</h3>
                {isNew && <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-[12px] font-medium text-emerald-600">New</span>}
                {a.blocking && <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-[12px] font-medium text-amber-600">Blocking</span>}
                {a.redo_of && <span className="rounded-md bg-bone px-2 py-0.5 text-[12px] font-medium text-inkSoft">Rewritten</span>}
                {signupPreviewWeeks(a) !== null && <span className="rounded-md bg-bone px-2 py-0.5 text-[12px] font-medium text-inkSoft">{`${signupPreviewWeeks(a)} wk old`}</span>}
              </div>
              {lead && <div className="mt-1 text-[14px] leading-relaxed text-inkSoft [overflow-wrap:anywhere]">{lead}</div>}
            </div>
          </div>
          {meta && <span className="hidden shrink-0 text-[14px] text-inkMuted sm:inline">{meta}</span>}
        </div>
        {children && <div className="mt-4">{children}</div>}
      </div>
      {details && <div className="space-y-5 border-t border-rule bg-creamDeep p-4 sm:p-4">{details}</div>}
      {footer}
    </article>
  );
}
