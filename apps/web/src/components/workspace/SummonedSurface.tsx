"use client";

import { useState, type ComponentType } from "react";
import { EngineerDashboard } from "./agent/EngineerDashboard";
import { DashboardOpenSourceProvider } from "@/lib/workspace/dashboardOpenSource";
import type { SummonedSurfaceRef } from "@/lib/workspace/summonedSurface";

export const SUMMONED_SURFACES: Record<string, ComponentType> = {
  builds: EngineerDashboard,
};

export function SummonedSurface({ surface }: { surface: SummonedSurfaceRef }) {
  const Panel = SUMMONED_SURFACES[surface.key];
  const [open, setOpen] = useState(true);
  if (!Panel) return null;

  return (
    <section
      className="mt-2 overflow-hidden rounded-xl border border-ink/10 bg-white/70"
      aria-label={`${surface.label}, opened by Zavi in this reply`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-ink/10 px-4 py-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-[#1f1f1f]">
            {surface.label}
          </div>
          <div className="text-[11px] text-[#6b6b6b]">
            Opened here by Zavi for this answer
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="shrink-0 rounded-cta border border-ink/15 bg-white px-2 py-1 text-[11px] font-medium text-[#404040] hover:bg-[#f5f5f5]"
        >
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {open && (
        <div className="max-h-[520px] overflow-y-auto px-4 py-4">
          {}
          <DashboardOpenSourceProvider source="summon">
            <Panel />
          </DashboardOpenSourceProvider>
        </div>
      )}
    </section>
  );
}
