"use client";

import { useState } from "react";
import {
  ResearchEnvelopeRenderer,
  type ResearchEnvelope,
} from "@/components/ResearchEnvelopeRenderer";
import {
  PmEnvelopeRenderer,
  type PmEnvelope,
} from "@/components/PmEnvelopeRenderer";

export type EnvelopeCardProps = {
  schemaName?: string;
  envelope: unknown;
  agentSlug?: string;
};

export function EnvelopeCard({
  schemaName,
  envelope,
  agentSlug,
}: EnvelopeCardProps) {
  const [open, setOpen] = useState(false);
  if (agentSlug === "pm") {
    return (
      <div className="mt-2">
        <PmEnvelopeRenderer envelope={envelope as PmEnvelope} />
      </div>
    );
  }
  if (agentSlug === "research") {
    return (
      <div className="mt-2">
        <ResearchEnvelopeRenderer envelope={envelope as ResearchEnvelope} />
      </div>
    );
  }
  const json = JSON.stringify(envelope, null, 2);
  return (
    <div className="mt-2 rounded-md border border-ink/15 bg-white/60 text-[12px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2 py-1 text-left"
      >
        <span className="font-mono text-inkMuted">⊟</span>
        <span className="font-mono text-ink">
          envelope{schemaName ? `: ${schemaName}` : ""}
        </span>
        <span className="ml-auto text-[11px] text-inkMuted">
          {open ? "hide" : "show"}
        </span>
      </button>
      {open && (
        <pre className="border-t border-ink/10 bg-bone/70 px-2 py-1.5 font-mono text-[11px] leading-[1.45] text-ink overflow-x-auto whitespace-pre">
          {json}
        </pre>
      )}
    </div>
  );
}
