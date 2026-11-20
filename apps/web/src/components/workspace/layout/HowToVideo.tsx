"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GraduationCap, PlayCircle, X } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { trackEvent, trackEventDeferred } from "@/lib/analytics/events";
import { cx } from "./shared";

export const HOWTO_VIDEO_SRC = "https://media.zaviagent.com/videos/how-to-use-zavi.mp4";
export const HOWTO_VIDEO_POSTER = "/videos/how-to-use-zavi-poster.jpg";
export const HOWTO_SEEN_KEY = "zavi:howto-video:v1";

const MARKS = [25, 50, 100] as const;

export function howToSeen(): boolean {
  try {
    return window.localStorage.getItem(HOWTO_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function markHowToSeen() {
  try {
    window.localStorage.setItem(HOWTO_SEEN_KEY, "1");
  } catch {
  }
}

let shownReported = false;

export function HowToVideoCard({ onOpen, dialogOpen = false }: { onOpen: () => void; dialogOpen?: boolean }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (dialogOpen) return;
    const show = !howToSeen();
    setVisible(show);
    if (show && !shownReported) {
      shownReported = true;
      return trackEventDeferred("howto_video_card_shown");
    }
  }, [dialogOpen]);

  if (!visible) return null;

  const play = () => onOpen();
  const dismiss = () => {
    markHowToSeen();
    setVisible(false);
    trackEvent("howto_video_card_dismissed");
  };

  return (
    <div className="relative mx-2 mb-2 shrink-0 rounded-xl border border-rule bg-creamDeep">
      <button
        type="button"
        onClick={play}
        className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 pr-9 text-left hover:bg-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
      >
        <PlayCircle className="h-5 w-5 shrink-0 text-ink" aria-hidden />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
            How to use Zavi
            <span className="rounded-full bg-ink px-1.5 py-px text-[10px] font-bold tracking-[0.04em] text-cream">
              NEW
            </span>
          </span>
          <span className="mt-0.5 text-[12px] text-inkMuted">2 min video</span>
        </span>
      </button>
      <button
        type="button"
        aria-label="Hide the how-to video card"
        onClick={dismiss}
        className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-inkMuted hover:bg-bone hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}

export function HowToVideoDialog({
  source,
  onClose,
  onStart,
}: {
  source: "card" | "menu";
  onClose: () => void;
  onStart?: () => void;
}) {
  const reported = useRef(new Set<number>());
  const watched = useRef(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    trackEvent("howto_video_opened", { source });
  }, [source]);

  const report = (pct: number) => {
    watched.current = Math.max(watched.current, pct);
    for (const m of MARKS) {
      if (pct >= m && !reported.current.has(m)) {
        reported.current.add(m);
        trackEvent("howto_video_progress", { pct: m, source });
      }
    }
  };

  const close = () => {
    if (!failed) markHowToSeen();
    trackEvent("howto_video_closed", { watched_pct: Math.round(watched.current), source });
    onClose();
  };

  return createPortal(
    <Dialog id="howto-video" label="How to use Zavi" onClose={close}>
      <div className="flex h-full w-full items-center justify-center bg-black/60 p-4" onClick={(e) => e.target === e.currentTarget && close()}>
        <div className="flex w-full max-w-[1040px] flex-col overflow-hidden rounded-2xl bg-cream shadow-pop">
          <div className="flex items-center gap-3 px-5 py-3">
            <h2 className="text-[16px] font-semibold text-ink">How to use Zavi</h2>
            {}
            <a
              href="/tutorials"
              target="_blank"
              rel="noreferrer"
              onClick={() => trackEvent("tutorials_link_clicked", { source: `howto_${source}` })}
              className="ml-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-medium text-inkMuted hover:bg-creamDeep hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
            >
              <GraduationCap className="h-4 w-4" aria-hidden /> All tutorials
            </a>
            <button
              type="button"
              aria-label="Close video"
              onClick={close}
              className="flex h-8 w-8 items-center justify-center rounded-full text-inkMuted hover:bg-creamDeep hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
          {failed ? (
            <div className="flex aspect-video w-full items-center justify-center bg-black px-6 text-center text-[14px] text-white/80">
              The video didn&apos;t load. Check your connection, then open it again.
            </div>
          ) : (
            <video
              src={HOWTO_VIDEO_SRC}
              poster={HOWTO_VIDEO_POSTER}
              controls
              autoPlay
              playsInline
              preload="metadata"
              className="block aspect-video w-full bg-black"
              onPlay={markHowToSeen}
              onTimeUpdate={(e) => {
                const v = e.currentTarget;
                if (v.duration > 0) report((v.currentTime / v.duration) * 100);
              }}
              onEnded={() => report(100)}
              onError={() => setFailed(true)}
            />
          )}
          {onStart && (
          <div className="flex flex-wrap items-center gap-3 px-5 py-3">
            <span className="text-[14px] text-inkMuted">
              Start by connecting your messaging apps and your favorite tools.
            </span>
            <button
              type="button"
              onClick={() => {
                trackEvent("howto_video_cta", { target: "messaging", watched_pct: Math.round(watched.current), source });
                onStart();
              }}
              className={cx(
                "ml-auto inline-flex h-10 items-center rounded-full bg-ink px-4 text-[14px] font-semibold text-cream hover:opacity-90",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30",
              )}
            >
              Open Messaging
            </button>
          </div>
          )}
        </div>
      </div>
    </Dialog>,
    document.body,
  );
}
