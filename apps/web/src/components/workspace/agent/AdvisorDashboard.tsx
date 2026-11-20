"use client";

import {
  useAgentDashboard,
  DashboardShell,
  Kpi,
  KpiStrip,
  SectionTitle,
  AttentionList,
  EmptyState,
  Pill,
  num,
  ago,
  type AttentionItem,
} from "./dashboard-ui";

type ThreadRow = {
  id: string;
  title: string;
  snippet: string;
  last_message_at: string | null;
  status: "pending" | "running" | "done" | "idle";
};

type OpenRecommendation = {
  id: string;
  title: string;
  confidence: string;
  disconfirming_signal: string | null;
  lead_priority: boolean;
  age_days: number;
};

type ResolvedOutcome = "acted" | "rejected" | "stale";

type ResolvedRecommendation = {
  id: string;
  title: string;
  confidence: string;
  outcome: ResolvedOutcome;
  resolved_reason: string | null;
  lead_priority: boolean;
  age_days: number;
};

type TrackRecord = {
  acted: number;
  rejected: number;
  stale: number;
  open: number;
};

type Payload = {
  generic?: boolean;
  kpis: {
    pending: number;
    oldest_pending_days: number;
    emitted_14d: number;
    proposed_14d: number;
    acted_14d: number;
  };
  attention: AttentionItem[];
  threads: ThreadRow[];
  open_recommendations?: OpenRecommendation[];
  track_record?: TrackRecord;
  resolved_recommendations?: ResolvedRecommendation[];
};

export type OutcomeSegment = {
  key: ResolvedOutcome | "open";
  count: number;
  icon: string;
  label: string;
};

const OUTCOME_META: Record<
  ResolvedOutcome | "open",
  { icon: string; label: string }
> = {
  acted: { icon: "✓", label: "acted" },
  rejected: { icon: "✕", label: "rejected" },
  stale: { icon: "◷", label: "stale" },
  open: { icon: "○", label: "open" },
};

export function outcomeSegments(tr: TrackRecord): OutcomeSegment[] {
  return (["acted", "rejected", "stale", "open"] as const)
    .map((key) => ({
      key,
      count: Math.max(0, tr[key] | 0),
      icon: OUTCOME_META[key].icon,
      label: OUTCOME_META[key].label,
    }))
    .filter((s) => s.count > 0);
}

export function trackRecordTotal(tr: TrackRecord): number {
  return (
    Math.max(0, tr.acted | 0) +
    Math.max(0, tr.rejected | 0) +
    Math.max(0, tr.stale | 0) +
    Math.max(0, tr.open | 0)
  );
}

export function outcomeBarLabel(tr: TrackRecord): string {
  const parts = outcomeSegments(tr).map((s) => `${s.count} ${s.label}`);
  if (parts.length === 0) return "No prior recommendations yet.";
  return `Outcome split of ${trackRecordTotal(tr)} recommendations: ${parts.join(", ")}.`;
}

const STATUS_TONE: Record<
  ThreadRow["status"],
  { tone: "neutral" | "good" | "warn" | "bad"; label: string }
> = {
  pending: { tone: "warn", label: "Awaiting you" },
  running: { tone: "neutral", label: "Thinking" },
  done: { tone: "good", label: "Done" },
  idle: { tone: "neutral", label: "Idle" },
};

const CONFIDENCE_TONE: Record<
  string,
  { tone: "good" | "neutral" | "warn"; icon: string; label: string }
> = {
  evidence_grounded: { tone: "good", icon: "●", label: "evidence-grounded" },
  grounded: { tone: "good", icon: "●", label: "evidence-grounded" },
  inference: { tone: "neutral", icon: "◐", label: "inference" },
  low_confidence_speculation: {
    tone: "warn",
    icon: "○",
    label: "low-confidence speculation",
  },
  speculation: { tone: "warn", icon: "○", label: "speculation" },
};

function confidenceMeta(slug: string) {
  return (
    CONFIDENCE_TONE[slug] ?? {
      tone: "neutral" as const,
      icon: "◐",
      label: (slug || "inference").replace(/[_-]+/g, " "),
    }
  );
}

function ageLabel(days: number): string {
  if (days <= 0) return "emitted today";
  return `emitted ${num(days)}${days === 1 ? " day" : " days"} ago`;
}

const emptyState = (
  <EmptyState title="No open decisions">
    Ask the advisor to think through your hardest call this week, and the calls
    waiting on you (with their track record) will show up here.
  </EmptyState>
);

const OUTCOME_TONE: Record<
  ResolvedOutcome,
  { bar: string; chipBg: string; chipText: string; statusText: string; label: string }
> = {
  acted: {
    bar: "bg-[#167f50]",
    chipBg: "bg-[#e9f4ee]",
    chipText: "text-[#167f50]",
    statusText: "text-[#167f50]",
    label: "Acted",
  },
  rejected: {
    bar: "bg-[#c2453a]",
    chipBg: "bg-[#fbe9e7]",
    chipText: "text-[#c2453a]",
    statusText: "text-[#c2453a]",
    label: "Rejected",
  },
  stale: {
    bar: "bg-[#c79a16]",
    chipBg: "bg-[#f7f1de]",
    chipText: "text-[#8a6d00]",
    statusText: "text-[#8a6d00]",
    label: "Stale",
  },
};

const OPEN_BAR_TONE = "bg-[#cfcfcf]";

function AccountabilityBar({ tr }: { tr: TrackRecord }) {
  const segs = outcomeSegments(tr);
  const total = trackRecordTotal(tr);
  if (total === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div
        role="img"
        aria-label={outcomeBarLabel(tr)}
        className="flex h-9 w-full overflow-hidden rounded-lg text-[12px] font-semibold text-white"
      >
        {segs.map((s) => {
          const tone =
            s.key === "open" ? OPEN_BAR_TONE : OUTCOME_TONE[s.key].bar;
          const dark = s.key === "open";
          return (
            <div
              key={s.key}
              style={{ flexGrow: s.count, flexBasis: 0 }}
              className={`flex min-w-0 items-center justify-center gap-1 px-1 ${tone} ${
                dark ? "text-[#3a3a3a]" : "text-white"
              }`}
              title={`${s.count} ${s.label}`}
            >
              <span aria-hidden="true">{s.icon}</span>
              <span className="truncate">
                {s.count} {s.label}
              </span>
            </div>
          );
        })}
      </div>
      {}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#7a7a7a]">
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className="text-[#167f50]">
            ✓
          </span>
          Acted: operator executed
        </span>
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className="text-[#c2453a]">
            ✕
          </span>
          Rejected: killed / dissent stood
        </span>
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className="text-[#8a6d00]">
            ◷
          </span>
          Stale: went un-decided
        </span>
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className="text-[#9a9a9a]">
            ○
          </span>
          Open: awaiting call
        </span>
      </div>
    </div>
  );
}

function ResolvedRow({ rec }: { rec: ResolvedRecommendation }) {
  const conf = confidenceMeta(rec.confidence);
  const tone = OUTCOME_TONE[rec.outcome];
  const meta = OUTCOME_META[rec.outcome];
  return (
    <div className="overflow-hidden rounded-2xl border border-[#f0f0f0] bg-white">
      <div className="grid grid-cols-[26px_1fr_auto] items-start gap-3.5 px-4 py-4">
        {}
        <span
          aria-hidden="true"
          className={`flex h-[26px] w-[26px] items-center justify-center rounded-lg text-[16px] ${tone.chipBg} ${tone.chipText}`}
        >
          {meta.icon}
        </span>

        <div>
          <div className="text-[16px] font-semibold leading-snug text-[#0e0f11]">
            {rec.lead_priority ? (
              <span className="mr-2 inline-flex items-center gap-1 rounded-[5px] bg-[#0e0f11] px-1.5 py-0.5 align-[1px] text-[11px] font-bold uppercase tracking-wide text-white">
                ★ Lead
              </span>
            ) : null}
            {rec.title}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-[#595959]">
            <span
              className={`inline-flex items-center gap-2 rounded-md px-2 py-0.5 text-[12px] font-semibold ${
                conf.tone === "good"
                  ? "bg-[#e9f4ee] text-[#167f50]"
                  : conf.tone === "warn"
                    ? "bg-[#f7f1de] text-[#8a6d00]"
                    : "bg-[#e7f1ff] text-[#027bff]"
              }`}
            >
              <span aria-hidden="true">{conf.icon}</span>
              {conf.label}
            </span>
            <span aria-hidden="true" className="text-[#d4d4d4]">
              ·
            </span>
            <span>
              {rec.outcome === "stale"
                ? `went stale ${ageLabel(rec.age_days).replace(/^emitted /, "")}`
                : `${tone.label.toLowerCase()} ${ageLabel(rec.age_days).replace(/^emitted /, "")}`}
            </span>
          </div>

          {rec.resolved_reason ? (
            <div className="mt-3.5 rounded-[10px] border border-[#eee] bg-[#fafafa] px-3 py-2.5 text-[13px] leading-snug text-[#4a4a4a]">
              <span className="font-semibold text-[#2a2a2a]">
                {rec.outcome === "stale" ? "Why it went stale: " : "Outcome: "}
              </span>
              {rec.resolved_reason}
            </div>
          ) : null}
        </div>

        {}
        <div className="flex flex-col items-end gap-2 text-right">
          <span
            className={`inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide ${tone.statusText}`}
          >
            <span aria-hidden="true">{meta.icon}</span> {tone.label}
          </span>
        </div>
      </div>
    </div>
  );
}

function LedgerRow({ rec }: { rec: OpenRecommendation }) {
  const conf = confidenceMeta(rec.confidence);
  return (
    <div className="overflow-hidden rounded-2xl border border-[#f0f0f0] bg-white">
      <div className="grid grid-cols-[26px_1fr_auto] items-start gap-3.5 px-4 py-4">
        {}
        <span
          aria-hidden="true"
          className="flex h-[26px] w-[26px] items-center justify-center rounded-lg bg-[#e7f1ff] text-[16px] text-[#027bff]"
        >
          ○
        </span>

        <div>
          <div className="text-[16px] font-semibold leading-snug text-[#0e0f11]">
            {rec.lead_priority ? (
              <span className="mr-2 inline-flex items-center gap-1 rounded-[5px] bg-[#0e0f11] px-1.5 py-0.5 align-[1px] text-[11px] font-bold uppercase tracking-wide text-white">
                ★ Lead
              </span>
            ) : null}
            {rec.title}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-[#595959]">
            <span
              className={`inline-flex items-center gap-2 rounded-md px-2 py-0.5 text-[12px] font-semibold ${
                conf.tone === "good"
                  ? "bg-[#e9f4ee] text-[#167f50]"
                  : conf.tone === "warn"
                    ? "bg-[#f7f1de] text-[#8a6d00]"
                    : "bg-[#e7f1ff] text-[#027bff]"
              }`}
            >
              <span aria-hidden="true">{conf.icon}</span>
              {conf.label}
            </span>
            <span aria-hidden="true" className="text-[#d4d4d4]">
              ·
            </span>
            <span>{ageLabel(rec.age_days)}</span>
          </div>

          {rec.disconfirming_signal ? (
            <div className="mt-3.5 flex items-start gap-2.5 rounded-[10px] border border-[#ecdfb0] bg-[#f7f1de] px-3 py-2.5 text-[13px] leading-snug text-[#6b5500]">
              <span aria-hidden="true">⚠</span>
              <div>
                <span className="font-semibold text-[#5a4700]">
                  Disconfirming signal:{" "}
                </span>
                {rec.disconfirming_signal}
              </div>
            </div>
          ) : null}
        </div>

        {}
        <div className="flex flex-col items-end gap-2 text-right">
          <span className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-[#027bff]">
            <span aria-hidden="true">○</span> Open
          </span>
          <span className="text-[12px] text-[#9a9a9a]">awaiting call</span>
        </div>
      </div>
    </div>
  );
}

export function AdvisorDashboard() {
  const state = useAgentDashboard<Payload>("advisor");
  return (
    <DashboardShell
      title="Recommendation Ledger"
      subtitle="The calls waiting on you, scored by what happened, so advice stacks on a track record instead of evaporating."
      state={state}
      genericFallback={emptyState}
      render={(d) => {
        const k = d.kpis;
        const recs = d.open_recommendations ?? [];
        const resolved = d.resolved_recommendations ?? [];
        const tr: TrackRecord = d.track_record ?? {
          acted: 0,
          rejected: 0,
          stale: 0,
          open: recs.length,
        };
        const trTotal = trackRecordTotal(tr);
        const nothing =
          k.pending === 0 &&
          k.emitted_14d === 0 &&
          k.acted_14d === 0 &&
          recs.length === 0 &&
          resolved.length === 0 &&
          trTotal === 0 &&
          d.threads.length === 0;
        if (nothing) return emptyState;

        const followThrough =
          k.emitted_14d > 0
            ? Math.round((k.acted_14d / k.emitted_14d) * 100)
            : null;

        return (
          <div className="flex flex-col gap-5">
            <KpiStrip>
              <Kpi label="Pending decisions" value={num(k.pending)} />
              <Kpi
                label="Oldest pending"
                value={
                  k.pending === 0
                    ? "-"
                    : `${num(k.oldest_pending_days)}${k.oldest_pending_days === 1 ? " day" : " days"}`
                }
              />
              <Kpi
                label="Acted · 14d"
                value={
                  followThrough === null
                    ? num(k.acted_14d)
                    : `${num(k.acted_14d)} / ${num(k.emitted_14d)}`
                }
              />
              <Kpi
                label="Follow-through · 14d"
                value={followThrough === null ? "-" : `${followThrough}%`}
              />
            </KpiStrip>

            <AttentionList items={d.attention} />

            {}
            <section>
              <SectionTitle>Open recommendation ledger</SectionTitle>
              {recs.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[#e5e7eb] px-4 py-3 text-[12px] text-[#a8a8a8]">
                  No open recommendations. When the advisor emits a lead-priority
                  call, it stacks here until you act on or reject it.
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {recs.map((r) => (
                    <LedgerRow key={r.id} rec={r} />
                  ))}
                </div>
              )}

            </section>

            {}
            {trTotal > 0 ? (
              <section>
                <SectionTitle>Past calls: track record</SectionTitle>
                <div className="flex flex-col gap-4">
                  <AccountabilityBar tr={tr} />
                  {resolved.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-[#e5e7eb] px-4 py-3 text-[12px] text-[#a8a8a8]">
                      No closed recommendations yet. When you act on or reject an
                      open call (or it goes stale), it lands here with its
                      outcome, so advice stacks on a track record.
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {resolved.map((r) => (
                        <ResolvedRow key={r.id} rec={r} />
                      ))}
                    </div>
                  )}
                </div>
              </section>
            ) : null}

            {}
            <section>
              <SectionTitle>Recent thinking threads</SectionTitle>
              {d.threads.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[#e5e7eb] px-4 py-3 text-[12px] text-[#a8a8a8]">
                  No advisor conversations yet. Start one in the chat on the
                  right.
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl border border-[#e5e7eb] bg-white">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="border-b border-[#e5e7eb] text-left text-[11px] uppercase tracking-wide text-[#8a8a8a]">
                        <th className="px-3 py-2 font-medium">Thread</th>
                        <th className="px-3 py-2 font-medium">When</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.threads.map((t) => {
                        const s = STATUS_TONE[t.status] ?? STATUS_TONE.idle;
                        return (
                          <tr
                            key={t.id}
                            className="border-b border-[#f0ede5] align-top last:border-0"
                          >
                            <td className="px-3 py-2">
                              <div className="truncate font-medium text-[#1f1f1f]">
                                {t.title}
                              </div>
                              {t.snippet ? (
                                <div className="mt-0.5 line-clamp-2 text-[12px] text-[#8a8a8a]">
                                  {t.snippet}
                                </div>
                              ) : null}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-[12px] text-[#595959]">
                              {ago(t.last_message_at)}
                            </td>
                            <td className="px-3 py-2">
                              <Pill tone={s.tone}>{s.label}</Pill>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        );
      }}
    />
  );
}
