"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Filter } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ArtifactFilter } from "./types";

const FILTER_OPTIONS: ReadonlyArray<{ value: ArtifactFilter; label: string }> = [
  { value: "all", label: "All Artifacts" },
  { value: "image", label: "Images" },
  { value: "video", label: "Videos" },
  { value: "website", label: "Websites & Apps" },
  { value: "presentation", label: "Slides" },
  { value: "dashboard", label: "Dashboards" },
  { value: "spreadsheet", label: "Sheets" },
  { value: "document", label: "Reports" },
  { value: "file", label: "Other Files" },
];

export function ArtifactTypeFilter({
  value,
  onChange,
}: {
  value: ArtifactFilter;
  onChange: (value: ArtifactFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePress = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("mousedown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const active = value !== "all";
  const activeLabel = FILTER_OPTIONS.find((option) => option.value === value)?.label;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label={
          active ? `Filter artifacts by type (${activeLabel} selected)` : "Filter artifacts by type"
        }
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "relative flex h-10 w-10 items-center justify-center rounded-full border border-rule transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inkMuted",
          active || open
            ? "border-ink bg-ink text-cream hover:bg-inkSoft"
            : "bg-creamDeep text-inkMuted hover:bg-bone hover:text-ink",
        )}
      >
        <Filter className="h-4 w-4" aria-hidden="true" />
      </button>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Artifact type"
          className="absolute right-0 top-full z-50 mt-2 max-h-[min(22rem,60vh)] w-56 overflow-y-auto rounded-block border border-rule bg-creamDeep p-1.5 shadow-pop"
        >
          {FILTER_OPTIONS.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-base font-normal text-ink transition-colors hover:bg-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-inkMuted",
                  selected && "bg-bone font-medium",
                )}
              >
                <span>{option.label}</span>
                {selected && (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink" aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
