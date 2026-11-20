"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Upload } from "lucide-react";
import { cx, FOCUS_RING } from "./shared";

export type SkillsCreateMenuProps = {
  onUpload: () => void;
};

export function SkillsCreateMenu({ onUpload }: SkillsCreateMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const item =
    "flex w-full items-start gap-3 rounded-[10px] px-3 py-2.5 text-left transition-colors duration-100 hover:bg-bone motion-reduce:transition-none";

  return (
    <div ref={ref} className="relative shrink-0">
      {}
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls="skills-create-options"
        onClick={() => setOpen((v) => !v)}
        className={cx(
          "inline-flex h-10 items-center gap-2 rounded-full bg-ink pl-5 pr-4 text-[16px] font-medium text-cream shadow-elev",
          "compact:h-auto compact:min-h-[40px] compact:gap-1 compact:pl-3.5 compact:pr-2.5 compact:text-[13px]",
          "transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.98] motion-reduce:transition-none",
          FOCUS_RING,
        )}
      >
        Create
        <ChevronDown
          aria-hidden
          className={cx(
            "h-[18px] w-[18px] text-cream/70 transition-transform duration-200 motion-reduce:transition-none compact:h-4 compact:w-4",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div
          id="skills-create-options"
          className="absolute right-0 top-[calc(100%+8px)] z-30 flex w-[268px] max-w-[calc(100vw-32px)] animate-pop-in flex-col gap-0.5 rounded-2xl border border-rule bg-cream p-1.5 shadow-pop motion-reduce:animate-none"
        >
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onUpload();
            }}
            className={cx(item, FOCUS_RING)}
          >
            <Upload
              className="mt-0.5 h-[18px] w-[18px] shrink-0 text-inkMuted"
              aria-hidden
            />
            <span className="min-w-0">
              <span className="block text-[16px] text-ink">Upload a skill</span>
              <span className="mt-0.5 block text-[13px] leading-[1.4] text-inkMuted">
                A .zip with a SKILL.md inside
              </span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
