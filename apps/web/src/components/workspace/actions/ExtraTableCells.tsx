"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { ScoreMeter, TermsPopover } from "./TableParts";
import { CHIP, TONE, isLeft } from "./extraTableStyles";
import type { ExtraCell, ExtraCellSelect, ExtraColumn } from "./extraTableTypes";

export function cellClass(col: ExtraColumn | undefined, i: number, cell: ExtraCell): string {
  const left = isLeft(col);
  const pad = left && i > 0 ? "px-2" : "px-4";
  const align = left ? "text-left" : "whitespace-nowrap text-right tabular-nums";
  const box = left && i === 0 ? "min-w-table-name max-w-table-cell compact:min-w-0 compact:max-w-none" : "";
  const colour = cell.tone
    ? TONE[cell.tone]
    : cell.strong
      ? "font-semibold text-ink"
      : left
        ? "text-ink"
        : "text-inkMuted";
  return cn(pad, "py-3", align, box, colour);
}

function CellBadge({ badge }: { badge: NonNullable<ExtraCell["badge"]> }) {
  return (
    <span className={cn("mr-2 inline-block rounded-md px-1.5 py-0.5 align-badge text-xs font-semibold", CHIP[badge.tone])}>
      {badge.text}
    </span>
  );
}

export function CellText({ cell }: { cell: ExtraCell }) {
  if (cell.media) {
    const { media, ...content } = cell;
    return <span className="flex min-w-0 items-center gap-3">{media}<span className="min-w-0 break-words"><CellText cell={content} /></span></span>;
  }
  if (cell.badge) {
    return (
      <>
        <span className="block">
          <CellBadge badge={cell.badge} />
          <CellMain cell={cell} />
        </span>
        {cell.sub && (
          <span className="mt-0.5 block text-detail [overflow-wrap:anywhere] font-normal text-inkMuted">{cell.sub}</span>
        )}
      </>
    );
  }
  if (cell.sub) {
    return (
      <>
        <span className="block truncate">
          <CellMain cell={cell} />
        </span>
        <span className="mt-0.5 block text-detail [overflow-wrap:anywhere] font-normal text-inkMuted">{cell.sub}</span>
      </>
    );
  }
  return <CellMain cell={cell} />;
}

function CellTerms({ cell }: { cell: ExtraCell }) {
  if (!cell.terms) return null;
  return (
    <TermsPopover
      terms={cell.terms.items}
      name={cell.terms.name}
      heading={cell.terms.heading}
      buttonLabel={cell.terms.buttonLabel}
    />
  );
}

const SAVED_MS = 2500;
const recentSaves = new Map<string, number>();
const savedLeft = (label: string) => Math.max(0, (recentSaves.get(label) ?? 0) + SAVED_MS - Date.now());

function CellSelect({ select }: { select: ExtraCellSelect }) {
  const [value, setValue] = useState(select.value ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(() => savedLeft(select.label) > 0);
  useEffect(() => setValue(select.value ?? ""), [select.value]);
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), savedLeft(select.label) || SAVED_MS);
    return () => clearTimeout(t);
  }, [saved, select.label]);
  return (
    <span className="inline-flex min-w-0 flex-col items-start gap-1">
      <select
        aria-label={select.label}
        disabled={busy}
        value={value}
        onChange={(e) => {
          const next = e.target.value || null;
          const previous = value;
          setValue(next ?? "");
          setError(null);
          setSaved(false);
          recentSaves.delete(select.label);
          const r = select.onChange(next);
          if (!(r instanceof Promise)) return;
          setBusy(true);
          void r.then(
            () => {
              setBusy(false);
              recentSaves.set(select.label, Date.now());
              setSaved(true);
            },
            (err: unknown) => {
              setBusy(false);
              setValue(previous);
              setError(
                err instanceof Error && err.message
                  ? err.message
                  : "Couldn't save that. Try again in a moment.",
              );
            },
          );
        }}
        className="h-8 max-w-table-select rounded-lg border border-rule bg-cream px-2 text-detail text-ink disabled:opacity-50"
      >
        <option value="">{select.unsetLabel}</option>
        {select.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error && (
        <span role="alert" className="max-w-table-error whitespace-normal text-detail font-normal text-danger">
          {error}
        </span>
      )}
      {saved && !error && (
        <span role="status" className="text-detail font-normal text-inkMuted">
          Saved.
        </span>
      )}
    </span>
  );
}

function CellMain({ cell }: { cell: ExtraCell }) {
  if (cell.select) return <CellSelect select={cell.select} />;
  if (cell.meter) {
    return (
      <span className="inline-flex items-center gap-0.5">
        <ScoreMeter value={cell.meter.value} max={cell.meter.max} name={cell.meter.name} label={cell.text} />
        <CellTerms cell={cell} />
      </span>
    );
  }
  if (cell.terms) {
    return (
      <span className="inline-flex items-center gap-0.5">
        <span>{cell.text}</span>
        <CellTerms cell={cell} />
      </span>
    );
  }
  if (cell.chip) {
    return (
      <span
        title={cell.title}
        className={cn("whitespace-nowrap rounded-md px-2 py-0.5 text-detail font-medium", CHIP[cell.chip])}
      >
        {cell.text}
      </span>
    );
  }
  if (cell.href) {
    return (
      <a href={cell.href} target="_blank" rel="noopener noreferrer" className="hover:underline">
        {cell.text}
      </a>
    );
  }
  return <>{cell.text}</>;
}

