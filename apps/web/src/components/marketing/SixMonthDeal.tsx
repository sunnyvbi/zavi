
import type { PlanTier } from "@/lib/marketing/pricing";

const nf = new Intl.NumberFormat("en-US");

export function StruckPrice({ usd, className = "" }: { usd: number; className?: string }) {
  return (
    <del className={`font-medium tracking-normal text-[#595959] decoration-[1.5px] ${className}`}>
      <span className="sr-only">Regular price </span>${nf.format(usd)}
    </del>
  );
}

export function SixMonthDeal({
  tier,
  months,
  stack = false,
}: {
  tier: PlanTier;
  months: number;
  stack?: boolean;
}) {
  const save = tier.usd * months - tier.sixMonthUsd;
  return (
    <div
      className={
        stack
          ? "flex flex-col items-start gap-y-1"
          : "flex flex-wrap items-center gap-x-2 gap-y-1"
      }
    >
      {save > 0 && (
        <span className="inline-flex items-center rounded-full bg-[#e9f7f1] py-[2px] pl-1 pr-2 text-[12px] font-semibold leading-4 text-[#167f50]">
          <svg viewBox="0 0 16 16" className="size-4 flex-none" fill="none" aria-hidden>
            <path d="M8 4v8m0 0l-3-3m3 3l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {`Save $${nf.format(save)}`}
        </span>
      )}
      <span className="text-[13px] font-medium leading-5 text-[#595959]">
        {`$${nf.format(tier.sixMonthUsd)} billed every ${months} months`}
      </span>
    </div>
  );
}
