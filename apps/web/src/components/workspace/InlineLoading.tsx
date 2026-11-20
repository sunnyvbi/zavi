"use client";

export function InlineLoading({ label = "Loading…" }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2.5 py-12 text-[13px] text-inkMuted"
    >
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="h-4 w-4 animate-spin text-inkMuted"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      >
        <path d="M21 12a9 9 0 1 1-6.2-8.55" />
      </svg>
      <span>{label}</span>
    </div>
  );
}
