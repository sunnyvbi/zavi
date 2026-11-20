"use client";

import Link from "next/link";

export type ChannelFit = { value: "high" | "medium" | "low"; line: string };

const LABEL: Record<ChannelFit["value"], string> = {
  high: "High fit",
  medium: "Medium fit",
  low: "Low fit",
};

const CHIP: Record<ChannelFit["value"], string> = {
  high: "bg-success/[0.12] text-success ring-success/25",
  medium: "bg-warn/[0.12] text-warn ring-warn/25",
  low: "bg-ink/[0.06] text-inkSoft ring-ink/10",
};

const STRATEGY_HREF = "/workspace?tab=growth-strategy";

export function ChannelFitPill({ fit }: { fit: ChannelFit }) {
  return (
    <span
      className={`inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[11px] font-medium leading-none ring-1 ring-inset ${CHIP[fit.value]}`}
      data-testid="channel-fit-pill"
    >
      {LABEL[fit.value]}
    </span>
  );
}

export function ChannelValueLine({
  fit,
  hasStrategy,
}: {
  fit: ChannelFit | null;
  hasStrategy: boolean;
}) {
  if (fit) return null;
  return (
    <p className="mt-5 text-[13px] leading-5 text-inkMuted" data-testid="channel-value-empty">
      {hasStrategy
        ? "Your latest growth strategy did not rate this channel. Redraft it and Zavi will rate every channel for your business. "
        : "Zavi hasn't judged this channel for your business yet. Draft your growth strategy and it will rate every channel. "}
      <Link href={STRATEGY_HREF} className="font-medium text-ink underline underline-offset-2">
        {hasStrategy ? "Redraft growth strategy" : "Draft growth strategy"}
      </Link>
    </p>
  );
}
