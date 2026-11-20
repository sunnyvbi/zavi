"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { inter, jakarta, jbmono } from "@/fonts";

type Step = {
  phase: string;
  hold: number;
};

const STEPS: Step[] = [
  { phase: "Operator asks", hold: 2600 },
  { phase: "Reading the repo", hold: 2800 },
  { phase: "Drafting the fix", hold: 2800 },
  { phase: "Typed output envelope", hold: 3000 },
  { phase: "Landed in Needs you", hold: 3000 },
  { phase: "Approved · shipped", hold: 3400 },
];

function StatusDot({ live }: { live: boolean }) {
  return (
    <span className="relative flex size-2 shrink-0" aria-hidden>
      {live && (
        <span className="absolute inset-0 rounded-full bg-[#34d399] opacity-75 motion-safe:animate-ping" />
      )}
      <span
        className={`relative size-2 rounded-full ${live ? "bg-[#10b981]" : "bg-[#a3a3a3]"}`}
      />
    </span>
  );
}

function agentLine(step: number): React.ReactNode {
  if (step <= 1) {
    return (
      <span className="inline-flex items-center gap-2">
        Reading{" "}
        <code className="font-[family-name:var(--font-jbmono)] text-[12px] text-[#0a0a0a]">
          tripPriceHelpers.ts
        </code>
        <Dots />
      </span>
    );
  }
  if (step === 2) {
    return (
      <span className="inline-flex items-center gap-2">
        Found the asymmetric-drift bug · drafting a fix
        <Dots />
      </span>
    );
  }
  return (
    <>
      Found it in{" "}
      <code className="font-[family-name:var(--font-jbmono)] text-[12px] text-[#0a0a0a]">
        tripPriceHelpers.ts
      </code>
      . Drafted a 6-line fix + $493 refund.
    </>
  );
}

function Transcript({ step }: { step: number }) {
  return (
    <div className="flex flex-col gap-2">
      {}
      <div className="flex justify-end">
        <div className="max-w-[88%] rounded-2xl rounded-br-md bg-[#171717] px-3.5 py-2 text-[13px] leading-[18px] tracking-[-0.1px] text-white">
          A host got overcharged $493 on trip 10583. What happened?
        </div>
      </div>

      {}
      {step >= 1 && (
        <div className="flex justify-start">
          <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-[#ececec] bg-[#fafafa] px-3.5 py-2 text-[13px] leading-[18px] tracking-[-0.1px] text-[#525252]">
            <span className="mb-0.5 block font-[family-name:var(--font-jbmono)] text-[11px] uppercase tracking-[1.4px] text-[#10b981]">
              engineer
            </span>
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={step <= 1 ? "read" : step === 2 ? "draft" : "done"}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.25 }}
                className="block"
              >
                {agentLine(step)}
              </motion.span>
            </AnimatePresence>
          </div>
        </div>
      )}
    </div>
  );
}

function Dots() {
  return (
    <span className="inline-flex gap-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="size-1 rounded-full bg-[#a3a3a3]"
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ duration: 1, repeat: Infinity, delay: i * 0.18 }}
        />
      ))}
    </span>
  );
}

function Envelope({ step }: { step: number }) {
  if (step < 3) return null;
  const approved = step >= 5;
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="rounded-xl border border-[#e5e5e5] bg-white p-3 shadow-[0_8px_24px_-12px_rgba(16,18,20,0.18)]"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-[family-name:var(--font-jbmono)] text-[11px] uppercase tracking-[1.4px] text-[#737373]">
          Output envelope · needs_approval
        </span>
        <StatusDot live={!approved} />
      </div>

      <p className="font-[family-name:var(--font-jakarta)] text-[16px] font-semibold leading-[19px] text-[#0a0a0a]">
        Fix $493 overcharge on trip 10583
      </p>
      <p className="mt-0.5 font-[family-name:var(--font-inter)] text-[12px] leading-[17px] text-[#525252]">
        PR: asymmetric-drift guard in{" "}
        <code className="font-[family-name:var(--font-jbmono)] text-[11px]">tripPriceHelpers.ts</code>{" "}
        · refund $493 to host.
      </p>

      {}
      <div className="mt-2.5 flex items-center gap-2 border-t border-[#f0f0f0] pt-2.5">
        <AnimatePresence mode="wait" initial={false}>
          {approved ? (
            <motion.span
              key="approved"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.3 }}
              className="inline-flex items-center gap-2 rounded-full bg-[#ecfdf5] px-2.5 py-1 font-[family-name:var(--font-jbmono)] text-[11px] font-medium uppercase tracking-[1.2px] text-[#047857]"
            >
              <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
                <path
                  d="M3.5 8.5l3 3 6-7"
                  fill="none"
                  stroke="#047857"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Approved · shipped + refunded
            </motion.span>
          ) : (
            <motion.div
              key="pending"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="flex items-center gap-2"
            >
              <span className="inline-flex h-7 items-center rounded-full bg-[#171717] px-3 text-[12px] font-medium tracking-[-0.1px] text-white">
                Approve
              </span>
              <span className="inline-flex h-7 items-center rounded-full border border-[#d4d4d4] bg-white px-3 text-[12px] font-medium tracking-[-0.1px] text-[#525252]">
                Revise
              </span>
              <span className="ml-auto font-[family-name:var(--font-jbmono)] text-[11px] uppercase tracking-[1.4px] text-[#737373]">
                in Needs you
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

export function HeroAgentDemo() {
  const reduceMotion = useReducedMotion();
  const [step, setStep] = useState(reduceMotion ? STEPS.length - 1 : 0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (reduceMotion) {
      setStep(STEPS.length - 1);
      return;
    }
    timer.current = setTimeout(
      () => setStep((s) => (s + 1) % STEPS.length),
      STEPS[step].hold,
    );
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [step, reduceMotion]);

  const active = STEPS[step];

  return (
    <div
      className={`${inter.variable} ${jbmono.variable} ${jakarta.variable} relative flex min-h-[440px] w-full flex-col overflow-hidden rounded-3xl border border-neutral-200 bg-white/70 p-4 shadow-2xl shadow-neutral-300/40 backdrop-blur-md`}
    >
      {}
      <div
        className="absolute inset-0 -z-0 opacity-40"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(0,0,0,0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(0,0,0,0.05) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
        }}
      />

      {}
      <div className="relative mb-3 flex items-center justify-between">
        <span className="font-[family-name:var(--font-jbmono)] text-[11px] uppercase tracking-[1.8px] text-neutral-500">
          Sample run · real shapes
        </span>
        <span className="flex items-center gap-2 text-[11px] text-neutral-700">
          <StatusDot live={!reduceMotion && step < STEPS.length - 1} />
          <span aria-live="polite">{active.phase}</span>
        </span>
      </div>

      {}
      <div className="relative mb-3.5 flex gap-2" aria-hidden>
        {STEPS.map((_, i) => (
          <span
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
              i <= step ? "bg-[#171717]" : "bg-[#e5e5e5]"
            }`}
          />
        ))}
      </div>

      {}
      <div className="relative flex flex-1 flex-col gap-2.5">
        <Transcript step={step} />
        <Envelope step={step} />
      </div>
    </div>
  );
}
