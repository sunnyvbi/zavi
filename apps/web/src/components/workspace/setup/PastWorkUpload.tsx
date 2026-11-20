"use client";

import { useRef, useState } from "react";
import { FileText, Loader2, Upload, X } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/cn";
import {
  PAST_WORK_ACCEPT,
  PAST_WORK_LIMITS,
  PAST_WORK_DROP_LABEL,
  PAST_WORK_FILE_READY,
  PAST_WORK_FILE_ADDING,
  PAST_WORK_FILE_SAVED,
} from "./pastWorkCopy";
import type { PastWorkFile } from "./usePastWorkImport";

export function PastWorkUpload({
  files,
  busy,
  addFiles,
  remove,
}: {
  files: PastWorkFile[];
  busy: boolean;
  addFiles: (files: File[]) => void;
  remove: (key: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  return (
    <div>
      <input
        ref={input}
        type="file"
        multiple
        accept={PAST_WORK_ACCEPT}
        aria-label="Choose past-work files"
        className="sr-only"
        tabIndex={-1}
        disabled={busy}
        onChange={(e) => {
          addFiles(Array.from(e.currentTarget.files ?? []));
          e.currentTarget.value = "";
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null))
            setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!busy) addFiles(Array.from(e.dataTransfer.files));
        }}
        className={cn(
          "flex min-h-onboarding-drop w-full flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed px-5 py-10 text-center transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-onboarding-focus disabled:cursor-wait motion-reduce:transition-none",
          dragging
            ? "border-onboarding-ink bg-onboarding-subtle"
            : "border-onboarding-border bg-white hover:bg-onboarding-subtle/50",
        )}
      >
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-onboarding-subtle">
          <Upload className="h-5 w-5" aria-hidden />
        </span>
        <span className="text-base font-semibold">
          {PAST_WORK_DROP_LABEL}
        </span>
        <span className="text-sm leading-relaxed text-onboarding-muted">
          {PAST_WORK_LIMITS}
        </span>
      </button>
      {files.length > 0 && (
        <ul className="mt-4 divide-y divide-onboarding-rule rounded-2xl border border-onboarding-rule">
          {files.map((row) => (
            <li key={row.key} className="flex items-center gap-3 px-4 py-3">
              <FileText
                className="h-5 w-5 shrink-0 text-onboarding-muted"
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">
                  {row.file.name}
                </span>
                <span
                  className={cn(
                    "block text-xs",
                    row.status === "failed"
                      ? "text-warn"
                      : "text-onboarding-muted",
                  )}
                >
                  {row.status === "failed"
                    ? row.reason
                    : row.status === "saved"
                      ? PAST_WORK_FILE_SAVED
                      : row.status === "uploading"
                        ? PAST_WORK_FILE_ADDING
                        : PAST_WORK_FILE_READY}
                </span>
              </div>
              {row.status === "uploading" && (
                <Loader2
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-label="Uploading"
                />
              )}
              {row.status !== "saved" && (
                <IconButton
                  type="button"
                  label={`Remove ${row.file.name}`}
                  disabled={busy}
                  onClick={() => remove(row.key)}
                >
                  <X className="h-4 w-4" aria-hidden />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
