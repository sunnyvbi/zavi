"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { apiFetch } from "@/lib/api";
import type { TabDescriptor } from "@/lib/workspace/types";
import { useChatThread, type ArtifactRow } from "@/lib/workspace/useChatThread";
import { useInlineEdit } from "@/lib/workspace/useInlineEdit";
import { useWorkspace } from "../WorkspaceShell";
import { ChatThread } from "../ChatThread";
import { Composer } from "../Composer";
import { InlineStatusRow } from "../InlineStatusRow";
import { ThreadBar } from "../ThreadBar";
import { LowCreditsWarning } from "../LowCreditsWarning";
import { resolveInflight } from "../chatInflight";
import { useAgentDashboard } from "./dashboard-ui";
import {
  C,
  Ce3Badge,
  DeadlinePill,
  deadline,
  type OpenDispute,
  type Payload,
} from "./DisputeResponseDashboard";

const AGENT_SLUG = "dispute-response";

type Ce3Status = "qualified" | "requires_action" | "not_qualified" | "n/a";

type DisputeDetailData = {
  connected: true;
  dispute: {
    id: string;
    reason: string;
    reason_label: string;
    network_reason_code: string | null;
    status: string;
    amount_usd: number;
    currency: string;
    evidence_due_by: number | null;
    past_due: boolean;
    submission_count: number;
    opened: number;
  };
  finalize?: {
    draft_decision_id: string | null;
    submitted: boolean;
    can_submit: boolean;
  };
  charge: {
    id: string;
    amount_usd: number;
    currency: string;
    created: string | null;
    statement_descriptor: string | null;
    card_brand: string | null;
    card_last4: string | null;
    receipt_url: string | null;
  } | null;
  cardholder: {
    customer_id: string;
    name: string | null;
    email: string | null;
    customer_since: number | null;
  } | null;
  ce3: { status: Ce3Status; required_actions: string[] };
  evidence_checklist: { attached: number; total: number; missing: string[] };
  matching_data: { ip: "unavailable"; device: "unavailable" };
  win_rate: { won: number; resolved: number; rate: number | null };
  fees: { dispute_fee_usd: number | null; recoverable_usd: number };
  booking:
    | { linked: false }
    | {
        linked: true;
        source_collection: string;
        id: string;
        id_field: string;
        label: string | null;
        start_date: string | null;
        end_date: string | null;
      };
  links: { stripe_dispute_url: string; booking_url: string | null };
  raw: {
    charge_id: string | null;
    payment_intent: string | null;
    network_reason_code: string | null;
    evidence_details: unknown;
  };
};

type DisputeHistoryData =
  | {
      connected: true;
      available: true;
      customer_since: number | null;
      total_charges: number;
      prior_dispute_count: number;
      prior_disputes: Array<{
        id: string;
        amount_usd: number;
        reason: string;
        status: string;
        created: number;
      }>;
      capped: boolean;
    }
  | {
      connected: true;
      available: false;
      customer_since: number | null;
    };

type DetailFetch =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "not_found" }
  | { phase: "not_connected" }
  | { phase: "ready"; data: DisputeDetailData };

function useDisputeDetail(disputeId: string): DetailFetch {
  const [state, setState] = useState<DetailFetch>({ phase: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    void (async () => {
      try {
        const res = await apiFetch(
          `/api/agents/dispute-response/dispute/${encodeURIComponent(disputeId)}`,
        );
        if (cancelled) return;
        if (res.status === 404) {
          setState({ phase: "not_found" });
          return;
        }
        if (!res.ok) {
          setState({ phase: "error" });
          return;
        }
        const json = (await res.json()) as
          | DisputeDetailData
          | { connected: false };
        if (cancelled) return;
        if (!("connected" in json) || json.connected !== true) {
          setState({ phase: "not_connected" });
          return;
        }
        setState({ phase: "ready", data: json });
      } catch {
        if (!cancelled) setState({ phase: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [disputeId]);
  return state;
}

export function DisputeDetailTab({
  tab,
  isActive: _isActive = true,
}: {
  tab: TabDescriptor;
  isActive?: boolean;
}) {
  const payload = tab.payload as {
    kind: "dispute-detail";
    disputeId: string;
    threadId?: string | null;
  };
  const { disputeId, threadId } = payload;

  const { setTabThreadId, seedComposer } = useWorkspace();

  const onThreadLoaded = useCallback(
    (thread: { id: string; title: string | null }) => {
      if (threadId === undefined) setTabThreadId(tab.id, thread.id);
    },
    [tab.id, threadId, setTabThreadId],
  );
  const chat = useChatThread(AGENT_SLUG, threadId, onThreadLoaded);

  const [pendingRunId, setPendingRunId] = useState<string | null>(null);

  const dash = useAgentDashboard<Payload>(AGENT_SLUG);
  const dispute: OpenDispute | null = useMemo(() => {
    const d = dash.data;
    if (!d || d.generic || !d.connected) return null;
    return d.open.find((row) => row.id === disputeId) ?? null;
  }, [dash.data, disputeId]);

  const latestPdf: ArtifactRow | null = useMemo(() => {
    let found: ArtifactRow | null = null;
    for (const r of chat.rows) {
      if (r.kind !== "chat_assistant" || !r.artifacts) continue;
      for (const a of r.artifacts) {
        if (a.mime === "application/pdf") found = a;
      }
    }
    return found;
  }, [chat.rows]);

  const isGenerating = pendingRunId !== null || chat.activeRunId !== null;

  const genLatchRef = useRef(false);
  const runObservedRef = useRef(false);
  useEffect(() => {
    if (isGenerating) {
      runObservedRef.current = true;
      return;
    }
    if (runObservedRef.current) {
      runObservedRef.current = false;
      genLatchRef.current = false;
    }
  }, [isGenerating]);

  const GEN_PROMPT = `Assemble the compelling-evidence packet for Stripe dispute ${disputeId} and generate it as a downloadable PDF I can review.`;

  const generate = useCallback(() => {
    if (genLatchRef.current) return;
    if (dispute) {
      if (dispute.past_due === true) return;
      if ((dispute.submission_count ?? 0) >= 1) return;
    }
    genLatchRef.current = true;
    window.setTimeout(() => {
      if (!runObservedRef.current) genLatchRef.current = false;
    }, 4000);
    seedComposer({
      agentSlug: AGENT_SLUG,
      text: GEN_PROMPT,
      tabId: tab.id,
      autoSend: true,
    });
  }, [seedComposer, tab.id, GEN_PROMPT, dispute]);

  const regenerate = useCallback(() => {
    seedComposer({
      agentSlug: AGENT_SLUG,
      text: GEN_PROMPT,
      tabId: tab.id,
      placeholderHint: "Describe what to change, then send…",
    });
  }, [seedComposer, tab.id, GEN_PROMPT]);

  return (
    <div className="flex h-full flex-col bg-cream">
      {}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {}
        <section className="min-h-0 flex-1 overflow-y-auto border-b border-[#f0f0f0] bg-cream lg:border-b-0 lg:border-r">
          <div className="mx-auto max-w-2xl px-6 py-6">
            <DetailColumn
              disputeId={disputeId}
              dispute={dispute}
              loading={dash.loading}
              latestPdf={latestPdf}
              isGenerating={isGenerating}
              onGenerate={generate}
              onRegenerate={regenerate}
            />
          </div>
        </section>

        {}
        <aside className="flex h-full min-h-0 flex-col lg:w-[420px] lg:shrink-0">
          <ChatColumn
            threadId={threadId}
            chat={chat}
            tabId={tab.id}
            pendingRunId={pendingRunId}
            setPendingRunId={setPendingRunId}
          />
        </aside>
      </div>
    </div>
  );
}

function DetailColumn({
  disputeId,
  dispute,
  latestPdf,
  isGenerating,
  onGenerate,
  onRegenerate,
}: {
  disputeId: string;
  dispute: OpenDispute | null;
  loading: boolean;
  latestPdf: ArtifactRow | null;
  isGenerating: boolean;
  onGenerate: () => void;
  onRegenerate: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      {}
      <EvidencePdfPanel
        dispute={dispute}
        latestPdf={latestPdf}
        isGenerating={isGenerating}
        onGenerate={onGenerate}
        onRegenerate={onRegenerate}
      />

      {}
      <RichDetail disputeId={disputeId} />
    </div>
  );
}

function EvidencePdfPanel({
  dispute,
  latestPdf,
  isGenerating,
  onGenerate,
  onRegenerate,
}: {
  dispute: OpenDispute | null;
  latestPdf: ArtifactRow | null;
  isGenerating: boolean;
  onGenerate: () => void;
  onRegenerate: () => void;
}) {
  const pastDue = dispute?.past_due === true;
  const filed = (dispute?.submission_count ?? 0) >= 1;
  const blockGenerate = pastDue || filed;
  const blockReason = filed
    ? "Already filed"
    : pastDue
      ? "Filing window closed"
      : null;
  const notInDocket = dispute === null;

  return (
    <section
      className="flex flex-col gap-3 rounded-3xl border bg-white px-4 py-4"
      style={{ borderColor: C.border }}
    >
      {}
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] font-semibold uppercase tracking-wide text-[#595959]">
          Evidence packet
        </div>
        {latestPdf ? (
          <button
            type="button"
            onClick={() => void downloadArtifact(latestPdf.id)}
            className="inline-flex flex-none items-center gap-2 rounded-cta bg-ink px-3.5 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-inkSoft"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M12 3v12M7 10l5 5 5-5" />
              <path d="M5 21h14" />
            </svg>
            Download
          </button>
        ) : !notInDocket && !blockGenerate ? (
          <button
            type="button"
            onClick={onGenerate}
            disabled={isGenerating}
            className="inline-flex flex-none items-center gap-2 rounded-cta bg-ink px-3.5 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-inkSoft disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isGenerating ? "Generating…" : "Generate evidence PDF"}
          </button>
        ) : null}
      </div>

      {latestPdf ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <DocGlyph ready />
            <div className="min-w-0">
              <div className="text-[16px] font-semibold text-[#0e0f11]">
                Evidence packet ready
              </div>
              <div
                className="truncate text-[12px] text-[#595959]"
                title={latestPdf.filename}
              >
                {latestPdf.filename}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onRegenerate}
              disabled={isGenerating || blockGenerate || notInDocket}
              title={blockReason ?? undefined}
              className="inline-flex items-center gap-2 rounded-cta border px-3.5 py-1.5 text-[13px] font-semibold text-[#1f1f1f] transition-colors hover:bg-[#f7f4ee] disabled:cursor-not-allowed disabled:opacity-50"
              style={{ borderColor: C.border }}
            >
              Regenerate
            </button>
          </div>
          {blockReason ? (
            <p className="text-[12px] text-[#595959]">
              {blockReason}. This packet can be downloaded but not regenerated.
            </p>
          ) : notInDocket ? (
            <p className="text-[12px] text-[#595959]">
              This dispute isn&apos;t in the open docket. The packet can be
              downloaded but not regenerated.
            </p>
          ) : isGenerating ? (
            <p className="text-[12px] text-[#595959]">
              Working on a new packet. Hold on.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <DocGlyph />
            <div className="min-w-0">
              <div className="text-[16px] font-semibold text-[#0e0f11]">
                No evidence packet yet
              </div>
              <div className="text-[12px] text-[#595959]">
                Generate the compelling-evidence PDF, then review and download it
                here.
              </div>
            </div>
          </div>
          {}
          {notInDocket ? (
            <p className="text-[12px] font-medium text-[#595959]">
              Evidence generation is available while the dispute is in the open
              docket.
            </p>
          ) : blockGenerate ? (
            <p className="text-[12px] font-medium text-[#595959]">
              {blockReason}. Evidence can&apos;t be generated for a filed or
              closed dispute.
            </p>
          ) : null}
        </div>
      )}

      <p
        className="border-t pt-2.5 text-[11px] text-[#8a8a8a]"
        style={{ borderColor: C.border }}
      >
        The agent assembles the packet in chat; review and download it here. When
        you&apos;re ready, use Submit for review above to file it with Stripe.
      </p>
    </section>
  );
}

function RichDetail({ disputeId }: { disputeId: string }) {
  const fetchState = useDisputeDetail(disputeId);

  if (fetchState.phase === "loading") {
    return <DetailNote>Loading dispute detail…</DetailNote>;
  }
  if (fetchState.phase === "not_connected") {
    return (
      <DetailNote>
        Connect Stripe under Settings → Connectors to load this dispute&apos;s
        detail.
      </DetailNote>
    );
  }
  if (fetchState.phase === "not_found") {
    return (
      <DetailNote title="This dispute is no longer open">
        It may have been resolved or closed, or it isn&apos;t visible to this
        workspace&apos;s Stripe account.
      </DetailNote>
    );
  }
  if (fetchState.phase === "error") {
    return (
      <DetailNote title="Couldn’t load this dispute">
        Something went wrong reaching Stripe. Try reopening the dispute.
      </DetailNote>
    );
  }

  const d = fetchState.data;
  const { dispute, charge, cardholder, ce3, evidence_checklist, win_rate, fees, booking, links, raw } = d;

  const dlProj: OpenDispute = {
    id: dispute.id,
    amount_usd: dispute.amount_usd,
    currency: dispute.currency,
    reason: dispute.reason,
    due_by: dispute.evidence_due_by,
    past_due: dispute.past_due,
  };
  const dl = deadline(dlProj);

  return (
    <div className="flex flex-col gap-3">
      {}
      <SubmitForReviewCard finalize={d.finalize} />

      {}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {}
        <GridCard title="Charge">
          {charge ? (
            <>
              <GRow label="Amount">
                <span className="tabular-nums font-semibold">
                  {fmtUsd(charge.amount_usd, charge.currency)}
                </span>
              </GRow>
              <GRow label="Card">
                {charge.card_brand || charge.card_last4 ? (
                  <span className="tabular-nums">
                    {cap(charge.card_brand)} •••• {charge.card_last4 ?? "----"}
                  </span>
                ) : (
                  <Muted>Unknown</Muted>
                )}
              </GRow>
              <GRow label="Date">{fmtDateISO(charge.created)}</GRow>
              <GRow label="Descriptor">
                {charge.statement_descriptor ?? <Muted>-</Muted>}
              </GRow>
              {charge.receipt_url ? (
                <div className="pt-1.5">
                  <a
                    href={charge.receipt_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[12px] font-semibold text-[#027bff] hover:underline"
                  >
                    View Stripe receipt ↗
                  </a>
                </div>
              ) : null}
            </>
          ) : (
            <Muted>No charge on this dispute.</Muted>
          )}
        </GridCard>

        {}
        <GridCard title="Cardholder">
          {cardholder ? (
            <>
              <GRow label="Name">{cardholder.name ?? <Muted>-</Muted>}</GRow>
              <GRow label="Email">{cardholder.email ?? <Muted>-</Muted>}</GRow>
              <GRow label="Customer since">
                {fmtDateUnix(cardholder.customer_since)}
              </GRow>
            </>
          ) : (
            <Muted>No cardholder linked to this charge.</Muted>
          )}
        </GridCard>

        {}
        <GridCard title="Dispute">
          <GRow label="Amount">
            <span className="tabular-nums font-semibold">
              {fmtUsd(dispute.amount_usd, dispute.currency)}
            </span>
          </GRow>
          <GRow label="Reason">
            {dispute.reason_label}
            {dispute.network_reason_code ? (
              <span className="ml-1.5 font-mono text-[11px] text-[#8a8a8a]">
                ({dispute.network_reason_code})
              </span>
            ) : null}
          </GRow>
          <GRow label="Status">
            <span className="tabular-nums">{cap(dispute.status)}</span>
          </GRow>
          <GRow label="Opened">{fmtDateUnix(dispute.opened)}</GRow>
          <GRow label="Evidence due">
            <DeadlinePill tone={dl.tone} label={dl.label} caption={dl.caption} />
          </GRow>
          <GRow label="Submissions">
            <span className="tabular-nums">{dispute.submission_count}</span>
            {dispute.submission_count >= 1 ? (
              <span className="ml-1.5 text-[11px] text-[#8a6d00]">
                (window spent)
              </span>
            ) : null}
          </GRow>
        </GridCard>

        {}
        <GridCard title="Fees & recovery">
          <GRow label="Dispute fee">
            {fees.dispute_fee_usd != null ? (
              <span className="tabular-nums" style={{ color: C.bad }}>
                {fmtUsd(fees.dispute_fee_usd, "USD")}
              </span>
            ) : (
              <Muted>-</Muted>
            )}
          </GRow>
          <GRow label="Recoverable">
            <span className="tabular-nums" style={{ color: C.good }}>
              {fmtUsd(fees.recoverable_usd, "USD")}
            </span>
          </GRow>
        </GridCard>

        {}
        <GridCard title="Visa CE 3.0">
          <div className="mb-1.5">
            {ce3.status === "n/a" ? (
              <Muted>Not applicable to this dispute.</Muted>
            ) : (
              <Ce3Badge status={ce3.status} />
            )}
          </div>
          {ce3.required_actions.length > 0 ? (
            <ul className="mb-1.5 flex flex-col gap-1">
              {ce3.required_actions.map((g, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-[12px] text-[#0e0f11]"
                >
                  <span
                    className="mt-1.5 h-1 w-1 flex-none rounded-full"
                    style={{ background: C.warn }}
                    aria-hidden="true"
                  />
                  <span>{g}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {}
          <GRow label="IP match">
            <Muted>not available from Stripe</Muted>
          </GRow>
          <GRow label="Device match">
            <Muted>not available from Stripe</Muted>
          </GRow>
        </GridCard>

        {}
        <GridCard title="Win rate · this reason">
          <GRow label="Record">
            <span className="tabular-nums">
              {win_rate.won} of {win_rate.resolved} won
            </span>
          </GRow>
          <GRow label="Win rate">
            {win_rate.rate != null ? (
              <span
                className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums"
                style={{ background: "#e9f5ee", color: C.good }}
              >
                {Math.round(win_rate.rate * 100)}%
              </span>
            ) : (
              <Muted>-</Muted>
            )}
          </GRow>
        </GridCard>

        {}
        <GridCard title="Evidence attached" className="sm:col-span-2">
          <div className="text-[14px] font-bold tabular-nums text-[#0e0f11]">
            {evidence_checklist.attached} of {evidence_checklist.total} attached
          </div>
          {evidence_checklist.missing.length > 0 ? (
            <div className="mt-2">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#595959]">
                Still missing
              </div>
              <div className="flex flex-wrap gap-2">
                {evidence_checklist.missing.map((m) => (
                  <span
                    key={m}
                    className="rounded-full border px-2.5 py-[3px] text-[12px] text-[#595959]"
                    style={{ borderColor: C.border, background: C.soft }}
                  >
                    {m}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div className="mt-1">
              <Muted>All tracked evidence fields are populated.</Muted>
            </div>
          )}
        </GridCard>
      </div>

      {}
      <GridCard title="Booking">
        {booking.linked ? (
          <>
            <GRow label="Reference">
              <span className="tabular-nums">
                {booking.source_collection} · {booking.id}
              </span>
            </GRow>
            {booking.label ? <GRow label="Booking">{booking.label}</GRow> : null}
            {booking.start_date || booking.end_date ? (
              <GRow label="Dates">
                {booking.start_date ?? "-"}
                {booking.end_date ? ` → ${booking.end_date}` : ""}
              </GRow>
            ) : null}
            {links.booking_url ? (
              <div className="pt-1.5 text-[12px] font-semibold text-[#8a8a8a]">
                Open booking (Your database)
              </div>
            ) : null}
          </>
        ) : (
          <Muted>Not linked to a booking.</Muted>
        )}
      </GridCard>

      {}
      <HistorySection disputeId={disputeId} />

      {}
      <details className="group rounded-3xl border bg-white px-4 py-4" style={{ borderColor: C.border }}>
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
          Raw Stripe fields
        </summary>
        <div className="mt-3 flex flex-col gap-2">
          <Row label="Charge id">
            <span className="font-mono text-[12px]">{raw.charge_id ?? "-"}</span>
          </Row>
          <Row label="Payment intent">
            <span className="font-mono text-[12px]">
              {raw.payment_intent ?? "-"}
            </span>
          </Row>
          <Row label="Network reason code">
            <span className="font-mono text-[12px]">
              {raw.network_reason_code ?? "-"}
            </span>
          </Row>
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#595959]">
              evidence_details
            </div>
            <pre
              className="max-h-64 overflow-auto rounded-xl border p-3 text-[11px] leading-4 text-[#0e0f11]"
              style={{ borderColor: C.border, background: C.soft }}
            >
              {JSON.stringify(raw.evidence_details, null, 2)}
            </pre>
          </div>
        </div>
      </details>

      {}
      <a
        href={links.stripe_dispute_url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-fit items-center gap-2 rounded-lg border px-3.5 py-1.5 text-[13px] font-semibold text-[#1f1f1f] transition-colors hover:bg-[#f7f4ee]"
        style={{ borderColor: C.border }}
      >
        Open in Stripe ↗
      </a>
    </div>
  );
}

type HistoryFetch =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; data: DisputeHistoryData };

function HistorySection({ disputeId }: { disputeId: string }) {
  const [state, setState] = useState<HistoryFetch>({ phase: "idle" });

  const check = useCallback(() => {
    if (state.phase === "ready" || state.phase === "loading") return;
    setState({ phase: "loading" });
    void (async () => {
      try {
        const res = await apiFetch(
          `/api/agents/dispute-response/dispute/${encodeURIComponent(disputeId)}/history`,
        );
        if (!res.ok) {
          setState({ phase: "error" });
          return;
        }
        const json = (await res.json()) as
          | DisputeHistoryData
          | { connected: false };
        if (!("connected" in json) || json.connected !== true) {
          setState({ phase: "error" });
          return;
        }
        setState({ phase: "ready", data: json });
      } catch {
        setState({ phase: "error" });
      }
    })();
  }, [disputeId, state.phase]);

  return (
    <RichCard title="Related disputes from this buyer">
      {state.phase === "ready" && state.data.available ? (
        <div className="flex flex-col gap-2">
          <Row label="Customer since">
            {fmtDateUnix(state.data.customer_since)}
          </Row>
          <Row label="Total charges">
            <span className="tabular-nums">
              {state.data.total_charges}
              {state.data.capped ? "+" : ""}
            </span>
          </Row>
          <Row label="Prior disputes">
            <span
              className="tabular-nums font-semibold"
              style={{ color: state.data.prior_dispute_count > 0 ? C.bad : C.good }}
            >
              {state.data.prior_dispute_count}
            </span>
          </Row>
          {state.data.prior_disputes.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-2">
              {state.data.prior_disputes.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-[12px]"
                  style={{ borderColor: C.border }}
                >
                  <span className="min-w-0">
                    <span className="font-mono text-[11px] text-[#8a8a8a]">
                      {p.id.slice(0, 14)}…
                    </span>
                    <span className="ml-2 text-[#0e0f11]">
                      {p.reason.replace(/_/g, " ")}
                    </span>
                  </span>
                  <span className="flex flex-none items-center gap-2 tabular-nums">
                    {fmtUsd(p.amount_usd, "USD")}
                    <span className="text-[#595959]">{cap(p.status)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Muted>No prior disputes from this buyer in the sample.</Muted>
          )}
        </div>
      ) : state.phase === "ready" ? (
        <div className="flex flex-col gap-2">
          <div
            className="text-[13px] font-semibold"
            style={{ color: C.warn }}
          >
            Couldn&apos;t determine this buyer&apos;s history
          </div>
          <Muted>
            No linked customer on the charge, or Stripe couldn&apos;t be reached.
            Prior-dispute count is unknown, not zero.
          </Muted>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-2">
          <p className="text-[12px] text-[#595959]">
            Look up this buyer&apos;s prior charges + disputes (one capped page,
            fetched only on request).
          </p>
          <button
            type="button"
            onClick={check}
            disabled={state.phase === "loading"}
            className="inline-flex items-center gap-2 rounded-cta border px-3.5 py-1.5 text-[13px] font-semibold text-[#1f1f1f] transition-colors hover:bg-[#f7f4ee] disabled:cursor-not-allowed disabled:opacity-50"
            style={{ borderColor: C.border }}
          >
            {state.phase === "loading"
              ? "Checking…"
              : "Check for related disputes"}
          </button>
          {state.phase === "error" ? (
            <p className="text-[12px]" style={{ color: C.bad }}>
              Couldn&apos;t load history. Try again.
            </p>
          ) : null}
        </div>
      )}
    </RichCard>
  );
}

function RichCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      className="flex flex-col gap-2.5 rounded-3xl border bg-white px-4 py-4"
      style={{ borderColor: C.border }}
    >
      <div className="text-[12px] font-semibold uppercase tracking-wide text-[#595959]">
        {title}
      </div>
      {children}
    </section>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 text-[13px]">
      <span className="flex-none text-[#8a8a8a]">{label}</span>
      <span className="min-w-0 text-right font-medium text-[#0e0f11]">
        {children}
      </span>
    </div>
  );
}

function GridCard({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`flex flex-col rounded-2xl border bg-white px-4 py-3.5 ${className ?? ""}`}
      style={{ borderColor: C.border }}
    >
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-[#8a8a8a]">
        {title}
      </div>
      {children}
    </section>
  );
}

function GRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[#f6f6f4] py-1 last:border-b-0">
      <span className="flex-none whitespace-nowrap text-[13px] text-[#8a8a8a]">
        {label}
      </span>
      <span className="min-w-0 text-right text-[13px] font-medium text-[#0e0f11]">
        {children}
      </span>
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-[13px] font-normal text-[#8a8a8a]">{children}</span>;
}

function SubmitForReviewCard({
  finalize,
}: {
  finalize?: DisputeDetailData["finalize"];
}) {
  const [phase, setPhase] = useState<"idle" | "submitting" | "done" | "error">(
    "idle",
  );
  const draftId = finalize?.draft_decision_id ?? null;
  const submit = useCallback(() => {
    if (!draftId) return;
    setPhase("submitting");
    void (async () => {
      try {
        const res = await apiFetch(
          `/api/approvals/${encodeURIComponent(draftId)}/finalize-evidence`,
          { method: "POST" },
        );
        setPhase(res.ok ? "done" : "error");
      } catch {
        setPhase("error");
      }
    })();
  }, [draftId]);

  if (!draftId) return null;
  const submitted = (finalize?.submitted ?? false) || phase === "done";

  return (
    <RichCard title="Submit to Stripe">
      {submitted ? (
        <div className="flex flex-col gap-1">
          <div className="text-[13px] font-semibold text-[#0e0f11]">
            Submitted for review ✓
          </div>
          <Muted>
            The evidence is filed with Stripe. This dispute is now closed to
            further changes.
          </Muted>
        </div>
      ) : !finalize?.can_submit ? (
        <Muted>The evidence window has closed for this dispute.</Muted>
      ) : (
        <div className="flex flex-col gap-2.5">
          <p className="text-[12px] text-[#595959]">
            The evidence is saved as a draft but not submitted yet. Submitting
            files it with Stripe for review and closes the dispute to further
            changes.
          </p>
          <button
            type="button"
            onClick={submit}
            disabled={phase === "submitting"}
            className="inline-flex w-fit items-center gap-2 rounded-cta bg-ink px-3.5 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-inkSoft disabled:cursor-not-allowed disabled:opacity-50"
          >
            {phase === "submitting" ? "Submitting…" : "Submit for review"}
          </button>
          {phase === "error" ? (
            <p className="text-[12px] font-medium text-[#b42318]">
              Couldn&apos;t submit. Try again.
            </p>
          ) : null}
        </div>
      )}
    </RichCard>
  );
}

function DetailNote({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <div
      className="rounded-3xl border border-dashed px-6 py-8 text-center"
      style={{ borderColor: "#d8d2c4" }}
    >
      {title ? (
        <div className="text-[16px] font-semibold text-[#1f1f1f]">{title}</div>
      ) : null}
      <p className="mx-auto mt-1 max-w-md text-[12px] text-[#595959]">
        {children}
      </p>
    </div>
  );
}

function cap(s: string | null | undefined): string {
  if (!s) return "-";
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}

function fmtUsd(n: number, currency: string): string {
  const amt = `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
  return currency && currency !== "USD" ? `${amt} ${currency}` : amt;
}

function fmtDateUnix(unix: number | null): string {
  if (unix == null) return "-";
  const d = new Date(unix * 1000);
  return Number.isNaN(d.getTime())
    ? "-"
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function fmtDateISO(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "-"
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function DocGlyph({ ready = false }: { ready?: boolean }) {
  return (
    <span
      className="flex h-10 w-10 flex-none items-center justify-center rounded-xl"
      style={{ background: ready ? "#e9f5ee" : C.soft }}
      aria-hidden="true"
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke={ready ? C.good : C.muted}
        strokeWidth="1.8"
        strokeLinejoin="round"
      >
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
      </svg>
    </span>
  );
}

function ChatColumn({
  threadId,
  chat,
  tabId,
  pendingRunId,
  setPendingRunId,
}: {
  threadId?: string | null;
  chat: ReturnType<typeof useChatThread>;
  tabId: string;
  pendingRunId: string | null;
  setPendingRunId: Dispatch<SetStateAction<string | null>>;
}) {
  const onEditMessage = useInlineEdit(chat, AGENT_SLUG, threadId);
  const handleStopRun = useCallback(
    (runId: string) => {
      const hadPendingRun = pendingRunId === runId;
      if (hadPendingRun) setPendingRunId(null);
      chat.markRunStopped(runId);
      return () => {
        chat.unmarkRunStopped(runId);
        if (hadPendingRun) setPendingRunId((cur) => cur ?? runId);
        void chat.refetch();
      };
    },
    [pendingRunId, setPendingRunId, chat],
  );

  const { show: inflightShow, runId: inflightRunId } = resolveInflight({
    activeRunId: chat.activeRunId,
    activeTrigger: chat.activeTrigger,
    pendingRunId,
    rows: chat.rows,
  });
  const loadingEmpty = chat.loading && chat.rows.length === 0;
  const stopRunId = inflightShow && !loadingEmpty ? inflightRunId : null;

  const latestRunId = useMemo(() => {
    for (let i = chat.rows.length - 1; i >= 0; i--) {
      const r = chat.rows[i];
      if (r.kind === "chat_assistant" && r.agent_run_id) return r.agent_run_id;
    }
    return null;
  }, [chat.rows]);

  useEffect(() => {
    if (!pendingRunId) return;
    const replied = chat.rows.some(
      (r) => r.kind === "chat_assistant" && r.agent_run_id === pendingRunId,
    );
    if (!replied) return;
    const id = window.setTimeout(() => setPendingRunId(null), 2000);
    return () => window.clearTimeout(id);
  }, [chat.rows, pendingRunId, setPendingRunId]);

  useEffect(() => {
    if (!pendingRunId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      void apiFetch(
        `/api/agents/runs/${encodeURIComponent(pendingRunId)}/cancel`,
        { method: "POST" },
      ).catch(() => {});
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pendingRunId]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-cream">
      <ThreadBar slug={AGENT_SLUG} currentThreadId={threadId} />
      <div className="flex-1 min-h-0 overflow-y-auto focus:outline-none focus-visible:outline-none focus-visible:ring-0">
        <ChatThread
          agentSlug={AGENT_SLUG}
          onEditMessage={onEditMessage}
          threadId={threadId}
          onRetry={() => void chat.refetch()}
          state={{
            rows: chat.rows,
            activityRows: chat.activityRows,
            activityByRun: chat.activityByRun,
            loading: chat.loading,
            errorMsg: chat.errorMsg,
            activeRunId: chat.activeRunId,
            activeTrigger: chat.activeTrigger,
            activeRunStartedAt: chat.activeRunStartedAt,
            activeRunTurnStartedAt: chat.activeRunTurnStartedAt,
            pendingRunId,
          }}
        />
        {pendingRunId && (
          <div className="mx-auto max-w-3xl px-6">
            <InlineStatusRow
              key={pendingRunId}
              agentSlug={AGENT_SLUG}
              runId={pendingRunId}
              headless
              onComplete={() => {
                const completedRunId = pendingRunId;
                setTimeout(
                  () =>
                    setPendingRunId((cur) =>
                      cur === completedRunId ? null : cur,
                    ),
                  2000,
                );
                void chat.refetch();
              }}
            />
          </div>
        )}
      </div>
      <LowCreditsWarning />
      <div className="shrink-0 border-t border-[#e5e7eb]">
        <Composer
          agentSlug={AGENT_SLUG}
          tabId={tabId}
          threadId={threadId}
          latestRunId={latestRunId}
          stopRunId={stopRunId}
          onStopRun={handleStopRun}
          onSent={(runId) => setPendingRunId(runId)}
          onNonRunHandled={() => {
            void chat.refetch();
          }}
          onOptimistic={chat.appendOptimisticUser}
          onSystem={chat.appendOptimisticSystem}
        />
      </div>
    </div>
  );
}

async function downloadArtifact(id: string) {
  try {
    const res = await apiFetch(`/api/run-artifacts/${id}/url`);
    if (!res.ok) return;
    const { signed_url } = (await res.json()) as { signed_url?: string };
    if (signed_url) window.open(signed_url, "_blank", "noopener,noreferrer");
  } catch {
  }
}
