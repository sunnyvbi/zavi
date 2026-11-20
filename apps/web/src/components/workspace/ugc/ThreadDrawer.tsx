"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FilePlus2, Mail } from "lucide-react";
import { feesFor, firstName, money, useUgcDrawer } from "./hub";
import { OfferCard } from "../actions/creators/OfferCard";
import { openIntroVideo } from "@/lib/creator/introVideo";
import { Bone, CreatorProfileCard, CreatorProfileCardSkeleton, DrawerNote, FIELD, ProductQuestion, SideDrawer, Thread, ThreadSkeleton, scrollDrawerToEnd, stamp, type ThreadItem } from "./ui";
import { callJson, inviteIdOf, isInviteId, useCreatorCards } from "./useCards";
import { POLL_MS, cachedThreads, markThreadSeen, rememberThreads, unreadFor } from "./unread";
import { readThreadNotices } from "./NotificationBell";
import { offerTitleOf } from "./offers";
import type { BusinessThreadSummary, CreatorOfferView, CreatorThreadMessageRow } from "./types";

type Loaded = { messages: CreatorThreadMessageRow[]; offers: CreatorOfferView[] };

function fetchThread(threadId: string): Promise<Partial<Loaded>> {
  if (isInviteId(threadId)) {
    return callJson<{ messages: CreatorThreadMessageRow[] }>(
      `/api/creators/invites/${encodeURIComponent(inviteIdOf(threadId))}/messages`,
    ).then((m) => ({ messages: m.ok ? m.data.messages : undefined, offers: [] }));
  }
  return Promise.all([
    callJson<{ messages: CreatorThreadMessageRow[] }>(`/api/creators/threads/${threadId}/messages`),
    callJson<{ offers: CreatorOfferView[] }>(`/api/creators/threads/${threadId}/offers`),
  ]).then(([m, o]) => ({ messages: m.ok ? m.data.messages : undefined, offers: o.ok ? o.data.offers : undefined }));
}

const threadCache = new Map<string, Loaded>();
const PREFETCH_MAX = 8;

export function ThreadDrawer() {
  const drawer = useUgcDrawer();
  const [threads, setThreads] = useState<BusinessThreadSummary[] | null>(cachedThreads);
  const [inviteConvs, setInviteConvs] = useState<BusinessThreadSummary[]>([]);
  const [emailNotes, setEmailNotes] = useState<Record<string, string>>({});
  const [byThread, setByThread] = useState<Record<string, Loaded>>(() => Object.fromEntries(threadCache));
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const actedAt = useRef(0);
  const store = useCallback((id: string, r: Partial<Loaded>) => {
    setByThread((all) => {
      const prev = all[id]?.messages ?? [];
      const newest = r.messages?.reduce((a, m) => (a > m.created_at ? a : m.created_at), "") ?? "";
      const messages = r.messages
        ? [...r.messages, ...prev.filter((m) => m.created_at > newest && !r.messages!.some((x) => x.id === m.id))]
        : prev;
      const next = { messages, offers: r.offers ?? all[id]?.offers ?? [] };
      threadCache.set(id, next);
      return { ...all, [id]: next };
    });
  }, []);

  useEffect(() => {
    let alive = true;
    void callJson<{ threads: BusinessThreadSummary[] }>("/api/creators/threads").then((r) => {
      if (!alive) return;
      if (r.ok) {
        rememberThreads(r.data.threads);
        setThreads(r.data.threads);
      } else {
        setThreads((t) => t ?? []);
        setError(r.message);
      }
    });
    void callJson<{ threads: Array<{ human_member_id: string; display_name: string; last_message_at: string }> }>(
      "/api/creators/invites/threads",
    ).then((r) => {
      if (alive && r.ok) {
        setInviteConvs(
          r.data.threads.map((t) => ({
            thread_id: "",
            human_member_id: t.human_member_id,
            display_name: t.display_name,
            last_message: null,
            last_message_at: t.last_message_at,
          })),
        );
      }
    });
    return () => {
      alive = false;
    };
  }, [tick]);

  const open = useMemo(() => {
    if (!threads) return null;
    const want = drawer.params.creator;
    if (want) return [...threads, ...inviteConvs].find((t) => t.human_member_id === want) ?? null;
    return threads[0] ?? inviteConvs[0] ?? null;
  }, [threads, inviteConvs, drawer.params.creator]);
  const memberId = open?.human_member_id ?? drawer.params.creator ?? "";
  const invite = isInviteId(memberId);
  const [opened, setOpened] = useState<Record<string, string>>({});
  const threadId = invite ? null : open?.thread_id || opened[memberId] || null;
  const convKey = invite ? memberId : threadId;
  const [pending, setPending] = useState<{ key: string; memberId: string; text: string }[]>([]);

  useEffect(() => {
    if (!convKey) return;
    let alive = true;
    void fetchThread(convKey).then((r) => {
      if (alive) store(convKey, r);
    });
    return () => {
      alive = false;
    };
  }, [convKey, tick, store]);

  useEffect(() => {
    let alive = true;
    const every = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void callJson<{ threads: BusinessThreadSummary[] }>("/api/creators/threads").then((r) => {
        if (!alive || !r.ok) return;
        rememberThreads(r.data.threads);
        setThreads(r.data.threads);
      });
    }, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(every);
    };
  }, []);

  useEffect(() => {
    if (!convKey) return;
    let alive = true;
    let busySince = 0;
    let seq = 0;
    let applied = 0;
    const every = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      if (busySince && Date.now() - busySince < POLL_STALL_MS) return;
      const mine = ++seq;
      const started = Date.now();
      busySince = started;
      void fetchThread(convKey)
        .then((r) => {
          if (!alive || mine < applied) return;
          applied = mine;
          store(convKey, started <= actedAt.current ? { messages: r.messages } : r);
        })
        .finally(() => {
          if (seq === mine) busySince = 0;
        });
    }, CONVERSATION_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(every);
    };
  }, [convKey, store]);

  const otherIds = (threads ?? []).map((t) => t.thread_id).filter((id) => id && id !== threadId).slice(0, PREFETCH_MAX).join(",");
  const prefetched = useRef(new Set<string>());
  useEffect(() => {
    if (!otherIds) return;
    for (const id of otherIds.split(",")) {
      if (prefetched.current.has(id) || threadCache.has(id)) continue;
      prefetched.current.add(id);
      void fetchThread(id).then((r) => {
        setByThread((all) => {
          if (all[id]) return all;
          const next = { messages: r.messages ?? [], offers: r.offers ?? [] };
          threadCache.set(id, next);
          return { ...all, [id]: next };
        });
      });
    }
  }, [otherIds]);

  const loaded = convKey ? byThread[convKey] : undefined;
  const messages = useMemo(() => loaded?.messages ?? [], [loaded]);
  const offers = loaded?.offers ?? [];

  useEffect(() => {
    if (!threadId) return;
    const newest = messages.reduce<string | null>((a, x) => (a && a > x.created_at ? a : x.created_at), null);
    if (newest) markThreadSeen(threadId, newest);
  }, [threadId, messages]);

  const newestSeen = messages.reduce((a, x) => (a > x.created_at ? a : x.created_at), "");
  useEffect(() => {
    if (!memberId || invite || !newestSeen) return;
    void readThreadNotices(memberId);
  }, [memberId, invite, newestSeen]);

  const [drafts, setDrafts] = useState<string[]>([]);
  const draftId =
    threads && memberId && ![...threads, ...inviteConvs].some((t) => t.human_member_id === memberId) ? memberId : null;
  useEffect(() => {
    if (draftId) setDrafts((d) => (d.includes(draftId) ? d : [draftId, ...d]));
  }, [draftId]);

  useEffect(() => setError(null), [memberId]);

  const cards = useCreatorCards([
    memberId,
    ...drafts,
    ...(threads ?? []).map((t) => t.human_member_id),
    ...inviteConvs.map((t) => t.human_member_id),
  ]);
  const card = memberId ? cards[memberId] : undefined;
  const knownName = card?.display_name || open?.display_name || null;
  const name = knownName ?? "the creator";
  const first = knownName ? firstName(knownName) : "the creator";

  const addMessage = useCallback((id: string, m: CreatorThreadMessageRow) => {
    setByThread((all) => {
      const prev = all[id];
      if (prev?.messages.some((x) => x.id === m.id)) return all;
      const next = { messages: [...(prev?.messages ?? []), m], offers: prev?.offers ?? [] };
      threadCache.set(id, next);
      return { ...all, [id]: next };
    });
  }, []);

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      const key = `pending:${Date.now()}:${Math.random()}`;
      setPending((p) => [...p, { key, memberId, text }]);
      if (invite) {
        const ri = await callJson<{ message: CreatorThreadMessageRow; email_note?: string }>(
          `/api/creators/invites/${encodeURIComponent(inviteIdOf(memberId))}/messages`,
          { body: { body: text } },
        );
        setPending((p) => p.filter((x) => x.key !== key));
        if (!ri.ok) {
          setError(ri.message);
          return false;
        }
        setError(null);
        addMessage(memberId, ri.data.message);
        const note = ri.data.email_note;
        if (note) setEmailNotes((n) => ({ ...n, [memberId]: note }));
        reload();
        return true;
      }
      const r = threadId
        ? await callJson<{ message: CreatorThreadMessageRow }>(`/api/creators/threads/${threadId}/messages`, { body: { body: text } })
        : await callJson<{ thread: { id: string }; message: CreatorThreadMessageRow | null }>(
            `/api/creators/${encodeURIComponent(memberId)}/threads`,
            { body: { body: text } },
          );
      if (!r.ok) {
        setPending((p) => p.filter((x) => x.key !== key));
        setError(r.message);
        return false;
      }
      setError(null);
      const landedIn = threadId ?? ("thread" in r.data ? r.data.thread?.id : undefined);
      if (landedIn && !threadId) setOpened((o) => ({ ...o, [memberId]: landedIn }));
      if (landedIn && r.data.message) addMessage(landedIn, r.data.message);
      setPending((p) => p.filter((x) => x.key !== key));
      reload();
      return true;
    },
    [invite, threadId, memberId, reload, addMessage],
  );

  const [offerOpenFor, setOfferOpenFor] = useState<string | null>(null);
  const [offerSentFor, setOfferSentFor] = useState<string | null>(null);
  useEffect(() => {
    if (!offerSentFor) return;
    const timer = window.setTimeout(() => setOfferSentFor(null), OFFER_SENT_MS);
    return () => window.clearTimeout(timer);
  }, [offerSentFor]);
  const offerSent = useCallback(
    async (newThreadId: string | null) => {
      if (!threadId && newThreadId) {
        store(newThreadId, await fetchThread(newThreadId));
        setOpened((o) => ({ ...o, [memberId]: newThreadId }));
      }
      reload();
    },
    [threadId, memberId, store, reload],
  );

  const act = useCallback(
    async (offerId: string, action: "decline" | "withdraw") => {
      const r = await callJson<{ offer: CreatorOfferView }>(`/api/creators/offers/${offerId}/${action}`, { body: {} });
      if (r.ok && convKey) {
        actedAt.current = Date.now();
        const next = r.data.offer;
        setByThread((all) => {
          const cur = all[convKey];
          if (!cur) return all;
          const patched = { ...cur, offers: cur.offers.map((x) => (x.id === next.id ? { ...x, ...next } : x)) };
          threadCache.set(convKey, patched);
          return { ...all, [convKey]: patched };
        });
      }
      reload();
      return r.ok ? true : r.message;
    },
    [convKey, reload],
  );

  const items: ThreadItem[] = [
    ...messages.map((m) => ({ at: m.created_at, item: { kind: "msg" as const, key: m.id, from: m.sender_kind === "tenant" ? ("me" as const) : ("them" as const), text: m.body, at: stamp(m.created_at) } })),
    ...offers.map((o) => ({
      at: o.created_at,
      item: {
        kind: "card" as const,
        key: o.id,
        node: (
          <OfferCard
            offer={o}
            creatorName={name}
            onAccept={() => drawer.open("hire", { offer: o.id })}
            onAct={(a) => act(o.id, a)}
          />
        ),
      },
    })),
  ]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((x) => x.item)
    .concat(
      pending
        .filter((x) => x.memberId === memberId)
        .map((x) => ({ kind: "msg" as const, key: x.key, from: "me" as const, text: x.text, at: "Sending…" })),
    );

  const strip = [...(threads ?? []), ...inviteConvs].sort((a, b) =>
    (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""),
  );
  const newOnes = [...(draftId && !drafts.includes(draftId) ? [draftId] : []), ...drafts]
    .filter((id) => !strip.some((t) => t.human_member_id === id))
    .map((id) => ({ thread_id: "", human_member_id: id, display_name: "", last_message: null, last_message_at: null }));
  const list = [...newOnes, ...strip];

  return (
    <SideDrawer title={memberId && knownName ? `Messages with ${knownName}` : "Messages"} onClose={drawer.close}>
      <div data-testid="thread-drawer-body" className="flex min-h-full flex-col">
      {threads === null ? (
        <div aria-hidden="true" className="-mx-1 mb-4 flex gap-2 overflow-hidden px-1 pb-1">
          <Bone className="h-[30px] w-28 shrink-0 rounded-full" />
          <Bone className="h-[30px] w-24 shrink-0 rounded-full" />
          <Bone className="h-[30px] w-28 shrink-0 rounded-full" />
        </div>
      ) : list.length > 0 && (
        <nav aria-label="Conversations" className="-mx-1 mb-4 flex gap-2 overflow-x-auto px-1 pb-1">
          {list.map((t) => {
            const on = t.human_member_id === memberId;
            const label = cards[t.human_member_id]?.display_name || t.display_name || null;
            return (
              <button
                key={t.human_member_id}
                type="button"
                onClick={() => drawer.open("thread", { creator: t.human_member_id })}
                aria-current={on ? "page" : undefined}
                aria-label={label ? undefined : "Conversation"}
                className={`inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] ${on ? "border-ink bg-ink font-semibold text-cream" : "border-rule bg-cream font-medium text-inkSoft hover:bg-creamDeep"}`}
              >
                {label ?? <Bone className={`h-3.5 w-20 rounded-full ${on ? "opacity-40" : ""}`} />}
                {}
                {!on && unreadFor(t) > 0 && (
                  <span
                    className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#027bff] px-1 text-[11px] font-bold text-white"
                    aria-label={`${unreadFor(t)} new ${unreadFor(t) === 1 ? "message" : "messages"}`}
                  >
                    {unreadFor(t) > 99 ? "99+" : unreadFor(t)}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      )}
      <p className="mb-3 flex items-start gap-2 text-[13px] text-inkMuted">
        <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {invite
          ? `${first} is not on Zavi yet. Your first message sends them an email to join and read it; later ones wait until they do.`
          : "Each new message or offer emails the other side, at most one email per conversation every 15 minutes."}
      </p>
      {threads === null && !memberId ? (
        <div className="flex flex-1 flex-col">
          <div role="status" aria-live="polite">
            <span className="sr-only">Loading messages.</span>
            <div aria-hidden="true">
              <CreatorProfileCardSkeleton />
              <div className="mt-4">
                <ThreadSkeleton />
              </div>
            </div>
          </div>
          <Thread
            them=""
            placeholder="Message"
            items={[]}
            onSend={async () => false}
            stickyComposer
            pending
            composerAction={
              <button type="button" disabled className={OFFER_BUTTON}>
                <FilePlus2 className="h-4 w-4" aria-hidden="true" />
                Send a custom offer
              </button>
            }
          />
        </div>
      ) : !memberId ? (
        <DrawerNote>No conversations yet. Open Find creators and press Message on a creator.</DrawerNote>
      ) : (
        <>
          {card ? (
            <CreatorProfileCard
              creator={card}
              onBook={(pid) => drawer.open("hire", { package: pid, brief: drawer.params.brief })}
              onPlayIntro={() => openIntroVideo(`/api/humans/creators/${encodeURIComponent(memberId)}/intro-video`, card.display_name)}
            />
          ) : card === undefined ? (
            <CreatorProfileCardSkeleton />
          ) : null}
          <div className="mt-4 flex flex-1 flex-col">
            {(threads === null || (convKey && !loaded)) && items.length === 0 ? (
              <div role="status" aria-live="polite" className="mb-4">
                <span className="sr-only">Loading messages.</span>
                <ThreadSkeleton />
              </div>
            ) : items.length === 0 && (
              <p className="mb-4 rounded-xl border border-dashed border-rule px-4 py-6 text-center text-[14px] text-inkMuted">
                {invite
                  ? `No messages with ${first} yet. Say hello: they get an email to join and read it.`
                  : `No messages with ${first} yet. Say hello, or send a custom offer below.`}
              </p>
            )}
            {error && <p className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-[13px] text-red-600">{error}</p>}
                {}
                <Thread
                  key={`composer:${memberId}`}
                  them={name}
                  placeholder={`Message ${first}`}
                  items={items}
                  onSend={send}
                  clearOnSend
                  stickyComposer
                  pending={threads === null}
                  beforeComposer={
                    !invite && offerOpenFor === memberId ? (
                      <OfferForm
                        key={`offer:${memberId}`}
                        to={first}
                        threadId={threadId}
                        memberId={memberId}
                        onSent={async (t) => {
                          setOfferOpenFor(null);
                          setOfferSentFor(memberId);
                          await offerSent(t);
                        }}
                        onCancel={() => setOfferOpenFor(null)}
                      />
                    ) : null
                  }
                  composerAction={
                    invite ? undefined : (
                      <button
                        type="button"
                        onClick={() => {
                          setOfferSentFor(null);
                          setOfferOpenFor(memberId);
                        }}
                        disabled={threads === null || offerOpenFor === memberId}
                        className={OFFER_BUTTON}
                      >
                        <FilePlus2 className="h-4 w-4" aria-hidden="true" />
                        Send a custom offer
                      </button>
                    )
                  }
                />
                {invite ? (
                  <>
                    {emailNotes[memberId] && <p className="mt-2 text-[13px] text-inkMuted">{emailNotes[memberId]}</p>}
                    <p className="mt-5 rounded-2xl border border-dashed border-rule bg-creamDeep px-4 py-3 text-[13px] text-inkSoft">
                      Custom offers and booking open once {first} joins Zavi. This conversation moves with them when they do.
                    </p>
                  </>
                ) : offerSentFor === memberId ? (
                  <p role="status" className="mt-2 text-[13px] font-medium text-emerald-600">
                    Offer sent. {first} gets an email.
                  </p>
                ) : null}
          </div>
        </>
      )}
      </div>
    </SideDrawer>
  );
}

export const OFFER_SENT_MS = 2500;

export const CONVERSATION_POLL_MS = 3_000;

export const POLL_STALL_MS = 15_000;

const OFFER_BUTTON =
  "inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full border border-rule px-3 text-[13px] font-semibold text-ink transition-colors hover:bg-bone disabled:cursor-not-allowed disabled:opacity-40";

function OfferForm({
  to,
  threadId,
  memberId,
  onSent,
  onCancel,
}: {
  to: string;
  threadId: string | null;
  memberId: string;
  onCancel: () => void;
  onSent: (threadId: string | null) => void | Promise<void>;
}) {
  const [count, setCount] = useState("1");
  const [price, setPrice] = useState("");
  const [days, setDays] = useState("");
  const [product, setProduct] = useState(false);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = Number(price) || 0;
  const n = Number(count) || 0;
  const daysN = Number(days) || 0;
  const box = useRef<HTMLFormElement>(null);
  useEffect(() => {
    scrollDrawerToEnd(box.current);
  }, []);
  const fees = p > 0 ? feesFor(Math.round(p * 100)) : null;
  const ready = fees !== null && n > 0 && n <= 20 && daysN >= 1 && daysN <= 90;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const body = {
      kind: "ugc_video",
      terms: { title: offerTitleOf(n), content_type: "UGC video", count: n },
      price_cents: Math.round(p * 100),
      delivery_days: daysN,
      product_needed: product,
    };
    const r = threadId
      ? await callJson<{ offer?: { thread_id?: string | null } }>(`/api/creators/threads/${threadId}/offers`, { body })
      : await callJson<{ offer?: { thread_id?: string | null } }>(`/api/creators/${encodeURIComponent(memberId)}/offers`, { body });
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    setSent(true);
    void onSent(r.data.offer?.thread_id ?? null);
  };

  return (
    <form
      ref={box}
      data-testid="offer-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="mt-5 rounded-2xl border border-rule bg-creamDeep p-4"
    >
      <p className="text-[14px] font-semibold text-ink">Send a custom offer</p>
      <p className="mt-0.5 text-[13px] text-inkMuted">
        {to} can accept or decline. You can withdraw it until they answer. Includes 2 rounds of changes.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="text-[14px] font-medium text-ink">How many UGC videos</span>
          <input inputMode="numeric" className={`${FIELD} mt-1`} value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ""))} />
        </label>
        <label className="block">
          <span className="text-[14px] font-medium text-ink">Price</span>
          <input inputMode="numeric" className={`${FIELD} mt-1`} value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ""))} placeholder="150" />
        </label>
        <label className="block">
          <span className="text-[14px] font-medium text-ink">Days to deliver</span>
          <input inputMode="numeric" className={`${FIELD} mt-1`} value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} placeholder="7" />
        </label>
      </div>
      <div className="mt-3">
        <ProductQuestion value={product} onChange={setProduct} creator={to} />
      </div>
      {error && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-[13px] text-red-600">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] text-inkSoft">{fees ? `If ${to} accepts, you are asked to pay ${money(fees.business_total_cents)} with Zavi's 10% fee.` : ""}</span>
        {sent ? (
          <span className="text-[14px] font-semibold text-emerald-600">Offer sent. {to} gets an email.</span>
        ) : (
          <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="inline-flex h-10 cursor-pointer items-center justify-center rounded-cta border border-rule bg-cream px-4 text-[14px] font-semibold text-ink hover:bg-bone disabled:cursor-not-allowed disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!ready || busy}
            className="inline-flex h-10 cursor-pointer items-center justify-center rounded-cta bg-ink px-4 text-[14px] font-semibold text-cream hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send offer
          </button>
          </div>
        )}
      </div>
    </form>
  );
}
