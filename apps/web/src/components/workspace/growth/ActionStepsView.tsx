"use client";

import { useState } from "react";
import { actionSteps, type DoStep } from "./actionSteps";

const LABEL = "mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-inkMuted";

function Step({ step }: { step: DoStep }) {
  if ("text" in step) return <p>{step.text}</p>;
  return (
    <p className="flex flex-wrap items-center gap-1">
      {step.prefix && <span className="mr-1">{step.prefix}</span>}
      {step.path.map((seg, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && (
            <span aria-hidden="true" className="text-inkMuted">
              ›
            </span>
          )}
          <span className="rounded-md bg-creamDeep px-1.5 py-0.5 text-[12px] font-medium text-ink">{seg}</span>
        </span>
      ))}
    </p>
  );
}

function Box({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-rule px-3 py-2.5">
      <span className={LABEL}>{label}</span>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

export function ActionStepsView({ text }: { text: string | null | undefined }) {
  const [whyOpen, setWhyOpen] = useState(false);
  const steps = actionSteps(text);
  if (steps.kind === "plain") {
    if (steps.lines.length === 0) return null;
    return (
      <div className="space-y-1 text-inkSoft">
        {steps.lines.map((line, i) => (
          <p key={i}>{line}</p>
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <Box label="Do">
        {steps.do.map((s, i) => (
          <Step key={i} step={s} />
        ))}
        {}
        {steps.notes.map((s, i) => (
          <p key={`n${i}`} className="font-medium text-ink">
            {`Note: ${s}`}
          </p>
        ))}
      </Box>
      {steps.check.length > 0 && (
        <Box label="Check">
          {steps.check.map((s, i) => (
            <p key={i}>{s}</p>
          ))}
        </Box>
      )}
      {steps.dont.length > 0 && (
        <Box label="Don't">
          {steps.dont.map((s, i) => (
            <p key={i}>{s}</p>
          ))}
        </Box>
      )}
      {steps.why.length > 0 && (
        <div>
          <button
            type="button"
            aria-expanded={whyOpen}
            onClick={() => setWhyOpen((v) => !v)}
            className="text-[13px] text-inkMuted underline underline-offset-2 hover:text-ink"
          >
            Why this matters
          </button>
          {whyOpen && (
            <div className="mt-1.5 space-y-1 text-inkSoft">
              {steps.why.map((s, i) => (
                <p key={i}>{s}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
