
import type { Band } from "./format";

export const BAND_TEXT: Record<Band, string> = {
  pass: "text-success",
  warn: "text-warn",
  fail: "text-danger",
};

const CHIP_TONE: Record<Band | "neutral" | "locked", string> = {
  pass: "bg-successBg text-success",
  warn: "bg-warnBg text-warn",
  fail: "bg-dangerBg text-danger",
  neutral: "bg-bone text-inkMuted",
  locked: "bg-bone text-inkMuted",
};

export function SeoChip({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: Band | "neutral" | "locked";
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-[1px] text-[11px] font-semibold uppercase tracking-wide ${CHIP_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

export function SeoSectionLabel({
  children,
  right,
  id,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
  id?: string;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <p
        id={id}
        className="text-[11px] font-semibold uppercase tracking-wide text-inkMuted"
      >
        {children}
      </p>
      {right ? <div className="flex items-baseline gap-2">{right}</div> : null}
    </div>
  );
}

export function SeoNote({
  title,
  children,
  busy = false,
}: {
  title: string;
  children?: React.ReactNode;
  busy?: boolean;
}) {
  return (
    <div className="rounded-xl border border-dashed border-rule bg-white px-3.5 py-3">
      <p className="flex items-center gap-2 text-[13px] font-semibold leading-5 text-ink">
        {busy ? (
          <span
            aria-hidden
            className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-rule border-t-ink motion-reduce:animate-none"
          />
        ) : null}
        {title}
      </p>
      {children ? (
        <div className="mt-1 flex flex-col gap-2 text-[13px] leading-[1.5] text-inkMuted">
          {children}
        </div>
      ) : null}
    </div>
  );
}
