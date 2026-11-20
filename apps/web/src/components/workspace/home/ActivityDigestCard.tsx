"use client";

import { useWorkspace } from "../WorkspaceShell";
import { relativeTime } from "@/lib/workspace/relativeTime";
import type { ActivityRow } from "./types";

function usdToCredits(usd: number): string {
  return `${Math.round(usd / 0.0025).toLocaleString()} cr`;
}

export function ActivityDigestCard({ rows }: { rows: ActivityRow[] }) {
  const { openTab, creditsEnforced } = useWorkspace();

  return (
    <section className="rounded-xl border border-ink/[0.08] bg-white p-4 shadow-[0_1px_2px_rgba(25,25,25,0.04),0_6px_18px_rgba(25,25,25,0.05)]">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="font-display text-[16px] font-semibold tracking-tight text-ink">
          What your team did
        </h2>
        <span className="font-mono text-[11px] uppercase tracking-[0.05em] text-inkMuted">
          recent
        </span>
      </header>

      {rows.length === 0 ? (
        <p className="text-[13px] text-inkMuted">
          No completed runs yet. As your agents finish work, it shows up here.
        </p>
      ) : (
        <ul className="-my-1.5">
          {rows.map((r, i) => (
            <li key={`${r.agent_slug}-${r.finished_at ?? i}`}>
              <button
                type="button"
                onClick={() =>
                  openTab({
                    kind: "agent",
                    title: r.agent_slug,
                    payload: { kind: "agent", slug: r.agent_slug },
                    dirty: false,
                    pinned: false,
                  })
                }
                title={`Open ${r.agent_slug}`}
                className={`flex w-full cursor-pointer items-center gap-2 py-2 text-left transition-colors duration-150 hover:bg-ink/[0.025] focus-visible:bg-ink/[0.025] focus-visible:outline-none ${
                  i > 0 ? "border-t border-ink/[0.06]" : ""
                }`}
              >
                <span
                  aria-hidden
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500 opacity-70"
                />
                <span className="truncate font-mono text-[13px] text-ink">
                  {r.agent_slug}
                </span>
                <span className="ml-auto shrink-0 text-[12px] tabular-nums text-inkMuted">
                  {relativeTime(r.finished_at)}
                </span>
                <span className="w-px shrink-0 self-stretch bg-ink/[0.08]" aria-hidden />
                <span className="shrink-0 font-mono text-[12px] tabular-nums text-inkMuted">
                  {creditsEnforced
                    ? usdToCredits(r.cost_usd)
                    : `$${r.cost_usd.toFixed(2)}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
