"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { cx, FOCUS_RING } from "../layout/shared";
import { useLookFonts } from "./LookPreview";
import { WebsiteChoiceBody, websiteAriaLabel } from "./WebsiteVariant";
import { selectLook, useLookSelection, type SiteDesign, type SiteDesignLook } from "@/lib/workspace/useSiteDesign";

export const BUILD_WITH_LOOK = "Build with this website";
export const STARTING_BUILD = "Starting your build…";
export const PICK_FIRST = "Pick a website to start your build.";

export function selectedLookLine(label: string): string {
  return `Previewing “${label}”. Build with it when you're ready.`;
}

export function lookStartedLine(label: string): string {
  return `Building your site in “${label}”.`;
}

export function autoStartLine(label: string, secondsLeft: number): string {
  const s = Math.max(0, Math.ceil(secondsLeft));
  if (s === 0) return `Starting with “${label}”…`;
  return `Starting with “${label}” in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function useSecondsUntil(at: string | null | undefined): number | null {
  const target = at ? Date.parse(at) : NaN;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!Number.isFinite(target)) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [target]);
  return Number.isFinite(target) ? Math.max(0, (target - now) / 1000) : null;
}

export type LookPickerProps = {
  design: SiteDesign;
  starting: string | null;
  started: string | null;
  startError: string | null;
  onStart: (lookId: string) => void | Promise<unknown>;
  wide?: boolean;
};

function LookTile({
  look,
  index,
  design,
  selected,
  disabled,
  tabbable,
  onSelect,
  onArrow,
}: {
  look: SiteDesignLook;
  index: number;
  design: SiteDesign;
  selected: boolean;
  disabled: boolean;
  tabbable: boolean;
  onSelect: () => void;
  onArrow: (step: 1 | -1) => void;
}) {
  const preview = look.preview ?? design.preview ?? null;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={websiteAriaLabel(look, index)}
      disabled={disabled}
      tabIndex={tabbable ? 0 : -1}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          onArrow(1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          onArrow(-1);
        }
      }}
      data-testid={`look-tile-${look.id}`}
      className={cx(
        "group flex min-w-0 flex-col overflow-hidden rounded-xl border bg-cream text-left transition-colors",
        selected ? "border-ink ring-1 ring-ink" : "border-rule hover:border-inkMuted",
        disabled && !selected ? "cursor-not-allowed opacity-60" : "",
        FOCUS_RING,
      )}
    >
      <WebsiteChoiceBody look={look} index={index} preview={preview} selected={selected} />
    </button>
  );
}

export function LookPicker({ design, starting, started, startError, onStart, wide = false }: LookPickerProps) {
  useLookFonts(design.looks);
  const runId = design.run_id;
  const selected = useLookSelection(runId);
  const setSelected = (id: string | null) => selectLook(runId, id);
  const firedRef = useRef(false);
  const looks = design.looks;
  const secondsLeft = useSecondsUntil(design.awaiting_pick ? design.auto_start_at : null);
  const autoLook = looks.find((l) => l.recommended) ?? looks[0] ?? null;

  useEffect(() => {
    if (selected && !looks.some((l) => l.id === selected)) selectLook(runId, null);
  }, [looks, selected, runId]);

  useEffect(() => {
    if (!starting && !started) firedRef.current = false;
  }, [starting, started, startError]);

  if (started) {
    const look = looks.find((l) => l.id === started);
    const label = look?.label ?? "the look you picked";
    return (
      <div data-testid="look-picker" data-state="started" className="mt-2.5">
        <p role="status" className="text-[13px] leading-5 text-ink">
          {lookStartedLine(label)}
        </p>
        {look && (
          <div className="mt-2 max-w-[320px]">
            <LookTile
              look={look}
              index={looks.indexOf(look)}
              design={design}
              selected
              disabled
              tabbable
              onSelect={() => undefined}
              onArrow={() => undefined}
            />
          </div>
        )}
      </div>
    );
  }

  const busy = starting !== null;
  const chosenLook = looks.find((l) => l.id === selected) ?? null;
  const build = () => {
    if (!chosenLook || busy || firedRef.current) return;
    firedRef.current = true;
    const result = onStart(chosenLook.id);
    if (result instanceof Promise) {
      const release = () => {
        firedRef.current = false;
      };
      void result.then(release, release);
    }
  };

  return (
    <div data-testid="look-picker" data-state={busy ? "starting" : "picking"} className="mt-2.5 [container-type:inline-size]">
      <div
        role="radiogroup"
        aria-label="Looks"
        className={cx("grid grid-cols-1 gap-2", wide ? "grid-cols-3" : "[@container(min-width:480px)]:grid-cols-3")}
      >
        {looks.map((look, i) => (
          <LookTile
            key={look.id}
            look={look}
            index={i}
            design={design}
            selected={look.id === selected}
            disabled={busy}
            tabbable={selected ? look.id === selected : i === 0}
            onSelect={() => {
              if (!busy) setSelected(look.id);
            }}
            onArrow={(step) => {
              if (busy || looks.length < 2) return;
              const from = selected ? looks.findIndex((l) => l.id === selected) : i;
              const next = looks[(from + step + looks.length) % looks.length]!;
              setSelected(next.id);
              if (typeof document !== "undefined") {
                (document.querySelector(`[data-testid="look-tile-${next.id}"]`) as HTMLElement | null)?.focus();
              }
            }}
          />
        ))}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="look-build"
          disabled={!chosenLook || busy}
          onClick={build}
          className={cx(
            "inline-flex items-center gap-1.5 rounded-cta bg-ink px-3 py-1.5 text-[13px] font-medium text-cream hover:bg-inkSoft disabled:cursor-not-allowed disabled:opacity-50",
            FOCUS_RING,
          )}
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          {busy ? STARTING_BUILD : BUILD_WITH_LOOK}
        </button>
        {!busy && <span className="text-[12px] leading-5 text-inkMuted">{chosenLook ? selectedLookLine(chosenLook.label) : PICK_FIRST}</span>}
      </div>
      {!busy && secondsLeft !== null && autoLook && (
        <p data-testid="look-auto-start" role="timer" aria-live="off" className="mt-2 text-[12px] leading-5 text-inkMuted">
          {autoStartLine(autoLook.label, secondsLeft)}
        </p>
      )}
      {startError && (
        <p role="alert" className="mt-2 text-[12px] leading-5 text-danger">
          {startError}
        </p>
      )}
    </div>
  );
}
