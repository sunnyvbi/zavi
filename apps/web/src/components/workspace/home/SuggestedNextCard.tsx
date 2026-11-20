"use client";

import type { SuggestedNextRow } from "./types";
import { useWorkspace } from "../WorkspaceShell";

export function SuggestedNextCard({ rows }: { rows: SuggestedNextRow[] }) {
  const { openTab } = useWorkspace();

  if (rows.length === 0) {
    return (
      <section className="rounded-xl border border-ink/[0.08] bg-white p-4 shadow-[0_1px_2px_rgba(25,25,25,0.04),0_6px_18px_rgba(25,25,25,0.05)]">
        <h2 className="mb-3 font-display text-[16px] font-semibold tracking-tight text-ink">
          Suggested next
        </h2>
        <p className="text-[16px] leading-[1.55] text-inkMuted">
          Nothing pending. Suggestions appear here when an agent gets a
          thumbs-down or a written-rule note in its Feedback tab.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-ink/[0.08] bg-white p-4 shadow-[0_1px_2px_rgba(25,25,25,0.04),0_6px_18px_rgba(25,25,25,0.05)]">
      <h2 className="mb-3 font-display text-[16px] font-semibold tracking-tight text-ink">
        Suggested next
      </h2>
      <ul className="space-y-2">
        {rows.slice(0, 3).map((r) => (
          <li
            key={r.feedback_id}
            className="rounded-lg border border-ink/[0.08] shadow-[0_1px_2px_rgba(25,25,25,0.04)] transition-colors duration-150 hover:border-ink/20 hover:bg-bone/40"
          >
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
              className="flex w-full cursor-pointer items-start gap-3 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
            >
              <span
                aria-hidden
                className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-[12px] text-emerald-700"
              >
                ↑
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-mono text-[12px] text-inkMuted">
                  {r.agent_slug}
                </span>
                <span className="mt-0.5 block line-clamp-2 text-[16px] leading-[1.5] text-ink">
                  {r.suggestion_text}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
