"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cx, FOCUS_RING } from "../layout/shared";
import { ChannelControlsSlot } from "../layout/ChannelHeaderRow";
import { DownloadIcon, PlayIcon, RefreshIcon, SentIcon } from "./libraryIcons";
import { useSignedVideo } from "./useSignedVideo";
import { FULLSCREEN_FIT, VideoControls } from "./VideoControls";
import { joinNames, loadPostTargets, POST_LABELS, PostDialog, postedLabel, type PostTargetName } from "./PostDialog";
import { kindLabel, type GalleryVideo, type VideoIntent } from "./types";

function shortDate(iso: string, now: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (d.toDateString() === new Date(now).toDateString()) return "Today";
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

function length(seconds: number, intent: VideoIntent | null | undefined): string {
  return `${kindLabel(intent, "AI video")} · ${Math.max(1, Math.round(seconds))}s`;
}

const INTERNAL_NAME = /^([a-z]+(?:_[a-z]+)*)-[0-9a-f]{6,}$/i;
const CARD_TAG = /(?<=\S)\s+(?=[a-f]*\d)[0-9a-f]{8}$/;

function title(filename: string | null): string {
  if (!filename) return "Video";
  const base = filename.replace(/\.[a-z0-9]{2,4}$/i, "");
  const kind = INTERNAL_NAME.exec(base)?.[1];
  if (!kind) return base.replace(CARD_TAG, "");
  const words = kind.replace(/_/g, " ").toLowerCase();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}${/video$/.test(words) ? "" : " video"}`;
}

const SHOW_OPEN_AD = false;
const ORDER = Object.keys(POST_LABELS) as PostTargetName[];

function badgeLabel(posted: PostTargetName[], posting: PostTargetName[], check: PostTargetName[] = [], failed: PostTargetName[] = []): string {
  const parts: string[] = [];
  if (posted.length === 1) parts.push(postedLabel(posted[0]));
  else if (posted.length > 1) parts.push(`Posted on ${joinNames(posted.map((n) => (n === "tiktok" ? "TikTok (private)" : POST_LABELS[n])))}`);
  if (posting.length > 0) parts.push(`${parts.length ? "posting" : "Posting"} to ${joinNames(posting.map((n) => POST_LABELS[n]))}…`);
  if (check.length > 0) parts.push(`${parts.length ? "check" : "Check"} ${joinNames(check.map((n) => POST_LABELS[n]))}`);
  if (failed.length > 0) parts.push(`${parts.length ? "post failed" : "Post failed"} on ${joinNames(failed.map((n) => POST_LABELS[n]))}`);
  return parts.length ? parts.join(", ") : "Ready";
}
const UPDATED_MS = 4000;
const POST_POLL_MS = 5000;
const POST_WATCH_MS = 600_000;

function LibraryControls({ onRefresh, refreshing, updated }: { onRefresh: () => void; refreshing: boolean; updated: boolean }) {
  return (
    <ChannelControlsSlot>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {updated && (
          <span role="status" data-testid="video-library-updated" className="text-[14px] text-ink">
            Updated just now
          </span>
        )}
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          data-testid="video-library-refresh"
          className={cx(
            "inline-flex min-h-10 items-center gap-2 rounded-xl border border-ink/20 bg-cream py-1.5 pl-4 pr-5 text-[14px] font-semibold leading-5 tracking-[0.01em] text-ink transition hover:bg-creamDeep disabled:opacity-60",
            FOCUS_RING,
          )}
        >
          <RefreshIcon className={cx("h-5 w-5 text-ink", refreshing && "animate-spin motion-reduce:animate-none")} />
          Refresh
        </button>
      </div>
    </ChannelControlsSlot>
  );
}

function LibraryCard({ video, onOpenChat, onPosted, onWaiting, now }: { video: GalleryVideo; onOpenChat?: (id: string) => void; onPosted: () => void; onWaiting: (id: string, waiting: boolean) => void; now: number }) {
  const { url, failed, onError, download, downloading } = useSignedVideo(video.artifact_id);
  const ref = useRef<HTMLVideoElement>(null);
  const playRef = useRef<HTMLButtonElement>(null);
  const [playing, setPlaying] = useState(false);
  const [moved, setMoved] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postedNow, setPostedNow] = useState<PostTargetName[]>([]);
  const name = title(video.filename);
  const posted = ORDER.filter((n) => (video.posted_on ?? []).includes(n));
  const postingTo = ORDER.filter((n) => !posted.includes(n) && (postedNow.includes(n) || (video.posting_on ?? []).includes(n)));
  const check = ORDER.filter((n) => !posted.includes(n) && !postingTo.includes(n) && (video.check_on ?? []).includes(n));
  const failedOn = ORDER.filter((n) => !posted.includes(n) && !postingTo.includes(n) && !check.includes(n) && (video.failed_on ?? []).includes(n));
  const badge = badgeLabel(posted, postingTo, check, failedOn);
  useEffect(() => {
    const known = new Set([...(video.posted_on ?? []), ...(video.posting_on ?? []), ...(video.check_on ?? []), ...(video.failed_on ?? [])]);
    setPostedNow((cur) => (cur.some((n) => known.has(n)) ? cur.filter((n) => !known.has(n)) : cur));
  }, [video]);
  const waiting = postedNow.length > 0;
  useEffect(() => {
    onWaiting(video.artifact_id, waiting);
  }, [onWaiting, video.artifact_id, waiting]);
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
  const save = () => {
    setDownloadFailed(false);
    void download().then((ok) => (ok ? setDownloaded(true) : setDownloadFailed(true)));
  };
  return (
    <article data-testid="video-library-item" aria-label={`${name}: ${badge}`} className="flex min-w-0 flex-col gap-2.5">
      <div className={cx("relative aspect-[3/4] overflow-hidden rounded-[20px] bg-bone", FULLSCREEN_FIT)}>
        {failed ? (
          <p className="absolute inset-0 grid place-items-center px-4 text-center text-[13px] text-coral">
            This video could not be loaded. Refresh the page.
          </p>
        ) : !url ? (
          <div role="status" aria-label="Loading your video" className="absolute inset-0 animate-pulse bg-bone" />
        ) : (
          <video
            ref={ref}
            data-artifact-id={video.artifact_id}
            src={url}
            onError={onError}
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration;
              if (Number.isFinite(d) && d > 0) setDuration(d);
            }}
            onEnded={() => setPlaying(false)}
            preload="metadata"
            playsInline
            className="size-full bg-black object-cover"
          />
        )}
        {!playing && (
          <>
            <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/25 via-transparent to-black/60" />
            <span
              data-testid="video-library-status"
              className="absolute left-3 top-3 max-w-[calc(100%-24px)] break-words rounded-2xl bg-cream/90 px-2.5 py-1 text-[12px] font-semibold leading-4 text-ink"
            >
              {badge}
            </span>
            {url && !failed && (
              <button
                ref={playRef}
                type="button"
                onClick={play}
                aria-label={`Play ${name}`}
                className={cx(
                  "absolute left-1/2 top-1/2 grid size-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-cream/90 text-ink transition hover:bg-cream",
                  FOCUS_RING,
                )}
              >
                <PlayIcon className="h-5 w-5" />
              </button>
            )}
            {duration !== null && (
              <span data-testid="video-library-duration" className="absolute inset-x-3 bottom-3 text-[12px] font-semibold leading-4 text-white">
                {length(duration, video.intent)}
              </span>
            )}
          </>
        )}
        {playing && url && !failed && <VideoControls video={ref} title={name} />}
      </div>
      <div className="min-w-0">
        <h3 className="line-clamp-2 break-words text-[15px] font-semibold leading-5 text-ink">
          {name}
        </h3>
        <p className="mt-0.5 text-[13px] leading-[18px] text-inkMuted">{shortDate(video.created_at, now)}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!url || downloading}
          aria-label={`Download ${name}`}
          className={cx(
            "inline-flex h-10 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border border-ink/20 bg-cream px-3 text-[14px] font-semibold text-ink hover:bg-creamDeep disabled:opacity-50",
            FOCUS_RING,
          )}
        >
          <DownloadIcon className="h-4 w-4" />
          {downloading ? "Downloading…" : downloaded ? "Download again" : "Download"}
        </button>
        <button
          type="button"
          onClick={() => setPosting(true)}
          aria-label={`Post ${name}`}
          data-testid="video-library-post"
          className={cx(
            "inline-flex h-10 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border border-ink/20 bg-cream px-3 text-[14px] font-semibold text-ink hover:bg-creamDeep",
            FOCUS_RING,
          )}
        >
          <SentIcon className="h-4 w-4" />
          Post
        </button>
        {SHOW_OPEN_AD && video.thread_id && onOpenChat && (
          <button
            type="button"
            onClick={() => onOpenChat(video.thread_id as string)}
            className={cx(
              "inline-flex h-10 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border border-ink/20 bg-cream px-3 text-[14px] font-semibold text-ink hover:bg-creamDeep",
              FOCUS_RING,
            )}
          >
            Open ad
          </button>
        )}
      </div>
      {downloadFailed && (
        <p role="alert" data-testid="video-library-download-error" className="text-[13px] leading-5 text-coral">
          The download did not start. Try again.
        </p>
      )}
      {posting && (
        <PostDialog
          artifactId={video.artifact_id}
          title={name}
          posted={posted}
          posting={postingTo}
          check={check}
          failed={failedOn}
          onPosted={(names) => {
            setPostedNow((p) => [...new Set([...p, ...names])]);
            if (names.length > 0) onPosted();
          }}
          onClose={() => setPosting(false)}
        />
      )}
    </article>
  );
}

export function VideoLibrary({
  videos,
  error,
  onOpenChat,
  onMake,
  onRefresh,
  now = Date.now,
}: {
  videos: GalleryVideo[] | null;
  error: string | null;
  onOpenChat?: (id: string) => void;
  onMake?: () => void;
  onRefresh?: () => Promise<boolean | void> | boolean | void;
  now?: () => number;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [updated, setUpdated] = useState(false);
  const shown = videos;
  const hasVideos = !!videos && videos.length > 0;
  useEffect(() => {
    if (hasVideos) void loadPostTargets().catch(() => undefined);
  }, [hasVideos]);
  const [watchUntil, setWatchUntil] = useState(0);
  const [waiting, setWaiting] = useState<string[]>([]);
  const onWaiting = useCallback((id: string, on: boolean) => {
    setWaiting((cur) => (cur.includes(id) === on ? cur : on ? [...cur, id] : cur.filter((w) => w !== id)));
  }, []);
  const anyPosting = waiting.length > 0 || !!videos?.some((v) => (v.posting_on ?? []).length > 0);
  const refreshRef = useRef(onRefresh);
  useEffect(() => {
    refreshRef.current = onRefresh;
  }, [onRefresh]);
  const polled = useRef(false);
  const watchPosts = () => {
    polled.current = false;
    setWatchUntil(Date.now() + POST_WATCH_MS);
  };
  const rewatch = useRef(false);
  useEffect(() => {
    const again = rewatch.current;
    rewatch.current = false;
    if (anyPosting) setWatchUntil((w) => (w && !again ? w : Date.now() + POST_WATCH_MS));
    else if (polled.current) setWatchUntil(0);
  }, [anyPosting, videos]);
  useEffect(() => {
    if (watchUntil <= Date.now()) return;
    const timer = window.setInterval(() => {
      if (Date.now() > watchUntil) return window.clearInterval(timer);
      polled.current = true;
      void Promise.resolve(refreshRef.current?.()).catch(() => undefined);
    }, POST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [watchUntil]);
  useEffect(() => {
    if (!updated) return;
    const timer = window.setTimeout(() => setUpdated(false), UPDATED_MS);
    return () => window.clearTimeout(timer);
  }, [updated]);
  const refresh = onRefresh
    ? async () => {
        if (refreshing) return;
        setRefreshing(true);
        setUpdated(false);
        rewatch.current = true;
        try {
          setUpdated((await onRefresh()) !== false);
        } catch {
          setUpdated(false);
        } finally {
          setRefreshing(false);
        }
      }
    : undefined;
  const makeButton = onMake && (
    <button
      type="button"
      onClick={onMake}
      className={cx("rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-cream hover:opacity-90", FOCUS_RING)}
    >
      Make a video
    </button>
  );
  return (
    <section data-testid="video-library" aria-label="Library" className="mx-auto w-full max-w-[960px] pb-10">
      {refresh && <LibraryControls onRefresh={refresh} refreshing={refreshing} updated={updated} />}
      <div className="flex items-center gap-2.5">
        <h2 className="text-[24px] font-semibold leading-8 tracking-[-0.3px] text-ink">Library</h2>
        {shown && shown.length > 0 && (
          <span data-testid="video-library-count" className="rounded-full bg-bone px-2.5 py-0.5 text-[13px] font-semibold tabular-nums text-ink">
            {shown.length}
          </span>
        )}
      </div>
      <p className="mt-1 text-[13px] leading-[18px] text-inkMuted">Every ad you have made. Download a video to keep it, or post it to your social accounts.</p>
      {error ? (
        <p role="alert" className="mt-5 rounded-xl border border-coral/30 bg-coral/10 px-4 py-3 text-[14px] text-coral">
          {error}
        </p>
      ) : shown === null ? (
        <p role="status" className="mt-5 text-[14px] text-inkMuted">
          <span className="zavi-shimmer">Loading your videos…</span>
        </p>
      ) : shown.length === 0 ? (
        <div className="mt-5 flex flex-col items-start gap-3 rounded-[20px] border border-dashed border-rule px-5 py-8">
          <p className="text-[15px] text-ink">No videos yet.</p>
          <p className="text-[14px] text-inkMuted">Every video you make here or from a suggested ad shows up in this list.</p>
          {makeButton}
        </div>
      ) : (
        <ul className="mt-5 grid grid-cols-2 gap-4 [@container(min-width:28rem)]:grid-cols-3 [@container(min-width:48rem)]:grid-cols-4">
          {shown.map((v) => (
            <li key={v.artifact_id} className="min-w-0">
              <LibraryCard video={v} onOpenChat={onOpenChat} onPosted={watchPosts} onWaiting={onWaiting} now={now()} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
