"use client";

import type { ReactNode, JSX } from "react";
import {
  ExternalLink,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import { useWorkspaceOptional } from "../WorkspaceShell";
import {
  useAgentDashboard,
  DashboardShell,
  AttentionList,
  EmptyState,
  ago,
  btn,
  type AttentionItem,
} from "./dashboard-ui";

type PrStatus = "open" | "merged" | "proposed" | "unknown";

type WarnFlag =
  | "tests_warning"
  | "wiring_unverified"
  | "completeness_unverified";

type Typecheck = "green" | "red" | "not_reported";
type PrSignals = {
  risk_class: "trivial" | "low" | "medium" | null;
  typecheck: Typecheck;
  tests: { passed: number; failed: number; ran: boolean };
};

type PrRow = {
  run_id: string;
  number: number | null;
  title: string;
  repo: string;
  status: PrStatus;
  url: string | null;
  opened_at: string | null;
  warn_flags: WarnFlag[];
  signals?: PrSignals;
};

type Payload = {
  generic?: boolean;
  connected: boolean;
  kpis: {
    opened_30d: number;
    merged: number;
    awaiting_merge: number;
    unknown_state: number;
    no_pr_runs: number;
  };
  attention: AttentionItem[];
  prs: PrRow[];
};

const GOOD = "#059669";
const WARN = "#d97706";
const BAD = "#dc2626";

type Tone = "good" | "warn" | "bad" | "neutral";

const TONE: Record<Tone, string> = {
  good: "bg-emerald-500/15 text-emerald-600",
  warn: "bg-amber-500/15 text-amber-600",
  bad: "bg-red-500/10 text-red-600",
  neutral: "bg-bone text-inkMuted",
};

const CARD = "rounded-2xl border border-rule bg-cream";

const STAMP_DEFS: { key: WarnFlag; label: string }[] = [
  { key: "tests_warning", label: "Tests" },
  { key: "wiring_unverified", label: "Wiring" },
  { key: "completeness_unverified", label: "Complete" },
];

type Verdict = "passed" | "caveat" | "quarantine";

function verdictOf(p: PrRow): Verdict {
  if (p.warn_flags.length === 0) return "passed";
  return p.status === "merged" ? "caveat" : "quarantine";
}

function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
function AlertIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    </svg>
  );
}
function NeutralIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.6}
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="7" />
    </svg>
  );
}

function SectionHead({ title, sub }: { title: string; sub?: ReactNode }) {
  return (
    <div className="mb-3">
      <h3 className="text-[16px] font-semibold tracking-tight text-ink">{title}</h3>
      {sub ? <p className="mt-0.5 text-[16px] text-inkMuted">{sub}</p> : null}
    </div>
  );
}

function AskHint({ text, ask }: { text: string; ask: ((t: string) => void) | null }) {
  if (!ask) {
    return (
      <p className="text-[13px] text-inkMuted">
        Ask in chat: <span className="text-ink">“{text}”</span>
      </p>
    );
  }
  return (
    <button
      type="button"
      onClick={() => ask(text)}
      title={`Ask in chat: “${text}”`}
      className="group inline-flex w-fit max-w-[min(100%,26rem)] cursor-pointer items-center gap-2 rounded-cta border border-rule bg-cream px-3 py-1.5 text-left text-[13px] text-inkMuted transition-colors hover:border-ink/40 hover:bg-creamDeep"
    >
      <MessageSquare className="h-3.5 w-3.5 shrink-0 text-inkSoft" aria-hidden />
      <span className="min-w-0 truncate leading-5">
        Ask in chat: <span className="font-medium text-ink">“{text}”</span>
      </span>
    </button>
  );
}

function PrLink({
  href,
  children,
  className = "",
  icon = true,
}: {
  href: string | null;
  children: ReactNode;
  className?: string;
  icon?: boolean;
}) {
  if (!href) return <span className={className}>{children}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`group inline text-ink underline decoration-inkMuted/60 decoration-1 underline-offset-[3px] transition-colors hover:decoration-ink ${className}`}
    >
      {children}
      {icon && <ExternalLink className="ml-1 inline h-3.5 w-3.5 -translate-y-px align-middle text-inkMuted group-hover:text-ink" aria-hidden />}
    </a>
  );
}

function useAskEngineer(): ((t: string) => void) | null {
  const ws = useWorkspaceOptional();
  if (!ws) return null;
  return (text: string) => ws.seedComposer({ agentSlug: "engineer", text });
}

function EngineerAttention({ items, ask }: { items: AttentionItem[]; ask: ((t: string) => void) | null }) {
  if (items.length === 0) return null;
  if (items.some((a) => a.decision_id)) return <AttentionList items={items} />;
  return (
    <section>
      <SectionHead title="Needs your attention" />
      <ul className={`${CARD} divide-y divide-rule overflow-hidden`}>
        {items.map((a, i) => (
          <li key={i} className="flex items-start gap-3 px-4 py-3.5">
            <span
              className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${
                a.severity === "high" ? TONE.bad : TONE.warn
              }`}
              aria-hidden="true"
            >
              <AlertIcon className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold leading-5 text-ink">{a.title}</p>
              <p className="mt-0.5 text-[16px] leading-relaxed text-inkMuted">{a.detail}</p>
              <div className="mt-1.5">
                <AskHint text={a.ask} ask={ask} />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StampGrid({ p }: { p: PrRow }) {
  const notInspected = p.status === "proposed";
  return (
    <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-2">
      {STAMP_DEFS.map((s) => {
        const flagged = p.warn_flags.includes(s.key);
        const tone: Tone = notInspected ? "neutral" : flagged ? "bad" : "good";
        return (
          <div
            key={s.key}
            className="flex items-center gap-2.5 rounded-xl border border-rule bg-creamDeep px-3 py-2"
          >
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${TONE[tone]}`}
              aria-hidden="true"
            >
              {notInspected ? (
                <NeutralIcon className="h-3 w-3" />
              ) : flagged ? (
                <AlertIcon className="h-3 w-3" />
              ) : (
                <CheckIcon className="h-3 w-3" />
              )}
            </span>
            <div className="min-w-0 leading-5">
              <div className="text-[12px] text-inkMuted">{s.label}</div>
              <div
                className={`text-[13px] font-semibold ${notInspected ? "text-inkMuted" : ""}`}
                style={notInspected ? undefined : { color: flagged ? BAD : GOOD }}
              >
                {notInspected ? "n/a" : flagged ? "Flagged" : "Pass"}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Chip({
  tone,
  label,
  Icon,
}: {
  tone: "good" | "bad" | "neutral";
  label: string;
  Icon: ({ className }: { className?: string }) => JSX.Element;
}) {
  return (
    <span
      className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[13px] font-medium ${TONE[tone]}`}
    >
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}

function riskTone(rc: PrSignals["risk_class"]): "good" | "neutral" {
  return rc === "trivial" ? "good" : "neutral";
}

function SignalChips({ s }: { s: PrSignals }) {
  const chips: JSX.Element[] = [];

  if (s.risk_class) {
    chips.push(
      <Chip
        key="risk"
        tone={riskTone(s.risk_class)}
        label={`Risk: ${s.risk_class}`}
        Icon={s.risk_class === "trivial" ? CheckIcon : NeutralIcon}
      />,
    );
  }

  if (s.typecheck === "green") {
    chips.push(
      <Chip key="tc" tone="good" label="Typecheck green" Icon={CheckIcon} />,
    );
  } else if (s.typecheck === "red") {
    chips.push(<Chip key="tc" tone="bad" label="Typecheck red" Icon={AlertIcon} />);
  } else {
    chips.push(
      <Chip key="tc" tone="neutral" label="Typecheck not captured" Icon={NeutralIcon} />,
    );
  }

  if (s.tests.ran) {
    const allPass = s.tests.failed === 0;
    const total = s.tests.passed + s.tests.failed;
    chips.push(
      <Chip
        key="tests"
        tone={allPass ? "good" : "bad"}
        label={`Tests ${s.tests.passed}/${total}`}
        Icon={allPass ? CheckIcon : AlertIcon}
      />,
    );
  } else {
    chips.push(
      <Chip key="tests" tone="neutral" label="No sandbox test run" Icon={NeutralIcon} />,
    );
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {chips}
      <span className="ml-1 text-[12px] text-inkMuted">agent-reported · not CI</span>
    </div>
  );
}

function SignalCell({ s }: { s: PrSignals }) {
  const tcLabel =
    s.typecheck === "green"
      ? "tsc green"
      : s.typecheck === "red"
        ? "tsc red"
        : "tsc n/a";
  const tcColor =
    s.typecheck === "green" ? GOOD : s.typecheck === "red" ? BAD : undefined;
  const testsLabel = s.tests.ran
    ? `tests ${s.tests.passed}/${s.tests.passed + s.tests.failed}`
    : "tests n/a";
  const testsColor = s.tests.ran
    ? s.tests.failed === 0
      ? GOOD
      : BAD
    : undefined;
  return (
    <div className="flex flex-col text-[13px] leading-5 text-inkMuted">
      <span style={{ color: tcColor }}>{tcLabel}</span>
      <span style={{ color: testsColor }}>{testsLabel}</span>
      <span>{s.risk_class ? `risk ${s.risk_class}` : "risk n/a"}</span>
    </div>
  );
}

const VERDICT_STAMP: Record<
  Verdict,
  { label: string; tone: Tone; Icon: typeof CheckIcon }
> = {
  quarantine: { label: "Quarantined", tone: "bad", Icon: AlertIcon },
  caveat: { label: "Merged · caveat", tone: "warn", Icon: AlertIcon },
  passed: { label: "Passed all gates", tone: "good", Icon: CheckIcon },
};

function StatusStamp({ verdict }: { verdict: Verdict }) {
  const map = VERDICT_STAMP[verdict];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-2.5 py-1 text-[13px] font-semibold ${TONE[map.tone]}`}
    >
      <map.Icon className="h-3 w-3" />
      {map.label}
    </span>
  );
}

function WarrantyCard({ p, ask }: { p: PrRow; ask: ((t: string) => void) | null }) {
  const verdict = verdictOf(p);
  const stripColor =
    verdict === "quarantine" ? BAD : verdict === "caveat" ? WARN : GOOD;
  const flaggedLabels = p.warn_flags
    .map((f) => STAMP_DEFS.find((s) => s.key === f)?.label ?? f)
    .join(" · ");
  return (
    <div className={`${CARD} flex flex-col overflow-hidden`}>
      <div className="h-1" style={{ backgroundColor: stripColor }} />
      <div className="flex flex-1 flex-col px-4 pb-5 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[16px] font-semibold leading-6 text-ink">
              <PrLink href={p.url}>{p.title || "(untitled)"}</PrLink>
            </div>
            <div className="mt-1 text-[13px] tabular-nums text-inkMuted">
              {p.number != null ? `PR #${p.number}` : "Proposed PR"} · {p.repo} ·
              run {p.run_id.slice(0, 8)}
              {p.opened_at ? ` · ${ago(p.opened_at)}` : ""}
            </div>
          </div>
          <StatusStamp verdict={verdict} />
        </div>

        <StampGrid p={p} />

        {}
        {p.status !== "proposed" && p.signals && <SignalChips s={p.signals} />}

        {p.warn_flags.length > 0 && (
          <div
            className={`mt-3 flex items-start gap-2 rounded-xl px-3 py-2.5 text-[13px] leading-5 ${
              verdict === "caveat" ? TONE.warn : TONE.bad
            }`}
          >
            <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {verdict === "caveat" ? (
                <>
                  <b className="font-semibold">Shipped with a caveat.</b> Merged
                  despite a red stamp on: {flaggedLabels}. Worth a glance at the
                  diff so you know what&apos;s running.
                </>
              ) : (
                <>
                  <b className="font-semibold">Held at the gate.</b> Red stamp
                  on: {flaggedLabels}. Review the diff before you merge.
                </>
              )}
            </span>
          </div>
        )}

        <div className="mt-auto pt-3">
          <AskHint
            ask={ask}
            text={
              p.number != null
                ? `show me the diff for PR #${p.number} before I merge`
                : "open the proposed PR and show me the diff"
            }
          />
        </div>
      </div>
    </div>
  );
}

function PassRateDonut({
  passed,
  caveat,
  quarantine,
}: {
  passed: number;
  caveat: number;
  quarantine: number;
}) {
  const total = passed + caveat + quarantine;
  const r = 44;
  const circ = 2 * Math.PI * r;
  const passPct = total > 0 ? passed / total : 0;
  const cavPct = total > 0 ? caveat / total : 0;
  const quarPct = total > 0 ? quarantine / total : 0;
  const ratePct = Math.round(passPct * 100);

  const passLen = passPct * circ;
  const cavLen = cavPct * circ;
  const quarLen = quarPct * circ;

  const segs: { len: number; off: number; color: string }[] = [
    { len: passLen, off: 0, color: GOOD },
    { len: cavLen, off: -passLen, color: WARN },
    { len: quarLen, off: -(passLen + cavLen), color: BAD },
  ];

  return (
    <div className="flex flex-wrap items-center gap-5">
      <div className="relative shrink-0">
        <svg
          width="104"
          height="104"
          viewBox="0 0 104 104"
          role="img"
          aria-label={`Gate pass rate: ${ratePct} percent of ${total} inspected PRs passed all four quality gates clean`}
        >
          <circle
            cx="52"
            cy="52"
            r={r}
            fill="none"
            className="stroke-bone"
            strokeWidth="12"
          />
          {segs.map((s, i) =>
            s.len > 0 ? (
              <circle
                key={i}
                cx="52"
                cy="52"
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth="12"
                strokeDasharray={`${s.len} ${circ - s.len}`}
                strokeDashoffset={s.off}
                transform="rotate(-90 52 52)"
                strokeLinecap="butt"
              />
            ) : null,
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[22px] font-bold leading-7 tabular-nums text-ink">
            {total > 0 ? `${ratePct}%` : "0%"}
          </span>
          <span className="text-[12px] text-inkMuted">passed</span>
        </div>
      </div>
      <div className="min-w-[160px] flex-1">
        <div className="text-[14px] font-semibold text-ink">
          Gate pass rate
        </div>
        <div className="mt-1 text-[13px] leading-5 text-inkMuted">
          Share of the last {total} inspected PR{total === 1 ? "" : "s"} that
          passed all four stamps clean.
        </div>
        <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] text-inkMuted">
          {(
            [
              [GOOD, `Passed clean (${passed})`],
              [WARN, `Caveat (${caveat})`],
              [BAD, `Quarantined (${quarantine})`],
            ] as const
          ).map(([color, label]) => (
            <span key={label} className="flex items-center gap-2 whitespace-nowrap">
              <i
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: color }}
              />
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function LedgerKpi({
  num,
  label,
  sub,
  flag,
  icon: Icon,
}: {
  num: string;
  label: string;
  sub: string;
  flag?: boolean;
  icon: LucideIcon;
}) {
  return (
    <div className={`${CARD} flex min-w-[150px] flex-1 flex-col px-4 py-4`}>
      <div className="flex items-center gap-2 whitespace-nowrap text-[16px] font-medium leading-5 text-inkMuted">
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
            flag ? TONE.bad : "bg-creamDeep text-inkSoft"
          }`}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden />
        </span>
        <span className="min-w-0 truncate" title={label}>{label}</span>
      </div>
      <div
        className={`mt-2.5 text-[28px] font-bold leading-8 tracking-tight tabular-nums ${
          flag ? "" : num === "0" ? "text-inkMuted" : "text-ink"
        }`}
        style={flag ? { color: BAD } : undefined}
      >
        {num}
      </div>
      <div
        className={`mt-1 text-[13px] leading-5 ${flag ? "" : "text-inkMuted"}`}
        style={flag ? { color: BAD } : undefined}
      >
        {sub}
      </div>
    </div>
  );
}

function MiniStamp({
  state,
  title,
}: {
  state: "pass" | "fail" | "na";
  title: string;
}) {
  const tone: Tone = state === "pass" ? "good" : state === "fail" ? "bad" : "neutral";
  return (
    <span
      title={title}
      aria-label={title}
      className={`flex h-6 w-6 items-center justify-center rounded-md ${TONE[tone]}`}
    >
      {state === "pass" ? (
        <CheckIcon className="h-3 w-3" />
      ) : state === "fail" ? (
        <AlertIcon className="h-3 w-3" />
      ) : (
        <NeutralIcon className="h-3 w-3" />
      )}
    </span>
  );
}

function VerdictLabel({ verdict }: { verdict: Verdict }) {
  const map = {
    passed: { label: "Passed", fg: GOOD, Icon: CheckIcon },
    caveat: { label: "Caveat", fg: WARN, Icon: AlertIcon },
    quarantine: { label: "Quarantine", fg: BAD, Icon: AlertIcon },
  }[verdict];
  return (
    <span
      className="inline-flex items-center gap-2 whitespace-nowrap text-[13px] font-semibold"
      style={{ color: map.fg }}
    >
      <map.Icon className="h-3 w-3" />
      {map.label}
    </span>
  );
}

function StatusBadge({ status }: { status: PrStatus }) {
  const map: Record<PrStatus, { label: string; tone: Tone; Icon: typeof CheckIcon | null }> = {
    merged: { label: "Merged", tone: "good", Icon: CheckIcon },
    open: { label: "Open", tone: "neutral", Icon: null },
    proposed: { label: "Proposed", tone: "neutral", Icon: null },
    unknown: { label: "Unknown", tone: "neutral", Icon: null },
  };
  const m = map[status];
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[13px] font-semibold ${TONE[m.tone]}`}
    >
      {m.Icon ? <m.Icon className="h-3 w-3" /> : null}
      {m.label}
    </span>
  );
}

const TH = "whitespace-nowrap bg-creamDeep px-3 py-2.5 text-left align-middle text-[16px] font-semibold text-inkMuted";
const TD = "px-3 py-3 align-middle";

const connectFallback = (
  <EmptyState title="Connect GitHub, then ask the engineer to open your first PR">
    Once GitHub is connected and you ask the engineer for a change, this ledger
    stamps every pull request it opens with three quality marks (tests,
    wiring, completeness) and flags the ones held at the gate. Connect under
    Settings → Connections, or ask the agent in chat to walk you through it.
  </EmptyState>
);

export function EngineerDashboard() {
  const state = useAgentDashboard<Payload>("engineer");
  const ask = useAskEngineer();
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[20px] font-semibold leading-7 tracking-tight text-ink">
            Quality Warranty Ledger
          </h2>
          <p className="mt-0.5 text-[16px] text-inkMuted">
            Every PR stamped at the gate. Red stamps are quarantined until you sign off.
          </p>
        </div>
        <button
          type="button"
          onClick={state.refresh}
          disabled={state.refreshing}
          className={`${btn.secondary} shrink-0`}
        >
          {state.refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <DashboardShell
        state={state}
        genericFallback={connectFallback}
        render={(d) => {
          if (!d.connected) return connectFallback;
          const k = d.kpis;

          const quarantined = d.prs.filter((p) => verdictOf(p) === "quarantine");
          const caveats = d.prs.filter((p) => verdictOf(p) === "caveat");
          const passedClean = d.prs.filter((p) => verdictOf(p) === "passed");

          return (
            <div className="flex flex-col gap-7">
              {}
              <EngineerAttention items={d.attention} ask={ask} />

              {}
              <section className="flex flex-wrap gap-3">
                <div className={`${CARD} min-w-[300px] flex-[3] px-4 py-4`}>
                  <PassRateDonut
                    passed={passedClean.length}
                    caveat={caveats.length}
                    quarantine={quarantined.length}
                  />
                </div>
                <div className="flex min-w-[280px] flex-[5] flex-wrap gap-3">
                  <LedgerKpi
                    icon={GitPullRequest}
                    num={String(k.opened_30d)}
                    label="Opened · 30d"
                    sub={`${k.no_pr_runs} run${
                      k.no_pr_runs === 1 ? "" : "s"
                    } shipped no PR`}
                  />
                  <LedgerKpi
                    icon={GitMerge}
                    num={String(k.merged)}
                    label="Merged"
                    sub={
                      k.unknown_state > 0
                        ? `Confirmed. ${k.unknown_state} unknown`
                        : `Confirmed. ${caveats.length} with a caveat`
                    }
                    flag={k.unknown_state > 0}
                  />
                  <LedgerKpi
                    icon={ShieldAlert}
                    num={String(quarantined.length)}
                    label="Quarantined"
                    sub="Red stamp · needs sign-off"
                    flag={quarantined.length > 0}
                  />
                </div>
              </section>

              {}
              {quarantined.length > 0 && (
                <section>
                  <SectionHead
                    title="Quarantine bay: review before these ship"
                    sub="PRs with a red stamp (tests warning · wiring unverified · completeness unconfirmed). Held at the gate."
                  />
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] gap-3">
                    {quarantined.map((p) => (
                      <WarrantyCard key={p.run_id} p={p} ask={ask} />
                    ))}
                  </div>
                </section>
              )}

              {}
              {caveats.length > 0 && (
                <section>
                  <SectionHead
                    title="Warranty caveats: merged, but not clean"
                    sub="Shipped to prod despite a red/amber stamp. Review the diff so you know what's running."
                  />
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] gap-3">
                    {caveats.map((p) => (
                      <WarrantyCard key={p.run_id} p={p} ask={ask} />
                    ))}
                  </div>
                </section>
              )}

              {}
              <section>
                <SectionHead title="Inspection ledger" sub="Every PR the engineer opened, newest first." />
                {d.prs.length === 0 ? (
                  <EmptyState title="No pull requests yet">
                    Ask the engineer in chat to make a change. The PRs it opens
                    show up here, stamped, the moment they land.
                  </EmptyState>
                ) : (
                  <div className={`${CARD} overflow-x-auto`}>
                    <table className="w-full min-w-[720px] text-[16px]">
                      <thead>
                        <tr className="border-b border-rule">
                          <th className={TH}>PR</th>
                          <th className={`${TH} w-full`}>Pull request</th>
                          <th className={TH}>Stamps</th>
                          <th className={TH}>Signals</th>
                          <th className={TH}>Verdict</th>
                          <th className={TH}>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.prs.map((p) => {
                          const notInspected = p.status === "proposed";
                          return (
                            <tr
                              key={p.run_id}
                              className="border-b border-rule transition-colors last:border-0 hover:bg-creamDeep/50"
                            >
                              <td className={`${TD} whitespace-nowrap font-semibold tabular-nums`}>
                                {p.number != null ? (
                                  <PrLink href={p.url} icon={false}>#{p.number}</PrLink>
                                ) : (
                                  <span className="font-medium text-inkMuted">New</span>
                                )}
                              </td>
                              <td className={`${TD} min-w-[180px]`}>
                                <div className="font-semibold leading-5 text-ink">
                                  <PrLink href={p.url}>{p.title || "(untitled)"}</PrLink>
                                </div>
                                <div className="mt-0.5 text-[13px] text-inkMuted">
                                  {p.repo}
                                  {p.opened_at ? ` · opened ${ago(p.opened_at)}` : ""}
                                </div>
                              </td>
                              <td className={TD}>
                                <div className="flex gap-1">
                                  {STAMP_DEFS.map((s) => (
                                    <MiniStamp
                                      key={s.key}
                                      state={
                                        notInspected
                                          ? "na"
                                          : p.warn_flags.includes(s.key)
                                            ? "fail"
                                            : "pass"
                                      }
                                      title={`${s.label}: ${
                                        notInspected
                                          ? "not inspected"
                                          : p.warn_flags.includes(s.key)
                                            ? "flagged"
                                            : "passed"
                                      }`}
                                    />
                                  ))}
                                </div>
                              </td>
                              <td className={`${TD} whitespace-nowrap`}>
                                {notInspected || !p.signals ? (
                                  <span className="text-[13px] text-inkMuted">Not run</span>
                                ) : (
                                  <SignalCell s={p.signals} />
                                )}
                              </td>
                              <td className={TD}>
                                {notInspected ? (
                                  <span className="whitespace-nowrap text-[13px] font-semibold text-inkMuted">
                                    Not inspected
                                  </span>
                                ) : (
                                  <VerdictLabel verdict={verdictOf(p)} />
                                )}
                              </td>
                              <td className={TD}>
                                <StatusBadge status={p.status} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {}
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 px-1 text-[13px] text-inkMuted">
                  <span className="flex items-center gap-2">
                    <MiniStamp state="pass" title="Passed gate" /> Passed gate
                  </span>
                  <span className="flex items-center gap-2">
                    <MiniStamp state="fail" title="Flagged gate" /> Flagged / held
                  </span>
                  <span className="flex items-center gap-2">
                    <MiniStamp state="na" title="Not run" /> Not inspected
                  </span>
                  <span>Stamp order: Tests · Wiring · Completeness</span>
                </div>

                <p className="mt-2 px-1 text-[13px] text-inkMuted">
                  Auto-merge stays gated on you. To merge or review a PR, ask the
                  engineer in the chat on the right.
                </p>
                {}
              </section>
            </div>
          );
        }}
      />
    </div>
  );
}
