"use client";

import { ActionTooltip } from "./ActionTooltip";
import { actionHint } from "./actionHints";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Play, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { upgradeOnPlanRefusal, useChannelPlanLock } from "./channelPlanLock";
import { ApiError, approve, newRequestId, type ChannelActionView } from "@/lib/workspace/channelActionsApi";
import { creditRefusalFrom, type CreditRefusal } from "@/lib/workspace/creditRefusal";
import { CostTag } from "../CostTag";
import { BILLING_URL, CreditRefusalNotice } from "@/components/workspace/CreditRefusalNotice";
import { AdsDialog } from "@/components/ui/AdsDialog";
import { cx, FOCUS_RING } from "../layout/shared";
import { mediaOf } from "./types";

export const STARTER_COUNT = 5;
export const GRID_LIMIT = 9;
export const VIEWER_CHROME =
  "rounded-2xl border border-rule bg-cream text-ink shadow-2xl !w-[min(calc(80vh*9/16+32px),calc(100%-32px))]";

const FORMAT_LABEL: Record<string, string> = {
  product_demo: "Product demo",
  explainer: "Explainer",
  hook: "Hook",
  behind_the_scenes: "Behind the scenes",
  offer: "Offer",
};

export type StarterRun = {
  loaded: boolean;
  runId: string | null;
  runStatus?: string | null;
  failedAttempts: number;
  lastEmpty?: boolean;
  firstVideoUsed?: boolean;
  firstVideoActionId?: string | null;
  setRunId: (id: string | null) => void;
  reload?: () => void;
};

export const RUN_ACTIVE = new Set(["queued", "running"]);
const STATUS_POLL_MS = 20_000;
const TAP_HOLD_MS = 2 * 60_000;

export function useStarterRun(slug: string, enabled: boolean): StarterRun {
  const [loaded, setLoaded] = useState(!enabled);
  const [runId, setRunIdState] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [lastEmpty, setLastEmpty] = useState(false);
  const [firstVideoUsed, setFirstVideoUsed] = useState(false);
  const [firstVideoActionId, setFirstVideoActionId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/channels/${slug}/starters`);
        if (!res.ok) return;
        const body = (await res.json()) as { run_id?: unknown; run_status?: unknown; failed_attempts?: unknown; last_empty?: unknown; first_video_used?: unknown; first_video_action_id?: unknown };
        if (cancelled) return;
        setRunIdState(typeof body.run_id === "string" ? body.run_id : null);
        setRunStatus(typeof body.run_status === "string" ? body.run_status : null);
        setFailedAttempts(typeof body.failed_attempts === "number" ? body.failed_attempts : 0);
        setLastEmpty(body.last_empty === true);
        setFirstVideoUsed(body.first_video_used === true);
        setFirstVideoActionId(typeof body.first_video_action_id === "string" ? body.first_video_action_id : null);
      } catch {
        return;
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, enabled, tick]);
  const setRunId = useCallback((id: string | null) => {
    setRunIdState(id);
    setRunStatus(null);
  }, []);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { loaded, runId, runStatus, failedAttempts, lastEmpty, firstVideoUsed, firstVideoActionId, setRunId, reload };
}

export function useVideoCreditsEach(slug: string): { each: number | null; loaded: boolean } {
  const [each, setEach] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/api/channels");
        if (!res.ok) return;
        const body = (await res.json()) as { channels?: Array<{ channel_slug?: string; video_credits_each?: unknown }> };
        const n = (body.channels ?? []).find((c) => c.channel_slug === slug)?.video_credits_each;
        if (!cancelled && typeof n === "number" && Number.isFinite(n) && n > 0) setEach(n);
      } catch {
        return;
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);
  return { each, loaded };
}

export function isGridVideo(a: ChannelActionView, runId: string | null): boolean {
  if (!a.executable || a.status === "rejected") return false;
  if (runId !== null && a.run_id === runId) return true;
  return a.exec_status != null;
}

export function starterCards(actions: ChannelActionView[], runId: string | null): ChannelActionView[] {
  return actions
    .filter((a) => isGridVideo(a, runId))
    .sort((a, b) => Date.parse(a.proposed_at) - Date.parse(b.proposed_at));
}

const RAW_FAILURE_PREFIX = "Sorry, the video could not be made (";

export function failureReasonOf(a: Pick<ChannelActionView, "note">): string | null {
  const note = a.note?.trim();
  if (!note || !note.startsWith("Sorry, ") || note.startsWith(RAW_FAILURE_PREFIX)) return null;
  return note;
}

export function formatOf(a: ChannelActionView): string {
  const f = (a.body as { video_format?: unknown } | undefined)?.video_format;
  return typeof f === "string" && FORMAT_LABEL[f] ? FORMAT_LABEL[f] : "Starter video";
}

export function scriptOf(a: Pick<ChannelActionView, "body" | "title">): string {
  const content = (a.body as { step?: { deliverable?: { content?: unknown } } } | undefined)?.step?.deliverable?.content;
  if (typeof content === "string" && content.trim()) return content.split(/\n\s*\nCaption:/)[0].trim();
  return a.title.replace(/^[^:]{1,40}:\s*/, "");
}

export function creditsOf(a: Pick<ChannelActionView, "body">, each: number | null): number | null {
  const n = (a.body as { cost_credits?: unknown } | undefined)?.cost_credits;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : each;
}

export type StarterTileState = "ready" | "failed" | "waiting" | "making";

export function starterTileState(
  a: Pick<ChannelActionView, "id" | "body" | "exec_status">,
  approvedHere: ReadonlyMap<string, ChannelActionView["exec_status"]> = new Map(),
): StarterTileState {
  if (mediaOf(a)?.kind === "video") return "ready";
  if (approvedHere.has(a.id) && approvedHere.get(a.id) === a.exec_status) return "making";
  if (a.exec_status === "failed") return "failed";
  if (a.exec_status == null) return "waiting";
  return "making";
}

type MakeProps = {
  each: number | null;
  eachLoaded: boolean;
  busy: boolean;
  error: { text: string; credit: CreditRefusal | null } | null;
  onMake: (c: ChannelActionView) => void;
};

function MakeButton({ card, busy, onMake }: { card: ChannelActionView } & Omit<MakeProps, "error" | "each" | "eachLoaded">) {
  return (
    <ActionTooltip description={actionHint(card, "approve", "Approve generating this video from its script. The credits shown on the card are charged only if the video arrives. This does not publish it to a social channel.")} label="Make this video" className="w-full">
      <button
        type="button"
        onClick={() => onMake(card)}
        disabled={busy}
        data-testid="starter-make"
        className={cx(
          "relative mt-2 inline-flex h-8 w-full items-center justify-center rounded-cta bg-ink px-2 text-[13px] font-semibold text-cream hover:opacity-90",
          busy && "cursor-not-allowed opacity-50",
          FOCUS_RING,
        )}
      >
        {busy ? "Starting…" : "Make this video"}
      </button>
    </ActionTooltip>
  );
}

function TileCost({ card, make }: { card: ChannelActionView; make: MakeProps }) {
  const credits = creditsOf(card, make.each);
  return (
    <CostTag
      testId="starter-cost"
      credits={credits}
      loading={credits === null && !make.eachLoaded}
      loadingLabel="Loading what this video costs"
      hint="Charged only if the video arrives. If it fails, nothing is taken."
      className="absolute right-3 top-3 z-10 bg-cream/85 backdrop-blur-sm"
    />
  );
}

function TileError({ error }: { error: MakeProps["error"] }) {
  if (!error) return null;
  if (error.credit) return <CreditRefusalNotice refusal={error.credit} className="relative mt-2" />;
  return (
    <p role="alert" className="relative mt-2 text-[12px] leading-5 text-danger">{error.text}</p>
  );
}

function StarterTile({
  card,
  onOpen,
  state,
  make,
}: {
  card: ChannelActionView;
  onOpen: (c: ChannelActionView) => void;
  state: StarterTileState;
  make: MakeProps;
}) {
  const media = mediaOf(card);
  const label = formatOf(card);
  const frame = "group relative flex aspect-[2/3] w-full flex-col overflow-hidden rounded-2xl bg-bone ring-1 ring-ink/10";
  if (state === "ready" && media?.kind === "video") {
    return (
      <button
        type="button"
        onClick={() => onOpen(card)}
        data-testid="starter-tile"
        data-state="ready"
        aria-label={`Play ${label}`}
        className={cx(
          frame,
          "text-left shadow-sm transition duration-200 hover:-translate-y-1 hover:shadow-2xl hover:ring-ink/30",
          "focus-visible:outline-none focus-visible:shadow-[0_0_28px_rgba(255,255,255,0.35)]",
        )}
      >
        <video src={media.url} muted playsInline preload="metadata" className="h-full w-full bg-black object-cover object-top" />
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/45 text-white opacity-90 ring-1 ring-white/30 backdrop-blur-md transition group-hover:scale-110 group-hover:bg-black/60 group-hover:opacity-100">
            <Play aria-hidden className="h-6 w-6 fill-current" />
          </span>
        </span>
        <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-4 pb-4 pt-16">
          <span className="block text-[14px] font-semibold leading-5 text-white drop-shadow">{label}</span>
        </span>
      </button>
    );
  }
  if (state === "failed") {
    const credits = card.exec_code === "insufficient_credits";
    return (
      <div data-testid="starter-tile" data-state="failed" className={cx(frame, "justify-end p-3")}>
        {(credits || card.exec_bucket === "temporary") && <TileCost card={card} make={make} />}
        <p className="text-[13px] font-semibold text-ink">{label}</p>
        {credits ? (
          <>
            <p className="mt-1 text-[12px] leading-5 text-inkMuted">Not enough credits for this video. Nothing was charged.</p>
            <a href={BILLING_URL} data-testid="starter-top-up" className="mt-1 text-[12px] font-medium text-ink underline underline-offset-2">
              Top up credits
            </a>
            <MakeButton card={card} busy={make.busy} onMake={make.onMake} />
            <TileError error={make.error} />
          </>
        ) : (
          <>
            <p data-testid="starter-failure" className="mt-1 text-[12px] leading-5 text-inkMuted">
              {failureReasonOf(card) ?? "Couldn't make this one. You were not charged."}
            </p>
            {}
            {card.exec_bucket === "temporary" && (
              <>
                <MakeButton card={card} busy={make.busy} onMake={make.onMake} />
                <TileError error={make.error} />
              </>
            )}
          </>
        )}
      </div>
    );
  }
  if (state === "waiting") {
    return (
      <div data-testid="starter-tile" data-state="waiting" className={cx(frame, "justify-end bg-white p-3")}>
        <TileCost card={card} make={make} />
        <span className="text-[13px] font-semibold text-ink">{label}</span>
        <span className="mt-0.5 text-[12px] font-medium uppercase tracking-wide text-inkMuted">Waiting for you</span>
        <p data-testid="starter-script" className="mt-1 line-clamp-2 text-[12px] leading-5 text-inkMuted">{scriptOf(card)}</p>
        <MakeButton card={card} busy={make.busy} onMake={make.onMake} />
        <TileError error={make.error} />
      </div>
    );
  }
  return (
    <div data-testid="starter-tile" data-state="making" className={cx(frame, "justify-end p-3")}>
      <span aria-hidden className="absolute inset-0 animate-pulse bg-gradient-to-b from-transparent via-ink/5 to-ink/10" />
      <span className="relative text-[13px] font-semibold text-ink">{label}</span>
      <span className="relative mt-1 text-[12px] leading-5 text-inkMuted">Making your video…</span>
    </div>
  );
}

function PendingTile() {
  return (
    <div
      data-testid="starter-tile"
      data-state="writing"
      className="relative flex aspect-[2/3] w-full flex-col justify-end overflow-hidden rounded-2xl border border-dashed border-ink/15 bg-bone p-3"
    >
      <span aria-hidden className="absolute inset-0 animate-pulse bg-gradient-to-b from-transparent to-ink/5" />
      <span className="relative text-[12px] leading-5 text-inkMuted">Writing the script…</span>
    </div>
  );
}

export function StartersPanel({
  slug,
  starter,
  actions,
  running,
  onRan,
  onChanged,
}: {
  slug: string;
  starter: StarterRun;
  actions: ChannelActionView[];
  running: boolean;
  onRan: () => void;
  onChanged?: () => void;
}) {
  const { each, loaded: eachLoaded } = useVideoCreditsEach(slug);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credit, setCredit] = useState<CreditRefusal | null>(null);
  const [open, setOpen] = useState<ChannelActionView | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [makingId, setMakingId] = useState<string | null>(null);
  const [approvedHere, setApprovedHere] = useState<ReadonlyMap<string, ChannelActionView["exec_status"]>>(() => new Map());
  const tappedAt = useRef(new Map<string, number>());

  useEffect(() => {
    setApprovedHere((prev) => {
      let next: Map<string, ChannelActionView["exec_status"]> | null = null;
      for (const a of actions) {
        const held = prev.get(a.id);
        const stale = Date.now() - (tappedAt.current.get(a.id) ?? 0) > TAP_HOLD_MS;
        if (prev.has(a.id) && (held !== a.exec_status || stale)) {
          next ??= new Map(prev);
          next.delete(a.id);
        }
      }
      return next ?? prev;
    });
  }, [actions]);
  const [tileError, setTileError] = useState<{ id: string; text: string; credit: CreditRefusal | null } | null>(null);

  const planLock = useChannelPlanLock();
  const make = useCallback(
    async (card: ChannelActionView) => {
      if (makingId) return;
      if (planLock?.tierName) {
        planLock.upgrade();
        return;
      }
      setMakingId(card.id);
      setTileError(null);
      try {
        await approve(card.id, newRequestId());
        tappedAt.current.set(card.id, Date.now());
        setApprovedHere((prev) => new Map(prev).set(card.id, card.exec_status));
        onChanged?.();
      } catch (e) {
        if (upgradeOnPlanRefusal(planLock, e)) return;
        const credit = creditRefusalFrom(e instanceof ApiError ? e.body : null, "video");
        setTileError({
          id: card.id,
          text: credit?.headline ?? ((e as Error).message || "Zavi could not start this video. Try again."),
          credit,
        });
      } finally {
        setMakingId(null);
      }
    },
    [makingId, onChanged, planLock],
  );

  const writing =
    running && starter.runId !== null && (starter.runStatus == null || RUN_ACTIVE.has(starter.runStatus));
  const { reload: reloadRun } = starter;
  useEffect(() => {
    if (!writing || !reloadRun) return;
    const id = setInterval(reloadRun, STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [writing, reloadRun]);

  const unconfirmed = actions.some((a) => approvedHere.has(a.id) && approvedHere.get(a.id) === a.exec_status && mediaOf(a)?.kind !== "video");
  useEffect(() => {
    if (!unconfirmed) return;
    const id = setInterval(() => {
      onChanged?.();
      setApprovedHere((prev) => {
        const old = [...prev.keys()].filter((k) => Date.now() - (tappedAt.current.get(k) ?? 0) > TAP_HOLD_MS);
        if (old.length === 0) return prev;
        const next = new Map(prev);
        for (const k of old) next.delete(k);
        return next;
      });
    }, STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [unconfirmed, onChanged]);

  const start = useCallback(async () => {
    if (busy) return;
    if (planLock?.tierName) {
      planLock.upgrade();
      return;
    }
    setBusy(true);
    setError(null);
    setCredit(null);
    try {
      const res = await apiFetch(`/api/channels/${slug}/starters`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = (await res.json().catch(() => null)) as { run_id?: unknown; error?: { message?: string } } | null;
      if (!res.ok) {
        const refusal = creditRefusalFrom(body, "channel");
        setCredit(refusal);
        setError(refusal?.headline ?? body?.error?.message ?? "Zavi could not start your starter videos.");
        return;
      }
      starter.setRunId(typeof body?.run_id === "string" ? body.run_id : null);
      onRan();
    } catch {
      setError("Zavi could not start your starter videos. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }, [busy, slug, starter, onRan, planLock]);

  if (!starter.loaded) return null;

  const cards = starterCards(actions, starter.runId);
  const started = starter.runId !== null || cards.length > 0;

  if (!started) {
    return (
      <section aria-label="Starter demos" data-testid="starters" className="mb-6 rounded-2xl border border-rule bg-white px-4 py-4">
        <h3 className="text-[16px] font-semibold text-ink">Starter demos</h3>
        <p className="mt-1 text-[14px] leading-6 text-inkMuted">
          {starter.firstVideoUsed
            ? `Press Start and Zavi writes ${STARTER_COUNT} short video ideas for your business. Your first automatic video is already used, so each one waits for your Approve and shows its price.`
            : `Press Start and Zavi writes ${STARTER_COUNT} short video ideas for your business and makes the first one right away. You can make the others with one tap each.`}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void start()}
            disabled={busy}
            data-testid="start-the-ai"
            className={cx(
              "inline-flex h-10 items-center rounded-cta bg-ink px-4 text-[14px] font-semibold text-cream hover:opacity-90",
              busy && "cursor-not-allowed opacity-50",
              FOCUS_RING,
            )}
          >
            {busy ? "Starting…" : "Start the AI"}
          </button>
          <span className="text-[13px] text-inkMuted">
            {starter.firstVideoUsed
              ? each === null
                ? "Each video is charged only if it arrives."
                : `About ${each.toLocaleString("en-US")} credits a video, charged only if it arrives.`
              : each === null
                ? "The first video is charged only if it arrives."
                : `About ${each.toLocaleString("en-US")} credits for the first video, charged only if it arrives.`}
          </span>
        </div>
        {starter.lastEmpty && !error ? (
          <p className="mt-2 text-[13px] leading-5 text-inkMuted">The last start finished without writing any videos. If Next steps below asks you for something, do that first, then press Start the AI.</p>
        ) : (
          starter.failedAttempts > 0 &&
          !error && <p className="mt-2 text-[13px] leading-5 text-inkMuted">The last start did not finish. You are charged only for videos that arrived.</p>
        )}
        {credit && error === credit.headline && <CreditRefusalNotice refusal={credit} className="mt-2" />}
        {error && !(credit && error === credit.headline) && (
          <p role="alert" className="mt-2 text-[13px] leading-5 text-danger">{error}</p>
        )}
      </section>
    );
  }

  const runCards = starter.runId === null ? 0 : cards.filter((c) => c.run_id === starter.runId).length;
  const pending = writing ? Math.max(0, STARTER_COUNT - runCards) : 0;
  const states = new Map(cards.map((c) => [c.id, starterTileState(c, approvedHere)] as const));
  const count = (st: StarterTileState) => cards.filter((c) => states.get(c.id) === st).length;
  const ready = count("ready");
  const making = count("making");
  const waiting = count("waiting");
  const failed = count("failed");
  const readyCards = cards.filter((c) => states.get(c.id) === "ready");
  const openIndex = open ? Math.max(0, readyCards.findIndex((c) => c.id === open.id)) : 0;
  const openMedia = open ? mediaOf(open) : null;

  const total = cards.length + pending;
  const parts = [
    ready > 0 ? `${ready} ready` : null,
    making > 0 ? `${making} making` : null,
    waiting > 0 ? `${waiting} waiting for you` : null,
    failed > 0 ? `${failed} not made` : null,
    pending > 0 ? `${pending} writing` : null,
  ].filter((p): p is string => p !== null);
  const chip = ready === total && total > 0 ? `${ready} video${ready === 1 ? "" : "s"} ready` : parts.join(" · ") || (writing ? "Writing scripts…" : "No videos yet");
  return (
    <section aria-label="Starter demos" data-testid="starters" className="mb-2">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div>
          <h3 className="text-[20px] font-semibold tracking-tight text-ink">Starter demos</h3>
          <p className="mt-0.5 text-[13px] leading-5 text-inkMuted">
            {waiting > 0
              ? "Short videos for your business. Tap a ready one to watch it, or make the others with one tap."
              : "Short videos for your business. Tap a ready one to watch or download it."}
          </p>
        </div>
        <span role="status" data-testid="starter-chip" className="inline-flex h-7 items-center rounded-lg bg-ink/[0.05] px-2.5 text-[12px] font-medium leading-none text-inkMuted ring-1 ring-inset ring-ink/[0.07]">
          {chip}
        </span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3" data-testid="starter-grid">
        {(showAll ? cards : cards.slice(0, GRID_LIMIT)).map((c) => (
          <StarterTile
            key={c.id}
            card={c}
            onOpen={setOpen}
            state={states.get(c.id) ?? "making"}
            make={{
              each,
              eachLoaded,
              busy: makingId !== null,
              error: tileError?.id === c.id ? tileError : null,
              onMake: (card) => void make(card),
            }}
          />
        ))}
        {Array.from({ length: Math.max(0, Math.min(pending, GRID_LIMIT - cards.length)) }, (_, i) => (
          <PendingTile key={`pending-${i}`} />
        ))}
      </div>
      {cards.length > GRID_LIMIT && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            data-testid="starter-show-all"
            className={cx("rounded-cta px-3 py-1.5 text-[13px] font-medium text-ink ring-1 ring-ink/15 hover:bg-bone", FOCUS_RING)}
          >
            {showAll ? "Show less" : "Show more"}
          </button>
        </div>
      )}
      {open && openMedia?.kind === "video" && (
        <AdsDialog label={formatOf(open)} onClose={() => setOpen(null)} closeOnBackdrop size="md" chrome={VIEWER_CHROME}>
          <div
            className="flex flex-col gap-3 p-4"
            data-testid="starter-viewer"
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" && readyCards.length > 1) setOpen(readyCards[(openIndex + 1) % readyCards.length]);
              if (e.key === "ArrowLeft" && readyCards.length > 1) setOpen(readyCards[(openIndex - 1 + readyCards.length) % readyCards.length]);
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h4 className="text-[16px] font-semibold text-ink">{formatOf(open)}</h4>
                <p className="mt-0.5 text-[13px] text-inkMuted">
                  AI-generated video{readyCards.length > 1 ? ` · ${openIndex + 1} of ${readyCards.length}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(null)}
                aria-label="Close"
                className={cx("flex h-8 w-8 items-center justify-center rounded-full text-inkMuted hover:bg-bone hover:text-ink", FOCUS_RING)}
              >
                <X aria-hidden className="h-4 w-4" />
              </button>
            </div>
            <div className="relative w-full overflow-hidden rounded-2xl bg-black">
              <video
                key={openMedia.url}
                src={openMedia.url}
                controls
                autoPlay
                playsInline
                className="aspect-[9/16] w-full object-contain"
              />
              {readyCards.length > 1 && (
                <>
                  <button
                    type="button"
                    aria-label="Previous video"
                    onClick={() => setOpen(readyCards[(openIndex - 1 + readyCards.length) % readyCards.length])}
                    className={cx("absolute left-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white ring-1 ring-white/25 backdrop-blur-md hover:bg-black/70", FOCUS_RING)}
                  >
                    <ChevronLeft aria-hidden className="h-5 w-5" />
                  </button>
                  <button
                    type="button"
                    aria-label="Next video"
                    onClick={() => setOpen(readyCards[(openIndex + 1) % readyCards.length])}
                    className={cx("absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white ring-1 ring-white/25 backdrop-blur-md hover:bg-black/70", FOCUS_RING)}
                  >
                    <ChevronRight aria-hidden className="h-5 w-5" />
                  </button>
                </>
              )}
            </div>
            <a
              href={openMedia.downloadUrl ?? openMedia.url}
              download
              className={cx(
                "inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-ink text-[14px] font-semibold text-cream hover:opacity-90",
                FOCUS_RING,
              )}
            >
              <Download aria-hidden className="h-4 w-4" />
              Download video
            </a>
          </div>
        </AdsDialog>
      )}
    </section>
  );
}
