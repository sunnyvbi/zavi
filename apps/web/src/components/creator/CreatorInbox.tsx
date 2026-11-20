"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Check, Clock, MessageSquare, Sparkles } from "lucide-react";
import {
  creatorApi,
  CreatorApiError,
  money,
  type CreatorAlert,
  type CreatorBriefCard,
  type CreatorJob,
  type CreatorThreadSummary,
} from "@/lib/creator/api";
import { BTN_PRIMARY, BTN_SECONDARY, BTN_SMALL, Card, CardSkeleton, EmptySlot, ErrorNote, H1, Loading, RING, RowsSkeleton, SectionLabel, StatusPill } from "./areaUi";
import { offerTitle, stamp } from "./CreatorThread";
import { answerConfirm, jobTerms, jobTitle } from "./CreatorJobs";
import { InlineConfirm } from "@/components/humans/InlineConfirm";
import { NextChevron } from "@/components/ui/NextChevron";

export const INBOX_CHANGED = "zavi:creator-inbox-changed";

export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function RequestCard({ job, onDone }: { job: CreatorJob; onDone: () => void }) {
  const [busy, setBusy] = useState<"accept" | "pass" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"accept" | "pass" | null>(null);
  const biz = job.business_name?.trim() || "The business";

  const act = async (kind: "accept" | "pass") => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "accept") await creatorApi.accept(job.id);
      else await creatorApi.pass(job.id, "");
      setConfirming(null);
      onDone();
      window.dispatchEvent(new Event(INBOX_CHANGED));
    } catch (e) {
      setError(e instanceof CreatorApiError ? e.message : "That did not go through. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StatusPill tone="dark">{job.source === "applicant" ? "Hired from a brief" : "Booking request"}</StatusPill>
        {job.deadline ? (
          <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-warn">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            Answer by {job.deadline.deadline_text}
          </span>
        ) : null}
      </div>
      <p className="mt-3 break-words text-[16px] font-semibold text-foreground">
        {job.business_name?.trim() || "A business"} booked {jobTitle(job)}
      </p>
      <p className="mt-1 text-[14px] text-muted">{jobTerms(job, job.business_name?.trim() || "The business")}</p>
      <p className="mt-3 text-[14px] text-foreground">
        You receive <span className="font-semibold">{money(job.creator_payout_cents)}</span>
        <span className="text-muted"> ({money(job.price_cents)} less Zavi&apos;s 15%)</span>
      </p>
      <p className="mt-2 text-[13px] text-muted">Their card is on hold until you answer.</p>
      {error ? (
        <div className="mt-3">
          <ErrorNote message={error} />
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" disabled={busy !== null} onClick={() => setConfirming("accept")} className={BTN_PRIMARY}>
          <Check className="h-4 w-4" aria-hidden="true" />
          {busy === "accept" ? "Accepting" : "Accept"}
        </button>
        <button type="button" disabled={busy !== null} onClick={() => setConfirming("pass")} className={BTN_SECONDARY}>
          {busy === "pass" ? "Passing" : "Pass"}
        </button>
        <Link href={`/creator/jobs/${job.id}`} className={BTN_SECONDARY}>
          Open the booking
        </Link>
      </div>
      {confirming ? (
        <InlineConfirm
          text={answerConfirm(confirming, job, biz).text}
          confirmLabel={busy ? "Working" : answerConfirm(confirming, job, biz).label}
          busy={busy !== null}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void act(confirming)}
          primaryClass={BTN_PRIMARY}
          secondaryClass={BTN_SECONDARY}
        />
      ) : null}
    </Card>
  );
}

function BriefCard({ b }: { b: CreatorBriefCard }) {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StatusPill tone="good">
          <Sparkles className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Brief fits you
        </StatusPill>
        {b.answer_by ? <span className="text-[13px] text-muted">Answer by {shortDate(b.answer_by)}</span> : null}
      </div>
      <p className="mt-3 break-words text-[16px] font-semibold text-foreground">
        {b.business_name ? `${b.business_name}: ` : ""}
        {b.title}
      </p>
      {b.angle ? <p className="mt-1 break-words text-[14px] text-muted">{b.angle}</p> : null}
      <p className="mt-2 text-[14px] text-foreground">
        {b.budget_usd != null ? (
          <>
            Budget <span className="font-semibold">${b.budget_usd.toLocaleString("en-US")}</span>
          </>
        ) : null}
        {b.budget_usd != null && b.delivery_days != null ? " · " : null}
        {b.delivery_days != null ? `deliver in ${b.delivery_days} days` : null}
      </p>
      <Link href={`/creator/briefs?brief=${b.id}`} className={`${BTN_SECONDARY} mt-4`}>
        See the brief and apply
        <NextChevron />
      </Link>
    </Card>
  );
}

export function threadLine(t: CreatorThreadSummary): { line: string; tag: string | null } {
  const o = t.open_offer;
  const m = t.last_message;
  if (o && (!m || o.created_at >= m.created_at)) {
    const what = `${offerTitle({ kind: o.kind, terms: o.terms })}, ${money(o.price_cents)}`;
    return o.proposed_by === "tenant"
      ? { line: `Sent you a custom offer: ${what}`, tag: "Offer for you" }
      : { line: `You sent a custom offer: ${what}`, tag: null };
  }
  const tag = o && o.proposed_by === "tenant" ? "Offer for you" : null;
  if (!m) return { line: "No messages yet.", tag };
  return { line: m.sender_kind === "creator" ? `You: ${m.body}` : m.body, tag };
}

function ThreadList({ threads }: { threads: CreatorThreadSummary[] }) {
  return (
    <>
        {threads.map((t) => {
          const { line, tag } = threadLine(t);
          return (
            <li key={t.thread_id}>
              <Link
                href={`/creator/messages?thread=${encodeURIComponent(t.thread_id)}`}
                className={`${RING} flex flex-wrap items-center gap-3 rounded-xl px-3 py-3 hover:bg-black/[0.03]`}
              >
                <MessageSquare className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 break-words text-[14px] font-semibold text-foreground">{t.business_name}</span>
                    {tag ? <StatusPill tone="wait">{tag}</StatusPill> : null}
                  </span>
                  <span className="mt-0.5 block truncate text-[13px] text-muted">{line}</span>
                </span>
                <span className="shrink-0 text-[12px] text-muted">{stamp(t.last_message_at)}</span>
                <span className={BTN_SMALL}>Open</span>
              </Link>
            </li>
          );
        })}
    </>
  );
}

const seenKey = (threadId: string) => `zavi.creator.seen.${threadId}`;

function seenAt(threadId: string): string | null {
  try {
    return localStorage.getItem(seenKey(threadId));
  } catch {
    return null;
  }
}

export function waitingSince(t: CreatorThreadSummary): string | null {
  const times: string[] = [];
  if (t.open_offer?.proposed_by === "tenant") times.push(t.open_offer.created_at ?? "");
  if (t.last_message != null && t.last_message.sender_kind !== "creator") times.push(t.last_message.created_at ?? "");
  return times.length ? times.sort()[times.length - 1] : null;
}

export function markCreatorThreadSeen(threadId: string, at: string): void {
  try {
    const prev = localStorage.getItem(seenKey(threadId));
    if (prev && prev >= at) return;
    localStorage.setItem(seenKey(threadId), at);
  } catch {
    return;
  }
  window.dispatchEvent(new Event(INBOX_CHANGED));
}

export function messagesWaiting(threads: CreatorThreadSummary[]): number {
  return threads.filter((t) => {
    const since = waitingSince(t);
    if (since === null) return false;
    const seen = seenAt(t.thread_id);
    return !(seen && seen >= since);
  }).length;
}

export function inboxCount(
  requests: CreatorJob[],
  threads: CreatorThreadSummary[],
  changes: CreatorJob[] = [],
  alerts: CreatorAlert[] = [],
): number {
  return requests.length + messagesWaiting(threads) + changes.length + unreadUpdates(alerts).length;
}

const COUNTED_ELSEWHERE = new Set(["thread_message", "custom_offer_received", "revision_requested", "booking_request_received"]);

export async function readAlerts(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await Promise.allSettled(ids.map((id) => creatorApi.markAlertRead(id)));
  window.dispatchEvent(new Event(INBOX_CHANGED));
}

export function threadAlertIds(alerts: CreatorAlert[], threadId: string): string[] {
  const needle = `thread=${encodeURIComponent(threadId)}`;
  return alerts
    .filter((a) => a.read_at === null && a.kind === "thread_message" && (a.link_path ?? "").includes(needle))
    .map((a) => a.id);
}

export function unreadUpdates(alerts: CreatorAlert[]): CreatorAlert[] {
  return alerts.filter((a) => a.read_at === null && !COUNTED_ELSEWHERE.has(a.kind));
}

export function changesAsked(jobs: CreatorJob[]): CreatorJob[] {
  return jobs.filter((j) => j.status === "revision_requested");
}

function ChangeCard({ job }: { job: CreatorJob }) {
  const biz = job.business_name?.trim() || "The business";
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 break-words text-[16px] font-semibold text-foreground">
          {biz} asked for changes on {jobTitle(job)}
        </p>
        <StatusPill tone="wait">Changes asked</StatusPill>
      </div>
      {job.change_request_note ? (
        <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[14px] leading-relaxed text-foreground">&ldquo;{job.change_request_note}&rdquo;</p>
      ) : (
        <p className="mt-2 text-[14px] text-muted">Open the job to see what {biz} wants changed.</p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Link href={`/creator/jobs/${job.id}#feedback`} className={BTN_PRIMARY}>
          See feedback and reply
          <NextChevron />
        </Link>
      </div>
    </Card>
  );
}

function AlertRow({ alert, onRead }: { alert: CreatorAlert; onRead: (id: string) => void }) {
  const unread = alert.read_at === null;
  const inner = (
    <>
      <MessageSquare className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 break-words text-[14px] font-semibold text-foreground">{alert.title}</span>
          {unread ? <StatusPill tone="wait">New</StatusPill> : null}
        </span>
        {alert.body ? <span className="mt-0.5 block truncate text-[13px] text-muted">{alert.body}</span> : null}
      </span>
      <span className="shrink-0 text-[12px] text-muted">{shortDate(alert.created_at)}</span>
      {alert.link_path ? <span className={BTN_SMALL}>Open</span> : null}
    </>
  );
  const cls = `${RING} flex w-full flex-wrap items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-black/[0.03]`;
  return (
    <li>
      {alert.link_path ? (
        <Link href={alert.link_path} className={cls} onClick={() => onRead(alert.id)}>
          {inner}
        </Link>
      ) : (
        <button type="button" className={cls} onClick={() => onRead(alert.id)}>
          {inner}
        </button>
      )}
    </li>
  );
}

export const ALERTS_SHOWN = 30;

export function updatesCount(alerts: CreatorAlert[]): string {
  const full = alerts.length >= ALERTS_SHOWN;
  const unread = alerts.filter((a) => a.read_at === null).length;
  const total = `${alerts.length}${full ? "+" : ""}`;
  const fresh = unread > 0 ? `, ${unread}${full && unread === alerts.length ? "+" : ""} new` : "";
  return `${total}${fresh}`;
}

function Updates({ alerts, onRead, onReadAll }: { alerts: CreatorAlert[]; onRead: (id: string) => void; onReadAll: () => void }) {
  const hasNew = alerts.some((a) => a.read_at === null);
  const [open, setOpen] = useState(hasNew);
  useEffect(() => {
    if (hasNew) setOpen(true);
  }, [hasNew]);
  return (
    <details className="group mt-3" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className={`${RING} inline-flex cursor-pointer list-none items-center gap-2 rounded-lg px-1 text-[14px] font-semibold text-muted hover:text-foreground`}>
        Updates from Zavi ({updatesCount(alerts)})<span className="text-[12px] font-normal group-open:hidden">Show</span>
        <span className="hidden text-[12px] font-normal group-open:inline">Hide</span>
      </summary>
      {hasNew ? (
        <button
          type="button"
          onClick={onReadAll}
          className={`${RING} ml-2 rounded-cta px-1 text-[12px] font-semibold text-foreground underline underline-offset-2 hover:text-muted`}
        >
          Mark all read
        </button>
      ) : null}
      <Card className="mt-2 p-2">
        <ul className="divide-y divide-black/[0.06]">
          {alerts.map((a) => (
            <AlertRow key={a.id} alert={a} onRead={onRead} />
          ))}
        </ul>
      </Card>
    </details>
  );
}

export function CreatorInbox() {
  const params = useSearchParams();
  const router = useRouter();
  const threadId = params?.get("thread") ?? null;
  useEffect(() => {
    if (threadId) router.replace(`/creator/messages?thread=${encodeURIComponent(threadId)}`);
  }, [threadId, router]);
  const [requests, setRequests] = useState<CreatorJob[] | null>(null);
  const [alerts, setAlerts] = useState<CreatorAlert[] | null>(null);
  const [briefs, setBriefs] = useState<CreatorBriefCard[] | null>(null);
  const [threads, setThreads] = useState<CreatorThreadSummary[] | null>(null);
  const [changes, setChanges] = useState<CreatorJob[]>([]);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    creatorApi
      .inbox()
      .then((v) => {
        setRequests(v.requests);
        setAlerts(v.alerts);
      })
      .catch((e: unknown) => setError(e instanceof CreatorApiError ? e.message : "Your inbox did not load."));
    creatorApi
      .jobs("active")
      .then((v) => setChanges(changesAsked(v.jobs)))
      .catch(() => setChanges([]));
    creatorApi
      .briefs()
      .then((v) => setBriefs(v.briefs))
      .catch(() => setBriefs([]));
    creatorApi
      .threads()
      .then((v) => setThreads(v.threads))
      .catch((e: unknown) => setThreadsError(e instanceof CreatorApiError ? e.message : "Your messages did not load."));
  }, []);

  useEffect(load, [load]);
  useEffect(() => {
    window.addEventListener(INBOX_CHANGED, load);
    return () => window.removeEventListener(INBOX_CHANGED, load);
  }, [load]);

  const markRead = (id: string) => {
    const before = alerts?.find((a) => a.id === id)?.read_at ?? null;
    if (before !== null) return;
    const at = new Date().toISOString();
    setAlerts((prev) => prev?.map((a) => (a.id === id ? { ...a, read_at: at } : a)) ?? prev);
    creatorApi
      .markAlertRead(id)
      .then(() => window.dispatchEvent(new Event(INBOX_CHANGED)))
      .catch(() => {
      setAlerts((prev) => prev?.map((a) => (a.id === id ? { ...a, read_at: before } : a)) ?? prev);
    });
  };

  if (threadId) return <Loading what="this conversation" />;

  return (
    <div>
      <H1 title="Inbox" blurb="Bookings to answer, messages with businesses, and briefs that fit you." />
      <div className="mt-6 space-y-6">
        <section>
          <SectionLabel>Needs your answer</SectionLabel>
          <div className="mt-2 space-y-3">
            {error ? (
              <ErrorNote message={error} />
            ) : !requests ? (
              <CardSkeleton label="Loading booking requests." />
            ) : requests.length === 0 && changes.length === 0 ? (
              <EmptySlot>No booking requests right now. When a business books a package, it shows here and you have 72 hours to answer.</EmptySlot>
            ) : (
              <>
                {changes.map((job) => (
                  <ChangeCard key={job.id} job={job} />
                ))}
                {requests.map((job) => (
                  <RequestCard key={job.id} job={job} onDone={load} />
                ))}
              </>
            )}
          </div>
        </section>

        <section>
          <SectionLabel>Messages</SectionLabel>
          <div className="mt-2">
            {threadsError ? (
              <ErrorNote message={threadsError} />
            ) : !threads ? (
              <RowsSkeleton label="Loading messages." rows={2} />
            ) : threads.length === 0 ? (
              <EmptySlot>
                No messages yet. A business can message you from Find creators or from a brief you applied to. You can send them a custom offer in the
                conversation.
              </EmptySlot>
            ) : (
              <Card className="p-2">
                <ul className="divide-y divide-black/[0.06]">
                  <ThreadList threads={threads} />
                </ul>
              </Card>
            )}
          </div>
          {alerts && alerts.length > 0 ? (
            <Updates
              alerts={alerts}
              onRead={markRead}
              onReadAll={() => {
                const ids = alerts.filter((a) => a.read_at === null).map((a) => a.id);
                const at = new Date().toISOString();
                setAlerts((prev) => prev?.map((a) => (ids.includes(a.id) ? { ...a, read_at: at } : a)) ?? prev);
                void readAlerts(ids);
              }}
            />
          ) : null}
        </section>

        <section>
          <SectionLabel>Briefs that fit you</SectionLabel>
          <div className="mt-2">
            {!briefs ? (
              <CardSkeleton label="Loading briefs." />
            ) : briefs.length === 0 ? (
              <EmptySlot>No briefs for you right now. When a business posts a brief that fits your platforms and niches, it shows here.</EmptySlot>
            ) : (
              <BriefCard b={briefs[0]} />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
