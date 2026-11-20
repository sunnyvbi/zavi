"use client";

import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Loader2, X } from "lucide-react";
import type { CreditRefusal } from "@/lib/workspace/creditRefusal";
import { cx, FOCUS_RING } from "../layout/shared";
import { AskIcon, CheckIcon, DownloadIcon, EditIcon, GenerateIcon, InfoIcon, PlayIcon, RefreshIcon } from "./libraryIcons";
import { useSignedVideo } from "./useSignedVideo";
import { FULLSCREEN_FIT, VideoControls } from "./VideoControls";
import { REVISIONS } from "./StudioHero";
import { kindLabel, type VideoIntent } from "./types";
import { TopUp } from "./TopUp";
import { ANSWER_PLACEHOLDER } from "../actions/channelChat";
import { CardEyebrow } from "../actions/card/CardEyebrow";
import { WithMedia } from "../actions/card/blocks/MediaTile";
import { cardButton, cardIconButton, cardLink, cardText } from "../actions/card/styles";
import { InfoDialog } from "../actions/card/CardDialogs";
import { MediaExpand } from "../actions/card/blocks/MediaExpand";

export const MAKING_STAGES = ["Writing the script", "Picking scenes", "Adding the voice", "Putting it together"] as const;
export const STAGE_MS = 20_000;
export const QUEUED_BUTTON = "In line behind other videos";
export const QUEUED_STAGE = "Waiting for the videos ahead";
export const QUEUED_NOTE = "Other videos in this workspace are being made first. This one starts on its own when they finish.";

export type AdVideo = { artifactId: string } | { url: string; downloadUrl: string | null };

export type AdItem = {
  key: string;
  title: string;
  hooks: string[];
  script: string;
  state: "draft" | "making" | "ready" | "failed";
  startedAt?: number;
  queued?: boolean;
  stalled?: boolean;
  free?: boolean;
  writing?: boolean;
  statusLine?: string;
  note?: string | null;
  video?: AdVideo;
  error?: { text: string; credit: CreditRefusal | null } | null;
  topUp?: boolean;
  cost?: number | null;
  busy?: boolean;
  onMake?: () => void;
  onMakeScript?: (text: string) => void | Promise<boolean>;
  onRetry?: () => void;
  onEdit?: () => void;
  hookless?: boolean;
  intent?: VideoIntent | null;
  prompt?: boolean;
  onRevise?: (line: string) => void;
  onAsk?: () => void;
  onDismiss?: () => void;
};

export type NextStep = {
  key: string;
  title: string;
  body: string | null;
  doneLabel: string;
  busy?: boolean;
  error?: string | null;
  onDone: () => void;
  onDismiss: () => void;
  onAnswer?: (note: string) => Promise<boolean>;
};

export type Suggest = {
  busy: boolean;
  writing?: boolean;
  onSuggest: () => void;
  hint: string | null;
  error: { text: string; credit: CreditRefusal | null } | null;
};

export const adDomId = (key: string) => `suggested-ad-${key}`;

export function makingStep(startedAt: number | undefined, now: number): number {
  if (startedAt === undefined) return 0;
  return Math.min(MAKING_STAGES.length - 1, Math.max(0, Math.floor((now - startedAt) / STAGE_MS)));
}

const PRIMARY = "inline-flex min-h-12 h-auto items-center justify-center gap-2 rounded-full border border-transparent bg-ink px-5 py-3 text-[16px] font-semibold leading-6 tracking-[0.07px] text-cream hover:bg-inkSoft active:scale-[0.96] disabled:cursor-not-allowed disabled:bg-bone disabled:text-inkLight disabled:active:scale-100 motion-reduce:active:scale-100";
const SECONDARY = "inline-flex min-h-12 h-auto items-center justify-center gap-2 rounded-full border border-ink/20 bg-cream px-5 py-3 text-[16px] font-semibold leading-6 tracking-[0.07px] text-ink hover:bg-creamDeep active:scale-[0.96] disabled:opacity-50 motion-reduce:active:scale-100";
const CARD_PRIMARY = `${cardButton.base} ${cardButton.primary}`;
const CARD_SECONDARY = `${cardButton.base} ${cardButton.secondary}`;
const PREVIEW_PLAY = "absolute left-1/2 top-1/2 inline-flex size-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-white drop-shadow-[0_1px_3px_rgb(0_0_0/0.6)] transition-colors hover:bg-black/30 focus-visible:shadow-ca-focus focus-visible:outline-none";

const POSTER_SECONDS = 0.1;
const NOTE = "text-ca-action text-ca-secondary";
const ALERT = "text-ca-action text-ca-danger";
const PREVIEW_ERROR = "absolute inset-0 grid place-items-center px-4 text-center text-ca-action text-ca-danger";
const FIELD = "w-full rounded-xl border border-ink/20 bg-cream px-3 text-[15px] leading-6 text-ink placeholder:text-inkMuted focus:border-ink focus:outline-none focus:ring-2 focus:ring-ink/10";

function pickByArrow(e: KeyboardEvent<HTMLButtonElement>, count: number, current: number, pick: (i: number) => void) {
  const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
  const next = e.key === "Home" ? 0 : e.key === "End" ? count - 1 : step ? (current + step + count) % count : -1;
  if (next < 0) return;
  e.preventDefault();
  pick(next);
  const radios = e.currentTarget.closest('[role="radiogroup"]')?.querySelectorAll<HTMLElement>('[role="radio"]');
  radios?.[next]?.focus();
}

export function spokenText(hook: string | null, script: string): string {
  return [hook?.trim(), script.trim()].filter(Boolean).join(" ");
}

export function secondsFor(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(5, Math.round(words / 2.5 / 5) * 5);
}

export function SuggestedAds({
  items,
  loading,
  error,
  now,
  suggest = null,
  steps = [],
  more = null,
  loadingMore = 0,
  announce,
}: {
  items: AdItem[];
  loading: boolean;
  error: string | null;
  now: number;
  suggest?: Suggest | null;
  steps?: NextStep[];
  more?: (() => void) | null;
  loadingMore?: number;
  announce?: (message: string) => void;
}) {
  return (
    <section data-testid="suggested-ads" aria-labelledby="suggested-ads-title" className="mx-auto w-full max-w-[960px] pb-10">
      {steps.length > 0 && <NextSteps steps={steps} />}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id="suggested-ads-title" className="text-[24px] font-semibold leading-8 tracking-[-0.3px] text-ink">
            Suggested ads
          </h2>
          <p data-testid="suggested-ads-subtitle" className="mt-1 text-[13px] leading-[18px] text-inkMuted">
            {items.some((i) => i.free && i.state === "making")
              ? "Zavi is making the first one now. It is charged only if it arrives."
              : "Pick a hook on any ad and make it."}
          </p>
        </div>
        {suggest && (
          <button type="button" data-testid="suggest-ads" onClick={suggest.onSuggest} disabled={suggest.busy} className={cx(SECONDARY, FOCUS_RING)}>
            {suggest.busy ? (suggest.writing ? "Writing new ads…" : "Starting…") : "Suggest new ads"}
          </button>
        )}
      </div>
      {suggest?.hint && !suggest.error && <p className="mt-2 text-[13px] leading-5 text-inkMuted">{suggest.hint}</p>}
      {suggest?.error && (
        <p role="alert" data-testid="suggest-ads-error" className="mt-2 text-[13px] leading-5 text-coral">
          {suggest.error.text}
          {suggest.error.credit && <TopUp testId="suggest-ads-top-up" className="ml-2 inline font-semibold text-ink underline underline-offset-2" />}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-5 rounded-xl border border-coral/30 bg-coral/10 px-4 py-3 text-[14px] text-coral">
          {error}
        </p>
      )}
      {items.length > 0 ? (
        <ul className="mt-5 flex flex-col gap-5">
          {items.map((item) => (
            <li key={item.key} id={adDomId(item.key)} className="scroll-mt-4 animate-[fadeIn_240ms_ease-out] motion-reduce:animate-none">
              <AdCard item={item} now={now} announce={announce} />
            </li>
          ))}
        </ul>
      ) : loading || loadingMore > 0 ? (
        <ul aria-busy className="mt-5 flex flex-col gap-5">
          {[0, 1].map((i) => (
            <li key={i} role="status" aria-label="Loading your ads" className="h-[300px] animate-pulse rounded-[20px] border border-rule bg-bone motion-reduce:animate-none" />
          ))}
        </ul>
      ) : (
        !error && (
          <p className="mt-5 rounded-[20px] border border-dashed border-rule px-5 py-8 text-[14px] text-inkMuted">
            {suggest ? "Your ads show here. Describe one above and press Generate, or press Suggest new ads." : "Your ads show here. Describe one above and press Generate."}
          </p>
        )
      )}
      {items.length > 0 && loadingMore > 0 && (
        <div role="status" aria-label="Loading more ads" data-testid="suggested-ads-more" className="flex justify-center py-6">
          <Loader2 className="h-6 w-6 animate-spin text-inkMuted motion-reduce:animate-none" aria-hidden />
        </div>
      )}
      {more && loadingMore === 0 && <MoreSentinel onMore={more} count={items.length} />}
    </section>
  );
}

function MoreSentinel({ onMore, count }: { onMore: () => void; count: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [observed, setObserved] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setObserved(false);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onMore();
    }, { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [onMore, count]);
  return (
    <div ref={ref} data-testid="suggested-ads-sentinel" className="mt-5 flex justify-center">
      {!observed && (
        <button type="button" onClick={onMore} className={cx(SECONDARY, FOCUS_RING)}>
          Show more
        </button>
      )}
    </div>
  );
}

function NextSteps({ steps }: { steps: NextStep[] }) {
  return (
    <div data-testid="next-steps" className="mb-8">
      <h2 className="text-[18px] font-semibold leading-7 text-ink">Zavi needs you</h2>
      <ul className="mt-3 flex flex-col gap-3">
        {steps.map((s) => (
          <NextStepCard key={s.key} step={s} />
        ))}
      </ul>
    </div>
  );
}

function NextStepCard({ step: s }: { step: NextStep }) {
  const [answering, setAnswering] = useState(false);
  const [note, setNote] = useState("");
  const boxId = useId();
  const answer = s.onAnswer;
  const send = () => {
    const text = note.trim();
    if (!answer || !text || s.busy) return;
    void answer(text).then((sent) => {
      if (sent) setNote("");
    });
  };
  return (
    <li data-testid="next-step" className="rounded-[20px] border border-rule bg-cream p-5">
      <h3 className="break-words text-[16px] font-semibold leading-6 text-ink">{s.title}</h3>
      {s.body && <p className="mt-1 whitespace-pre-line break-words text-[14px] leading-6 text-inkMuted">{s.body}</p>}
      {answer && answering && (
        <div className="mt-4">
          <label htmlFor={boxId} className="text-[14px] font-medium text-ink">
            Your answer
          </label>
          <textarea
            id={boxId}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={ANSWER_PLACEHOLDER}
            rows={3}
            autoFocus
            className={cx("mt-2 block min-h-[88px] w-full resize-y rounded-2xl border border-rule bg-creamDeep px-4 py-3 text-[16px] leading-6 text-ink placeholder:text-inkLight", FOCUS_RING)}
          />
          <p className="mt-2 text-[13px] leading-5 text-inkMuted">Zavi runs this channel again with your answer. Nothing is posted until you say so.</p>
        </div>
      )}
      {s.error && (
        <p role="alert" className="mt-2 text-[13px] leading-5 text-coral">
          {s.error}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {answer ? (
          answering ? (
            <>
              <button type="button" onClick={send} disabled={s.busy || !note.trim()} className={cx(PRIMARY, FOCUS_RING)}>
                {s.busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                Send
              </button>
              <button type="button" onClick={() => setAnswering(false)} disabled={s.busy} className={cx(SECONDARY, FOCUS_RING)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setAnswering(true)} disabled={s.busy} className={cx(PRIMARY, FOCUS_RING)}>
                {s.doneLabel}
              </button>
              <button type="button" onClick={s.onDismiss} disabled={s.busy} className={cx(SECONDARY, FOCUS_RING)}>
                Dismiss
              </button>
            </>
          )
        ) : (
          <>
            <button type="button" onClick={s.onDone} disabled={s.busy} className={cx(PRIMARY, FOCUS_RING)}>
              {s.doneLabel}
            </button>
            <button type="button" onClick={s.onDismiss} disabled={s.busy} className={cx(SECONDARY, FOCUS_RING)}>
              Dismiss
            </button>
          </>
        )}
      </div>
    </li>
  );
}

const HOOK_ROWS = 3;

type Copy = { hooks: string[]; script: string };

export function AdCard({ item, now, announce }: { item: AdItem; now: number; announce?: (message: string) => void }) {
  const [copy, setCopy] = useState<Copy | null>(null);
  const [picked, setPicked] = useState(0);
  const [editing, setEditing] = useState(false);
  const editRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const sent = useRef(false);
  const awaiting = useRef(0);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    sent.current = false;
  });
  useEffect(() => {
    if (item.state !== "making" || awaiting.current > 0) return;
    setCopy(null);
    setPicked(0);
  }, [item.state]);
  const [downloaded, setDownloaded] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const [openedInTab, setOpenedInTab] = useState(false);
  const [linkFailed, setLinkFailed] = useState(false);
  const [length, setLength] = useState<number | null>(null);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [about, setAbout] = useState(false);
  const stepsId = useId();
  const made = item.state === "making" || (item.state === "ready" && copy === null);
  const open = item.state === "draft" || item.state === "failed";
  const hooks = made ? item.hooks : copy?.hooks ?? item.hooks;
  const script = made ? item.script : copy?.script ?? item.script;
  const index = made ? 0 : Math.min(picked, Math.max(0, hooks.length - 1));
  const hook = hooks[index] ?? null;
  const changed = !made && (copy !== null || index !== 0);
  const editable = !!item.onMakeScript && (hooks.length > 0 || script.trim().length > 0);
  const idle = item.state !== "making";
  const shown = item.state === "ready" ? item.video : undefined;
  const signed = useSignedVideo(shown && "artifactId" in shown ? shown.artifactId : null);
  const seconds = secondsFor(spokenText(hook, script));
  const finish = () => {
    setDownloadFailed(false);
    setOpenedInTab(false);
    setDownloaded(true);
    announce?.(`Downloaded "${item.title}".`);
  };
  const download = shown
    ? "artifactId" in shown
      ? () => {
          setDownloadFailed(false);
          void signed.download().then((ok) => (ok ? finish() : setDownloadFailed(true)));
        }
      : () => {
          const target = shown.downloadUrl ?? shown.url;
          setDownloadFailed(false);
          setOpenedInTab(false);
          const openInTab = () => {
            const tab = window.open(target, "_blank");
            if (!tab) {
              setDownloadFailed(true);
              return;
            }
            tab.opener = null;
            setOpenedInTab(true);
          };
          void (async () => {
            try {
              const res = await fetch(target);
              if (!res.ok) throw new Error("download failed");
              const objectUrl = URL.createObjectURL(await res.blob());
              const a = document.createElement("a");
              a.href = objectUrl;
              a.download = `${item.title || "video"}.mp4`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
            } catch {
              openInTab();
              return;
            }
            finish();
          })();
        }
    : null;
  const make =
    changed && item.onMakeScript
      ? () => {
          if (sent.current || starting) return;
          sent.current = true;
          const sending = item.onMakeScript?.(spokenText(hook, script));
          const clear = () => {
            setCopy(null);
            setPicked(0);
          };
          if (sending instanceof Promise) {
            awaiting.current += 1;
            setStarting(true);
            const settle = (ok: boolean) => {
              awaiting.current -= 1;
              setStarting(awaiting.current > 0);
              if (ok) clear();
            };
            void sending.then(settle, () => settle(false));
          } else if (item.state === "ready") clear();
        }
      : item.onMake;
  const revise = (line: string) => {
    if (sent.current) return;
    sent.current = true;
    item.onRevise?.(line);
  };
  const scriptLabel = item.prompt ? "Your request" : "Script";
  const howSteps = item.state === "ready"
    ? ["Press play to watch your video.", "Press Download to save it and post it anywhere.", "Press Edit to change the words and make a new one."]
    : ["Check the words. Press Edit to change them.", "Press Make video. It takes a few minutes.", "Download it when it is ready. You are charged only if the video arrives."];
  const seed: Copy = item.hookless && copy === null ? { hooks: [], script: spokenText(hook, script) } : { hooks, script };
  useEffect(() => {
    if (editing || !returnFocus.current) return;
    returnFocus.current = false;
    editRef.current?.focus();
  }, [editing]);
  const startEdit = () => {
    if (editable) setEditing(true);
    else item.onEdit?.();
  };
  const close = () => {
    returnFocus.current = true;
    setEditing(false);
  };
  const save = (next: Copy, nextPicked: number) => {
    const asIs = next.script === item.script && next.hooks.length === item.hooks.length && next.hooks.every((h, i) => h === item.hooks[i]);
    const asSeeded = !!item.hookless && next.hooks.length === 0 && next.script === spokenText(item.hooks[0] ?? null, item.script);
    const same = (asIs || asSeeded) && (item.state !== "ready" || nextPicked === 0);
    setCopy(same ? null : next);
    setPicked(asSeeded ? 0 : nextPicked);
    close();
    announce?.(`Saved your changes to "${item.title}".`);
  };
  return (
    <article
      data-testid="suggested-ad"
      data-state={item.state}
      className="relative flex min-w-0 flex-col gap-3 overflow-hidden rounded-2xl border border-ca-strong bg-ca-bg p-5"
    >
      {item.onDismiss && !editing && (
        <button type="button" aria-label="Dismiss" title="Dismiss" onClick={item.onDismiss} className={cx(cardIconButton, "absolute right-3 top-3 text-ca-secondary hover:bg-ca-hover hover:text-ca-primary")}>
          <X className="size-4" aria-hidden />
        </button>
      )}
      <CardEyebrow kind={shown ? "Review" : "Video"} meta={shown ? [kindLabel(item.intent), ...(item.cost != null ? [`About ${item.cost.toLocaleString("en-US")} credits`] : [])] : []} />
      <h3 className={cardText.title} title={item.title}>{item.title}</h3>
      <WithMedia
        media={
          <div className="flex w-ca-media shrink-0 flex-col gap-2">
          <aside aria-label="Video preview" className={cx("group/media relative aspect-ad-feed w-full overflow-hidden rounded-lg bg-ca-subtle", FULLSCREEN_FIT)}>
            {shown ? (
              "artifactId" in shown ? (
                signed.failed ? (
                  <p className={PREVIEW_ERROR}>This video could not be loaded. Refresh the page.</p>
                ) : signed.url ? (
                  <Preview url={signed.url} title={item.title} onError={signed.onError} onLength={setLength} />
                ) : (
                  <div role="status" aria-label="Loading your video" className="absolute inset-0 animate-pulse bg-ca-hover" />
                )
              ) : linkFailed ? (
                <p className={PREVIEW_ERROR}>This video could not be loaded. Refresh the page.</p>
              ) : (
                <Preview url={shown.url} title={item.title} onError={() => setLinkFailed(true)} onLength={setLength} />
              )
            ) : item.state === "making" ? (
              <Making item={item} now={now} />
            ) : (
              <NotMade failed={item.state === "failed" && !changed} stalled={!!item.stalled && !changed} retry={!!item.onRetry} hook={hook} seconds={seconds} kind={kindLabel(item.intent)} />
            )}
          </aside>
          {shown && <p data-testid="suggested-ad-preview-meta" className="text-ca-action text-ca-secondary">{length != null ? `${length} seconds` : `About ${seconds} seconds`}</p>}
          </div>
        }
      >
        {editing ? (
          <EditForm title={item.title} hooks={seed.hooks} script={seed.script} scriptLabel={scriptLabel} picked={index} onSave={save} onCancel={close} />
        ) : (
          <div className="flex min-w-0 flex-col gap-3">
            {hooks.length > 1 && !made && (
              <div>
                <p className={cardText.label}>Pick the hook</p>
                <div role="radiogroup" aria-label="Pick the hook" className="flex flex-wrap gap-2">
                  {hooks.map((h, i) => (
                    <button
                      key={i}
                      type="button"
                      role="radio"
                      aria-checked={i === index}
                      tabIndex={i === index ? 0 : -1}
                      onClick={() => setPicked(i)}
                      onKeyDown={(e) => pickByArrow(e, hooks.length, index, setPicked)}
                      className={cx(
                        "inline-flex min-h-8 items-center rounded-full px-3 py-1 text-left text-ca-action font-semibold transition-colors focus-visible:shadow-ca-focus focus-visible:outline-none",
                        i === index ? "bg-ca-action text-ca-on-action" : "border border-ca-strong bg-ca-bg text-ca-primary hover:bg-ca-hover",
                      )}
                    >
                      {h}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {hook && script && (made || hooks.length === 1) && (
              <div>
                <p className={cardText.label}>Hook</p>
                <p data-testid="suggested-ad-hook" className="min-w-0 break-words text-ca-row font-semibold text-ca-xdark [overflow-wrap:anywhere]">{hook}</p>
              </div>
            )}
            {(hook || script) && (
              <div>
                <p className={cardText.label}>{scriptLabel}</p>
                <p data-testid="suggested-ad-script" className="line-clamp-4 min-w-0 whitespace-pre-line break-words text-ca-row text-ca-dark [overflow-wrap:anywhere]">
                  {hook && script ? <span className="sr-only">{hook} </span> : hook && <span data-testid={made || hooks.length === 1 ? "suggested-ad-hook" : undefined}>{hook}</span>}
                  {script}
                </p>
              </div>
            )}
            {item.note && <p className={NOTE}>{item.note}</p>}
            {item.cost != null && (make || item.onRetry) && (
              <p data-testid="suggested-ad-cost" className={NOTE}>
                {changed
                  ? `About ${item.cost.toLocaleString("en-US")} credits for the suggested script. Yours is priced by its length, charged only if the video arrives.`
                  : `About ${item.cost.toLocaleString("en-US")} credits, charged only if the video arrives.`}
              </p>
            )}
            {item.error && (
              <p role="alert" className={ALERT}>
                {item.error.text}
              </p>
            )}
            {(item.topUp || item.error?.credit) && (
              <TopUp testId="suggested-ad-top-up" className="inline-block self-start text-left text-ca-action font-semibold text-ca-primary underline underline-offset-4" />
            )}
            {downloadFailed && (
              <p role="alert" data-testid="suggested-ad-download-error" className={ALERT}>
                The download did not start. Try again.
              </p>
            )}
            {openedInTab && (
              <p role="status" data-testid="suggested-ad-opened" className={NOTE}>
                Opened in a new tab.
              </p>
            )}
          </div>
        )}
      </WithMedia>
      {!editing && (
        <div data-testid="card-footer" className="mt-1 flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-ca-border pt-3">
          <span className="flex min-w-0 flex-none flex-wrap items-center gap-x-4 gap-y-1">
            <button type="button" data-card-open="how-it-works" aria-expanded={stepsOpen} aria-controls={stepsId} onClick={() => setStepsOpen((v) => !v)} className={cardLink}>
              How it works
              <ChevronDown className={cx("size-4 transition-transform duration-200 ease-ca-spring", stepsOpen && "rotate-180")} aria-hidden />
            </button>
            {(hook || script) && (
              <button type="button" data-card-open="what-it-is" aria-haspopup="dialog" onClick={() => setAbout(true)} className={cardLink}>What it is</button>
            )}
          </span>
          <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          {item.state === "ready" &&
            made &&
            item.onRevise &&
            REVISIONS.map((r) => (
              <button key={r.line} type="button" onClick={() => revise(r.line)} disabled={item.busy} className={CARD_SECONDARY}>
                {r.label}
              </button>
            ))}
          {open && item.onAsk && (
            <button type="button" onClick={item.onAsk} className={CARD_SECONDARY}>
              <AskIcon className="size-4" />
              Ask Zavi
            </button>
          )}
          {idle && !item.writing && (editable || item.onEdit) && (
            <button ref={editRef} type="button" onClick={startEdit} className={CARD_SECONDARY}>
              <EditIcon className="size-4" />
              Edit
            </button>
          )}
          {item.onRetry && !(changed && item.onMakeScript) && (
            <button type="button" onClick={item.onRetry} disabled={item.busy} className={CARD_PRIMARY}>
              <RefreshIcon className="size-4" />
              {item.busy ? "Starting…" : "Try again"}
            </button>
          )}
          {make && idle && (
            <button type="button" onClick={make} disabled={item.busy || starting} className={CARD_PRIMARY}>
              <GenerateIcon className="size-4" />
              {item.busy || starting ? "Starting…" : "Make video"}
            </button>
          )}
          {!idle && !item.writing && (
            <button type="button" disabled className={CARD_PRIMARY}>
              <RefreshIcon className="size-4" />
              {item.queued ? QUEUED_BUTTON : "Making it · a few minutes"}
            </button>
          )}
          {download && (
            <button
              type="button"
              data-testid="suggested-ad-download"
              onClick={download}
              disabled={signed.downloading || ("artifactId" in (shown ?? {}) && !signed.url)}
              className={CARD_PRIMARY}
            >
              <DownloadIcon className="size-4" />
              {signed.downloading ? "Downloading…" : downloaded ? "Download again" : "Download"}
            </button>
          )}
          </span>
        </div>
      )}
      {!editing && stepsOpen && (
        <ol id={stepsId} className="mt-1 list-decimal rounded-xl bg-ca-subtle py-3 pl-8 pr-4 text-ca-facts text-ca-dark">
          {howSteps.map((step) => <li key={step}>{step}</li>)}
        </ol>
      )}
      <InfoDialog
        open={about}
        title={item.title}
        onClose={() => setAbout(false)}
        about={
          <div className="flex flex-col gap-3">
            <p>{kindLabel(item.intent)} video, about {seconds} seconds.</p>
            {hook && <p><span className="font-semibold text-ca-xdark">Hook</span><br />{hook}</p>}
            {script && <p className="whitespace-pre-line"><span className="font-semibold text-ca-xdark">{scriptLabel}</span><br />{script}</p>}
          </div>
        }
      />
    </article>
  );
}

function EditForm({
  title,
  hooks,
  script,
  scriptLabel = "Script",
  picked,
  onSave,
  onCancel,
}: {
  title: string;
  hooks: string[];
  script: string;
  scriptLabel?: string;
  picked: number;
  onSave: (copy: Copy, picked: number) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [rows, setRows] = useState(() => (hooks.length > 0 ? Array.from({ length: Math.max(HOOK_ROWS, hooks.length) }, (_, i) => hooks[i] ?? "") : []));
  const [choice, setChoice] = useState(picked);
  const [body, setBody] = useState(script);
  const blank = rows.some((r, i) => i < hooks.length && !r.trim()) || (rows.length > 0 && !rows[choice]?.trim()) || !body.trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (blank) return;
    const kept = rows.map((r) => r.trim()).filter(Boolean);
    const at = rows.slice(0, choice).filter((r) => r.trim()).length;
    onSave({ hooks: kept, script: body.trim() }, rows.length ? at : 0);
  };
  return (
    <form
      aria-label={`Edit "${title}"`}
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        onCancel();
      }}
      className="flex min-w-0 flex-col gap-4"
    >
      {rows.length > 0 && (
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-2 text-[14px] font-medium leading-5 text-ink">Pick the hook</legend>
          <div role="radiogroup" aria-label="Hook to use" className="flex flex-col gap-2">
            {rows.map((h, i) => (
              <div key={i} className="flex min-w-0 items-center gap-3">
                <button
                  type="button"
                  role="radio"
                  aria-checked={i === choice}
                  aria-label={`Use hook ${i + 1}`}
                  tabIndex={i === choice ? 0 : -1}
                  onClick={() => setChoice(i)}
                  onKeyDown={(e) => pickByArrow(e, rows.length, choice, setChoice)}
                  className={cx(
                    "flex size-8 shrink-0 items-center justify-center rounded-full text-[14px] font-semibold tabular-nums",
                    i === choice ? "bg-ink text-cream" : "border border-ink/20 text-ink hover:bg-creamDeep",
                    FOCUS_RING,
                  )}
                >
                  {i + 1}
                </button>
                <input
                  aria-label={`Hook ${i + 1}`}
                  autoFocus={i === choice}
                  value={h}
                  maxLength={200}
                  placeholder="Write another first line"
                  onChange={(e) => {
                    const v = e.target.value;
                    setRows((cur) => cur.map((x, j) => (j === i ? v : x)));
                  }}
                  className={cx(FIELD, "h-12 min-w-0")}
                />
              </div>
            ))}
          </div>
        </fieldset>
      )}
      <div className="flex flex-col gap-2">
        <label htmlFor={`${id}-script`} className="text-[14px] font-medium leading-5 text-ink">
          {scriptLabel}
        </label>
        <textarea id={`${id}-script`} autoFocus={rows.length === 0} aria-describedby={rows.length > 0 ? `${id}-script-hint` : undefined} rows={4} value={body} onChange={(e) => setBody(e.target.value)} className={cx(FIELD, "min-h-24 resize-y py-3")} />
        {rows.length > 0 && (
          <p id={`${id}-script-hint`} className="flex items-center gap-1.5 text-[14px] leading-5 text-inkMuted">
            <InfoIcon className="h-4 w-4 shrink-0" />
            The picked hook is said first, then this.
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button type="submit" disabled={blank} className={CARD_PRIMARY}>
          <CheckIcon className="size-4" />
          Save
        </button>
        <button type="button" onClick={onCancel} className={CARD_SECONDARY}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Making({ item, now }: { item: AdItem; now: number }) {
  const step = makingStep(item.startedAt, now);
  if (item.writing) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-5 text-center">
        <RefreshIcon className="h-6 w-6 animate-spin text-inkMuted motion-reduce:animate-none" />
        <p role="status" data-testid="suggested-ad-stage" className="text-[14px] font-semibold leading-5 text-ink">
          {item.statusLine ?? "Writing the script…"}
        </p>
      </div>
    );
  }
  if (item.queued) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-5 text-center">
        <RefreshIcon className="h-6 w-6 animate-spin text-inkMuted motion-reduce:animate-none" />
        <p role="status" data-testid="suggested-ad-stage" className="text-[14px] font-semibold leading-5 text-ink">
          {QUEUED_STAGE}
        </p>
        <p data-testid="suggested-ad-queued" className="text-[13px] leading-[18px] text-inkMuted">
          {QUEUED_NOTE}
        </p>
      </div>
    );
  }
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-5 text-center">
      <RefreshIcon className="h-6 w-6 animate-spin text-inkMuted motion-reduce:animate-none" />
      <p role="status" data-testid="suggested-ad-stage" className="text-[14px] font-semibold leading-5 text-ink">
        {MAKING_STAGES[step]}
      </p>
      {item.free && (
        <p data-testid="suggested-ad-free" className="text-[13px] leading-[18px] text-inkMuted">
          Zavi is making this first one now. It is charged only if it arrives.
        </p>
      )}
      {item.statusLine && (
        <p role="status" data-testid="suggested-ad-status" className="sr-only">
          {item.statusLine}
        </p>
      )}
      <div aria-hidden className="h-1.5 w-full overflow-hidden rounded-full bg-rule">
        <div
          data-testid="suggested-ad-progress"
          className="h-full rounded-full bg-ink transition-[width] duration-[320ms] ease-out"
          style={{ width: `${((step + 1) / MAKING_STAGES.length) * 100}%` }}
        />
      </div>
    </div>
  );
}

function NotMade({ failed, stalled, retry, hook, seconds, kind }: { failed: boolean; stalled: boolean; retry: boolean; hook: string | null; seconds: number; kind: string }) {
  return (
    <div
      data-testid="suggested-ad-placeholder"
      className="absolute inset-0 flex flex-col items-center justify-between rounded-lg border border-ca-border bg-ca-bg p-3 text-center"
    >
      <span
        className={cx(
          "self-start rounded-full px-2.5 py-1 text-[12px] font-semibold leading-4",
          failed && !stalled ? "bg-coral/10 text-coral" : "bg-bone text-inkMuted",
        )}
      >
        {stalled ? "Taking longer" : failed ? "Not made" : "Not made yet"}
      </span>
      <span className="flex flex-col items-center gap-1.5">
        <span aria-hidden className="grid size-9 place-items-center rounded-full bg-bone text-inkMuted">
          <GenerateIcon className="h-5 w-5" />
        </span>
        {hook && (
          <span data-testid="suggested-ad-preview-hook" className="line-clamp-2 text-balance text-[13px] font-semibold leading-[18px] text-ink">
            “{hook}”
          </span>
        )}
        <span className="text-[13px] leading-[18px] text-inkMuted">
          {stalled ? (retry ? "Press Try again to check on it." : "Edit it or ask Zavi for a new one.") : failed ? (retry ? "Press Try again to make it." : "Edit it or ask Zavi for a new one.") : "Your video shows here once you make it."}
        </span>
      </span>
      <span className="text-[12px] font-semibold leading-4 text-inkMuted">{kind} · {seconds}s</span>
    </div>
  );
}

function Preview({ url, title, onError, onLength }: { url: string; title: string; onError?: () => void; onLength?: (seconds: number) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const playRef = useRef<HTMLButtonElement>(null);
  const [playing, setPlaying] = useState(false);
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    if (!moved) return;
    if (playing) ref.current?.parentElement?.querySelector<HTMLButtonElement>('[data-testid="video-controls"] button')?.focus();
    else playRef.current?.focus();
  }, [playing, moved]);
  const play = () => {
    setPlaying(true);
    setMoved(true);
    void ref.current?.play()?.catch(() => undefined);
  };
  return (
    <>
      <video
        ref={ref}
        src={url}
        onError={onError}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          const d = el.duration;
          if (Number.isFinite(d) && d > 0) onLength?.(Math.round(d));
          if (el.paused && el.currentTime === 0) el.currentTime = POSTER_SECONDS;
        }}
        onEnded={() => setPlaying(false)}
        preload="metadata"
        playsInline
        className="size-full bg-black object-cover"
      />
      {!playing && (
        <>
          <button ref={playRef} type="button" onClick={play} aria-label={`Play ${title}`} className={PREVIEW_PLAY}>
            <PlayIcon className="h-6 w-6" />
          </button>
          <MediaExpand url={url} alt={title} video />
        </>
      )}
      {playing && <VideoControls video={ref} title={title} />}
    </>
  );
}
