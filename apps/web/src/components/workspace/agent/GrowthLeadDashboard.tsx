"use client";

import { useState } from "react";
import {
  CheckSquare,
  HelpCircle,
  ListChecks,
  MessageSquareText,
  RefreshCw,
} from "lucide-react";
import { useWorkspace } from "@/components/workspace/WorkspaceShell";
import { STATIC_TITLES } from "@/components/workspace/layout/shared";
import { ConstraintCard } from "./ConstraintCard";
import {
  useAgentDashboard,
  useExternalRefresh,
  useRefreshingSignal,
  DashboardShell,
  EmptyState,
  KpiStrip,
  Kpi,
  SectionTitle,
  AttentionList,
  Pill,
  usd,
  ratio,
  pct,
  num,
  type AttentionItem,
} from "./dashboard-ui";
import { NextChevron } from "@/components/ui/NextChevron";

type FunnelStep = {
  event: string;
  count: number;
  conversion_from_top: number | null;
  conversion_from_prev: number | null;
  drop_from_prev_pct: number | null;
  is_bottleneck: boolean;
};

type Bottleneck = {
  stage: string;
  from_stage: string;
  conversion_from_prev: number | null;
  drop_pct: number | null;
} | null;

type CohortRow = {
  cohort: string;
  signups: number;
  revenue: number | null;
  revenue_per_signup: number | null;
  payback_ratio: number | null;
};

type GrowthBetRow = {
  id: string;
  kind: "budget" | "lifecycle" | "social";
  claim: string;
  from_channel: string | null;
  to_channel: string | null;
  amount_usd: number | null;
  amount_qualitative: boolean;
  confidence: "high" | "medium" | "low" | null;
  status: string;
  emitted_at: string | null;
};

type ExecTag = "yes" | "needs-connector" | "needs-data" | "manual";
type GrowthAction = { action: string; exec: ExecTag };
type GrowthStage = "data_not_ready" | "pre_loop" | "leaky_loop";
type CurrentGrowthPlan = {
  stage: GrowthStage;
  now: GrowthAction | null;
  next: GrowthAction[];
  later: string[];
  updated_at: string;
};

type Payload = {
  generic?: boolean;
  connected: boolean;
  current_growth_plan?: CurrentGrowthPlan | null;
  funnel?: {
    connected: boolean;
    diagnosis_source: string | null;
    window: string | null;
    total_events_in_window: number | null;
    steps: FunnelStep[];
    top_of_funnel_count: number | null;
    bottleneck: Bottleneck;
  };
  cohorts?: {
    connected: boolean;
    currency: string | null;
    rows: CohortRow[];
  };
  bets?: GrowthBetRow[];
  attention?: AttentionItem[];
  autopilot_enabled?: boolean;
};

const connectFallback = (
  <EmptyState title="Connect your funnel to see where it leaks">
    Instrument your product (event ingest) or connect Stripe to see your funnel
    and cohorts. Until then, ask growth-lead in the chat to diagnose from
    whatever signals are connected.
  </EmptyState>
);

function usdCents(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

type Band = "profitable" | "recovering" | "underwater";
function bandOf(p: number | null): Band | null {
  if (p === null || !Number.isFinite(p)) return null;
  if (p >= 1.0) return "profitable";
  if (p >= 0.7) return "recovering";
  return "underwater";
}
const BAND_COLOR: Record<Band, string> = {
  profitable: "#167f50",
  recovering: "#8a6d00",
  underwater: "#cb2029",
};
const BAND_GLYPH: Record<Band, string> = {
  profitable: "●",
  recovering: "◆",
  underwater: "▲",
};
const BAND_PILL: Record<Band, "good" | "warn" | "bad"> = {
  profitable: "good",
  recovering: "warn",
  underwater: "bad",
};

function betStatusTone(status: string): "neutral" | "good" | "warn" | "bad" {
  switch (status) {
    case "approved":
    case "acted":
      return "good";
    case "proposed":
      return "warn";
    case "rejected":
      return "bad";
    default:
      return "neutral";
  }
}
const BET_KIND_LABEL: Record<GrowthBetRow["kind"], string> = {
  budget: "Budget reallocation",
  lifecycle: "Lifecycle",
  social: "Social",
};
const BET_KIND_SHORT: Record<GrowthBetRow["kind"], string> = {
  budget: "Budget",
  lifecycle: "Lifecycle",
  social: "Social",
};
function betAmountLabel(b: GrowthBetRow): string | null {
  if (b.amount_qualitative) return "qualitative";
  if (b.amount_usd !== null && Number.isFinite(b.amount_usd))
    return `${usd(b.amount_usd)}/wk`;
  return null;
}
function betDateLabel(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const STATUS_ORDER: Record<string, number> = {
  proposed: 0,
  approved: 1,
  acted: 2,
  expired: 3,
  rejected: 4,
  superseded: 5,
};

function rankBets(rows: GrowthBetRow[]): GrowthBetRow[] {
  return [...rows].sort((a, b) => {
    const sa = STATUS_ORDER[a.status] ?? 9;
    const sb = STATUS_ORDER[b.status] ?? 9;
    if (sa !== sb) return sa - sb;
    return (
      (Date.parse(b.emitted_at ?? "") || 0) -
      (Date.parse(a.emitted_at ?? "") || 0)
    );
  });
}

function betRouteLabel(b: GrowthBetRow): string {
  if (b.from_channel || b.to_channel) {
    return `${b.from_channel ?? "new"} → ${b.to_channel ?? "-"}`;
  }
  return BET_KIND_LABEL[b.kind];
}

function betPrompt(
  b: GrowthBetRow,
  mode: "explain" | "refine" | "regenerate" | "evaluate",
): string {
  const lines = [
    `Growth bet: ${b.claim}`,
    `Decision id: ${b.id}`,
    `Status: ${b.status}`,
    `Lever: ${BET_KIND_LABEL[b.kind]}`,
    `Route: ${betRouteLabel(b)}`,
  ];
  const amount = betAmountLabel(b);
  if (amount) lines.push(`Amount: ${amount}`);
  if (b.confidence) lines.push(`Confidence: ${b.confidence}`);

  const context = lines.join("\n");
  switch (mode) {
    case "refine":
      return `${context}\n\nRefine this growth bet before I act. Show the better version, the evidence required, the risk, and the smallest safe next step.`;
    case "regenerate":
      return `${context}\n\nThis growth bet is stale or expired. Regenerate a current version using today's available signals, or tell me to archive it if the evidence is no longer strong.`;
    case "evaluate":
      return `${context}\n\nEvaluate whether this growth bet worked. Compare expected vs observed signal if available, say what we learned, and propose the next iteration.`;
    case "explain":
    default:
      return `${context}\n\nExplain why I should or should not act on this bet now. Use only evidence you can cite, call out missing data, and give me the exact decision you recommend.`;
  }
}

function draftNextBetPrompt(): string {
  return [
    "Draft the highest-leverage growth bet for this week.",
    "Start from funnel constraint, unit economics, and recent agent signals.",
    "Return one approval-ready bet with expected upside, evidence, risk, missing data, and the smallest safe action.",
  ].join("\n");
}

function ActionButton({
  children,
  onClick,
  primary = false,
  icon: Icon,
}: {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  icon: typeof CheckSquare;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        primary
          ? "inline-flex h-8 cursor-pointer items-center gap-2 rounded-cta bg-[#0e0f11] px-3 text-[12px] font-semibold text-white transition-opacity hover:opacity-90"
          : "inline-flex h-8 cursor-pointer items-center gap-2 rounded-cta border border-[#e5e7eb] bg-white px-3 text-[12px] font-semibold text-[#1f1f1f] transition-colors hover:bg-[#f7f4ee]"
      }
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {children}
    </button>
  );
}

const EXEC_LABEL: Record<ExecTag, string> = {
  yes: "Zavi can do this",
  "needs-connector": "Needs a connector",
  "needs-data": "Needs more data",
  manual: "You do this",
};
const EXEC_TONE: Record<ExecTag, "good" | "warn" | "neutral"> = {
  yes: "good",
  "needs-connector": "warn",
  "needs-data": "neutral",
  manual: "neutral",
};
const STAGE_LABEL: Record<GrowthStage, string> = {
  data_not_ready: "Connect your data",
  pre_loop: "Before the loop",
  leaky_loop: "Working loop, with leaks",
};

function ExecPill({ exec }: { exec: ExecTag }) {
  return <Pill tone={EXEC_TONE[exec]}>{EXEC_LABEL[exec]}</Pill>;
}

function CurrentGrowthPlanPanel({ plan }: { plan: CurrentGrowthPlan | null }) {
  const [showLater, setShowLater] = useState(false);

  if (plan === null) {
    return (
      <section>
        <SectionTitle>This week&apos;s growth plan</SectionTitle>
        <div className="rounded-xl border border-dashed border-[#f0f0f0] bg-white px-4 py-4 text-[12px] text-[#595959]">
          Growth Lead hasn&apos;t set a plan yet. Ask it in the chat to diagnose
          your funnel and draft this week&apos;s priorities.
        </div>
      </section>
    );
  }

  const dataNotReady = plan.stage === "data_not_ready";

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <SectionTitle>This week&apos;s growth plan</SectionTitle>
        <Pill tone={dataNotReady ? "warn" : "neutral"}>
          {STAGE_LABEL[plan.stage]}
        </Pill>
      </div>
      <div className="flex flex-col gap-3 rounded-3xl border border-[#f0f0f0] bg-white px-4 py-4">
        {}
        {plan.now ? (
          <div className="rounded-xl border border-[#e5e7eb] bg-[#faf9f6] px-4 py-3">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-[#595959]">
                {dataNotReady ? "Start here" : "Do this first"}
              </span>
              <ExecPill exec={plan.now.exec} />
            </div>
            <div className="text-[16px] font-semibold leading-snug text-[#0e0f11]">
              {plan.now.action}
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-[#f0f0f0] px-4 py-3 text-[12px] text-[#595959]">
            No single top action surfaced this run.
          </div>
        )}

        {}
        {plan.next.length > 0 && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#595959]">
              Then
            </div>
            <div className="flex flex-col gap-2">
              {plan.next.map((a, i) => (
                <div
                  key={i}
                  className="flex items-start justify-between gap-2 rounded-lg border border-[#f0f0f0] px-3 py-2"
                >
                  <span className="text-[13px] leading-snug text-[#1f1f1f]">
                    {a.action}
                  </span>
                  <span className="shrink-0">
                    <ExecPill exec={a.exec} />
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {}
        {plan.later.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setShowLater((v) => !v)}
              className="cursor-pointer text-[12px] font-medium text-[#595959] hover:text-[#1f1f1f]"
            >
              {showLater ? "Hide later" : <>Later ({plan.later.length}) <NextChevron /></>}
            </button>
            {showLater && (
              <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-[12px] text-[#595959]">
                {plan.later.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function GrowthBetDecisionQueue({
  bets,
  selectedBetId,
  onSelectBet,
  onReview,
  onAsk,
  onDraftNext,
  autopilotEnabled,
  onTurnOnAutopilot,
}: {
  bets: GrowthBetRow[];
  selectedBetId: string | null;
  onSelectBet: (id: string) => void;
  onReview: (id: string) => void;
  onAsk: (
    bet: GrowthBetRow,
    mode: "explain" | "refine" | "regenerate" | "evaluate",
  ) => void;
  onDraftNext: () => void;
  autopilotEnabled?: boolean;
  onTurnOnAutopilot: () => void;
}) {
  const autopilotOff = autopilotEnabled === false;
  const ranked = rankBets(bets);
  const selected =
    ranked.find((b) => b.id === selectedBetId) ?? ranked[0] ?? null;
  const proposed = ranked.filter((b) => b.status === "proposed");
  const onDeck = selected
    ? ranked.filter((b) => b.id !== selected.id)
    : ranked.slice(1);

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <SectionTitle>Growth decision queue</SectionTitle>
        <span className="text-[12px] text-[#8a8a8a]">
          {bets.length === 0
            ? autopilotOff
              ? "advisory mode"
              : "all clear"
            : `${proposed.length} waiting · ${bets.length} recent`}
        </span>
      </div>

      {bets.length === 0 || selected === null ? (
        <div className="rounded-xl border border-dashed border-[#f0f0f0] bg-white px-4 py-4">
          <div className="text-[13px] font-semibold text-[#0e0f11]">
            {autopilotOff
              ? "Bets queue here once Autopilot is on"
              : "No growth decisions queued"}
          </div>
          <div className="mt-1 text-[12px] text-[#595959]">
            {autopilotOff
              ? "Autopilot is off, so Growth Lead's bets stay advisory: drafted on demand but not queued as approval cards. Turn on Autopilot to auto-queue them, or draft one now to review in chat."
              : "Growth Lead has not proposed a current budget, lifecycle, or social bet for this tenant."}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {autopilotOff ? (
              <ActionButton
                icon={CheckSquare}
                onClick={onTurnOnAutopilot}
                primary
              >
                Turn on Autopilot
              </ActionButton>
            ) : null}
            <ActionButton
              icon={MessageSquareText}
              onClick={onDraftNext}
              primary={!autopilotOff}
            >
              Draft next bet
            </ActionButton>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_300px]">
          <div className="rounded-xl border border-[#e5e7eb] bg-white px-4 py-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-[#595959]">
                  {selected.status === "proposed"
                    ? "Next decision"
                    : "Selected bet"}
                </span>
                <Pill tone={betStatusTone(selected.status)}>
                  {selected.status}
                </Pill>
              </div>
              <span className="text-[11px] text-[#8a8a8a]">
                {betDateLabel(selected.emitted_at)}
              </span>
            </div>

            <div className="text-[14px] font-semibold leading-snug text-[#0e0f11]">
              {selected.claim}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-4">
              <div className="rounded-lg bg-[#faf9f6] px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-[#8a8a8a]">
                  Lever
                </div>
                <div className="mt-0.5 font-medium text-[#1f1f1f]">
                  {BET_KIND_LABEL[selected.kind]}
                </div>
              </div>
              <div className="rounded-lg bg-[#faf9f6] px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-[#8a8a8a]">
                  Route
                </div>
                <div className="mt-0.5 truncate font-medium text-[#1f1f1f]">
                  {betRouteLabel(selected)}
                </div>
              </div>
              <div className="rounded-lg bg-[#faf9f6] px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-[#8a8a8a]">
                  Amount
                </div>
                <div className="mt-0.5 font-medium text-[#1f1f1f]">
                  {betAmountLabel(selected) ?? "-"}
                </div>
              </div>
              <div className="rounded-lg bg-[#faf9f6] px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-[#8a8a8a]">
                  Confidence
                </div>
                <div className="mt-0.5 font-medium text-[#1f1f1f]">
                  {selected.confidence ?? "-"}
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {selected.status === "proposed" ? (
                <ActionButton
                  icon={CheckSquare}
                  primary
                  onClick={() => onReview(selected.id)}
                >
                  Review on the Growth page
                </ActionButton>
              ) : selected.status === "expired" ||
                selected.status === "superseded" ? (
                <ActionButton
                  icon={RefreshCw}
                  primary
                  onClick={() => onAsk(selected, "regenerate")}
                >
                  Regenerate
                </ActionButton>
              ) : selected.status === "acted" ||
                selected.status === "approved" ? (
                <ActionButton
                  icon={ListChecks}
                  primary
                  onClick={() => onAsk(selected, "evaluate")}
                >
                  Evaluate outcome
                </ActionButton>
              ) : (
                <ActionButton
                  icon={MessageSquareText}
                  primary
                  onClick={() => onAsk(selected, "refine")}
                >
                  Revise
                </ActionButton>
              )}
              <ActionButton
                icon={HelpCircle}
                onClick={() => onAsk(selected, "explain")}
              >
                Ask why
              </ActionButton>
              <ActionButton
                icon={MessageSquareText}
                onClick={() => onAsk(selected, "refine")}
              >
                Refine
              </ActionButton>
            </div>
          </div>

          <div className="rounded-xl border border-[#e5e7eb] bg-white px-3 py-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[#595959]">
              On deck
            </div>
            {onDeck.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[#f0f0f0] px-3 py-3 text-[12px] text-[#8a8a8a]">
                No other recent bets.
              </div>
            ) : (
              <div className="flex max-h-[280px] flex-col gap-2 overflow-y-auto pr-1">
                {onDeck.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => onSelectBet(b.id)}
                    className="w-full cursor-pointer rounded-cta border border-transparent px-2.5 py-2 text-left transition-colors hover:border-[#e5e7eb] hover:bg-[#faf9f6]"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="line-clamp-2 text-[12px] font-medium leading-snug text-[#1f1f1f]">
                          {b.claim}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[#8a8a8a]">
                          <span>{BET_KIND_SHORT[b.kind]}</span>
                          {betAmountLabel(b) && (
                            <span className="tabular-nums">
                              {betAmountLabel(b)}
                            </span>
                          )}
                          {b.confidence && <span>{b.confidence}</span>}
                          <span className="tabular-nums">{betDateLabel(b.emitted_at)}</span>
                        </div>
                      </div>
                      <Pill tone={betStatusTone(b.status)}>{b.status}</Pill>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function CohortLtvChart({ rows }: { rows: CohortRow[] }) {
  const pts = [...rows]
    .reverse()
    .filter((r) => r.revenue_per_signup !== null);
  if (pts.length < 2) return null;

  const W = 1080;
  const H = 320;
  const padL = 56;
  const padR = 20;
  const padT = 24;
  const padB = 40;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const maxV = Math.max(...pts.map((p) => p.revenue_per_signup ?? 0), 1);
  const yMax = maxV * 1.12;
  const xAt = (i: number) =>
    pts.length === 1
      ? padL + innerW / 2
      : padL + (i / (pts.length - 1)) * innerW;
  const yAt = (v: number) => padT + innerH - (v / yMax) * innerH;

  const yTicks = 4;
  const gridLines = Array.from({ length: yTicks + 1 }, (_, i) => {
    const v = (yMax / yTicks) * i;
    return { v, y: yAt(v) };
  });

  const linePts = pts
    .map(
      (p, i) =>
        `${xAt(i).toFixed(1)},${yAt(p.revenue_per_signup ?? 0).toFixed(1)}`,
    )
    .join(" ");

  const labelIdx = new Set([
    0,
    Math.floor((pts.length - 1) / 2),
    pts.length - 1,
  ]);

  return (
    <div className="w-full overflow-hidden">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full"
        role="img"
        aria-label={`Revenue-per-signup by cohort, oldest to newest. Ranges from ${usdCents(
          pts[0].revenue_per_signup,
        )} to ${usdCents(
          pts[pts.length - 1].revenue_per_signup,
        )} per signup. Dot color encodes payback band (profitable, recovering, or underwater).`}
      >
        {}
        {gridLines.map((g, i) => (
          <g key={`g-${i}`}>
            <line
              x1={padL}
              y1={g.y}
              x2={W - padR}
              y2={g.y}
              stroke="currentColor"
              strokeOpacity={0.08}
              strokeWidth={1}
            />
            <text
              x={padL - 8}
              y={g.y + 4}
              textAnchor="end"
              fill="#8a8a8a"
              fontSize={11}
              fontFamily="inherit"
            >
              {usd(g.v)}
            </text>
          </g>
        ))}

        {}
        <polyline
          points={linePts}
          fill="none"
          stroke="#8a8a8a"
          strokeWidth={2}
        />

        {}
        {pts.map((p, i) => {
          const band = bandOf(p.payback_ratio);
          const color = band ? BAND_COLOR[band] : "#8a8a8a";
          const cx = xAt(i);
          const cy = yAt(p.revenue_per_signup ?? 0);
          return (
            <g key={`pt-${p.cohort}-${i}`}>
              <circle cx={cx} cy={cy} r={6} fill={color} />
              {labelIdx.has(i) && (
                <text
                  x={cx}
                  y={H - padB + 18}
                  textAnchor="middle"
                  fill="#8a8a8a"
                  fontSize={11}
                  fontFamily="inherit"
                >
                  {p.cohort}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function GrowthLeadDashboard({
  refreshTick,
  active,
  onRefreshingChange,
}: {
  refreshTick?: number;
  active?: boolean;
  onRefreshingChange?: (refreshing: boolean) => void;
} = {}) {
  const state = useAgentDashboard<Payload>("growth-lead");
  useExternalRefresh(state, refreshTick, active);
  useRefreshingSignal(state.refreshing, onRefreshingChange);
  const { openTab, seedComposer } = useWorkspace();
  const [selectedBetId, setSelectedBetId] = useState<string | null>(null);

  const openApprovals = (decisionId: string) => {
    openTab({
      kind: "autopilot",
      title: "Your CGO",
      payload: { kind: "autopilot", decision: decisionId },
      dirty: false,
      pinned: false,
    });
  };

  const askGrowthLead = (
    bet: GrowthBetRow,
    mode: "explain" | "refine" | "regenerate" | "evaluate",
  ) => {
    seedComposer({
      agentSlug: "growth-lead",
      text: betPrompt(bet, mode),
    });
  };

  const draftNextBet = () => {
    seedComposer({
      agentSlug: "growth-lead",
      text: draftNextBetPrompt(),
    });
  };

  const openAutopilot = () => {
    openTab({
      kind: "autopilot",
      title: STATIC_TITLES.autopilot,
      payload: { kind: "autopilot" },
      dirty: false,
      pinned: false,
    });
  };

  return (
    <DashboardShell
      title="Growth decision queue"
      subtitle="Bets waiting for approval, stale bets to regenerate, and cohort payback evidence."
      state={state}
      genericFallback={connectFallback}
      render={(d) => {
        if (!d.connected)
          return (
            <>
              <ConstraintCard />
              {connectFallback}
            </>
          );

        const funnel = d.funnel;
        const cohorts = d.cohorts;
        const bets = d.bets ?? [];
        const attention = d.attention ?? [];
        const steps = funnel?.steps ?? [];
        const maxCount = steps.reduce((m, s) => Math.max(m, s.count), 0);

        const rows = cohorts?.rows ?? [];
        const hasCohorts = (cohorts?.connected ?? false) && rows.length > 0;

        const paybacks = rows
          .map((r) => r.payback_ratio)
          .filter((p): p is number => p !== null && Number.isFinite(p));
        const avgPayback =
          paybacks.length > 0
            ? paybacks.reduce((a, b) => a + b, 0) / paybacks.length
            : null;

        const half = Math.floor(rows.length / 2);
        const newerPb = rows
          .slice(0, half || rows.length)
          .map((r) => r.payback_ratio)
          .filter((p): p is number => p !== null && Number.isFinite(p));
        const olderPb = rows
          .slice(rows.length - (half || rows.length))
          .map((r) => r.payback_ratio)
          .filter((p): p is number => p !== null && Number.isFinite(p));
        const avg = (xs: number[]) =>
          xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
        const newerAvg = avg(newerPb);
        const olderAvg = avg(olderPb);
        const paybackDelta =
          newerAvg !== null && olderAvg !== null && rows.length >= 2
            ? newerAvg - olderAvg
            : null;

        const newestRps = rows.length > 0 ? rows[0].revenue_per_signup : null;
        const totalSignups = rows.reduce((a, r) => a + (r.signups || 0), 0);

        return (
          <>
            {}
            <ConstraintCard />

            {}
            <CurrentGrowthPlanPanel plan={d.current_growth_plan ?? null} />

            {}
            <KpiStrip>
              <Kpi
                label="Blended payback"
                value={avgPayback === null ? "-" : ratio(avgPayback)}
              />
              <Kpi label="Latest rev / signup" value={usdCents(newestRps)} />
              <Kpi
                label="Payback trend"
                value={
                  paybackDelta === null
                    ? "-"
                    : `${paybackDelta >= 0 ? "+" : "−"}${Math.abs(
                        paybackDelta,
                      ).toFixed(2)}×`
                }
              />
              <Kpi
                label="Cohort signups"
                value={hasCohorts ? num(totalSignups) : "-"}
              />
            </KpiStrip>

            {}
            <AttentionList items={attention} />

            <GrowthBetDecisionQueue
              bets={bets}
              selectedBetId={selectedBetId}
              onSelectBet={setSelectedBetId}
              onReview={openApprovals}
              onAsk={askGrowthLead}
              onDraftNext={draftNextBet}
              autopilotEnabled={d.autopilot_enabled}
              onTurnOnAutopilot={openAutopilot}
            />

            {}
            <section>
              <SectionTitle>LTV per signup · by cohort</SectionTitle>
              {!hasCohorts ? (
                <div className="rounded-xl border border-dashed border-[#f0f0f0] px-4 py-3 text-[12px] text-[#595959]">
                  {cohorts?.connected
                    ? "No cohort revenue yet for the recent window."
                    : "Connect Stripe to see revenue-per-signup cohorts and payback."}
                </div>
              ) : (
                <div className="rounded-3xl border border-[#f0f0f0] bg-white px-4 py-4">
                  {}
                  <div className="mb-3 flex flex-wrap items-center gap-4 text-[12px] text-[#595959]">
                    <span className="flex items-center gap-2">
                      <span
                        className="inline-block h-3 w-3 rounded-sm"
                        style={{ background: BAND_COLOR.profitable }}
                        aria-hidden="true"
                      />
                      Profitable (≥ 1.0×)
                    </span>
                    <span className="flex items-center gap-2">
                      <span
                        className="inline-block h-3 w-3 rounded-sm"
                        style={{ background: BAND_COLOR.recovering }}
                        aria-hidden="true"
                      />
                      Recovering (0.7–1.0×)
                    </span>
                    <span className="flex items-center gap-2">
                      <span
                        className="inline-block h-3 w-3 rounded-sm"
                        style={{ background: BAND_COLOR.underwater }}
                        aria-hidden="true"
                      />
                      Underwater (&lt; 0.7×)
                    </span>
                  </div>
                  <CohortLtvChart rows={rows} />
                  <div className="mt-2 flex items-center gap-2 text-[11px] text-[#8a8a8a]">
                    <span aria-hidden="true">●</span>
                    Dot color = payback band (labeled above, never color-only).
                  </div>
                </div>
              )}
            </section>

            {}
            <section>
              <SectionTitle>Cohorts ranked by payback</SectionTitle>
              {!hasCohorts ? (
                <div className="rounded-xl border border-dashed border-[#f0f0f0] px-4 py-3 text-[12px] text-[#595959]">
                  {cohorts?.connected
                    ? "No cohort revenue yet for the recent window."
                    : "Connect Stripe to see revenue-per-signup cohorts and payback."}
                </div>
              ) : (
                <div className="overflow-hidden rounded-3xl border border-[#f0f0f0] bg-white">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="border-b border-[#f0f0f0] text-left text-[11px] uppercase tracking-wide text-[#8a8a8a]">
                        <th className="px-3 py-2.5 font-medium">Cohort</th>
                        <th className="px-3 py-2.5 text-right font-medium">
                          Signups
                        </th>
                        <th className="px-3 py-2.5 text-right font-medium">
                          Revenue
                        </th>
                        <th className="px-3 py-2.5 text-right font-medium">
                          Rev / signup
                        </th>
                        <th className="px-3 py-2.5 text-right font-medium">
                          Payback
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {}
                      {[...rows]
                        .sort((a, b) => {
                          const pa = a.payback_ratio;
                          const pb = b.payback_ratio;
                          if (pa === null && pb === null) return 0;
                          if (pa === null) return 1;
                          if (pb === null) return -1;
                          return pb - pa;
                        })
                        .map((r) => {
                          const band = bandOf(r.payback_ratio);
                          return (
                            <tr
                              key={r.cohort}
                              className="border-b border-[#f0f0f0] last:border-0"
                            >
                              <td className="px-3 py-2.5 font-medium text-[#0e0f11]">
                                {r.cohort}
                              </td>
                              <td className="px-3 py-2.5 text-right tabular-nums text-[#595959]">
                                {num(r.signups)}
                              </td>
                              <td className="px-3 py-2.5 text-right tabular-nums text-[#595959]">
                                {usd(r.revenue)}
                              </td>
                              <td className="px-3 py-2.5 text-right tabular-nums text-[#595959]">
                                {usdCents(r.revenue_per_signup)}
                              </td>
                              <td className="px-3 py-2.5 text-right tabular-nums">
                                {band === null ? (
                                  "-"
                                ) : (
                                  <Pill tone={BAND_PILL[band]}>
                                    <span aria-hidden="true">
                                      {BAND_GLYPH[band]}
                                    </span>{" "}
                                    {ratio(r.payback_ratio)} {band}
                                  </Pill>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-1.5 flex items-center gap-2 text-[11px] text-[#8a8a8a]">
                <span aria-hidden="true">🔒</span>
                Payback shows “—” until a blended CAC is supplied (it isn’t
                fabricated). Bets are gated: growth-lead never auto-dispatches
                spend. Ask in chat to factor in your CAC and draft a rebalance
                bet.
              </p>

              {}
              <p className="mt-1 text-[11px] text-[#a8a8a8]">
                Per-cohort channel-mix attribution (paid/organic/referral split),
                blended CAC, and LTV-90d aren’t wired to this panel yet. They’d
                need a signup→channel join we don’t store. Ask growth-lead in
                chat for the channel breakdown.
              </p>
            </section>

            {}
            {funnel?.connected && steps.length > 0 && (
              <section>
                <SectionTitle>Funnel (AARRR)</SectionTitle>
                <div className="flex flex-col gap-2.5 rounded-3xl border border-[#f0f0f0] bg-white px-4 py-4">
                  {steps.map((s, i) => {
                    const width =
                      maxCount > 0
                        ? Math.max(4, Math.round((s.count / maxCount) * 100))
                        : 4;
                    return (
                      <div key={`${s.event}-${i}`}>
                        <div className="mb-1 flex items-center justify-between gap-2 text-[12px]">
                          <span className="flex items-center gap-2 font-medium capitalize text-[#0e0f11]">
                            {s.event.replace(/_/g, " ")}
                            {s.is_bottleneck && (
                              <Pill tone="bad">
                                <span aria-hidden="true">▲</span>{" "}
                                {s.drop_from_prev_pct !== null
                                  ? `${s.drop_from_prev_pct}% drop`
                                  : "biggest drop"}
                              </Pill>
                            )}
                          </span>
                          <span className="shrink-0 tabular-nums text-[#595959]">
                            {num(s.count)}
                            {s.conversion_from_prev !== null && i > 0 && (
                              <span className="ml-2 text-[11px] text-[#8a8a8a]">
                                {pct(s.conversion_from_prev)} from prev
                              </span>
                            )}
                          </span>
                        </div>
                        <div className="h-2.5 w-full overflow-hidden rounded-full bg-[#f0f0f0]">
                          <div
                            className={`h-full rounded-full ${
                              s.is_bottleneck ? "bg-[#cb2029]" : "bg-[#8a8a8a]"
                            }`}
                            style={{ width: `${width}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                  {funnel.total_events_in_window !== null && (
                    <div className="mt-1 text-[11px] text-[#8a8a8a]">
                      {num(funnel.total_events_in_window)} events in window
                      {funnel.diagnosis_source
                        ? ` · source: ${funnel.diagnosis_source.replace(/_/g, " ")}`
                        : ""}
                    </div>
                  )}
                </div>
              </section>
            )}
          </>
        );
      }}
    />
  );
}
