import type { CellTone, ChipTone, ExtraColumn } from "./extraTableTypes";

export const TONE: Record<CellTone, string> = {
  good: "font-semibold text-success",
  bad: "font-semibold text-danger",
  dim: "text-inkMuted",
};

export const CHIP: Record<ChipTone, string> = {
  good: "bg-successBg text-success",
  warn: "bg-warnBg text-warn",
  bad: "bg-dangerBg text-danger",
  muted: "bg-bone text-inkMuted",
};

export const ROW_ACTION =
  "inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border border-rule bg-cream px-3 text-detail font-semibold text-ink transition-colors hover:border-ink hover:bg-bone disabled:opacity-50";

export const ROW_ACTION_PRIMARY =
  "inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border border-ink bg-ink px-3 text-detail font-semibold text-cream transition-colors hover:bg-ink/85";

export const isLeft = (c: ExtraColumn | undefined) => c?.align === "left";

