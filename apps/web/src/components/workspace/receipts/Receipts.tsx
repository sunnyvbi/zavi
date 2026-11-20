"use client";

import Image from "next/image";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Clock, Plug, X } from "lucide-react";
import { CONNECTOR_ICON } from "../settings/connectorLogos";
import {
  agoText,
  chipLabel,
  formatStamp,
  formatWindow,
  logoSlug,
  receiptSource,
  type ReceiptData,
  type TrendTone,
} from "./receiptData";

export function SourceMark({ slug, size = 13 }: { slug?: string | null; size?: number }) {
  const key = logoSlug(slug);
  const icon = key ? CONNECTOR_ICON[key] : undefined;
  if (icon) {
    return <Image src={icon} alt="" width={size} height={size} className="m-0 shrink-0 object-contain" style={{ width: size, height: size, margin: 0 }} />;
  }
  return <Plug aria-hidden className="shrink-0 text-inkMuted" style={{ width: size, height: size }} />;
}

export function ReceiptChip({ r, className = "" }: { r: ReceiptData; className?: string }) {
  const [open, setOpen] = useState(false);
  const exploratory = r.kind === "exploratory";
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="How this number was worked out"
        className={
          "not-prose mx-0.5 inline-flex max-w-full translate-y-[-1px] items-center gap-1 whitespace-nowrap rounded-cta border px-1.5 py-px align-middle font-sans text-[12px] font-medium leading-[18px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inkMuted " +
          (exploratory
            ? "border-dashed border-marigoldDeep/60 bg-warnBg text-warn hover:bg-marigold/20"
            : "border-rule bg-white text-inkMuted hover:border-inkMuted/50 hover:text-ink dark:bg-cream") +
          (className ? ` ${className}` : "")
        }
        data-testid="receipt-chip"
        data-kind={r.kind}
      >
        {exploratory ? <AlertTriangle aria-hidden className="h-3 w-3" /> : <SourceMark slug={r.sourceSlug} />}
        <span className="truncate">{exploratory ? "Exploratory · one-off query" : chipLabel(r)}</span>
      </button>
      {open && <ReceiptDrawer r={r} onClose={() => setOpen(false)} />}
    </>
  );
}

export function UnverifiedChip({ figure, receipt, className = "" }: { figure: string; receipt?: ReceiptData; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Why this number is marked"
        data-testid="unverified-chip"
        className={
          "not-prose mx-0.5 inline-flex translate-y-[-1px] items-center gap-1 whitespace-nowrap rounded-cta border border-dashed border-marigoldDeep/60 bg-warnBg px-1.5 py-px align-middle font-sans text-[12px] font-semibold leading-[18px] text-warn transition-colors hover:bg-marigold/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inkMuted " +
          className
        }
      >
        <AlertTriangle aria-hidden className="h-3 w-3" />
        Unverified
      </button>
      {open && <ReceiptDrawer r={receipt ?? { kind: "pulled", figure }} unverified onClose={() => setOpen(false)} />}
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[104px_1fr] gap-3 border-b border-rule/70 py-2.5 text-[14px] last:border-b-0">
      <dt className="font-medium text-inkMuted">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </div>
  );
}

export function ReceiptDrawer({
  r,
  onClose,
  unverified = false,
}: {
  r: ReceiptData;
  onClose: () => void;
  unverified?: boolean;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!mounted) return null;

  const title = unverified ? "Why this number is marked" : "How this number was worked out";
  const name = r.label ?? (r.metricId ? r.metricId.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : null);
  const windowText = formatWindow(r.window);
  const stamp = formatStamp(r.fetchedAt);
  const ago = agoText(r.fetchedAt);

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Close" onClick={onClose} className="dialog-scrim absolute inset-0 cursor-default" />
      <aside className="relative m-1 flex w-full max-w-[440px] flex-col overflow-hidden rounded-2xl border border-rule bg-cream font-sans shadow-[0_24px_80px_rgba(0,0,0,0.28)]">
        <header className="flex items-start gap-3 border-b border-rule px-4 py-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-creamDeep">
            {unverified || r.kind === "exploratory" ? (
              <AlertTriangle aria-hidden className="h-5 w-5 text-warn" />
            ) : (
              <SourceMark slug={r.sourceSlug} size={20} />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-inkMuted">{title}</p>
            {name && <p className="mt-0.5 text-[16px] font-semibold text-ink">{name}</p>}
            {r.figure && <p className="text-[26px] font-bold tabular-nums tracking-tight text-ink">{r.figure}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 items-center gap-1 rounded-cta px-2.5 text-[13px] font-medium text-inkMuted hover:bg-creamDeep hover:text-ink"
          >
            <X aria-hidden className="h-4 w-4" />
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {unverified && (
            <div className="rounded-xl border border-marigoldDeep/40 bg-warnBg p-3.5 text-warn">
              <p className="flex items-center gap-2 text-[14px] font-semibold">
                <AlertTriangle aria-hidden className="h-4 w-4" />
                {r.formula
                  ? "Worked out from a number typed in"
                  : "No source returned this number"}
              </p>
              <p className="mt-1.5 text-[14px] leading-5">
                {r.formula
                  ? "Zavi did the arithmetic in code, but at least one number in it was typed in rather than read from a source. Check that number before you act on it."
                  : "Nothing Zavi read while answering contains it. It was worked out in the answer or carried in from earlier in the conversation. Check it before you act on it."}
              </p>
              {r.formula && <p className="mt-2 font-code text-[13px] text-ink">{r.formula}</p>}
            </div>
          )}
          {r.kind === "exploratory" && (
            <div className="mb-4 rounded-xl border border-marigoldDeep/40 bg-warnBg p-3.5 text-warn">
              <p className="flex items-center gap-2 text-[14px] font-semibold">
                <AlertTriangle aria-hidden className="h-4 w-4" />
                Exploratory: Zavi wrote a one-off query for this
              </p>
              <p className="mt-1.5 text-[14px] leading-5">
                It is not one of your saved metrics, so nobody has checked the definition yet. Treat it as a lead, not a
                fact. The query is below.
              </p>
            </div>
          )}

          {!unverified && (
            <dl>
              {r.definition && <Row label="Definition">{r.definition}</Row>}
              {r.purpose && <Row label="Asked for">{r.purpose}</Row>}
              <Row label="Source">{receiptSource(r)}</Row>
              {windowText && <Row label="Window">{windowText}</Row>}
              {r.tz && <Row label="Timezone">{r.tz}</Row>}
              {r.currency !== undefined && <Row label="Currency">{r.currency ?? "Not money"}</Row>}
              {stamp && (
                <Row label="Fetched">
                  <span className="inline-flex items-center gap-1">
                    <Clock aria-hidden className="h-3.5 w-3.5 text-inkMuted" />
                    {stamp}
                    {ago ? ` (${ago})` : ""}
                  </span>
                </Row>
              )}
              {r.formula && (
                <Row label="Worked out">
                  <span className="font-code text-[13px]">{r.formula}</span>
                </Row>
              )}
              {r.params && r.params.length > 0 && (
                <Row label="Params">
                  <ul className="space-y-0.5 font-code text-[13px]">
                    {r.params.map(([k, v]) => (
                      <li key={k}>
                        <span className="text-inkMuted">{k}:</span> {v}
                      </li>
                    ))}
                  </ul>
                </Row>
              )}
              {r.caveats && r.caveats.length > 0 && (
                <Row label="Caveats">
                  <ul className="list-disc space-y-1 pl-4">
                    {r.caveats.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </Row>
              )}
            </dl>
          )}

          {!unverified && r.kind === "pulled" && !r.definition && (
            <p className="mt-3 text-[13px] leading-5 text-inkMuted">
              A read Zavi made while answering returned this exact number. It is not a saved metric, so there is no
              definition to show.
            </p>
          )}

          {r.sql && r.sql.length > 0 && (
            <div className="mt-4">
              <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-inkMuted">
                {r.sql.length === 1 ? "The query Zavi ran" : "The queries Zavi ran"}
              </p>
              {r.sql.map((q, i) => (
                <pre key={i} className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-xl bg-ink p-3.5 font-code text-[12px] leading-5 text-cream">
                  {q}
                </pre>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

const TONE: Record<TrendTone, string> = {
  green: "bg-successBg text-success ring-success/25",
  amber: "bg-warnBg text-warn ring-marigoldDeep/35",
  red: "bg-dangerBg text-danger ring-danger/25",
};
const DOT: Record<TrendTone, string> = { green: "bg-mintDeep", amber: "bg-marigoldDeep", red: "bg-danger" };

export function TrendPill({ tone, children }: { tone: TrendTone; children: ReactNode }) {
  return (
    <span
      data-testid="trend-pill"
      data-tone={tone}
      className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 font-sans text-[13px] font-semibold ring-1 ${TONE[tone]}`}
    >
      <span aria-hidden className={`h-2 w-2 rounded-full ${DOT[tone]}`} />
      {children}
    </span>
  );
}
