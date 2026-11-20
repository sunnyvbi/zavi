"use client";

import { X } from "lucide-react";
import type { FileRef } from "@/lib/workspace/fileRefs";

export function FileRefChips({
  files,
  onRemove,
  align = "start",
  variant = "card",
  className = "",
}: {
  files: ReadonlyArray<FileRef>;
  onRemove?: (url: string) => void;
  align?: "start" | "end";
  variant?: "card" | "thumb";
  className?: string;
}) {
  if (files.length === 0) return null;
  if (variant === "thumb") {
    return (
      <ul
        aria-label={files.length === 1 ? "Attached photo" : `${files.length} attached photos`}
        className={`flex max-w-full flex-wrap gap-2 ${align === "end" ? "justify-end" : ""} ${className}`}
      >
        {files.map((file) => (
          <li key={file.url} title={file.name} className="animate-code-fade motion-reduce:animate-none">
            <img
              src={file.url}
              alt={file.name}
              loading="lazy"
              decoding="async"
              className="block h-[132px] max-w-[240px] rounded-2xl border border-ink/10 bg-bone object-cover"
            />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul
      aria-label={files.length === 1 ? "Attached photo" : `${files.length} attached photos`}
      className={`flex max-w-full flex-wrap gap-2 ${align === "end" ? "justify-end" : ""} ${className}`}
    >
      {files.map((file) => (
        <li
          key={file.url}
          title={file.name}
          className="inline-flex min-w-0 w-[248px] max-w-full items-center gap-2.5 rounded-2xl border border-rule/80 bg-creamDeep p-1.5 pr-3 text-ink shadow-sm animate-code-fade motion-reduce:animate-none"
        >
          <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-xl border border-ink/10 bg-bone">
            <img
              src={file.url}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
            <span className="text-[11px] font-semibold uppercase leading-4 tracking-[0.08em] text-inkMuted">
              Image attachment
            </span>
            <span className="truncate text-[13px] font-semibold leading-4 text-ink">
              {file.name}
            </span>
          </span>
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(file.url)}
              aria-label={`Remove ${file.name}`}
              className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-inkMuted transition-colors hover:bg-bone hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
