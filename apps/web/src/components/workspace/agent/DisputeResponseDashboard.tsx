"use client";

import {
  useAgentDashboard,
  DashboardShell,
  SectionTitle,
  EmptyState,
} from "./dashboard-ui";
import { useWorkspace } from "../WorkspaceShell";
import { NextChevron } from "@/components/ui/NextChevron";

export const C = {
  ink: "#0e0f11",
  muted: "#595959",
  good: "#167f50",
  bad: "#cb2029",
  warn: "#8a6d00",
  border: "#f0f0f0",
  soft: "#f7f4ee",
  blue: "#027bff",
  neutralBg: "#f7f4ee",
  warnBg: "#fbf3d6",
  warnBorder: "#ecdca0",
  badBg: "#fdeaea",
  badBorder: "#f3c9cb",
} as const;

export type Ce3Status = "qualified" | "requires_action" | "not_qualified" | "n/a";

export type OpenDispute = {
  id: string;
  amount_usd: number;
  currency: string;
  reason: string;
  due_by: number | null;
  past_due: boolean;
  has_evidence?: boolean;
  submission_count?: number;
  ce3_status?: Ce3Status;
  ce3_required_actions?: string[];
};

type ReasonBucket = {
  reason: string;
  count: number;
  total_usd: number;
  won: number;
  resolved: number;
  win_rate: number | null;
};

export type Payload = {
  generic?: boolean;
  connected: boolean;
  kpis: {
    open_count: number;
    amount_at_risk_usd: number;
    win_rate: number | null;
    resolved_count: number;
    recovered_usd: number;
  };
  open: OpenDispute[];
  by_reason: ReasonBucket[];
  attention?: unknown[];
};

export function reasonMeta(reason: string): { label: string; dot: string } {
  switch (reason) {
    case "fraudulent":
      return { label: "Fraud (Visa 10.4)", dot: C.bad };
    case "product_not_received":
      return { label: "Not received", dot: C.warn };
    case "product_unacceptable":
      return { label: "Product unacceptable", dot: C.blue };
    case "duplicate":
      return { label: "Duplicate", dot: C.muted };
    default:
      return { label: (reason || "Other").replace(/_/g, " "), dot: C.muted };
  }
}

export function usd(n: number): string {
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function winRateText(rate: number | null, resolved: number): string {
  if (rate === null || resolved < 5) return "-";
  return `${Math.round(rate * 100)}%`;
}

export function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 16)}…` : id;
}

export type DeadlineTone = "neutral" | "warn" | "bad";
export function deadline(d: OpenDispute): {
  label: string;
  tone: DeadlineTone;
  caption: string;
} {
  const now = Math.floor(Date.now() / 1000);
  if (d.past_due || (d.due_by != null && d.due_by <= now)) {
    return { label: "Past due", tone: "bad", caption: "Filing window closed" };
  }
  if (d.due_by == null) {
    return { label: "No deadline", tone: "neutral", caption: "" };
  }
  const secs = d.due_by - now;
  const under72h = secs < 72 * 3600;
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  const label =
    days >= 1 ? `${days}d ${hours}h` : hours >= 1 ? `${hours}h ${mins}m` : `${mins}m`;
  return {
    label,
    tone: under72h ? "warn" : "neutral",
    caption: under72h ? "Closes soon" : "to file",
  };
}

function urgencyKey(d: OpenDispute): number {
  if (d.past_due) return -Infinity;
  return d.due_by == null ? Infinity : d.due_by;
}

export function DeadlinePill({
  tone,
  label,
  caption,
}: {
  tone: DeadlineTone;
  label: string;
  caption: string;
}) {
  const style =
    tone === "bad"
      ? { bg: C.badBg, color: C.bad, border: C.badBorder }
      : tone === "warn"
        ? { bg: C.warnBg, color: C.warn, border: C.warnBorder }
        : { bg: C.neutralBg, color: C.muted, border: C.border };
  const srPrefix =
    tone === "bad" ? "Past due: " : tone === "warn" ? "Closing soon: " : "";
  return (
    <div className="flex flex-col items-end gap-1 text-right">
      <span
        className="inline-flex items-center gap-2 rounded-lg px-2.5 py-1 text-[13px] font-bold tabular-nums"
        style={{
          background: style.bg,
          color: style.color,
          border: `1px solid ${style.border}`,
        }}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke={style.color}
          strokeWidth="2"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        <span>
          {srPrefix ? <span className="sr-only">{srPrefix}</span> : null}
          {label}
        </span>
      </span>
      {caption ? (
        <span className="text-[11px] text-[#595959]">{caption}</span>
      ) : null}
    </div>
  );
}

export function Ce3Badge({ status }: { status: Ce3Status }) {
  if (status === "n/a") return null;
  const meta =
    status === "qualified"
      ? { label: "CE 3.0 qualified", bg: "#e9f5ee", color: C.good, border: "#c2e3d0", glyph: "check" as const }
      : status === "requires_action"
        ? { label: "CE 3.0: action needed", bg: C.warnBg, color: C.warn, border: C.warnBorder, glyph: "alert" as const }
        : { label: "CE 3.0 not eligible", bg: C.soft, color: C.muted, border: C.border, glyph: "dash" as const };
  return (
    <span
      className="inline-flex items-center gap-2 rounded-lg px-2.5 py-1 text-[12px] font-bold"
      style={{ background: meta.bg, color: meta.color, border: `1px solid ${meta.border}` }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={meta.color} strokeWidth="2.4" aria-hidden="true">
        {meta.glyph === "check" ? (
          <path d="M5 13l4 4L19 7" />
        ) : meta.glyph === "alert" ? (
          <>
            <path d="M12 8v5" />
            <path d="M12 16.5h.01" />
            <circle cx="12" cy="12" r="9" />
          </>
        ) : (
          <path d="M6 12h12" />
        )}
      </svg>
      {meta.label}
    </span>
  );
}

export function EvidenceChip({
  hasEvidence,
  submissionCount,
}: {
  hasEvidence: boolean;
  submissionCount: number;
}) {
  const filed = submissionCount > 0;
  const meta = filed
    ? { label: `Submitted${submissionCount > 1 ? ` ×${submissionCount}` : ""}`, color: C.muted, dot: C.muted }
    : hasEvidence
      ? { label: "Evidence staged", color: C.good, dot: C.good }
      : { label: "Evidence not started", color: C.warn, dot: C.warn };
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border px-2.5 py-[3px] text-[12px] font-semibold"
      style={{ background: C.soft, borderColor: C.border, color: meta.color }}
    >
      <span className="h-2 w-2 flex-none rounded-full" style={{ background: meta.dot }} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

export function EvidenceReadiness({ d }: { d: OpenDispute }) {
  const ce3 = d.ce3_status ?? "n/a";
  const gaps = d.ce3_required_actions ?? [];
  const hasEvidenceSignal =
    d.has_evidence !== undefined ||
    d.submission_count !== undefined ||
    ce3 !== "n/a";
  if (!hasEvidenceSignal) return null;
  return (
    <div
      className="flex flex-col gap-2.5 border-t pt-3"
      style={{ borderColor: C.border }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Ce3Badge status={ce3} />
        <EvidenceChip
          hasEvidence={d.has_evidence === true}
          submissionCount={d.submission_count ?? 0}
        />
      </div>
      {ce3 === "requires_action" && gaps.length > 0 ? (
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#595959]">
            To qualify for CE 3.0
          </div>
          <ul className="flex flex-col gap-1">
            {gaps.map((g, i) => (
              <li
                key={i}
                className="flex items-start gap-2 text-[12px] text-[#0e0f11]"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={C.warn}
                  strokeWidth="2.2"
                  aria-hidden="true"
                  className="mt-px flex-none"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v5M12 16.5h.01" />
                </svg>
                <span>{g}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function DisputeIdentity({ d }: { d: OpenDispute }) {
  const r = reasonMeta(d.reason);
  return (
    <div>
      <div
        className="font-mono text-[12px] tabular-nums text-[#595959]"
        title={d.id}
      >
        {shortId(d.id)}
      </div>
      <div className="mt-0.5 text-[24px] font-bold tracking-[-0.01em] tabular-nums text-[#0e0f11]">
        {usd(d.amount_usd)}
        {d.currency !== "USD" ? (
          <span className="ml-1.5 text-[12px] font-medium text-[#a8a8a8]">
            {d.currency}
          </span>
        ) : null}
      </div>
      <div
        className="mt-1.5 inline-flex items-center gap-2 rounded-full border px-2.5 py-[3px] text-[12px] font-semibold text-[#0e0f11]"
        style={{ background: C.soft, borderColor: C.border }}
      >
        <span
          className="h-2 w-2 flex-none rounded-full"
          style={{ background: r.dot }}
          aria-hidden="true"
        />
        {r.label}
      </div>
    </div>
  );
}

function QueueRow({
  d,
  onOpen,
}: {
  d: OpenDispute;
  onOpen: (d: OpenDispute) => void;
}) {
  const r = reasonMeta(d.reason);
  const dl = deadline(d);
  const urgent = dl.tone === "bad" || dl.tone === "warn";
  const reviewable = d.has_evidence === true || (d.submission_count ?? 0) > 0;
  const cta = reviewable ? "Review & download" : "Draft evidence";
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open dispute ${d.id}, ${usd(d.amount_usd)}, ${r.label}. ${cta}`}
      onClick={() => onOpen(d)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(d);
        }
      }}
      className="flex cursor-pointer items-start justify-between gap-4 rounded-3xl border bg-white px-4 py-[18px] text-left transition-colors hover:bg-[#faf9f6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#027bff]/40"
      style={{ borderColor: urgent ? C.badBorder : C.border }}
    >
      <div className="flex min-w-0 flex-col gap-3.5">
        <DisputeIdentity d={d} />
        <EvidenceReadiness d={d} />
      </div>
      <div className="flex flex-none flex-col items-end gap-3">
        <DeadlinePill tone={dl.tone} label={dl.label} caption={dl.caption} />
        <span
          className="inline-flex items-center gap-2 rounded-lg bg-ink px-3.5 py-1.5 text-[13px] font-semibold text-white"
          aria-hidden="true"
        >
          {cta}
          <NextChevron />
        </span>
      </div>
    </div>
  );
}

function winBarColor(p: number): string {
  return p >= 60 ? C.good : p >= 40 ? C.warn : C.bad;
}

export function DisputeResponseDashboard() {
  const state = useAgentDashboard<Payload>("dispute-response");
  const { openTab } = useWorkspace();

  function connectStripe() {
    openTab({
      kind: "settings",
      title: "Settings",
      payload: { kind: "settings" },
      dirty: false,
      pinned: false,
    });
    if (typeof window !== "undefined") {
      window.setTimeout(() => {
        window.location.hash = "connector-stripe";
      }, 80);
    }
  }

  const connectFallback = (
    <EmptyState
      title="Connect Stripe to open the docket"
      action={
        <button
          type="button"
          onClick={connectStripe}
          className="inline-flex items-center gap-2 rounded-cta bg-ink px-3.5 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-inkSoft"
        >
          Connect Stripe
        </button>
      }
    >
      Once Stripe is connected, every open chargeback shows up here in the
      queue, sorted by filing deadline, with the amount at risk and your win
      rate. Open a dispute to draft and download its evidence packet. Use a
      restricted key with Disputes (read + write) so drafts can be submitted on
      your approval.
    </EmptyState>
  );

  return (
    <DashboardShell
      title="Dispute Response"
      subtitle="Evidence Court: open chargebacks by deadline, and your win rate. Every Stripe submission is operator-gated."
      state={state}
      genericFallback={connectFallback}
      render={(d) => {
        if (!d.connected) return connectFallback;
        const k = d.kpis;
        const sorted = [...d.open].sort((a, b) => urgencyKey(a) - urgencyKey(b));
        const urgentDisputes = d.open.filter((dp) => {
          const dl = deadline(dp);
          return dl.tone === "warn" || dl.tone === "bad";
        });
        const closingSoon = urgentDisputes.length;
        const atRiskSoon = urgentDisputes.reduce(
          (sum, dp) => sum + dp.amount_usd,
          0,
        );
        const pastDueCount = d.open.filter((dp) => dp.past_due).length;

        const openDetail = (dp: OpenDispute) =>
          openTab({
            kind: "dispute-detail",
            title: `Dispute ${dp.id.slice(0, 10)}…`,
            payload: {
              kind: "dispute-detail",
              disputeId: dp.id,
              threadId: null,
            },
            dirty: false,
            pinned: false,
          });

        return (
          <div className="flex flex-col gap-6">
            {}
            {closingSoon > 0 || pastDueCount > 0 ? (
              <div
                role="status"
                className="flex items-start gap-2.5 rounded-3xl border px-4 py-3.5 text-[16px] font-semibold"
                style={
                  pastDueCount > 0
                    ? { background: C.badBg, borderColor: C.badBorder, color: C.bad }
                    : { background: C.warnBg, borderColor: C.warnBorder, color: C.warn }
                }
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                  className="mt-px flex-none"
                >
                  <path d="M12 9v4M12 17h.01" />
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                </svg>
                <span>
                  <span className="sr-only">
                    {pastDueCount > 0 ? "Urgent: " : "Heads up: "}
                  </span>
                  {pastDueCount > 0 ? `${pastDueCount} past due · ` : ""}
                  {closingSoon} {closingSoon === 1 ? "chargeback" : "chargebacks"}{" "}
                  closing soon · {usd(atRiskSoon)} at risk
                </span>
              </div>
            ) : null}

            {}
            <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-4">
              <div
                className="rounded-3xl border px-[18px] py-4"
                style={{ borderColor: C.border }}
              >
                <div className="mb-2 text-[12px] font-semibold text-[#595959]">
                  Open disputes
                </div>
                <div className="text-[26px] font-bold tabular-nums text-[#0e0f11]">
                  {k.open_count}
                </div>
                {closingSoon > 0 ? (
                  <div className="mt-1 text-[12px] tabular-nums text-[#595959]">
                    {closingSoon} closing soon
                  </div>
                ) : null}
              </div>
              <div
                className="rounded-3xl border px-[18px] py-4"
                style={{ borderColor: C.border }}
              >
                <div className="mb-2 text-[12px] font-semibold text-[#595959]">
                  Amount at risk
                </div>
                <div
                  className="text-[26px] font-bold tabular-nums"
                  style={{ color: C.bad }}
                >
                  {usd(k.amount_at_risk_usd)}
                </div>
                <div className="mt-1 text-[12px] tabular-nums text-[#595959]">
                  across {k.open_count} open
                </div>
              </div>
              <div
                className="rounded-3xl border px-[18px] py-4"
                style={{ borderColor: C.border }}
              >
                <div className="mb-2 text-[12px] font-semibold text-[#595959]">
                  Win rate · 90d
                </div>
                <div
                  className="text-[26px] font-bold tabular-nums"
                  style={{ color: C.good }}
                >
                  {winRateText(k.win_rate, k.resolved_count)}
                </div>
                <div className="mt-1 text-[12px] tabular-nums text-[#595959]">
                  {k.resolved_count} resolved
                </div>
              </div>
              <div
                className="rounded-3xl border px-[18px] py-4"
                style={{ borderColor: C.border }}
              >
                <div className="mb-2 text-[12px] font-semibold text-[#595959]">
                  Recovered · 90d
                </div>
                <div
                  className="text-[26px] font-bold tabular-nums"
                  style={{ color: C.good }}
                >
                  {usd(k.recovered_usd)}
                </div>
                <div className="mt-1 text-[12px] tabular-nums text-[#595959]">
                  {k.resolved_count} resolved
                </div>
              </div>
            </div>

            {}
            <section>
              <SectionTitle>Active docket · closing soonest</SectionTitle>
              {sorted.length === 0 ? (
                <EmptyState title="No open disputes">
                  Nothing needs a response right now. New chargebacks show up
                  here the moment Stripe fires them.
                </EmptyState>
              ) : (
                <div className="flex flex-col gap-3">
                  {sorted.map((dp) => (
                    <QueueRow key={dp.id} d={dp} onOpen={openDetail} />
                  ))}
                </div>
              )}
            </section>

            {}
            {d.by_reason.length > 0 ? (
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-[#595959] transition-colors hover:text-[#0e0f11]">
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    aria-hidden="true"
                    className="transition-transform group-open:rotate-90"
                  >
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                  By reason: what wins, what doesn&apos;t
                </summary>
                <div className="mt-3">
                <div
                  className="overflow-hidden rounded-3xl border bg-white"
                  style={{ borderColor: C.border }}
                >
                  <table className="w-full text-[16px]">
                    <thead>
                      <tr
                        className="text-left text-[11px] font-bold uppercase tracking-wide text-[#595959]"
                        style={{ borderBottom: `1px solid ${C.border}` }}
                      >
                        <th className="px-4 py-3 font-bold">Reason code</th>
                        <th className="px-4 py-3 text-right font-bold">Open</th>
                        <th className="px-4 py-3 text-right font-bold">
                          At risk
                        </th>
                        <th className="px-4 py-3 text-right font-bold">
                          Resolved · 90d
                        </th>
                        <th className="px-4 py-3 text-right font-bold">
                          Win rate
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.by_reason.map((b) => {
                        const r = reasonMeta(b.reason);
                        const wt = winRateText(b.win_rate, b.resolved);
                        const hasRate = wt !== "-";
                        const p =
                          hasRate && b.win_rate != null
                            ? Math.round(b.win_rate * 100)
                            : 0;
                        return (
                          <tr
                            key={b.reason}
                            className="last:border-0"
                            style={{ borderBottom: `1px solid ${C.border}` }}
                          >
                            <td className="px-4 py-3">
                              <span className="flex items-center gap-2.5 font-semibold">
                                <span
                                  className="h-2 w-2 flex-none rounded-full"
                                  style={{ background: r.dot }}
                                  aria-hidden="true"
                                />
                                {r.label}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              {b.count}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              {usd(b.total_usd)}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              {b.won} / {b.resolved}
                            </td>
                            <td className="px-4 py-3 text-right">
                              {hasRate ? (
                                <span className="inline-flex items-center justify-end gap-2.5">
                                  <span
                                    className="h-[7px] w-16 overflow-hidden rounded-full"
                                    style={{ background: C.soft }}
                                    aria-hidden="true"
                                  >
                                    <span
                                      className="block h-full"
                                      style={{
                                        width: `${p}%`,
                                        background: winBarColor(p),
                                      }}
                                    />
                                  </span>
                                  <span className="min-w-[34px] text-right font-bold tabular-nums">
                                    {wt}
                                  </span>
                                </span>
                              ) : (
                                <span className="font-semibold tabular-nums text-[#595959]">
                                  {wt}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 flex items-start gap-2 text-[12px] text-[#595959]">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={C.muted}
                    strokeWidth="2"
                    aria-hidden="true"
                    className="mt-px flex-none"
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 8v5M12 16.5h.01" />
                  </svg>
                  <span>
                    Win rate is from disputes resolved in the last 90 days, shown
                    once 5+ are resolved. Every Stripe submission requires your
                    approval. The agent assembles and recommends in chat, you
                    sign off.
                  </span>
                </p>
                </div>
              </details>
            ) : null}
          </div>
        );
      }}
    />
  );
}

