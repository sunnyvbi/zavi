
const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export function CountPill({
  count,
  quiet = count === 0,
  className,
  testId = "count-pill",
}: {
  count: number;
  quiet?: boolean;
  className?: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      data-quiet={quiet || undefined}
      className={cx(
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums leading-none transition-colors",
        quiet ? "bg-ink/10 text-inkMuted" : "bg-ink text-cream",
        className,
      )}
    >
      {count}
    </span>
  );
}
