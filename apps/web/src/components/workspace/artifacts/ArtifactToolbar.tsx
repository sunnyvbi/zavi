"use client";

import { useEffect, useState } from "react";
import { Grid2X2, List, Search } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/cn";
import { ArtifactTypeFilter } from "./ArtifactTypeFilter";
import type { ArtifactFilter, ArtifactView } from "./types";

export function ArtifactToolbar({
  query,
  filter,
  view,
  onQueryChange,
  onFilterChange,
  onViewChange,
}: {
  query: string;
  filter: ArtifactFilter;
  view: ArtifactView;
  onQueryChange: (value: string) => void;
  onFilterChange: (value: ArtifactFilter) => void;
  onViewChange: (value: ArtifactView) => void;
}) {
  const [pending, setPending] = useState<ArtifactView | null>(null);
  const shown = pending ?? view;
  useEffect(() => {
    setPending((p) => (p === view ? null : p));
  }, [view]);

  const pick = (next: ArtifactView) => {
    if (next === shown) return;
    setPending(next);
    onViewChange(next);
  };

  const segment = (active: boolean) =>
    cn(
      "relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
      "transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inkMuted",
      "motion-reduce:transition-none motion-reduce:delay-0",
      active ? "text-cream delay-150" : "text-inkMuted hover:text-ink",
    );

  return (
    <div className="flex w-full items-center gap-2 sm:w-auto">
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:flex-none">
        <div className="relative w-full sm:w-52 md:w-64 lg:w-80">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-inkLight"
          />
          <label htmlFor="artifact-search" className="sr-only">
            Search artifacts
          </label>
          <Input
            id="artifact-search"
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search artifacts"
            className="bg-creamDeep pl-9"
          />
        </div>

        <div className="sm:hidden">
          <ArtifactTypeFilter value={filter} onChange={onFilterChange} />
        </div>
      </div>

      <div
        className="relative hidden h-10 items-center gap-0.5 rounded-full border border-rule bg-creamDeep p-1 sm:flex"
        role="group"
        aria-label="Artifact view"
      >
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute left-1 top-1 h-8 w-8 rounded-full bg-ink",
            "transition-transform duration-200 ease-out motion-reduce:transition-none",
            shown === "list" ? "translate-x-[34px]" : "translate-x-0",
          )}
        />
        <button
          type="button"
          aria-label="Grid view"
          title="Grid view"
          aria-pressed={shown === "grid"}
          onClick={() => pick("grid")}
          className={segment(shown === "grid")}
        >
          <Grid2X2 className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="List view"
          title="List view"
          aria-pressed={shown === "list"}
          onClick={() => pick("list")}
          className={segment(shown === "list")}
        >
          <List className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
