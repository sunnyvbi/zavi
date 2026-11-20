"use client";

import { useEffect, useRef } from "react";
import { useChannelHistoryRead } from "../actions/useChannelHistory";
import { ChannelRunDrawerView } from "./ChannelRunDrawer";
import { ChannelRefreshLine, useChannelReadFailure } from "./ChannelRefresh";
import { relative } from "./channelDetail";
import { RememberedPill } from "@/components/memory/RememberedPill";

export function ChannelRunFoot({ slug, runKey = "", logsOnly = false, memory = true }: { slug: string; runKey?: string; logsOnly?: boolean; memory?: boolean }) {
  const { history, failed, reload } = useChannelHistoryRead(slug);
  const seenRunKey = useRef(runKey);
  useEffect(() => {
    if (seenRunKey.current === runKey) return;
    seenRunKey.current = runKey;
    reload();
  }, [runKey, reload]);
  const inline = useChannelReadFailure(failed, reload);
  const latest =
    history.state === "ready" ? history.history.runs.find((r) => r.status === "success") : undefined;
  const stamp = latest?.finished_at ?? latest?.started_at ?? null;
  return (
    <>
      {inline && <ChannelRefreshLine onRetry={reload} />}
      {latest && !logsOnly && memory ? (
        <div data-testid="run-foot-memory" className="mt-5 has-[[data-testid=remembered-pill-slot]:empty]:mt-0">
          <RememberedPill
            key={latest.run_id}
            runId={latest.run_id}
            caption={stamp ? `From the latest run, ${relative(stamp).toLowerCase()}` : "From the latest run"}
          />
        </div>
      ) : null}
      <ChannelRunDrawerView history={history} slug={slug} logsOnly={logsOnly} />
    </>
  );
}
