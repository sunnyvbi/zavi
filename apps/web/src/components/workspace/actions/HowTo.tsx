"use client";

import { useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { setChannelActionSteps } from "@/lib/workspace/channelActionsApi";
import type { ActionItem } from "./types";
import { useAdsPresentation } from "./ads/AdsPresentation";
import { cn } from "@/lib/cn";
import { useInlineActionInstructions } from "./ActionHowItWorks";
import { AD_HOW_IT_WORKS } from "./ads/AdsHowItWorks";

export function HowTo({ a, caption = "How to do this", inline: inlineProp = false }: { a: ActionItem; caption?: string; inline?: boolean }) {
  const ads = useAdsPresentation();
  const inline = useInlineActionInstructions() || inlineProp;
  const steps = a.how_to ?? [];
  const server = (a.steps_done ?? []).filter((i) => i < steps.length);
  const serverKey = server.join(",");
  const [local, setLocal] = useState<{ value: number[]; acked: number[] | null; busy: boolean } | null>(null);
  const [seen, setSeen] = useState(serverKey);
  if (seen !== serverKey) {
    setSeen(serverKey);
    if (local && !local.busy) setLocal(null);
  }
  const ticked = local ? local.value : server;
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const pending = useRef<number[] | null>(null);
  if (!a.card_kind || steps.length === 0) return null;
  const checklist = a.card_kind === "task";

  const flush = (want: number[]) => {
    inFlight.current = true;
    setChannelActionSteps(a.id, want)
      .then(() => {
        setLocal((l) => (l ? { ...l, acked: want } : l));
      })
      .catch(() => {
        pending.current = null;
        setLocal((l) => (l?.acked ? { value: l.acked, acked: l.acked, busy: false } : null));
        setError("That step didn't save. Try again.");
      })
      .finally(() => {
        inFlight.current = false;
        const next = pending.current;
        pending.current = null;
        if (next) flush(next);
        else setLocal((l) => (l ? { ...l, busy: false } : l));
      });
  };

  const toggle = (i: number) => {
    const next = ticked.includes(i) ? ticked.filter((x) => x !== i) : [...ticked, i].sort((x, y) => x - y);
    setLocal((l) => ({ value: next, acked: l?.acked ?? null, busy: true }));
    setError(null);
    if (inFlight.current) pending.current = next;
    else flush(next);
  };

  const last = steps.length - 1;
  const badge = (i: number, done: boolean) => (
    <span
      data-testid="how-to-badge"
      aria-hidden
      className={`relative z-[1] grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12px] font-semibold tabular-nums ${done ? "bg-ink/[0.04] text-inkLight" : "bg-ink/[0.08] text-inkMuted"}`}
    >
      {i + 1}
    </span>
  );
  const connector = (i: number) =>
    i < last ? <span data-testid="how-to-connector" aria-hidden className="absolute -bottom-2 left-3 top-7 border-l border-rule" /> : null;
  const content = <>
      <ol data-testid="how-to-steps" className="mt-2 flex animate-pane-fade flex-col gap-3 rounded-xl border border-rule bg-ink/[0.03] p-4 motion-reduce:animate-none">
        {steps.map((s, i) => {
          const done = checklist && ticked.includes(i);
          return (
            <li key={i} data-testid="how-to-step" className="relative flex items-start gap-3">
              {connector(i)}
              {badge(i, done)}
              {checklist ? (
                <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
                  <span className={`min-w-0 flex-1 pt-0.5 text-[14px] leading-5 [overflow-wrap:anywhere] ${done ? "text-inkMuted line-through" : "text-ink"}`}>{s}</span>
                  <input
                    type="checkbox"
                    checked={done}
                    onChange={() => toggle(i)}
                    aria-label={`Step ${i + 1}: ${s}`}
                    className="mt-1 size-4 shrink-0 cursor-pointer accent-ink"
                  />
                </label>
              ) : (
                <span className="min-w-0 flex-1 pt-0.5 text-[14px] leading-5 text-ink [overflow-wrap:anywhere]">{s}</span>
              )}
            </li>
          );
        })}
      </ol>
      {error && (
        <p role="alert" className="mt-2 text-[13px] font-medium text-red-600">
          {error}
        </p>
      )}
    </>;
  if (inline || ads?.inlineInstructions) return <div data-testid="how-to">{content}</div>;
  return <details data-testid="how-to" className="group/howto"><summary className={cn("inline-flex cursor-pointer list-none items-center gap-1 font-semibold [&::-webkit-details-marker]:hidden", ads ? "min-h-10 px-1 text-sm text-inkSoft underline underline-offset-4" : "text-[11px] uppercase tracking-[0.06em] text-inkMuted")}>{ads ? AD_HOW_IT_WORKS : caption}<ChevronRight data-testid="how-to-chevron" className="h-4 w-4 shrink-0 text-inkMuted transition-transform group-open/howto:rotate-90 motion-reduce:transition-none" aria-hidden /></summary>{content}</details>;
}
