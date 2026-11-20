"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { creditRefusalFrom } from "@/lib/workspace/creditRefusal";
import { ApiError, approve, newRequestId, readChannelVideoCard, type ChannelVideoCard } from "@/lib/workspace/channelActionsApi";
import { upgradeOnPlanRefusal, useChannelPlanLock } from "./channelPlanLock";
import { creditsOf, failureReasonOf, starterTileState } from "./StartersPanel";
import { mediaOf } from "./types";
import { apiFetch } from "@/lib/api";
import { AdCard, type AdItem } from "../videoStudio/SuggestedAds";
import { animateCopy, starterCopy } from "../videoStudio/starterCopy";
import { postOnce, RENDER_POLL_MS } from "../videoStudio/studioApi";
import { STUDIO_PATH, type StudioView } from "../videoStudio/types";

export const CARD_POLL_MS = 5000;
export const CARD_WAITING_POLL_MS = 30000;
export const CARD_MAX_POLLS = 600;

const OPEN_STATUSES: ReadonlySet<string> = new Set(["pending", "snoozed"]);
const STAGE_TICK_MS = 1000;

type Failure = NonNullable<AdItem["error"]>;
type Edited = { threadId: string; runId: string; startedAt: number; view: StudioView | null };

function animateImageOf(card: ChannelVideoCard): string | null {
  const body = card.body as { video_format?: unknown; image_path?: unknown } | undefined;
  return body?.video_format === "animate" && typeof body.image_path === "string" ? body.image_path : null;
}

function cardPhotoOf(card: ChannelVideoCard): string | null {
  const portrait = (card.body as { portrait_path?: unknown } | undefined)?.portrait_path;
  return animateImageOf(card) ?? (typeof portrait === "string" ? portrait : null);
}

function editedRender(edited: Edited) {
  return edited.view?.renders[edited.runId] ?? null;
}

export function ChatVideoCard({ id, title, fallback }: { id: string; title: string; fallback: ReactNode }) {
  const [card, setCard] = useState<ChannelVideoCard | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [approvedHere, setApprovedHere] = useState<ReadonlyMap<string, ChannelVideoCard["exec_status"]>>(() => new Map());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [polls, setPolls] = useState(0);
  const [edited, setEdited] = useState<Edited | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const planLock = useChannelPlanLock();
  const tappedAt = useRef<number | null>(null);
  const pressing = useRef(false);
  const alive = useRef(true);
  const loaded = useRef(false);

  const read = useCallback(async () => {
    try {
      const next = await readChannelVideoCard(id);
      if (!alive.current) return;
      loaded.current = true;
      setCard(next);
      setUnreadable(false);
    } catch (e) {
      if (alive.current && (!loaded.current || (e instanceof ApiError && e.status === 404))) setUnreadable(true);
    }
  }, [id]);

  useEffect(() => {
    alive.current = true;
    void read();
    return () => {
      alive.current = false;
    };
  }, [read]);

  const tile = card ? starterTileState(card, approvedHere) : null;
  const making = tile === "making";
  const gaveUp = polls >= CARD_MAX_POLLS;
  const closed = (tile === "waiting" || tile === "failed") && !!card && !OPEN_STATUSES.has(card.status);
  const waiting = tile === "waiting" && !closed;

  useEffect(() => {
    if ((!making && !waiting) || gaveUp) return;
    const t = setTimeout(() => {
      void read().finally(() => {
        if (alive.current) setPolls((n) => n + 1);
      });
    }, making ? CARD_POLL_MS : CARD_WAITING_POLL_MS);
    return () => clearTimeout(t);
  }, [making, waiting, gaveUp, polls, read]);

  const editedStatus = edited ? editedRender(edited)?.status : undefined;
  const editedMaking = !!edited && (!editedStatus || editedStatus === "rendering" || editedStatus === "stalled");

  useEffect(() => {
    if (!making && !editedMaking) return;
    const t = setInterval(() => setNow(Date.now()), STAGE_TICK_MS);
    return () => clearInterval(t);
  }, [making, editedMaking]);

  const editedThread = edited?.threadId ?? null;
  useEffect(() => {
    if (!editedThread || !editedMaking) return;
    const t = setInterval(() => {
      void apiFetch(`${STUDIO_PATH}?thread_id=${encodeURIComponent(editedThread)}`)
        .then(async (res) => {
          if (!res.ok || !alive.current) return;
          const view = (await res.json()) as StudioView;
          if (alive.current) setEdited((cur) => (cur?.threadId === editedThread ? { ...cur, view } : cur));
        })
        .catch(() => undefined);
    }, RENDER_POLL_MS);
    return () => clearInterval(t);
  }, [editedThread, editedMaking]);

  const makeEdited = async (text: string): Promise<boolean> => {
    const t = text.trim();
    if (!t || pressing.current) return false;
    pressing.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const image_path = card ? cardPhotoOf(card) : null;
      const res = await postOnce(`${STUDIO_PATH}/messages`, JSON.stringify(image_path ? { text: t, image_path, new_thread: true } : { text: t, verbatim: true, new_thread: true }));
      const body = (await res.json().catch(() => null)) as { thread_id?: unknown; render?: { run_id?: unknown; error?: unknown } | null; error?: { message?: string } } | null;
      if (!res.ok) {
        const e = new ApiError(body?.error?.message ?? "Zavi could not start this video. Try again.", res.status, body);
        if (upgradeOnPlanRefusal(planLock, e)) return false;
        const credit = creditRefusalFrom(body, "video");
        if (alive.current) setFailure({ text: credit?.headline ?? e.message, credit });
        return false;
      }
      const threadId = body?.thread_id;
      const runId = body?.render?.run_id;
      const started = typeof threadId === "string" && typeof runId === "string";
      if (!alive.current) return started;
      if (started) setEdited({ threadId, runId, startedAt: Date.now(), view: null });
      else setFailure({ text: typeof body?.render?.error === "string" ? body.render.error : "Zavi could not start this video. Try again.", credit: null });
      return started;
    } catch {
      if (alive.current) setFailure({ text: "Could not reach Zavi. Check your connection.", credit: null });
      return false;
    } finally {
      pressing.current = false;
      if (alive.current) setBusy(false);
    }
  };

  const press = async () => {
    if (!card || pressing.current) return;
    if (planLock?.tierName) {
      planLock.upgrade();
      return;
    }
    pressing.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await approve(card.id, newRequestId());
      if (!alive.current) return;
      setPolls(0);
      tappedAt.current = Date.now();
      setApprovedHere(new Map([[card.id, card.exec_status]]));
      void read();
    } catch (e) {
      if (upgradeOnPlanRefusal(planLock, e) || !alive.current) return;
      const credit = creditRefusalFrom(e instanceof ApiError ? e.body : null, "video");
      setFailure({ text: credit?.headline ?? (e instanceof Error && e.message ? e.message : "Zavi could not start this video. Try again."), credit });
    } finally {
      pressing.current = false;
      if (alive.current) setBusy(false);
    }
  };

  if (unreadable) return <>{fallback}</>;

  const media = card ? mediaOf(card) : null;
  if (!card) {
    return (
      <section role="region" aria-label={title} data-decision-id={id} data-testid="chat-video-card" className="w-full min-w-0 rounded-[20px] border border-rule bg-cream p-6">
        <p className="text-[14px] font-semibold text-ink">{title}</p>
        <p className="mt-1 text-[13px] text-inkMuted">Loading your video card…</p>
      </section>
    );
  }
  const animate = !!animateImageOf(card);
  const copy = animate ? animateCopy(card) : starterCopy(card);
  const error = failure ? { text: failure.text, credit: failure.credit } : null;
  const base = { key: card.id, title: copy.title, hooks: copy.hooks, script: copy.script, error, busy, cost: creditsOf(card, null), intent: animate ? ("animate" as const) : ("talking_head" as const), prompt: animate, hookless: animate };
  const editable = closed ? {} : { onMakeScript: makeEdited };
  const render = edited ? editedRender(edited) : null;
  const stuck = card.exec_status === "executed" && making && !edited;
  const item: AdItem = edited
    ? render?.status === "done" && render.videos[0]
      ? { ...base, ...editable, state: "ready", video: { artifactId: render.videos[0].artifact_id } }
      : !render || render.status === "rendering"
        ? { ...base, state: "making", queued: render?.queued === true, startedAt: render ? Date.parse(render.working_since ?? render.started_at) : edited.startedAt }
        : render.status === "stalled"
          ? { ...base, ...editable, state: "failed", stalled: true, note: "This is taking longer than usual. You are charged only when the video arrives." }
          : { ...base, ...editable, state: "failed", note: "Couldn't make this one. You were not charged." }
    : tile === "ready" && media?.kind === "video"
      ? { ...base, ...editable, state: "ready", video: { url: media.url, downloadUrl: media.downloadUrl } }
      : stuck
        ? { ...base, state: "failed", stalled: true, note: "Your video is ready, but it could not be loaded here. Refresh the page to try again." }
        : making
          ? { ...base, state: "making", startedAt: tappedAt.current ?? (Date.parse(card.proposed_at ?? "") || undefined) }
          : tile === "failed" && !closed
            ? {
                ...base,
                ...editable,
                state: "failed",
                note: card.exec_code === "insufficient_credits" ? "Not enough credits for this video. Nothing was charged." : failureReasonOf(card) ?? "Couldn't make this one. You were not charged.",
                topUp: card.exec_code === "insufficient_credits",
                onRetry: card.exec_code === "insufficient_credits" || card.exec_bucket === "temporary" ? () => void press() : undefined,
              }
            : { ...base, ...editable, state: "draft", onMake: closed ? undefined : () => void press() };

  return (
    <section role="region" aria-label={copy.title} data-decision-id={id} data-testid="chat-video-card" className="w-full min-w-0 [container-type:inline-size]">
      <AdCard item={item} now={now} />
      {!stuck && making && gaveUp && <p role="status" data-testid="chat-video-note" className="mt-2 text-[13px] text-ink">This is taking longer than usual. You are charged only when the video arrives.</p>}
      {closed && <p data-testid="chat-video-note" className="mt-2 text-[13px] text-inkMuted">This card is closed, so nothing more will be made or charged.</p>}
    </section>
  );
}
