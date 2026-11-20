export const NOTICE_SURFACE =
  "mx-auto flex min-h-10 w-full items-center gap-2.5 rounded-2xl border border-rule bg-cream px-3.5 py-1.5 font-sans text-[13px] leading-5 shadow-[0_1px_2px_rgb(14_15_17/0.04)]";

export const NOTICE_DOT = "h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500";

export const NOTICE_LABEL = "min-w-0 text-inkMuted";

export const NOTICE_FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

export const NOTICE_GHOST_BUTTON = `inline-flex h-7 items-center rounded-full px-2.5 text-[13px] font-medium text-inkMuted transition-colors hover:bg-ink/[0.05] hover:text-ink disabled:opacity-60 ${NOTICE_FOCUS}`;

export const NOTICE_PRIMARY_BUTTON = `inline-flex h-7 items-center gap-1 rounded-full bg-ink px-3 text-[13px] font-medium text-cream transition-colors hover:bg-ink/90 disabled:opacity-60 ${NOTICE_FOCUS}`;
