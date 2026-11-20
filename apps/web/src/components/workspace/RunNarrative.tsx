"use client";

import { useEffect, useState } from "react";
import { buildRunPanel, type RunPanel as RunPanelModel, type RunPanelGroup } from "@zavi/shared";
import type { ChatRow } from "@/lib/workspace/useChatThread";
import {
  formatDuration,
  liveLineText,
  narrativeSegments,
  secondsBetween,
  stepRows,
  toolCount,
  usedToolsLabel,
} from "@/lib/workspace/runNarrative";
import { agentDisplayName } from "@/lib/agentRegistry";
import { startLineFor } from "@/lib/workspace/startLine";
import { RawCall, Tick, toActivityRows } from "./RunPanel";

function Chevron({ group }: { group: "s" | "r" }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={`h-3.5 w-3.5 shrink-0 text-ink/35 transition-transform ${group === "s" ? "group-open/s:rotate-90" : "group-open/r:rotate-90"}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="h-3.5 w-3.5 shrink-0 rounded-full border-[1.5px] border-ink/15 border-t-ink/60 animate-spin motion-reduce:animate-none"
    />
  );
}

function StepList({ groups }: { groups: RunPanelGroup[] }) {
  return (
    <div className="mb-2 ml-1.5 border-l border-ink/10 pl-4 pt-0.5">
      {stepRows(groups).map((row) => (
        <details key={row.label} className="group/r">
          <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2.5 py-1 text-[13px] text-ink/70">
            {row.state === "running" ? <Spinner /> : <Tick failed={row.state === "failed"} />}
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
            {row.count > 1 && <span className="shrink-0 tabular-nums text-ink/45">{row.count}</span>}
            <Chevron group="r" />
          </summary>
          <div className="flex flex-col gap-2 pb-2 pt-1">
            {row.tools.map((t) => (
              <RawCall key={t.key} tool={t} />
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

function FoldLine({ groups, durationSec }: { groups: RunPanelGroup[]; durationSec?: number | null }) {
  return (
    <details className="group/s my-1">
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1.5 py-1 text-[13px] text-ink/55 hover:text-ink/80">
        <span className="truncate">{usedToolsLabel(groups, durationSec)}</span>
        <Chevron group="s" />
      </summary>
      <StepList groups={groups} />
    </details>
  );
}

function LiveLine({ text, groups, elapsedSec }: { text: string; groups: RunPanelGroup[]; elapsedSec: number | null }) {
  const n = toolCount(groups);
  const body = (
    <>
      <span className="min-w-0 truncate" aria-hidden>
        <span className="zavi-shimmer block truncate text-[14px]">{text}</span>
      </span>
      {elapsedSec != null && (
        <span aria-hidden className="shrink-0 text-[13px] tabular-nums text-ink/40">
          · {formatDuration(elapsedSec)}
        </span>
      )}
      {n > 0 && (
        <span className="shrink-0 text-[13px] text-ink/40">
          · {n} {n === 1 ? "tool" : "tools"}
        </span>
      )}
    </>
  );
  if (n === 0) return <div className="my-1 flex min-w-0 items-center gap-1.5 py-1">{body}</div>;
  return (
    <details className="group/s my-1">
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1.5 py-1">
        {body}
        <Chevron group="s" />
      </summary>
      <StepList groups={groups} />
    </details>
  );
}

function useElapsed(startedAt: string | null | undefined, live: boolean): number | null {
  const startMs = startedAt ? Date.parse(startedAt) : NaN;
  const has = Number.isFinite(startMs);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live || !has) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live, has]);
  return has ? Math.max(0, (now - startMs) / 1000) : null;
}

export function RunNarrative({
  rows = [],
  model,
  agentSlug,
  state = "running",
  drafting = false,
  liveThought,
  queueAhead = null,
  waitingOnMemory = false,
  askText,
  askClaimed = false,
  workingAriaLabel,
  startedAt,
  endedAt,
  compact = false,
}: {
  rows?: ChatRow[];
  model?: RunPanelModel;
  agentSlug: string;
  state?: RunPanelModel["state"];
  drafting?: boolean;
  liveThought?: string;
  queueAhead?: number | null;
  waitingOnMemory?: boolean;
  askText?: string;
  askClaimed?: boolean;
  workingAriaLabel?: string;
  startedAt?: string | null;
  endedAt?: string | null;
  compact?: boolean;
}) {
  const panel = model ?? buildRunPanel(toActivityRows(rows), { state, drafting, liveThought });
  const runState = model ? model.state : state;
  const queued = typeof queueAhead === "number";
  const startLine = queued && waitingOnMemory ? "Zavi is still reading your site…" : startLineFor(askText, queued || !askClaimed);
  const running = runState === "running";
  const segments = narrativeSegments(panel.items);
  const terminal =
    runState === "stopped" ? "Stopped" : runState === "failed" ? "Stopped: something went wrong" : null;
  const elapsed = useElapsed(queued || !askClaimed ? null : startedAt, running);
  const durationSec = running ? null : secondsBetween(startedAt ?? rows[0]?.created_at, endedAt);

  if (!running && segments.length === 0 && !terminal) return null;

  const last = segments[segments.length - 1];
  const live = running && !drafting && !!last && !(last.thought?.live && last.groups.length === 0);
  const lastWithSteps = segments.reduce((at, s, i) => (s.groups.length > 0 ? i : at), -1);

  const narrative = (
    <div className="min-w-0">
      {running && !compact && (
        <span className="sr-only">
          {queued ? startLine : (workingAriaLabel ?? `${agentDisplayName(agentSlug)} is working`)}
        </span>
      )}
      {}
      {}
      {running && !compact && segments.length === 0 && !drafting && (
        <LiveLine text={startLine} groups={[]} elapsedSec={elapsed} />
      )}
      {segments.map((seg, i) => (
        <div key={seg.key}>
          {seg.thought?.origin === "plan" ? (
            <p className="my-1 py-1 text-[13px] leading-[1.5] text-ink/55">{seg.thought.full ?? seg.thought.text}</p>
          ) : seg.thought && (
            <p className="my-[0.4em] font-reading text-[16px] leading-[1.7] text-ink">
              {seg.thought.full ?? seg.thought.text}
              {seg.thought.live && (
                <span
                  aria-hidden
                  className="ml-0.5 inline-block h-[13px] w-[5px] translate-y-[2px] rounded-[1px] bg-ink/60 animate-pulse motion-reduce:animate-none"
                />
              )}
            </p>
          )}
          {live && !compact && i === segments.length - 1 ? (
            <LiveLine text={liveLineText(seg.groups)} groups={seg.groups} elapsedSec={elapsed} />
          ) : (
            seg.groups.length > 0 && <FoldLine groups={seg.groups} durationSec={i === lastWithSteps ? durationSec : null} />
          )}
        </div>
      ))}
      {terminal && !compact && (
        <p className="my-1 flex items-center gap-2 py-1 text-[13px] text-ink/55">
          {runState === "failed" && <Tick failed />}
          {terminal}
        </p>
      )}
    </div>
  );
  if (!compact) return narrative;
  return (
    <div className="min-w-0 space-y-1">
      {running && !drafting && (
        <div className="flex flex-wrap items-center gap-x-2 text-[14px] font-medium text-ink/80">
          <span role="status">{last ? liveLineText(last.groups) : startLine}</span>
          {elapsed != null && <span aria-hidden className="tabular-nums">· {formatDuration(elapsed)}</span>}
        </div>
      )}
      {segments.length > 0 && (
        <details>
          <summary className="cursor-pointer py-1 text-[13px] text-ink/70 hover:text-ink">View activity</summary>
          <div className="mt-1 border-l border-ink/15 pl-4">{narrative}</div>
        </details>
      )}
      {terminal && <p role="status" className="text-[14px] text-ink/80">{terminal}</p>}
    </div>
  );
}
