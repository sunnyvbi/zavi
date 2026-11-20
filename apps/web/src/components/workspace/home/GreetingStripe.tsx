"use client";

import { useWorkspace } from "../WorkspaceShell";
import type { ActiveRunRow } from "./types";

export function GreetingStripe({
  activeRunsToday,
  loading = false,
}: {
  activeRunsToday: ActiveRunRow[];
  loading?: boolean;
}) {
  const counts = bucket(activeRunsToday);

  if (loading) {
    return (
      <section aria-label="Today" className="mb-8 pt-2">
        <div className="h-4 w-44 animate-pulse rounded bg-bone" />
        <div className="mt-3 flex flex-wrap gap-2">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-5 w-44 animate-pulse rounded-full bg-bone"
            />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Today" className="mb-8 pt-2">
      <p className="text-[16px] text-inkMuted">
        {counts.total === 0 ? (
          <>No runs today yet.</>
        ) : (
          <>
            <span className="font-mono text-ink">{counts.total}</span>{" "}
            {counts.total === 1 ? "run" : "runs"} today
            {counts.running > 0 && (
              <>
                {" "}
                ·{" "}
                <span className="font-mono text-ink">
                  {counts.running}
                </span>{" "}
                in progress
              </>
            )}
            {counts.failed > 0 && (
              <>
                {" "}
                ·{" "}
                <span className="font-mono text-coral">
                  {counts.failed}
                </span>{" "}
                failed
              </>
            )}
          </>
        )}
      </p>
      {activeRunsToday.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {activeRunsToday.slice(0, 3).map((r) => (
            <RunChip key={r.id} row={r} />
          ))}
        </div>
      )}
    </section>
  );
}

function RunChip({ row }: { row: ActiveRunRow }) {
  const { openTab } = useWorkspace();
  const ds =
    row.presentation_status ??
    (row.status === "running" || row.status === "queued"
      ? "running"
      : row.status === "success"
        ? "answered"
        : "failed");
  const color =
    ds === "running"
      ? "bg-mint/30 text-ink hover:bg-mint/50"
      : ds === "answered" || ds === "cancelled"
        ? "bg-creamDeep text-inkSoft hover:bg-bone"
        : "bg-coral/15 text-ink hover:bg-coral/25";
  return (
    <button
      type="button"
      onClick={() => {
        openTab({
          kind: "agent",
          title: row.agent_slug,
          payload: { kind: "agent", slug: row.agent_slug },
          dirty: false,
          pinned: false,
        });
      }}
      title={`Open ${row.agent_slug} · run ${row.id.slice(0, 8)}`}
      className={`inline-flex cursor-pointer items-center gap-2 rounded-full px-2.5 py-1 font-mono text-[12px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 ${color}`}
    >
      <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-current opacity-60" />
      <span className="truncate max-w-[160px]">{row.agent_slug}</span>
      <span className="opacity-40">·</span>
      <span className="capitalize">{row.status}</span>
    </button>
  );
}

function bucket(rows: ActiveRunRow[]) {
  let running = 0;
  let failed = 0;
  for (const r of rows) {
    if (r.presentation_status) {
      if (r.presentation_status === "running") running += 1;
      else if (r.presentation_status === "failed") failed += 1;
    } else if (r.status === "running" || r.status === "queued") running += 1;
    else if (
      r.status === "dispatch_error" ||
      r.status === "parse_failed" ||
      r.status === "failed" ||
      r.status === "error"
    )
      failed += 1;
  }
  return { total: rows.length, running, failed };
}
