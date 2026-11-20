"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronRight, ExternalLink, FolderClock, ListChecks } from "lucide-react";
import { receiptLinkLabel } from "@zavi/shared";
import { getPlan, type PlannedEmail } from "@/lib/workspace/emailPlanApi";
import { EMAIL_PLAN_CHANGED_EVENT } from "../../email/NewCampaignDialog";
import { Button } from "@/components/ui/Button";
import { CHANNEL_HISTORY_VIEW_EVENT, type ChannelHistoryState } from "../useChannelHistory";
import { HistoryDisclosure } from "./HistoryDisclosure";
import { HistoryDetailDialog } from "./HistoryDetailDialog";
import { HistoryStatus } from "./HistoryStatus";
import { currentHistoryItem, historyDate, historyKind, historyLogs, historyReceipt, historyStamp, historyStatus, historyTitle, historyTone, type HistoryItem } from "./historyPresentation";

const PAGE_SIZE = 5;

function useSentPlanned(enabled: boolean): PlannedEmail[] {
  const [sent, setSent] = useState<PlannedEmail[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const again = () => setTick((n) => n + 1);
    window.addEventListener(EMAIL_PLAN_CHANGED_EVENT, again);
    return () => window.removeEventListener(EMAIL_PLAN_CHANGED_EVENT, again);
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    getPlan()
      .then((v) => {
        if (live) setSent(v.items.filter((i) => i.status === "sent"));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [enabled, tick]);
  return sent;
}

export function ChannelHistory({ slug, history, doneHistory = false, logsOnly = false }: { slug: string; history: ChannelHistoryState; doneHistory?: boolean; logsOnly?: boolean }) {
  const [selected, setSelected] = useState<HistoryItem | null>(null);
  const sentPlanned = useSentPlanned(doneHistory || slug === "email_marketing");
  const [shown, setShown] = useState(PAGE_SIZE);
  const [logsShown, setLogsShown] = useState(PAGE_SIZE);
  const [view, setView] = useState<{ id: string; n: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onView = (e: Event) => {
      const detail = (e as CustomEvent<{ slug: string; id: string }>).detail;
      if (detail?.slug !== slug) return;
      setView((cur) => ({ id: detail.id, n: (cur?.n ?? 0) + 1 }));
      box.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    };
    window.addEventListener(CHANNEL_HISTORY_VIEW_EVENT, onView);
    return () => window.removeEventListener(CHANNEL_HISTORY_VIEW_EVENT, onView);
  }, [slug]);
  const wanted = view && history.state === "ready" ? history.history.closed.find((row) => row.id === view.id) ?? null : null;
  useEffect(() => {
    if (!wanted) return;
    setSelected({ source: "action", row: wanted });
    setView((cur) => (cur ? { id: "", n: cur.n } : cur));
  }, [wanted]);
  if (history.state !== "ready") return null;
  const { closed: allClosed, pre_switch: allPrevious } = history.history;
  const closed = doneHistory ? allClosed.filter((row) => row.status === "acted") : allClosed;
  const previous = doneHistory ? [] : allPrevious;
  const closedIds = new Set(closed.map((row) => row.id));
  const planned = doneHistory ? sentPlanned.filter((p) => !(p.card && closedIds.has(p.card.id))) : [];
  const logs = historyLogs(history.history);
  const current = currentHistoryItem(selected, history.history);
  const listByCard = new Map(sentPlanned.flatMap((p) => (p.card ? [[p.card.id, p.list_name] as const] : [])));
  const kindOf = (item: HistoryItem) => historyKind(item, { email: slug === "email_marketing", listName: item.source === "action" ? listByCard.get(item.row.id) : null });
  const draw = (item: HistoryItem, key: string) => {
    const stamp = historyStamp(item);
    const live = historyReceipt(item)?.url ?? null;
    return <li key={key} className="flex min-w-0 items-center"><button type="button" onClick={() => setSelected(item)} aria-haspopup="dialog" className="flex w-full min-w-0 flex-1 items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-creamDeep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-inkMuted">
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1"><span className="break-words text-sm font-medium leading-6 text-ink">{historyTitle(item)}</span><span className="text-detail leading-5 text-inkMuted">{kindOf(item)}{stamp && <> · <time dateTime={stamp}>{historyDate(stamp)}</time></>}</span></span>
      <span className="max-w-table-hint shrink-0"><HistoryStatus label={historyStatus(item)} tone={historyTone(item)} /></span><ChevronRight className="size-4 shrink-0 text-inkMuted" aria-hidden />
    </button>{live && <a href={live} target="_blank" rel="noopener noreferrer" data-testid="history-receipt-link" className="mr-5 inline-flex shrink-0 items-center gap-1 text-detail font-medium text-ink underline underline-offset-2">{receiptLinkLabel(live)}<ExternalLink className="h-3.5 w-3.5" aria-hidden /></a>}</li>;
  };
  const drawPlanned = (p: PlannedEmail) => {
    const stamp = p.sent_at ?? p.planned_at;
    const body = <>
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1"><span className="break-words text-sm font-medium leading-6 text-ink">{p.angle}</span><span className="text-detail leading-5 text-inkMuted">{`Email to ${p.list_name}`} · <time dateTime={stamp}>{historyDate(stamp)}</time></span></span>
      <span className="max-w-table-hint shrink-0"><HistoryStatus label="Sent" tone="success" /></span>{p.card ? <ChevronRight className="size-4 shrink-0 text-inkMuted" aria-hidden /> : <span aria-hidden className="size-4 shrink-0" />}
    </>;
    const cls = "flex w-full items-center gap-3 px-5 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-inkMuted";
    return <li key={`plan:${p.id}`} data-testid="done-planned-row" className="min-w-0">{p.card ? <Link href={`/workspace/email-cards/${p.card.rail}/${p.card.id}`} className={cls}>{body}</Link> : <div className={cls}>{body}</div>}</li>;
  };
  if (logsOnly && !logs.length) return null;
  return <div ref={box} className={logsOnly ? "min-w-0 space-y-4" : "mt-12 min-w-0 space-y-4"} data-testid={logsOnly ? "channel-logs" : "ads-channel-history"}>
    {!logsOnly && <HistoryDisclosure id={`${slug}-${doneHistory ? "done" : "history"}`} title="History" count={closed.length + previous.length + planned.length} icon={FolderClock} openSignal={view?.n ?? 0}>
      {closed.length + previous.length + planned.length === 0 && <p data-testid="history-empty" className="px-5 py-4 text-sm leading-6 text-inkMuted">Nothing here yet. Cards you approve, reject or finish show up here.</p>}
      {planned.length + closed.length > 0 && <ul className="divide-y divide-rule px-2 py-4">{planned.slice(0, shown).map((p) => drawPlanned(p))}{closed.slice(0, Math.max(0, shown - planned.length)).map((row) => draw({ source: "action", row }, row.id))}</ul>}
      {shown < planned.length + closed.length && <div className="px-5 pb-4"><Button onClick={() => setShown((count) => count + PAGE_SIZE)} className="h-9 rounded-lg px-3 text-sm">Show more</Button></div>}
      {previous.length > 0 && <div data-testid="ads-pre-switch" className="border-t border-rule"><p className="px-5 pt-4 text-detail leading-5 text-inkMuted">Before the switch. These older items are read-only and cannot be approved from here.</p><ul className="divide-y divide-rule px-2 py-4">{previous.map((row, index) => draw({ source: "previous", row }, `${row.run_id}:${row.position}:${index}`))}</ul></div>}
    </HistoryDisclosure>}
    {logs.length > 0 && <HistoryDisclosure id={`${slug}-logs`} title="Logs" count={logs.length} icon={ListChecks}>
      <p className="px-5 pt-4 text-xs text-inkMuted">Times in UTC</p>
      <ol className="space-y-3 p-5">{logs.slice(0, logsShown).map((log) => <li key={log.id} className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm leading-6"><span className="w-36 shrink-0 text-inkMuted">{log.at ? <time dateTime={log.at}>{historyDate(log.at, "dateTime")}</time> : "Time not recorded"}</span><span className={log.failed ? "min-w-0 flex-1 basis-48 break-words text-danger" : "min-w-0 flex-1 basis-48 break-words text-inkSoft"}>{log.text}</span></li>)}</ol>
      {logsShown < logs.length && <div className="px-5 pb-4"><Button onClick={() => setLogsShown((count) => count + PAGE_SIZE)} className="h-9 rounded-lg px-3 text-sm">Show more logs</Button></div>}
    </HistoryDisclosure>}
    {current && <HistoryDetailDialog key={current.source === "action" ? current.row.id : `${current.row.run_id}:${current.row.position}`} item={current} kind={kindOf(current)} showCard={slug !== "email_marketing"} onClose={() => setSelected(null)} />}
  </div>;
}
