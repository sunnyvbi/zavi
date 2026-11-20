"use client";

import {
  DEPARTMENT_ORDER,
  getAgentMeta,
  type Department,
} from "@/lib/agentRegistry";

type TreeAgent = {
  slug: string;
  latest_run_status: string | null;
};

export function AgentInventoryCard({ agents }: { agents: TreeAgent[] }) {
  const byDept = new Map<Department, { active: number; idle: number }>();
  for (const d of DEPARTMENT_ORDER) byDept.set(d, { active: 0, idle: 0 });

  for (const a of agents) {
    const dept = getAgentMeta(a.slug).department;
    const bucket = byDept.get(dept);
    if (!bucket) continue;
    const isActive =
      a.latest_run_status === "running" ||
      a.latest_run_status === "queued" ||
      a.latest_run_status === "success";
    if (isActive) bucket.active += 1;
    else bucket.idle += 1;
  }

  const nonEmpty = DEPARTMENT_ORDER.filter(
    (d) =>
      (byDept.get(d)?.active ?? 0) + (byDept.get(d)?.idle ?? 0) > 0,
  );

  const totalActive = nonEmpty.reduce(
    (n, d) => n + (byDept.get(d)?.active ?? 0),
    0,
  );

  return (
    <section className="rounded-xl border border-ink/[0.08] bg-white p-4 shadow-[0_1px_2px_rgba(25,25,25,0.04),0_6px_18px_rgba(25,25,25,0.05)]">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="font-display text-[16px] font-semibold tracking-tight text-ink">
          Agents
        </h2>
        <span className="font-mono text-[12px] tabular-nums text-inkMuted">
          {totalActive} active
        </span>
      </header>
      {nonEmpty.length === 0 ? (
        <p className="text-[16px] text-inkMuted">
          No agents connected yet. Open the Explorer to browse the catalog.
        </p>
      ) : (
        <ul className="space-y-1.5 text-[16px]">
          {nonEmpty.map((d) => {
            const b = byDept.get(d)!;
            return (
              <li key={d} className="flex items-baseline justify-between">
                <span className="text-ink">{d}</span>
                <span className="font-mono text-[13px] tabular-nums text-inkMuted">
                  {b.active} active
                  {b.idle > 0 && (
                    <span className="text-inkMuted"> · {b.idle} idle</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
