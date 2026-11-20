"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Markdown } from "./Markdown";

import { SOURCES_HEADERS, splitSources } from "@zavi/shared";

export { splitSources };

const WARNING_PREFIXES = ["Not in this run's data:", "No pull in this run returned"];
const REFUSAL_PREFIXES = ["Your connector refused a query", "Your settings refused a query", "Zavi's safety check blocked a query"];

const isWarning = (l: string) => WARNING_PREFIXES.some((p) => l.startsWith(p));
export const isRefusalLine = (l: string) => REFUSAL_PREFIXES.some((p) => l.startsWith(p));

function detailRuns(lines: string[]): { refusal: boolean; text: string }[] {
  const runs: { refusal: boolean; text: string }[] = [];
  for (const l of lines) {
    const refusal = isRefusalLine(l);
    const last = runs.at(-1);
    if (last && !refusal && !last.refusal) last.text += `\n${l}`;
    else runs.push({ refusal, text: l });
  }
  return runs.map((r) => ({ ...r, text: r.text.trim() })).filter((r) => r.text.length > 0);
}

export function SourcesFootnote({ sources }: { sources: string }) {
  const [open, setOpen] = useState(false);
  const [first, ...rest] = sources.split("\n");
  const summary = SOURCES_HEADERS.reduce((s, h) => s.replace(h, ""), first).trim();
  const warnings = rest.filter(isWarning);
  const runs = detailRuns(rest.filter((l) => !isWarning(l)));
  const detail = runs.length > 0;

  return (
    <div className="mt-2 text-[13px] leading-[1.5] text-inkMuted" data-testid="sources-footnote">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        disabled={!detail}
        className="inline-flex items-start gap-1 text-left hover:text-ink disabled:cursor-default disabled:hover:text-inkMuted"
      >
        {detail && (
          <ChevronRight
            className={`mt-[3px] h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
            aria-hidden
          />
        )}
        <span>
          <span className="font-medium text-ink">Sources.</span> {summary}
        </span>
      </button>
      {warnings.map((w) => (
        <p key={w} className="mt-1 text-[#b45309]">
          {w}
        </p>
      ))}
      {open && detail && (
        <div className="mt-1 pl-4 text-[13px]">
          {runs.map((r, i) =>
            r.refusal ? (
              <div key={i} className="text-[#b45309]" data-testid="sources-refusal">
                <Markdown source={r.text} breaks reading />
              </div>
            ) : (
              <Markdown key={i} source={r.text} breaks reading />
            ),
          )}
        </div>
      )}
    </div>
  );
}
