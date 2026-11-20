"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

const LINE = "Marketing you switch on";
const WORDS = ["founders", "e-commerce", "coaches", "local shops"];

const TYPE_MS = 55;
const TOGGLE_IN_MS = 120;
const TOGGLE_ON_MS = 250;
const WORD_IN_MS = 200;
const ROTATE_MS = 2200;

const LABEL = `${LINE} for ${WORDS.slice(0, -1).join(", ")} and ${WORDS[WORDS.length - 1]}`;

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReduced(onChange: () => void) {
  const mq = window.matchMedia(REDUCED_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function usePrefersReducedMotion() {
  return useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia(REDUCED_QUERY).matches,
    () => false,
  );
}

function Toggle({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`zavi-auto-pop relative mx-[0.24em] inline-block h-[0.52em] w-[0.92em] rounded-full align-middle transition-colors duration-300 ${
        on ? "bg-[#34c759]" : "bg-[#d9d9de]"
      }`}
    >
      <span
        className={`absolute left-[0.05em] top-[0.05em] h-[0.42em] w-[0.42em] rounded-full bg-white shadow-[0_0.02em_0.06em_rgba(0,0,0,0.25)] transition-transform duration-300 ease-[cubic-bezier(0.3,1.3,0.5,1)] ${
          on ? "translate-x-[0.4em]" : ""
        }`}
      />
    </span>
  );
}

function WordSlot({ index, previous }: { index: number; previous: number | null }) {
  const measure = useRef<HTMLSpanElement | null>(null);
  const [width, setWidth] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    if (measure.current) setWidth(measure.current.offsetWidth);
  }, [index]);

  return (
    <span
      className="relative ml-[0.06em] inline-block whitespace-nowrap text-left transition-[width] duration-500 ease-[cubic-bezier(0.645,0.045,0.355,1)]"
      style={{ width }}
    >
      {previous !== null && previous !== index && (
        <span key={`out-${previous}`} className="zavi-auto-word-out absolute left-0 top-0">
          {WORDS[previous]}
        </span>
      )}
      <span key={`in-${index}`} className="zavi-auto-word-in inline-block">
        {WORDS[index]}
      </span>
      <span ref={measure} aria-hidden="true" className="invisible absolute left-0 top-0">
        {WORDS[index]}
      </span>
    </span>
  );
}

export function GrowthAutopilot() {
  const reduced = usePrefersReducedMotion();
  const [typed, setTyped] = useState(0);
  const [stage, setStage] = useState(0);
  const [word, setWord] = useState(0);
  const [prevWord, setPrevWord] = useState<number | null>(null);

  useEffect(() => {
    if (reduced) return;
    const timers: number[] = [];
    let n = 0;
    const tick = () => {
      n += 1;
      setTyped(n);
      if (n < LINE.length) {
        timers.push(window.setTimeout(tick, TYPE_MS));
        return;
      }
      timers.push(
        window.setTimeout(() => {
          setStage(1);
          timers.push(
            window.setTimeout(() => {
              setStage(2);
              timers.push(window.setTimeout(() => setStage(3), WORD_IN_MS));
            }, TOGGLE_ON_MS),
          );
        }, TOGGLE_IN_MS),
      );
    };
    timers.push(window.setTimeout(tick, TYPE_MS));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [reduced]);

  useEffect(() => {
    if (reduced || stage < 3) return;
    const t = window.setTimeout(() => {
      setPrevWord(word);
      setWord((w) => (w + 1) % WORDS.length);
    }, ROTATE_MS);
    return () => window.clearTimeout(t);
  }, [stage, word, reduced]);

  const shown = reduced ? LINE : LINE.slice(0, typed);
  const done = reduced || stage >= 3;

  return (
    <section className="w-full bg-white pb-8 pt-14 sm:py-20 lg:py-28">
      <div className="mx-auto w-full max-w-[1480px] px-6">
        <h2
          aria-label={LABEL}
          className="min-h-[1.15em] text-center text-[clamp(1.75rem,4.2vw,4rem)] font-bold leading-[1.15] tracking-[-0.03em] text-[#0e0f11] sm:whitespace-nowrap"
        >
          <span aria-hidden="true">
            {shown}
            {!reduced && stage === 0 && (
              <span className="zavi-auto-caret ml-[0.04em] inline-block h-[0.9em] w-[0.06em] translate-y-[0.12em] rounded-full bg-current" />
            )}
            {(reduced || stage >= 1) && <Toggle on={reduced || stage >= 2} />}
            {done && (
              <>
                <span className="zavi-auto-fade">for </span>
                <WordSlot index={word} previous={prevWord} />
              </>
            )}
          </span>
        </h2>
      </div>
    </section>
  );
}
