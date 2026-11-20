
import { cn } from "@/lib/cn";

export type StatusBadgeKind =
  | "live"
  | "shadow"
  | "advisory"
  | "rejected"
  | "live-ready"
  | "draft"
  | "killed"
  | "pending"
  | "queued"
  | "extracting"
  | "evaluating"
  | "drift-green"
  | "drift-yellow"
  | "drift-red"
  | "neutral";

const STYLES: Record<StatusBadgeKind, { bg: string; text: string; dot: string }> = {
  live:           { bg: "bg-emerald-50",  text: "text-emerald-700", dot: "bg-emerald-500" },
  "live-ready":   { bg: "bg-emerald-50",  text: "text-emerald-700", dot: "bg-emerald-500" },
  shadow:         { bg: "bg-slate-100",   text: "text-slate-700",   dot: "bg-slate-400" },
  advisory:       { bg: "bg-amber-50",    text: "text-amber-700",   dot: "bg-amber-500" },
  rejected:       { bg: "bg-rose-50",     text: "text-rose-700",    dot: "bg-rose-500" },
  draft:          { bg: "bg-slate-100",   text: "text-slate-600",   dot: "bg-slate-400" },
  killed:         { bg: "bg-rose-50",     text: "text-rose-700",    dot: "bg-rose-500" },
  pending:        { bg: "bg-slate-100",   text: "text-slate-700",   dot: "bg-slate-400" },
  queued:         { bg: "bg-slate-100",   text: "text-slate-600",   dot: "bg-slate-400" },
  extracting:     { bg: "bg-sky-50",      text: "text-sky-700",     dot: "bg-sky-500" },
  evaluating:     { bg: "bg-sky-50",      text: "text-sky-700",     dot: "bg-sky-500" },
  "drift-green":  { bg: "bg-emerald-50",  text: "text-emerald-700", dot: "bg-emerald-500" },
  "drift-yellow": { bg: "bg-amber-50",    text: "text-amber-700",   dot: "bg-amber-500" },
  "drift-red":    { bg: "bg-rose-50",     text: "text-rose-700",    dot: "bg-rose-500" },
  neutral:        { bg: "bg-slate-100",   text: "text-slate-600",   dot: "bg-slate-400" },
};

export function StatusBadge({
  kind,
  label,
  className,
}: {
  kind: StatusBadgeKind;
  label?: string;
  className?: string;
}) {
  const text = label ?? kind.replace(/-/g, " ");
  const s = STYLES[kind];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-medium leading-none",
        s.bg,
        s.text,
        className,
      )}
    >
      <span className={cn("inline-block h-1.5 w-1.5 rounded-full", s.dot)} />
      <span className="capitalize">{text}</span>
    </span>
  );
}
