"use client";

import type { ReactNode } from "react";
import type { BlankSuggestions } from "./blankSuggestions";
import { PaneCaption } from "./SplitCard";
import { isToggleRow, sentenceCase, splitWho, valueParts, type Audience, type AudienceRow, type ValuePart } from "./audienceParse";

export type SheetFills = {
  blanks: string[];
  typed: Record<string, string>;
  values: Record<string, string>;
  context?: Record<string, string>;
  set: (blank: string, value: string) => void;
  fill: (text: string) => string;
  suggest?: BlankSuggestions;
  suggested?: Record<string, string>;
};

function BlankInput({ part, fills }: { part: Extract<ValuePart, { kind: "blank" }>; fills: SheetFills }) {
  const value = fills.typed[part.raw] ?? fills.values[part.raw] ?? "";
  const filled = !!value.trim();
  const best = fills.suggest?.options[part.raw]?.[0];
  const hint = best ? `e.g. ${best}` : part.text;
  const suggested = fills.typed[part.raw] === undefined && fills.suggested?.[part.raw] !== undefined;
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-2">
    <input
      type="text"
      data-testid="audience-blank"
      data-filled={filled ? "true" : "false"}
      aria-label={fills.context?.[part.raw] ?? part.text}
      aria-description={best ? part.text : undefined}
      placeholder={hint}
      value={value}
      onChange={(e) => fills.set(part.raw, e.target.value)}
      style={{ width: `${Math.max(hint.length, value.length, 12) + 3}ch` }}
      className={`h-11 min-w-0 max-w-full rounded-xl border px-3.5 text-[15px] text-ink outline-none transition-shadow placeholder:text-ink/55 ${
        filled
          ? "border-rule bg-transparent focus:border-ink/40"
          : "border-ink/25 bg-ink/[0.04] shadow-[0_0_0_3px_rgba(255,255,255,0.05),0_0_14px_rgba(255,255,255,0.07)] focus:border-ink/50 focus:shadow-[0_0_0_3px_rgba(255,255,255,0.1),0_0_18px_rgba(255,255,255,0.12)]"
      }`}
    />
    {suggested && (
      <span data-testid="audience-suggested" className="inline-flex items-center rounded-full bg-creamDeep px-2 py-0.5 text-[12px] font-medium text-inkMuted">
        Zavi's suggestion
      </span>
    )}
    </span>
  );
}

function Part({ part, fills, first }: { part: ValuePart; fills: SheetFills; first: boolean }) {
  if (part.kind === "toggle")
    return (
      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-semibold ${part.on ? "bg-successBg text-success" : "bg-creamDeep text-inkMuted"}`}>
        {part.on ? "On" : "Off"}
      </span>
    );
  if (part.kind === "blank") return <BlankInput part={part} fills={fills} />;
  return <span>{first ? sentenceCase(part.text) : part.text}</span>;
}

const CHIP = "inline-flex items-center rounded-lg bg-creamDeep px-2.5 py-1 text-[14px] leading-5 text-ink";

function Value({ value, fills }: { value: string; fills: SheetFills }) {
  const items = valueParts(value);
  if (items.length <= 1)
    return (
      <span className="flex flex-wrap items-center gap-2">
        {(items[0] ?? []).map((p, i) => (
          <Part key={i} part={p} fills={fills} first={i === 0} />
        ))}
      </span>
    );
  return (
    <span className="flex flex-wrap items-center gap-2">
      {items.map((parts, i) =>
        parts.some((p) => p.kind === "blank") ? (
          <span key={i} className="inline-flex flex-wrap items-center gap-2">
            {parts.map((p, j) =>
              p.kind === "text" ? (
                <span key={j} className={CHIP}>{j === 0 ? sentenceCase(p.text) : p.text}</span>
              ) : (
                <Part key={j} part={p} fills={fills} first={j === 0} />
              ),
            )}
          </span>
        ) : (
          <span key={i} className={`${CHIP} gap-1.5`}>
            {parts.map((p, j) => (
              <Part key={j} part={p} fills={fills} first={j === 0} />
            ))}
          </span>
        ),
      )}
    </span>
  );
}

function Row({ label, open, field, children }: { label: string; open?: boolean; field?: boolean; children: ReactNode }) {
  return (
    <div data-gap={open ? "open" : undefined} className={`grid gap-1.5 px-5 py-3.5 sm:grid-cols-[176px_minmax(0,1fr)] sm:gap-5 ${field ? "sm:items-start" : "sm:items-center"}`}>
      <dt className={`flex items-center gap-2 ${field ? "sm:min-h-11" : ""} text-[13.5px] font-medium leading-5 text-inkMuted`}>
        {label}
        {open && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink/60" aria-label="To fill" />}
      </dt>
      <dd className="min-w-0 text-[15px] leading-6 text-ink [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function blanksOf(value: string): string[] {
  return valueParts(value).flat().flatMap((p) => (p.kind === "blank" ? [p.raw] : []));
}

const isOpen = (fills: SheetFills, blank: string) => !(fills.values[blank] ?? "").trim() && !fills.suggest?.options[blank]?.length;

function AudienceBlock({ audience, fills }: { audience: Audience; fills: SheetFills }) {
  const { title, aside } = splitWho(audience.who);
  const fields = audience.rows.filter((r) => !isToggleRow(r));
  const toggles: AudienceRow[] = audience.rows.filter(isToggleRow);
  return (
    <section data-testid="audience-block" className="overflow-hidden rounded-2xl border border-rule bg-white">
      <header className="flex items-start gap-3 px-5 pb-4 pt-[18px]">
        <span className="mt-px inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink text-[12px] font-semibold text-cream">{audience.n}</span>
        <div className="min-w-0 flex-1">
          <p className="text-[16px] font-semibold leading-6 text-ink">{sentenceCase(title)}</p>
          {aside && <p className="mt-0.5 text-[14px] leading-5 text-inkMuted">{sentenceCase(aside)}</p>}
        </div>
      </header>
      <dl className="divide-y divide-rule/70 border-t border-rule">
        {fields.map((row, i) => (
          <Row key={`${row.key}-${i}`} label={row.key} open={blanksOf(row.value).some((b) => isOpen(fills, b))} field={blanksOf(row.value).length > 0}>
            <Value value={row.value} fills={fills} />
          </Row>
        ))}
        {toggles.length > 0 && (
          <Row label="Settings">
            <span data-testid="audience-toggles" className="flex flex-wrap gap-2">
              {toggles.map((t) => {
                const on = /^on$/i.test(t.value.trim());
                return (
                  <span key={t.key} className={`inline-flex items-center gap-2 rounded-lg px-2.5 py-1 text-[14px] leading-5 ${on ? "bg-successBg text-success" : "bg-creamDeep text-ink"}`}>
                    {t.key}
                    <span className={`text-[11.5px] font-semibold uppercase tracking-wide ${on ? "" : "text-inkMuted"}`}>{on ? "On" : "Off"}</span>
                  </span>
                );
              })}
            </span>
          </Row>
        )}
      </dl>
      {audience.notes.length > 0 && (
        <div className="border-t border-rule px-5 py-3 text-[13.5px] leading-5 text-inkMuted">
          {audience.notes.map((n, i) => (
            <p key={i}>{n}</p>
          ))}
        </div>
      )}
    </section>
  );
}

export function AudienceSheet({ label, intro, audiences, fills }: { label: string | null; intro: string[]; audiences: Audience[]; fills: SheetFills }) {
  const lead = intro.filter((l) => !label || l.toLowerCase() !== label.toLowerCase());
  return (
    <div data-testid="audience-sheet">
      {label && <PaneCaption>{label}</PaneCaption>}
      {lead.length > 0 && <p className="mb-2 text-[13px] leading-5 text-inkMuted">{lead.join(" ")}</p>}
      <div className="space-y-3">
        {audiences.map((a) => (
          <AudienceBlock key={a.n} audience={a} fills={fills} />
        ))}
      </div>
    </div>
  );
}
