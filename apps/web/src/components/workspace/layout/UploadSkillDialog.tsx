"use client";

import { useCallback, useRef, useState } from "react";
import { FileArchive, Upload, X } from "lucide-react";
import { cx, FOCUS_RING, useModalFocusTrap } from "./shared";
import type { ParsedSkill } from "./skillFile";
import { checkSkillZip, parseSkillZip, SKILL_ZIP_ACCEPT } from "./skillZip";

function formatBundleSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export type UploadSkillDialogProps = {
  onClose: () => void;
  onCommit: (
    skill: ParsedSkill,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  onDone: (title: string, ignored: string[]) => void;
};

export function UploadSkillDialog({
  onClose,
  onCommit,
  onDone,
}: UploadSkillDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ name: string; size: number } | null>(
    null,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useModalFocusTrap(dialogRef, onClose, busy);

  const ingest = useCallback(
    async (file: File) => {
      const fileErr = checkSkillZip({ name: file.name, size: file.size });
      if (fileErr) {
        setError(fileErr);
        return;
      }
      setPending({ name: file.name, size: file.size });
      setBusy(true);
      setError(null);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const parsed = parseSkillZip(bytes);
        if (!parsed.ok) {
          setError(parsed.error);
          return;
        }
        const saved = await onCommit(parsed.skill);
        if (!saved.ok) {
          setError(saved.error);
          return;
        }
        onDone(parsed.skill.title, parsed.ignored);
      } catch (e) {
        setError(`Couldn't read that zip: ${(e as Error).message}`);
      } finally {
        setBusy(false);
        setPending(null);
      }
    },
    [onCommit, onDone],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto overscroll-contain bg-[rgba(11,11,12,0.55)] px-4 py-8 backdrop-blur-sm compact:px-3 compact:py-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Upload Skill"
        className="flex max-h-full w-full max-w-[560px] animate-pop-in flex-col overflow-hidden rounded-2xl border border-rule bg-cream shadow-[0_24px_64px_-16px_rgba(0,0,0,0.5),0_2px_10px_rgba(0,0,0,0.16)] ring-1 ring-white/[0.05] outline-none motion-reduce:animate-none"
      >
        <div className="flex items-start justify-between gap-3 px-6 pb-3 pt-5 compact:px-4 compact:pb-2 compact:pt-4">
          <div>
            <h3 className="text-[22px] font-medium leading-tight text-ink compact:text-[20px]">
              Upload Skill
            </h3>
            <p className="mt-1.5 text-[16px] leading-[1.5] text-inkMuted compact:mt-1 compact:text-[13px]">
              Upload a skill zip to add it to your agent.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
            className={cx(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-inkLight hover:bg-bone hover:text-ink disabled:opacity-50 compact:h-10 compact:w-10",
              FOCUS_RING,
            )}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto px-6 pb-6 compact:gap-3 compact:px-4 compact:pb-4">
          <div className="rounded-xl border border-rule bg-creamDeep px-4 py-3.5 compact:px-3.5 compact:py-3">
            <p className="text-[16px] font-medium text-ink">Skill zip format</p>
            <ul className="mt-2 flex list-disc flex-col gap-2 pl-4 text-[13px] leading-[1.5] text-inkMuted marker:text-inkLight">
              <li>
                Must contain a{" "}
                <code className="rounded bg-bone px-1 py-0.5 text-[13px] text-ink">
                  SKILL.md
                </code>{" "}
                at the root or inside a single top-level directory
              </li>
              <li>
                <code className="rounded bg-bone px-1 py-0.5 text-[13px] text-ink">
                  SKILL.md
                </code>{" "}
                must have YAML frontmatter with{" "}
                <code className="rounded bg-bone px-1 py-0.5 text-[13px] text-ink">
                  name
                </code>{" "}
                and{" "}
                <code className="rounded bg-bone px-1 py-0.5 text-[13px] text-ink">
                  description
                </code>
              </li>
              <li>
                Name must be lowercase, letters/numbers/hyphens only, max 64
                chars
              </li>
              <li>Max zip size: 50 MB</li>
            </ul>
          </div>

          <input
            ref={inputRef}
            type="file"
            accept={SKILL_ZIP_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void ingest(file);
            }}
          />

          {busy && pending ? (
            <div className="flex min-h-[200px] w-full flex-col items-center justify-center gap-2 rounded-xl border border-rule bg-creamDeep px-6 py-10 compact:min-h-[140px] compact:px-4 compact:py-6">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-rule text-inkMuted">
                <FileArchive className="h-5 w-5" aria-hidden />
              </span>
              <p className="mt-1 w-full truncate text-center text-[14px] font-medium text-ink">
                {pending.name}
              </p>
              <p aria-live="polite" className="text-[13px] text-inkMuted">
                {formatBundleSize(pending.size)} · Processing…
              </p>
              <div
                role="progressbar"
                aria-label="Processing skill zip"
                className="mt-3 h-1 w-full max-w-[320px] overflow-hidden rounded-full bg-bone"
              >
                <div className="h-full w-1/3 animate-indeterminate-bar rounded-full bg-ink/50 motion-reduce:w-full motion-reduce:animate-none" />
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const file = e.dataTransfer.files?.[0];
                if (file) void ingest(file);
              }}
              className={cx(
                "flex min-h-[200px] w-full flex-col items-center justify-center gap-2 rounded-cta border border-dashed px-6 py-10 transition-colors duration-150 disabled:opacity-60 motion-reduce:transition-none",
                "compact:min-h-[140px] compact:gap-2 compact:px-4 compact:py-6",
                dragging
                  ? "border-ink bg-bone"
                  : "border-rule hover:border-ink/40",
                FOCUS_RING,
              )}
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-rule text-inkMuted">
                <Upload className="h-5 w-5" aria-hidden />
              </span>
              <span className="mt-1 text-[14px] text-inkMuted compact:mt-0.5">
                Drag &amp; drop or{" "}
                <span className="font-medium text-ink">browse</span>
              </span>
              <span className="text-[13px] text-inkLight">
                ZIP file, up to 50 MB
              </span>
            </button>
          )}

          {error && (
            <p role="alert" className="text-[13px] leading-[1.5] text-danger">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
