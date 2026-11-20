"use client";

export function InlineConfirm({
  text,
  confirmLabel,
  onConfirm,
  onCancel,
  busy = false,
  primaryClass,
  secondaryClass,
}: {
  text: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  primaryClass: string;
  secondaryClass: string;
}) {
  return (
    <div role="group" aria-label="Confirm" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
      <p className="text-[14px] leading-relaxed text-ink">{text}</p>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button type="button" disabled={busy} onClick={onCancel} className={secondaryClass}>
          Not now
        </button>
        <button type="button" disabled={busy} onClick={onConfirm} className={primaryClass}>
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
