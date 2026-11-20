"use client";

import { ExternalLink } from "lucide-react";
import { receiptLinkLabel } from "@zavi/shared";
import { AdsDialog } from "@/components/ui/AdsDialog";
import { ResultsRow } from "@/components/email/EmailCampaignCard";
import { Button } from "@/components/ui/Button";
import { HistoryCard } from "./HistoryCard";
import { HistoryStatus } from "./HistoryStatus";
import { NO_RESULTS_LINE, historyDate, historyKind, historyOutcome, historyReceipt, historyStamp, historyStatus, historyTimeline, historyTitle, historyTone, savedAudienceLines, type HistoryItem } from "./historyPresentation";

export function HistoryDetailDialog({ item, kind, showCard = false, onClose }: { item: HistoryItem; kind?: string; showCard?: boolean; onClose: () => void }) {
  const title = historyTitle(item);
  const outcome = historyOutcome(item);
  const note = item.source === "action" ? item.row.note : null;
  const saved = savedAudienceLines(note);
  const stamp = historyStamp(item);
  const receipt = historyReceipt(item);
  return <AdsDialog size="history" label={title} onClose={onClose} closeOnBackdrop>
    <header className="border-b border-rule px-5 py-5 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-inkMuted"><HistoryStatus label={historyStatus(item)} tone={historyTone(item)} /><span>{kind ?? historyKind(item)}{stamp && <> · <time dateTime={stamp}>{historyDate(stamp)}</time></>}</span></div>
      <h2 className="mt-2.5 break-words text-xl font-semibold leading-7 text-ink">{title}</h2>
    </header>
    <div className="space-y-5 px-5 pb-6 pt-5 text-sm leading-6 text-inkSoft sm:px-6">
      {saved ? <ul data-testid="history-saved-audiences" className="space-y-2">{saved.map((line, i) => <li key={i} className={`break-words ${i === 0 ? "font-medium text-ink" : ""}`}>{line}</li>)}</ul> : note && <p className="whitespace-pre-wrap break-words">{note}</p>}
      {showCard && !saved && item.source === "action" && <HistoryCard id={item.row.id} />}
      {receipt?.url && <p><a href={receipt.url} target="_blank" rel="noopener noreferrer" data-testid="history-detail-receipt-link" className="inline-flex items-center gap-1 font-medium text-ink underline underline-offset-2">{receiptLinkLabel(receipt.url)}<ExternalLink className="h-3.5 w-3.5" aria-hidden /></a></p>}
      <section aria-label="What happened"><h3 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-inkMuted">What happened</h3>
        <ol className="space-y-1.5">{historyTimeline(item).map((event) => <li key={event.label} className="flex items-baseline gap-3">
          <span aria-hidden className="size-1.5 shrink-0 -translate-y-0.5 rounded-full bg-ink" />
          <p className="min-w-0 flex-1 break-words font-medium text-ink">{event.label}</p>
          {event.at && <time className="shrink-0 text-[13px] leading-5 text-inkMuted" dateTime={event.at}>{event.when ?? historyDate(event.at)}</time>}
        </li>)}</ol>
      </section>
      {(outcome.results || outcome.text !== NO_RESULTS_LINE) && <section aria-label={outcome.title} className="rounded-2xl border border-rule bg-creamDeep px-4 py-4"><h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-inkMuted">{outcome.title}</h3>{outcome.results ? <div className="divide-y divide-rule [&_p]:break-words [&_p]:text-sm [&_p]:leading-6">{outcome.results.map((r) => <div key={r.label} className="py-2.5 first:pt-0 last:pb-0"><ResultsRow label={r.label} r={r.counts} /></div>)}</div> : <p className="text-inkMuted">{outcome.text}</p>}</section>}
    </div>
    <footer className="flex shrink-0 justify-end border-t border-rule px-5 py-4 sm:px-6"><Button variant="primary" onClick={onClose} className="h-10 rounded-xl px-5 text-sm">Done</Button></footer>
  </AdsDialog>;
}
