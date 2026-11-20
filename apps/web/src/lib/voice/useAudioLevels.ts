"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const MIN_LEVEL = 0.08;

export function fitLevels(levels: readonly number[], bars: number): number[] {
  const size = Math.max(0, Math.floor(bars));
  if (levels.length >= size) return levels.slice(levels.length - size);
  return [...Array.from({ length: size - levels.length }, () => MIN_LEVEL), ...levels];
}

export function useAudioLevels({
  enabled,
  paused,
  bars,
}: {
  enabled: boolean;
  paused: boolean;
  bars: number;
}) {
  const [levels, setLevels] = useState<number[]>(() =>
    Array.from({ length: bars }, () => MIN_LEVEL),
  );
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const barsRef = useRef(bars);
  barsRef.current = bars;

  useEffect(() => {
    if (!enabled) {
      setLevels(Array.from({ length: barsRef.current }, () => MIN_LEVEL));
      return;
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      return;
    }
    let cancelled = false;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let frame = 0;

    const run = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      let history: number[] = Array.from({ length: barsRef.current }, () => MIN_LEVEL);
      const tick = () => {
        if (cancelled) return;
        if (!pausedRef.current) {
          analyser.getByteTimeDomainData(samples);
          let sum = 0;
          for (let i = 0; i < samples.length; i += 1) {
            const centered = (samples[i] - 128) / 128;
            sum += centered * centered;
          }
          const rms = Math.sqrt(sum / samples.length);
          history = fitLevels([...history, Math.max(MIN_LEVEL, Math.min(1, rms * 4))], barsRef.current);
          setLevels(history);
        }
        frame = window.requestAnimationFrame(tick);
      };
      frame = window.requestAnimationFrame(tick);
    };
    void run();

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close().catch(() => {});
    };
  }, [enabled]);

  return useMemo(() => fitLevels(levels, bars), [levels, bars]);
}
