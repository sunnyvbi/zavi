"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, Mic, Pause, Play, Square, X } from "lucide-react";

import { type DictationChunk, useDictation } from "@/lib/voice/useDictation";
import { useAudioLevels } from "@/lib/voice/useAudioLevels";
import styles from "./MicButton.module.css";

const WAVE_BARS = 56;
const WAVE_MIN_BARS = 16;
const WAVE_BAR_PITCH = 5;

export function waveBarCount(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return WAVE_BARS;
  return Math.max(WAVE_MIN_BARS, Math.floor((width + 3) / WAVE_BAR_PITCH));
}

function useWaveBarCount(el: HTMLElement | null): number {
  const [count, setCount] = useState(WAVE_BARS);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = (width: number) => {
      const next = waveBarCount(width);
      setCount((prev) => (prev === next ? prev : next));
    };
    measure(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) measure(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return count;
}

type Phase = "idle" | "recording" | "paused" | "stopped";

const PHASE_LABEL: Record<Exclude<Phase, "idle">, string> = {
  recording: "Recording",
  paused: "Paused",
  stopped: "Stopped",
};

interface MicButtonProps {
  onTranscript: (transcript: string) => void;
  className?: string;
  compact?: boolean;
  onActiveChange?: (active: boolean) => void;
  icon?: ReactNode;
  disabled?: boolean;
  showUnsupported?: boolean;
}

export function MicButton({
  onTranscript,
  className,
  compact = false,
  onActiveChange,
  icon,
  disabled = false,
  showUnsupported = false,
}: MicButtonProps) {
  const completedRef = useRef<string[]>([]);
  const interimRef = useRef("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState("");
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const transcriptRef = useRef<HTMLParagraphElement | null>(null);
  const [waveEl, setWaveEl] = useState<HTMLDivElement | null>(null);
  const waveBars = useWaveBarCount(waveEl);

  const readTranscript = () =>
    [...completedRef.current, interimRef.current]
      .filter(Boolean)
      .join(" ")
      .trim();

  const captureChunk = useCallback((chunk: DictationChunk) => {
    if (chunk.isFinal) {
      completedRef.current.push(chunk.transcript);
      interimRef.current = "";
    } else {
      interimRef.current = chunk.transcript;
    }
    setPreview(
      [...completedRef.current, interimRef.current].filter(Boolean).join(" "),
    );
  }, []);

  const dictation = useDictation(captureChunk);
  const active = phase !== "idle";
  const levels = useAudioLevels({
    enabled: phase === "recording" || phase === "paused",
    paused: phase !== "recording",
    bars: waveBars,
  });

  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  useEffect(() => () => onActiveChange?.(false), [onActiveChange]);

  const wasListening = useRef(false);
  useEffect(() => {
    if (wasListening.current && !dictation.listening && phase === "recording") {
      setPhase("paused");
    }
    wasListening.current = dictation.listening;
  }, [dictation.listening, phase]);

  useLayoutEffect(() => {
    const line = transcriptRef.current;
    if (!line) return;
    const overflowing = line.scrollWidth > line.clientWidth;
    line.dataset.overflowing = overflowing ? "true" : "false";
    line.scrollLeft = overflowing ? line.scrollWidth : 0;
  }, [preview]);

  useEffect(() => {
    if (active) primaryRef.current?.focus();
  }, [active, phase]);

  const clearCapture = () => {
    completedRef.current = [];
    interimRef.current = "";
    setPreview("");
  };

  const start = () => {
    clearCapture();
    setPhase("recording");
    dictation.start();
  };

  const pause = async () => {
    setPhase("paused");
    await dictation.stop();
  };

  const resume = () => {
    setPhase("recording");
    dictation.start();
  };

  const stop = async () => {
    setPhase("stopped");
    await dictation.stop();
  };

  const cancel = () => {
    dictation.cancel();
    clearCapture();
    setPhase("idle");
  };

  const confirm = async () => {
    await dictation.stop();
    const transcript = readTranscript();
    clearCapture();
    setPhase("idle");
    if (transcript) onTranscript(transcript);
  };

  const label = !dictation.supported
    ? "Dictation is not supported in this browser"
    : (dictation.error ?? "Start dictation");

  const idleButton = (
    <button
      type="button"
      onClick={start}
      disabled={disabled || !dictation.supported}
      aria-label={label}
      title={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/35 disabled:cursor-not-allowed disabled:opacity-40 ${
        dictation.error
          ? "bg-transparent text-amber-700 ring-1 ring-amber-300 hover:bg-amber-50"
          : "bg-transparent text-inkLight hover:bg-bone hover:text-ink"
      } ${className ?? ""}`}
    >
      {icon ?? <Mic aria-hidden className="h-[18px] w-[18px]" strokeWidth={1.6} />}
    </button>
  );

  if (!active) {
    if (compact) return idleButton;
    return (
      <div className="inline-flex items-center gap-2">
        {idleButton}
        {dictation.error && (
          <span role="alert" className="text-xs text-amber-700">
            {dictation.error}
          </span>
        )}
        {showUnsupported && !dictation.supported && !dictation.error && (
          <span data-testid="dictation-unsupported" className="max-w-[9rem] text-xs leading-4 text-inkMuted sm:max-w-none">
            Dictation is not supported in this browser
          </span>
        )}
      </div>
    );
  }

  const status = PHASE_LABEL[phase];
  const control =
    "grid h-9 w-9 place-items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/35";

  return (
    <>
      <span aria-hidden="true" className="h-8 w-px shrink-0" />
      <div
        role="group"
        aria-label={`Voice input, ${status.toLowerCase()}`}
        title={dictation.error ?? undefined}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            cancel();
          }
        }}
        className={`absolute inset-1.5 z-20 flex flex-col justify-center overflow-hidden rounded-[12px] px-3 py-2.5 ${styles.dictationSurface} ${className ?? ""}`}
      >
        <span role="status" aria-live="polite" className="sr-only">
          {dictation.error ?? status}
        </span>
        {dictation.error && (
          <p
            data-testid="dictation-error"
            aria-hidden="true"
            className="mb-1 min-w-0 line-clamp-2 text-[12px] font-medium leading-4 text-amber-700"
          >
            {dictation.error}
          </p>
        )}
        {preview && (
          <p
            ref={transcriptRef}
            data-testid="dictation-transcript"
            className={`mb-1 min-w-0 overflow-hidden whitespace-nowrap text-left text-[13px] text-inkMuted ${styles.transcript}`}
          >
            {}
            <span data-testid="dictation-transcript-text" className="inline-block pr-12">
              {preview}
            </span>
          </p>
        )}
        <div className="flex min-w-0 items-center gap-3">
          <div
            ref={setWaveEl}
            data-testid="dictation-wave"
            data-phase={phase}
            aria-hidden="true"
            className={styles.waveform}
          >
            {levels.map((level, index) => (
              <span
                key={index}
                className={styles.waveBar}
                style={{
                  height: `${Math.max(2, Math.round(level * 28))}px`,
                  animationDelay: `${(index - levels.length) * 45}ms`,
                }}
              />
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={cancel}
              aria-label="Cancel voice input"
              title="Cancel"
              className={`${control} ${styles.cancelButton}`}
            >
              <X aria-hidden className="h-[18px] w-[18px]" strokeWidth={1.5} />
            </button>
            {phase === "recording" && (
              <button
                ref={primaryRef}
                type="button"
                onClick={() => void pause()}
                aria-label="Pause recording"
                title="Pause"
                className={`${control} ${styles.secondaryButton}`}
              >
                <Pause
                  aria-hidden
                  className="h-[18px] w-[18px]"
                  strokeWidth={1.6}
                />
              </button>
            )}
            {phase === "paused" && (
              <button
                ref={primaryRef}
                type="button"
                onClick={resume}
                aria-label="Resume recording"
                title="Resume"
                className={`${control} ${styles.secondaryButton}`}
              >
                <Play
                  aria-hidden
                  className="h-[18px] w-[18px]"
                  strokeWidth={1.6}
                />
              </button>
            )}
            {phase !== "stopped" && (
              <button
                type="button"
                onClick={() => void stop()}
                aria-label="Stop recording"
                title="Stop"
                className={`${control} ${styles.secondaryButton}`}
              >
                <Square aria-hidden className="h-4 w-4" strokeWidth={1.8} />
              </button>
            )}
            <button
              ref={phase === "stopped" ? primaryRef : undefined}
              type="button"
              onClick={() => void confirm()}
              aria-label="Confirm and insert transcript"
              title="Confirm"
              className={`${control} hover:scale-[1.04] active:scale-95 ${styles.confirmButton}`}
            >
              <Check aria-hidden className="h-5 w-5" strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
