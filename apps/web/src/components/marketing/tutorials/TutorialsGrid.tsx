"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Clock, PlayCircle, X } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { trackEvent } from "@/lib/analytics/events";
import {
  formatDuration,
  isPlayable,
  tutorialAssetUrl,
  tutorialsByGroup,
  type Tutorial,
} from "@/lib/tutorials";
import { FOCUS } from "@/components/marketing/growth-home/growthUi";

const MARKS = [25, 50, 100] as const;
const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;

const POSTER_HUES = [
  ["#dce7ff", "#b9cdff", "#16337a", "#4f7cff"],
  ["#ffe1dc", "#ffc4cf", "#7d1f3c", "#ff6f61"],
  ["#d9f3e6", "#b5e6cd", "#0f4f33", "#1fb97a"],
  ["#e9e2ff", "#d3c4ff", "#3c2394", "#8a6bff"],
  ["#fff0d6", "#ffd9a3", "#6e4205", "#e8920f"],
  ["#e4f4ff", "#bfe3fb", "#0d4a6e", "#2bb0ef"],
] as const;

function Poster({ t }: { t: Tutorial }) {
  const [light, deep, ink, accent] = POSTER_HUES[(t.number - 1) % POSTER_HUES.length];
  const Icon = t.poster.icon;
  return (
    <span
      className="relative block aspect-video w-full overflow-hidden rounded-[14px] text-left"
      style={{ background: `radial-gradient(120% 120% at 85% 90%, ${deep}, ${light} 70%)`, color: ink }}
    >
      <span className="absolute left-4 top-3.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] opacity-80">
        Tutorial {t.number}
      </span>
      <span className="absolute left-4 right-[44%] top-8 text-[22px] font-extrabold leading-[1.05] tracking-[-0.02em] max-[380px]:text-[18px]">
        {t.poster.title}
      </span>
      {t.poster.screen ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={t.poster.screen}
          alt=""
          loading="lazy"
          className="absolute -bottom-3.5 left-4 w-[54%] -rotate-3 rounded-lg bg-white shadow-[0_0_0_3px_#1f6bff,0_14px_30px_-8px_rgba(0,0,0,0.35)]"
        />
      ) : (
        <span
          aria-hidden="true"
          className="absolute bottom-4 left-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-white max-[380px]:bottom-3 max-[380px]:h-10 max-[380px]:w-10 max-[380px]:rounded-xl shadow-[0_0_0_3px_rgba(255,255,255,0.5),0_10px_24px_-8px_rgba(0,0,0,0.3)]"
          style={{ color: accent }}
        >
          <Icon className="h-7 w-7 max-[380px]:h-5 max-[380px]:w-5" />
        </span>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/mascots/poses/zavi-${t.poster.pose}.webp`}
        alt=""
        loading="lazy"
        className="absolute -bottom-[14%] -right-[4%] h-[92%] w-auto drop-shadow-[0_10px_18px_rgba(0,0,0,0.25)]"
      />
      {isPlayable(t) ? (
        <PlayCircle
          aria-hidden="true"
          className="absolute right-3 top-2.5 h-9 w-9 text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.45)]"
        />
      ) : (
        <span className="absolute right-2 top-2 rounded-full bg-white/90 px-2.5 py-1 text-[12px] font-semibold text-[#595959]">
          Coming soon
        </span>
      )}
    </span>
  );
}

function CardBody({ t }: { t: Tutorial }) {
  const duration = formatDuration(t.durationSec);
  return (
    <>
      <Poster t={t} />
      <span className="mt-4 flex items-center gap-2 text-[13px] font-medium text-[#595959]">
        <span>#{t.number}</span>
        {duration && (
          <span className="inline-flex items-center gap-1">
            <Clock aria-hidden="true" className="h-3.5 w-3.5" />
            {duration}
          </span>
        )}
      </span>
      <span className="mt-2 text-[17px] font-semibold leading-snug text-[#0e0f11]">{t.title}</span>
      <span className="mt-1.5 text-[14px] leading-relaxed text-[#595959]">{t.description}</span>
    </>
  );
}

const CARD =
  "flex h-full w-full flex-col rounded-block border border-black/[0.08] bg-white p-4 text-left shadow-[0_1px_2px_rgba(16,18,20,0.04)]";

function TutorialCard({ t, onOpen }: { t: Tutorial; onOpen: (t: Tutorial) => void }) {
  if (!isPlayable(t)) {
    return (
      <div className={CARD} aria-label={`${t.title} (coming soon)`}>
        <CardBody t={t} />
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(t)}
      className={`${CARD} transition-shadow duration-200 hover:shadow-[0_24px_60px_-30px_rgba(16,18,20,0.35)] ${FOCUS}`}
    >
      <CardBody t={t} />
    </button>
  );
}

function TutorialPlayer({
  t,
  startHref,
  speed,
  onSpeed,
  onClose,
}: {
  t: Tutorial;
  startHref: string;
  speed: number;
  onSpeed: (s: number) => void;
  onClose: () => void;
}) {
  const reported = useRef(new Set<number>());
  const watched = useRef(0);
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const props = { slug: t.slug, number: t.number, tier: t.tier };

  useEffect(() => {
    trackEvent("tutorial_card_opened", { slug: t.slug, number: t.number, tier: t.tier });
  }, [t.slug, t.number, t.tier]);

  const report = (pct: number) => {
    watched.current = Math.max(watched.current, pct);
    for (const m of MARKS) {
      if (pct >= m && !reported.current.has(m)) {
        reported.current.add(m);
        trackEvent("tutorial_progress", { ...props, pct: m });
      }
    }
  };

  const close = () => {
    trackEvent("tutorial_closed", { ...props, watched_pct: Math.round(watched.current) });
    onClose();
  };

  return (
    <Dialog id="tutorial-video" label={t.title} onClose={close}>
      <div
        className="flex h-full w-full items-center justify-center bg-black/60 p-4"
        onClick={(e) => e.target === e.currentTarget && close()}
      >
        <div className="flex w-full max-w-[1040px] flex-col overflow-hidden rounded-2xl bg-white shadow-[0_24px_60px_-20px_rgba(0,0,0,0.5)]">
          <div className="flex items-center gap-3 px-5 py-3">
            <h2 className="min-w-0 text-[16px] font-semibold text-[#0e0f11]">
              {t.number}. {t.title}
            </h2>
                <button
              type="button"
              aria-label="Close video"
              onClick={close}
              className={`ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#595959] hover:bg-[#f3f3f4] hover:text-[#0e0f11] ${FOCUS}`}
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
              ref={videoRef}
              src={tutorialAssetUrl(t.videoUrl)}
              poster={tutorialAssetUrl(t.posterUrl)}
              controls
              autoPlay
              playsInline
              preload="metadata"
              className="block aspect-video w-full bg-black"
              onTimeUpdate={(e) => {
                const v = e.currentTarget;
                if (v.duration > 0) report((v.currentTime / v.duration) * 100);
              }}
              onLoadedMetadata={(e) => {
                e.currentTarget.playbackRate = speed;
              }}
              onEnded={() => report(100)}
              onError={() => setFailed(true)}
            />
          )}
          <div className="flex flex-wrap items-center gap-3 px-5 py-3">
            {!failed && (
              <div role="group" aria-label="Playback speed" className="flex items-center gap-1">
                {SPEEDS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={speed === s}
                    onClick={() => {
                      onSpeed(s);
                      if (videoRef.current) videoRef.current.playbackRate = s;
                    }}
                    className={`h-8 min-w-10 rounded-full px-2 text-[13px] font-semibold ${
                      speed === s ? "bg-[#0e0f11] text-white" : "text-[#595959] hover:bg-[#f3f3f4] hover:text-[#0e0f11]"
                    } ${FOCUS}`}
                  >
                    {s}x
                  </button>
                ))}
              </div>
            )}
            <span className="text-[14px] text-[#595959]">Try it on your own business.</span>
            <Link
              href={startHref}
              prefetch={false}
              onClick={() => trackEvent("tutorial_cta", { ...props, watched_pct: Math.round(watched.current) })}
              className={`ml-auto inline-flex h-10 items-center rounded-full bg-[#0e0f11] px-4 text-[14px] font-semibold text-white hover:opacity-90 ${FOCUS}`}
            >
              Open Zavi
            </Link>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

export function TutorialsGrid({ startHref }: { startHref: string }) {
  const [open, setOpen] = useState<Tutorial | null>(null);
  const [speed, setSpeed] = useState(1);
  return (
    <>
      <div className="mx-auto w-full max-w-[1200px] px-6">
        {tutorialsByGroup().map((g) => (
          <section key={g.id} id={g.id} aria-labelledby={`tutorials-${g.id}`} className="py-8 first:pt-0">
            <h2 id={`tutorials-${g.id}`} className="text-[24px] font-bold tracking-[-0.01em] text-[#0e0f11]">
              {g.title}
            </h2>
            <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {g.items.map((t) => (
                <li key={t.slug}>
                  <TutorialCard t={t} onOpen={setOpen} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {open && <TutorialPlayer t={open} startHref={startHref} speed={speed} onSpeed={setSpeed} onClose={() => setOpen(null)} />}
    </>
  );
}
