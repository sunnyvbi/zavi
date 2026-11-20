"use client";

import { useEffect } from "react";

export function BillingConfirmDialog({
  title,
  body,
  confirmLabel,
  busy = false,
  danger = false,
  error = null,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  busy?: boolean;
  danger?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return (
    <div
      className="dialog-scrim fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={() => !busy && onClose()}
    >
      <div
        className="w-full max-w-[440px] rounded-[20px] border border-rule bg-white p-6 font-sans shadow-[0_24px_48px_rgba(16,18,20,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[20px] font-semibold leading-7 text-[#0e0f11]">{title}</h3>
        <p className="mt-2 text-[14px] leading-[22px] text-[#595959]">{body}</p>
        {error && (
          <p className="mt-3 text-[13px] leading-5 text-[#cb2029]" role="alert">
            {error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex h-10 items-center justify-center rounded-cta border border-[#e8e7e4] bg-white px-4 text-[14px] font-semibold text-[#0e0f11] transition-colors hover:bg-[#f7f7f7] disabled:opacity-60"
          >
            Never mind
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`flex h-10 items-center justify-center rounded-cta px-4 text-[14px] font-semibold text-white transition-colors disabled:opacity-60 ${
              danger ? "bg-[#cb2029] hover:bg-[#b01b23]" : "bg-[#0e0f11] hover:bg-black"
            }`}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
