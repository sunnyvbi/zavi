"use client";

import { useEffect, useState, type ReactNode } from "react";
import { RunNarrative } from "./RunNarrative";
import { LiveFace } from "./LiveFace";
import { agentDisplayName } from "@/lib/agentRegistry";
import type { ChatRow } from "@/lib/workspace/useChatThread";

export function ThinkingDots() {
  return (
    <span aria-hidden className="inline-flex items-center">
      <span className="h-2.5 w-2.5 rounded-full bg-ink animate-thinking-dot motion-reduce:animate-none" />
    </span>
  );
}

function useStalled(turnStartedAt?: string | null, startedAt?: string | null): boolean {
  const turnAnchor = turnStartedAt ?? startedAt ?? null;
  const startMs = turnAnchor ? Date.parse(turnAnchor) : NaN;
  const hasStart = Number.isFinite(startMs);
  const [elapsedSec, setElapsedSec] = useState(() =>
    hasStart ? Math.max(0, Math.floor((Date.now() - startMs) / 1000)) : 0,
  );

  useEffect(() => {
    if (!hasStart) return;
    const tick = () =>
      setElapsedSec(Math.max(0, Math.floor((Date.now() - startMs) / 1000)));
    tick();
    const id = window.setInterval(tick, 10_000);
    return () => window.clearInterval(id);
  }, [hasStart, startMs]);

  return hasStart && elapsedSec > 15 * 60;
}

export function RunActivityFeed({
  rows,
  agentSlug,
  startedAt,
  turnStartedAt,
  queueAhead,
  waitingOnMemory = false,
  drafting = false,
  liveThought,
  askText,
  askClaimed = false,
  face,
}: {
  rows: ChatRow[];
  agentSlug: string;
  startedAt?: string | null;
  turnStartedAt?: string | null;
  queueAhead?: number | null;
  waitingOnMemory?: boolean;
  drafting?: boolean;
  liveThought?: string;
  askText?: string;
  askClaimed?: boolean;
  face?: ReactNode;
}) {
  const stalled = useStalled(turnStartedAt, startedAt);

  return (
    <div className="py-1">
      <LiveFace face={face}>
        <RunNarrative
          rows={rows}
          agentSlug={agentSlug}
          state="running"
          drafting={drafting}
          liveThought={liveThought}
          queueAhead={queueAhead}
          waitingOnMemory={waitingOnMemory}
          askText={askText}
          askClaimed={askClaimed}
          startedAt={turnStartedAt ?? startedAt}
        />
        {stalled && (
          <p className="pb-1 text-[11px] text-ink/50">
            {agentDisplayName(agentSlug)} is still working. This is taking
            longer than usual.
          </p>
        )}
      </LiveFace>
    </div>
  );
}

