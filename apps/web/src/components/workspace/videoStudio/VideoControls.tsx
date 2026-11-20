"use client";

import { type RefObject, useEffect, useState } from "react";
import { Maximize, Minimize, Volume2, VolumeX } from "lucide-react";
import { cx, FOCUS_RING } from "../layout/shared";
import { PauseIcon, PlayIcon } from "./libraryIcons";

export const FULLSCREEN_FIT =
  "[&:fullscreen>video]:h-full [&:fullscreen>video]:max-h-none [&:fullscreen>video]:w-full [&:fullscreen>video]:rounded-none [&:fullscreen>video]:object-contain";

const ROUND = "grid place-items-center rounded-full bg-cream/90 text-ink transition hover:bg-cream";

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function VideoControls({ video, title, bar = true }: { video: RefObject<HTMLVideoElement | null>; title: string; bar?: boolean }) {
  const [paused, setPaused] = useState(() => video.current?.paused ?? true);
  const [current, setCurrent] = useState(() => video.current?.currentTime ?? 0);
  const [duration, setDuration] = useState(() => video.current?.duration ?? 0);
  const [muted, setMuted] = useState(() => video.current?.muted ?? false);
  const [full, setFull] = useState(false);

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const sync = () => {
      setPaused(el.paused);
      setCurrent(el.currentTime);
      setDuration(Number.isFinite(el.duration) ? el.duration : 0);
      setMuted(el.muted);
    };
    const toggle = () => {
      if (el.paused) void el.play()?.catch(() => undefined);
      else el.pause();
    };
    const onFull = () => setFull(document.fullscreenElement === el.parentElement);
    const events = ["play", "pause", "timeupdate", "durationchange", "loadedmetadata", "volumechange", "seeked", "ended"];
    sync();
    events.forEach((e) => el.addEventListener(e, sync));
    el.addEventListener("click", toggle);
    document.addEventListener("fullscreenchange", onFull);
    return () => {
      events.forEach((e) => el.removeEventListener(e, sync));
      el.removeEventListener("click", toggle);
      document.removeEventListener("fullscreenchange", onFull);
    };
  }, [video]);

  const playPause = () => {
    const el = video.current;
    if (!el) return;
    if (el.paused) void el.play()?.catch(() => undefined);
    else el.pause();
  };
  const seek = (value: number) => {
    const el = video.current;
    if (!el) return;
    el.currentTime = value;
    setCurrent(value);
  };
  const toggleMute = () => {
    const el = video.current;
    if (!el) return;
    el.muted = !el.muted;
    setMuted(el.muted);
  };
  const toggleFull = () => {
    const el = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    const box = el?.parentElement;
    if (!el || !box) return;
    if (document.fullscreenElement) void document.exitFullscreen?.()?.catch(() => undefined);
    else if (document.fullscreenEnabled && box.requestFullscreen) void box.requestFullscreen()?.catch(() => undefined);
    else el.webkitEnterFullscreen?.();
  };
  const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;

  return (
    <>
      {paused && (
        <button
          type="button"
          onClick={playPause}
          aria-label={`Play ${title}`}
          className={cx(ROUND, "absolute left-1/2 top-1/2 size-11 -translate-x-1/2 -translate-y-1/2", FOCUS_RING)}
        >
          <PlayIcon className="h-5 w-5" />
        </button>
      )}
      {bar && (
        <div
          data-testid="video-controls"
          className="absolute inset-x-0 bottom-0 flex flex-col gap-1.5 rounded-b-[inherit] bg-gradient-to-t from-black/70 via-black/30 to-transparent px-3 pb-2.5 pt-8"
        >
          <div data-testid="video-seek-row" className="relative flex h-4 w-full min-w-[120px] items-center rounded-full focus-within:ring-2 focus-within:ring-white/70">
            <div aria-hidden className="h-1 w-full overflow-hidden rounded-full bg-white/30">
              <div className="h-full rounded-full bg-white" style={{ width: `${pct}%` }} />
            </div>
            <input
              type="range"
              aria-label="Seek"
              aria-valuetext={`${clock(current)} of ${clock(duration)}`}
              min={0}
              max={duration || 0}
              step="any"
              value={Math.min(current, duration || 0)}
              onChange={(e) => seek(Number(e.target.value))}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
          </div>
          <span data-testid="video-time" className="w-full whitespace-nowrap text-[12px] font-semibold tabular-nums leading-4 text-white">
            {clock(current)} / {clock(duration)}
          </span>
          <div data-testid="video-button-row" className="flex items-center gap-2">
            <button type="button" onClick={playPause} aria-label={paused ? "Play" : "Pause"} className={cx(ROUND, "size-8 shrink-0", FOCUS_RING)}>
              {paused ? <PlayIcon className="h-4 w-4" /> : <PauseIcon className="h-4 w-4" />}
            </button>
            <span aria-hidden className="min-w-0 flex-1" />
            <button type="button" onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"} className={cx(ROUND, "size-8 shrink-0", FOCUS_RING)}>
              {muted ? <VolumeX className="h-4 w-4" aria-hidden /> : <Volume2 className="h-4 w-4" aria-hidden />}
            </button>
            <button
              type="button"
              onClick={toggleFull}
              aria-label={full ? "Exit full screen" : "Full screen"}
              className={cx(ROUND, "size-8 shrink-0", FOCUS_RING)}
            >
              {full ? <Minimize className="h-4 w-4" aria-hidden /> : <Maximize className="h-4 w-4" aria-hidden />}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
