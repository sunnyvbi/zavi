"use client";


const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export const COST_UNKNOWN = "Uses credits from your plan";

export function CostTag({
  credits,
  loading,
  hint,
  loadingLabel = "Loading the cost",
  testId = "cost-tag",
  className,
}: {
  credits: number | null;
  loading: boolean;
  hint?: string;
  loadingLabel?: string;
  testId?: string;
  className?: string;
}) {
  if (loading) {
    return (
      <span
        data-testid={testId}
        aria-busy="true"
        className={cx("inline-flex h-8 w-[144px] animate-pulse items-center rounded-lg bg-ink/[0.06] motion-reduce:animate-none", className)}
      >
        <span className="sr-only">{loadingLabel}</span>
      </span>
    );
  }
  return (
    <span
      data-testid={testId}
      title={credits == null ? undefined : hint}
      className={cx(
        "inline-flex h-8 items-center gap-0.5 whitespace-nowrap rounded-lg border border-ink/[0.07] bg-ink/[0.05] px-3 text-[13px] leading-none text-inkMuted shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] animate-pane-fade motion-reduce:animate-none",
        className,
      )}
    >
      {credits == null ? (
        COST_UNKNOWN
      ) : (
        <>
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-inkLight">Uses</span>
          {"\u00a0"}
          <span className="text-[14px] font-semibold tabular-nums tracking-[-0.01em] text-ink">
            ~{credits.toLocaleString("en-US")}
            <span className="text-[13px] font-medium tracking-normal text-inkMuted"> credits</span>
          </span>
        </>
      )}
    </span>
  );
}
