"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, CalendarDays, Check, ChevronDown, FileText, RotateCcw } from "lucide-react";
import { CREATOR_MARKETPLACE_ENABLED } from "@zavi/shared";
import {
  creatorApi,
  CreatorApiError,
  money,
  type CreatorOffer,
  type ThreadMessage,
} from "@/lib/creator/api";
import { ROUNDS_LINE, priceCents } from "@/lib/creator/packageSpec";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  BTN_SMALL,
  ErrorNote,
  FeeLine,
  FIELD,
  Bone,
  StatusPill,
  Stepper,
} from "./areaUi";

export function stamp(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const mins = Math.floor((now.getTime() - d.getTime()) / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ago`;
  if (mins < 7 * 24 * 60) {
    const day = d.toLocaleDateString("en-US", { weekday: "short" });
    const hm = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    return `${day} ${hm}`;
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function dayLabel(v: string): string {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function offerTitle(o: Pick<CreatorOffer, "kind" | "terms">): string {
  const t = o.terms?.["title"];
  if (typeof t === "string" && t.trim()) return t.trim();
  return o.kind === "ugc_video" ? "Custom video" : "Custom offer";
}

export type Line = { from: "me" | "them"; body: string; at: string; iso?: string };

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0]?.[0] ?? "?").toUpperCase();
}

export function dayHeading(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

export type TimelineEntry = {
  key: string;
  from: "me" | "them";
  iso?: string;
  at: string;
  body?: string;
  action?: string;
  node?: ReactNode;
};

function Face({ label, mine }: { label: string; mine: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex size-9 shrink-0 items-center justify-center rounded-full text-[13px] font-bold ${
        mine ? "bg-foreground text-white" : "bg-[#e7e9ee] text-foreground"
      }`}
    >
      {initials(label)}
    </span>
  );
}

export function Timeline({ entries, them }: { entries: TimelineEntry[]; them: string }) {
  return (
    <ul>
      {entries.map((e, i) => {
        const prev = entries[i - 1];
        const day = e.iso ? dayHeading(e.iso) : "";
        const newDay = !!day && (!prev?.iso || dayHeading(prev.iso) !== day);
        const firstOfRun = newDay || !prev || prev.from !== e.from || !!e.action || !!prev.action;
        const who = e.from === "me" ? "You" : them;
        return (
          <li key={e.key} className={i === 0 ? "" : firstOfRun ? "mt-5" : "mt-1.5"}>
            {newDay && (
              <div className="mb-4 flex items-center gap-3" role="separator" aria-label={day}>
                <span className="shrink-0 text-[13px] font-medium text-muted">{day}</span>
                <span className="h-px flex-1 bg-black/[0.08]" />
              </div>
            )}
            <div className="flex gap-3">
              {firstOfRun ? <Face label={who} mine={e.from === "me"} /> : <span className="w-9 shrink-0" aria-hidden="true" />}
              <div className="min-w-0 flex-1">
                {firstOfRun && (
                  <p className="flex flex-wrap items-baseline gap-x-2 text-[14px]">
                    <span className="font-semibold text-foreground">{who}</span>
                    {e.action && <span className="text-foreground">{e.action}</span>}
                    <span className="text-[12px] text-muted">{e.at}</span>
                  </p>
                )}
                {e.body !== undefined && (
                  <p className={`${firstOfRun ? "mt-0.5" : ""} whitespace-pre-wrap break-words text-[14px] leading-relaxed text-foreground`}>{e.body}</p>
                )}
                {e.node}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function MessageList({ messages, them }: { messages: Line[]; them: string }) {
  return (
    <Timeline
      them={them}
      entries={messages.map((m, i) => ({ key: String(i), from: m.from, iso: m.iso, at: m.at, body: m.body }))}
    />
  );
}

export function Composer({ onSend, extra, busy }: { onSend: (body: string) => Promise<boolean>; extra?: ReactNode; busy?: boolean }) {
  const [text, setText] = useState("");
  async function send() {
    const body = text.trim();
    if (!body || busy) return;
    if (await onSend(body)) setText("");
  }
  const ready = text.trim().length > 0 && !busy;
  return (
    <div className="mt-5 rounded-2xl border border-black/[0.1] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)] focus-within:border-foreground/40 focus-within:shadow-[0_0_0_4px_rgba(9,9,11,0.06)]">
      <textarea
        value={text}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder="Send a message..."
        aria-label="Write a message"
        className="block w-full resize-none rounded-t-2xl bg-transparent px-4 pt-3.5 text-[14px] leading-relaxed text-foreground outline-none placeholder:text-muted"
      />
      <div className="flex items-center justify-between gap-3 px-3 pt-1 pb-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">{extra}</div>
        <button
          type="button"
          onClick={() => void send()}
          disabled={!ready}
          aria-label="Send"
          className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full bg-foreground text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-25"
        >
          <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.5} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function toLines(messages: ThreadMessage[]): Line[] {
  return messages
    .filter((m) => m.sender_kind === "creator" || m.sender_kind === "tenant")
    .map((m) => ({ from: m.sender_kind === "creator" ? "me" : "them", body: m.body, at: stamp(m.created_at), iso: m.created_at }));
}

export function acceptedOfferIsPaid(o: Pick<CreatorOffer, "status" | "awaiting_payment" | "closed_unpaid">): boolean {
  return o.status === "accepted" && o.awaiting_payment === false && o.closed_unpaid !== true;
}

function OfferCard({
  o,
  them,
  onChanged,
}: {
  o: CreatorOffer;
  them: string;
  onChanged: (next: CreatorOffer, orderId?: string) => void;
}) {
  const mine = o.proposed_by === "creator";
  const [busy, setBusy] = useState<"accept" | "decline" | "withdraw" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const due = typeof o.terms?.["due_date"] === "string" ? dayLabel(o.terms["due_date"] as string) : null;
  const dead = o.expired || o.status === "expired";
  const open = o.status === "open" && !dead;

  async function act(kind: "accept" | "decline" | "withdraw") {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "accept") {
        const r = await creatorApi.acceptOffer(o.id);
        onChanged(r.offer, r.order?.order_id);
      } else if (kind === "decline") {
        onChanged((await creatorApi.declineOffer(o.id)).offer);
      } else {
        onChanged((await creatorApi.withdrawOffer(o.id)).offer);
      }
    } catch (e) {
      setError(e instanceof CreatorApiError ? e.message : "That did not go through. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-2 max-w-[520px] rounded-xl bg-[#f6f7f9]">
      <div className="border-l-[3px] border-foreground/80 py-3.5 pr-4 pl-4">
      <p className="flex items-center gap-2 text-[12px] font-semibold tracking-[0.04em] text-muted uppercase">
        <FileText className="h-3.5 w-3.5" aria-hidden="true" />
        {mine ? "Your custom offer" : `Custom offer from ${them}`}
      </p>
      <div className="mt-1.5 flex items-start justify-between gap-3">
        <p className="text-[16px] font-semibold leading-snug text-foreground">{offerTitle(o)}</p>
        <p className="shrink-0 text-[16px] font-bold text-foreground tabular-nums">{money(o.price_cents)}</p>
      </div>
      {o.note && (
        <p className="mt-2 rounded-lg bg-white px-3 py-2 text-[14px] leading-relaxed text-foreground">
          <span className="text-muted">Note: </span>
          {o.note}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2 text-[12px] text-muted">
        <span className="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1">
          <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
          {due ? `Due ${due}` : `Due ${o.delivery_days} days after it starts`}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1">
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          {ROUNDS_LINE}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-successBg px-2.5 py-1 font-semibold text-success">
          You receive {money(o.fees.creator_payout_cents)}
        </span>
      </div>
      {error ? (
        <div className="mt-3">
          <ErrorNote message={error} />
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {CREATOR_MARKETPLACE_ENABLED && open && mine && (
          <>
            <StatusPill tone="wait">Waiting for {them}</StatusPill>
            <button type="button" disabled={busy !== null} onClick={() => void act("withdraw")} className={BTN_SMALL}>
              {busy === "withdraw" ? "Withdrawing" : "Withdraw"}
            </button>
          </>
        )}
        {CREATOR_MARKETPLACE_ENABLED && open && !mine && (
          <>
            <button type="button" disabled={busy !== null} onClick={() => void act("accept")} className={`${BTN_PRIMARY} h-10`}>
              <Check className="h-4 w-4" aria-hidden="true" />
              {busy === "accept" ? "Accepting" : "Accept"}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => void act("decline")} className={`${BTN_SECONDARY} h-10`}>
              {busy === "decline" ? "Declining" : "Decline"}
            </button>
          </>
        )}
        {o.status === "withdrawn" && <StatusPill tone="neutral">{mine ? "You withdrew this offer" : `${them} withdrew this offer`}</StatusPill>}
        {o.status === "declined" && <StatusPill tone="neutral">{mine ? `${them} declined this offer` : "You declined this offer"}</StatusPill>}
        {dead && o.status !== "accepted" && o.status !== "declined" && o.status !== "withdrawn" && (
          <StatusPill tone="neutral">This offer expired</StatusPill>
        )}
        {o.status === "accepted" && o.closed_unpaid === true && <StatusPill tone="neutral">Closed, not paid</StatusPill>}
        {o.status === "accepted" && o.closed_unpaid !== true && mine && (
          <StatusPill tone="good">{acceptedOfferIsPaid(o) ? "Paid, job started" : `${them} accepted`}</StatusPill>
        )}
        {o.status === "accepted" && mine && acceptedOfferIsPaid(o) && (
          <Link href="/creator/jobs" className={BTN_SMALL}>
            See it in Jobs
          </Link>
        )}
      </div>
      {o.status === "accepted" && o.closed_unpaid === true && (
        <p className="mt-3 text-[13px] text-muted">
          {mine ? `${them} accepted, but did not pay` : `You accepted, but ${them} did not pay`} before the offer expired, so it
          closed. Nothing was charged and there is no job.
        </p>
      )}
      {o.status === "accepted" && o.closed_unpaid !== true && mine && !acceptedOfferIsPaid(o) && (
        <p className="mt-3 text-[13px] text-muted">Waiting for {them} to pay. It shows in your Jobs once they do.</p>
      )}
      {o.status === "accepted" && o.closed_unpaid !== true && !mine && (
        <div className="mt-3 rounded-xl bg-successBg px-4 py-3 text-[14px] text-success">
          <p className="font-semibold">
            {acceptedOfferIsPaid(o)
              ? `You accepted and ${them} paid. The job has started.`
              : `You accepted. ${them} is asked to pay ${money(o.fees.business_total_cents)}.`}
          </p>
          {acceptedOfferIsPaid(o) ? (
            <Link href="/creator/jobs" className={`${BTN_SMALL} mt-2`}>
              See it in Jobs
            </Link>
          ) : (
            <p className="mt-1 text-[13px]">Waiting for {them} to pay. It shows in your Jobs once they do.</p>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

function todayPlus(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function daysUntil(day: string): number {
  const due = new Date(`${day}T23:59:59`);
  return Math.ceil((due.getTime() - Date.now()) / 86_400_000);
}

function OfferForm({ threadId, onSent, onCancel }: { threadId: string; onSent: (o: CreatorOffer) => void; onCancel: () => void }) {
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState("");
  const [due, setDue] = useState(todayPlus(14));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = Number(price);
  const cents = priceCents(price);
  const days = due ? daysUntil(due) : 0;

  async function send() {
    if (!cents || !due) return;
    if (days < 1 || days > 90) {
      setError("Pick a due date between tomorrow and 90 days from now.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await creatorApi.sendOffer(threadId, {
        kind: "ugc_video",
        terms: { title: `${qty} ${qty > 1 ? "UGC videos" : "UGC video"}`, content_type: "UGC video", count: qty, due_date: due },
        price_cents: cents,
        delivery_days: days,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onSent(r.offer);
    } catch (e) {
      setError(e instanceof CreatorApiError ? e.message : "That offer did not send. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, []);
  return (
    <div ref={box} data-testid="offer-form" className="mt-4 rounded-2xl border border-black/[0.08] bg-black/[0.02] p-4">
      <p className="text-[14px] font-semibold text-foreground">New custom offer</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <span className="mb-1.5 block text-[14px] font-medium text-muted">How many UGC videos</span>
          <Stepper value={qty} onChange={setQty} />
        </div>
        <label className="block">
          <span className="mb-1.5 block text-[14px] font-medium text-muted">Price</span>
          <input
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="400"
            className={`${FIELD} h-12 px-4`}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[14px] font-medium text-muted">Due date</span>
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={`${FIELD} h-12 px-4`} />
        </label>
      </div>
      <label className="mt-3 block">
        <span className="mb-1.5 block text-[14px] font-medium text-muted">Note (optional)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you will film" className={`${FIELD} h-12 px-4`} />
      </label>
      <p className="mt-3 text-[13px] text-foreground">Includes {ROUNDS_LINE}.</p>
      <FeeLine price={n} />
      {error ? (
        <div className="mt-3">
          <ErrorNote message={error} />
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-3">
        <button type="button" disabled={!cents || !due || busy} onClick={() => void send()} className={BTN_PRIMARY}>
          {busy ? "Sending" : "Send offer"}
        </button>
        <button type="button" onClick={onCancel} className={BTN_SECONDARY}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export const MESSAGES_POLL_MS = 30_000;

export const THREAD_POLL_MS = 3_000;

export const THREAD_POLL_STALL_MS = 15_000;

function keepNewer<T extends { id: string; created_at: string | null }>(fresh: T[], prev: T[]): T[] {
  const newest = fresh.reduce((a, x) => (x.created_at && x.created_at > a ? x.created_at : a), "");
  return [...fresh, ...prev.filter((x) => (x.created_at ?? "") > newest && !fresh.some((f) => f.id === x.id))];
}

export function CreatorThreadView({
  threadId,
  name,
  onSeen,
}: {
  threadId: string;
  name: string | null;
  onSeen?: (newestAt: string) => void;
}) {
  const [messages, setMessages] = useState<ThreadMessage[] | null>(null);
  const [offers, setOffers] = useState<CreatorOffer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [sending, setSending] = useState(false);
  const them = name || "The business";

  const take = useCallback((m: ThreadMessage[], o: CreatorOffer[]) => {
    setMessages((prev) => keepNewer(m, prev ?? []));
    setOffers((prev) => keepNewer([...o].reverse(), prev));
  }, []);

  const load = useCallback(() => {
    Promise.all([creatorApi.threadMessages(threadId), creatorApi.threadOffers(threadId)])
      .then(([m, o]) => take(m.messages, o.offers))
      .catch((e: unknown) => setError(e instanceof CreatorApiError ? e.message : "This conversation did not load."));
  }, [threadId, take]);

  useEffect(load, [load]);

  const newestAt = (messages ?? []).reduce((a, m) => (m.created_at && m.created_at > a ? m.created_at : a), "");
  useEffect(() => {
    if (newestAt) onSeen?.(newestAt);
  }, [newestAt, onSeen]);

  const actedAt = useRef(0);
  useEffect(() => {
    let alive = true;
    let busySince = 0;
    let seq = 0;
    let applied = 0;
    const every = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (busySince && Date.now() - busySince < THREAD_POLL_STALL_MS) return;
      const mine = ++seq;
      const started = Date.now();
      busySince = started;
      Promise.all([creatorApi.threadMessages(threadId), creatorApi.threadOffers(threadId)])
        .then(([m, o]) => {
          if (!alive || mine < applied) return;
          applied = mine;
          if (started <= actedAt.current) setMessages((prev) => keepNewer(m.messages, prev ?? []));
          else take(m.messages, o.offers);
        })
        .catch(() => undefined)
        .finally(() => {
          if (seq === mine) busySince = 0;
        });
    }, THREAD_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(every);
    };
  }, [threadId, take]);

  async function send(body: string): Promise<boolean> {
    setSending(true);
    setSendError(null);
    try {
      const r = await creatorApi.sendThreadMessage(threadId, body);
      setMessages((prev) => [...(prev ?? []), r.message]);
      return true;
    } catch (e) {
      setSendError(e instanceof CreatorApiError ? e.message : "That message did not send.");
      return false;
    } finally {
      setSending(false);
    }
  }

  const entries: TimelineEntry[] = [
    ...toLines(messages ?? []).map((l, i) => ({ key: `m${i}`, from: l.from, iso: l.iso, at: l.at, body: l.body })),
    ...offers.map((o) => ({
      key: `o${o.id}`,
      from: (o.proposed_by === "creator" ? "me" : "them") as "me" | "them",
      iso: o.created_at,
      at: stamp(o.created_at),
      action: "sent a custom offer",
      node: (
        <OfferCard
          o={o}
          them={them}
          onChanged={(next) => {
            actedAt.current = Date.now();
            setOffers((prev) => prev.map((x) => (x.id === next.id ? { ...x, ...next } : x)));
          }}
        />
      ),
    })),
  ].sort((a, b) => (a.iso ?? "").localeCompare(b.iso ?? ""));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-black/[0.06] pb-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[#e7e9ee] text-[14px] font-bold text-foreground">{initials(them)}</span>
        <div className="min-w-0">
          <h1 className="truncate text-[20px] font-bold leading-tight tracking-[-0.01em] text-foreground">{them}</h1>
          <p className="mt-0.5 text-[13px] text-muted">Messages and custom offers</p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-4 pr-2">
        {error ? (
          <ErrorNote message={error} />
        ) : !messages ? (
          <ThreadSkeleton />
        ) : entries.length === 0 ? (
          <p className="py-10 text-center text-[14px] text-muted">
            {CREATOR_MARKETPLACE_ENABLED ? `No messages yet. Say hello, or send ${them} a custom offer.` : "No messages yet. Say hello."}
          </p>
        ) : (
          <Timeline entries={entries} them={them} />
        )}
        {CREATOR_MARKETPLACE_ENABLED && composing && (
          <OfferForm
            threadId={threadId}
            onSent={(o) => {
              setOffers((prev) => [...prev, o]);
              setComposing(false);
            }}
            onCancel={() => setComposing(false)}
          />
        )}
      </div>

      <div className="shrink-0">
        {sendError ? (
          <div className="mt-3">
            <ErrorNote message={sendError} />
          </div>
        ) : null}
        {messages && !error && (
          <Composer
            onSend={send}
            busy={sending}
            extra={CREATOR_MARKETPLACE_ENABLED ? (
              <button type="button" onClick={() => setComposing(true)} disabled={composing} className={BTN_SMALL}>
                <FileText className="h-4 w-4" aria-hidden="true" />
                Send a custom offer
              </button>
            ) : undefined}
          />
        )}
        <p className="mt-2 text-[12px] text-muted">
          {them} gets an email when you send a message{CREATOR_MARKETPLACE_ENABLED ? " or an offer" : ""}, at most one email per conversation every 15 minutes.
        </p>
      </div>
    </div>
  );
}

export function ThreadSkeleton() {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading this conversation.</span>
      <div aria-hidden="true" className="space-y-5">
        {[
          ["w-24", "w-2/3"],
          ["w-16", "w-1/3"],
          ["w-24", "w-1/2"],
        ].map(([who, body], i) => (
          <div key={i} className="flex gap-3">
            <Bone className="size-9 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1">
              <Bone className={`h-3.5 ${who} rounded-full`} />
              <Bone className={`mt-2 h-4 ${body} rounded-full`} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function InfoSection({ title, open = false, children }: { title: string; open?: boolean; children: ReactNode }) {
  return (
    <details open={open} className="group rounded-xl border border-black/[0.08] bg-white">
      {}
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3.5 text-[14px] font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground/30 [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDown className="h-4 w-4 text-muted transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="px-4 pb-4">{children}</div>
    </details>
  );
}

export function ThreadInfo({ name }: { name: string | null }) {
  const them = name || "The business";
  return (
    <div className="space-y-3">
      <div className="flex flex-col items-center px-2 pt-2 pb-4 text-center">
        <span className="flex size-16 items-center justify-center rounded-full bg-[#e7e9ee] text-[20px] font-bold text-foreground">{initials(them)}</span>
        <p className="mt-3 text-[16px] font-semibold text-foreground">{them}</p>
        <p className="mt-0.5 text-[13px] text-muted">A business on Zavi</p>
      </div>
      {CREATOR_MARKETPLACE_ENABLED ? (
        <InfoSection title="How offers work" open>
          <ul className="space-y-2 text-[13px] leading-relaxed text-muted">
            <li>If {them} accepts your offer, they pay for it and the job starts once the payment goes through.</li>
            <li>If you accept their offer, they are asked to pay. The job starts when they do.</li>
            <li>There is no job until {them} pays. An offer not paid within 72 hours of being sent closes, and nothing is charged.</li>
            <li>Every offer includes {ROUNDS_LINE}. You receive the price less Zavi&apos;s 15%.</li>
          </ul>
        </InfoSection>
      ) : null}
      <InfoSection title={`About ${them}`}>
        <p className="text-[13px] leading-relaxed text-muted">A business on Zavi. Messages and offers with them stay here.</p>
      </InfoSection>
    </div>
  );
}
